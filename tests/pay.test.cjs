// Pay (docs/pay.js, the Pay line on Cash Flow): a pay sheet pasted in, the figures worked out from it, backups.
// Every figure here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { pay: P, app, ctx } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const round = (v, dp = 4) => (v == null ? v : Math.round(v * 10 ** dp) / 10 ** dp);

// The shape of the pay sheet: no header over the year column, worked-out columns (TC, YoY, average) between the
// inputs, and the cash payment and shares on the row of the year they were paid.
const SHEET = [
    '\tTitle\tBase\tBonus (prorate)\tRedundancy\tTC GBP\tYoY TC % Change\tYOY Bonus %\t3Yr average\tCash Payment\tAcme (ACME US Equity) Stock Awarded\tAward Price',
    '2016\tAnalyst\t£40,000\t\t\t£40,000\t\t\t\t\t\t',
    '2017\tAnalyst\t£42,000\t£8,000\t\t£50,000\t25.0%\t\t\t\t\t',
    '2018\tAssociate\t£60,000\t£20,000\t\t£80,000\t60.0%\t150.0%\t£56,666.67\t£8,000\t\t',
    '2019\tAssociate\t£64,000\t£40,000\t\t£104,000\t30.0%\t100.0%\t£78,000\t£20,000\t\t',
    '2020\tVP\t£90,000\t£20,000\t\t£110,000\t5.8%\t-50.0%\t£98,000\t£30,000\t400\t25.0000',
    '2021\tVP\t£95,000\t£0\t£100,000\t£195,000\t77.3%\t-100.0%\t£136,333.33\t£16,000\t200\t25.0000',
    '2022\tDirector\t£100,000\t\t\t\t\t\t\t\t\t',
    '2023',
].join('\n');

test('parsePaste reads the sheet: inputs only, every figure on its own row', () => {
    const r = P.parsePaste(SHEET);
    assert.equal(r.rows.length, 7);
    assert.equal(r.skipped, 1);                       // 2023 has nothing in it
    assert.equal(r.stockName, 'Acme');
    const by = Object.fromEntries(r.rows.map(y => [y.year, y]));
    assert.deepEqual([by[2018].title, by[2018].base, by[2018].bonus], ['Associate', 60000, 20000]);
    // Cash and shares stay where the sheet has them, even when they are more than that row's bonus.
    assert.deepEqual([by[2019].cash, by[2019].shares], [20000, null]);
    assert.deepEqual([by[2020].cash, by[2020].shares, by[2020].price, by[2020].stockName], [30000, 400, 25, 'Acme']);
    assert.deepEqual([by[2021].cash, by[2021].shares, by[2021].redundancy, by[2021].bonus], [16000, 200, 100000, 0]);
    // A blank bonus before the last known one was none; the year under way is still to come.
    assert.equal(by[2016].bonus, 0);
    assert.equal(by[2022].bonus, null);
});

test('a state saved with cash and shares on the bonus year moves them to the year paid, once', () => {
    const s = P.validateState({ v: 1, years: [
        { year: 2019, base: 64000, bonus: 40000, cash: 30000, shares: 400, price: 25, stockName: 'Acme' },
        { year: 2020, base: 90000, bonus: 20000, cash: 16000, shares: 200, price: 25, stockName: 'Acme' },
    ] });
    assert.equal(s.v, 2);
    assert.deepEqual(plain(s.years.map(y => [y.year, y.bonus, y.cash, y.shares, y.stockName])),
        [[2019, 40000, null, null, ''], [2020, 20000, 30000, 400, 'Acme'], [2021, null, 16000, 200, 'Acme']]);
    assert.deepEqual(plain(P.validateState(s).years), plain(s.years));   // a v 2 state stays as it is
});

test('computeYears works out total comp, growth, bonus against base and the 3-year average like the sheet', () => {
    const rows = P.computeYears(P.parsePaste(SHEET).rows);
    const by = Object.fromEntries(rows.map(r => [r.year, r]));
    assert.equal(by[2018].tc, 80000);
    assert.equal(round(by[2018].yoy), 0.6);
    assert.equal(round(by[2018].bonusYoy), 1.5);
    assert.equal(round(by[2018].bonusPct), round(20000 / 60000));
    assert.equal(round(by[2018].avg3, 2), round((40000 + 50000 + 80000) / 3, 2));
    assert.equal(by[2017].bonusYoy, null);           // against a £0 bonus there is no growth to show
    // Redundancy counts in total comp, as the sheet adds it; growth without it is shown beside.
    assert.equal(by[2021].tc, 195000);
    assert.equal(round(by[2021].yoy), round(195000 / 110000 - 1));
    assert.equal(round(by[2021].yoyEarned), round(95000 / 110000 - 1));
    assert.equal(round(by[2021].avg3Earned, 2), round((104000 + 110000 + 95000) / 3, 2));
    // The year under way: base only, nothing worked out from it.
    assert.deepEqual([by[2022].complete, by[2022].tc, by[2022].yoy, by[2022].avg3], [false, 100000, null, null]);
    const s = P.summary(rows);
    assert.deepEqual([s.latest.year, s.current.year, s.first.year], [2021, 2022, 2016]);
    assert.equal(round(s.cagr), round(Math.pow(95000 / 40000, 1 / 5) - 1));
});

test('validateState keeps one entry per year, oldest first, and drops nonsense', () => {
    const s = P.validateState({ years: [
        { year: 2021, base: 100, bonus: 50, cash: 80 },
        { year: 2019, base: 90, title: 'x'.repeat(100) },
        { year: 'soon', base: 1 },
        { year: 2021, base: 120, bonus: null },
    ] });
    assert.deepEqual(plain(s.years.map(y => [y.year, y.base])), [[2019, 90], [2021, 120]]);
    assert.equal(s.years[0].title.length, 40);
    assert.equal(s.years[1].bonus, null);
    assert.equal(P.validYear({ year: 2021, bonus: 0, cash: 80 }).cash, 80);   // cash paid is not capped by the row's own bonus
    assert.equal(P.validateState({ bills: [] }), null);
});

test('mergeYears updates a pasted year in place and keeps its notes and own rate', () => {
    const old = [P.validYear({ id: 'keep', year: 2020, base: 1, notes: 'promoted', fx: 1.3, shares: 10, cash: 1, bonus: 2 })];
    const res = P.mergeYears(old, [P.validYear({ year: 2020, base: 2, shares: 12, cash: 1, bonus: 3 }), P.validYear({ year: 2021, base: 3 })]);
    assert.deepEqual([res.added, res.updated], [1, 1]);
    assert.deepEqual([res.years[0].id, res.years[0].base, res.years[0].notes, res.years[0].fx, res.years[0].shares], ['keep', 2, 'promoted', 1.3, 12]);
});

test('EV (sales credits) is read from the sheet and pay is set against it in dollars', () => {
    const r = P.parsePaste('\tTitle\tBase\tBonus\tEV $mm\t\n2020\tVP\t£100,000\t£50,000\t4,000,000\t9.9%\n2021\tVP\t£100,000\t£30,000\t5\t');
    assert.deepEqual(plain(r.rows.map(y => y.ev)), [4000000, 5000000]);   // a small figure is in $mm
    const rows = P.computeYears(r.rows.map((y, i) => (i ? Object.assign({}, y, { fx: 1.5 }) : y)));
    assert.equal(round(rows[0].evPct), round(150000 * P.fxFor({ year: 2020 }).rate / 4000000));
    assert.equal(round(rows[1].evPct), round(130000 * 1.5 / 5000000));
    assert.equal(round(rows[1].evYoy), 0.25);
    assert.equal(P.fxFor({ year: 2099 }).rate, P.fxFor({ year: 2025 }).rate);   // a year past the table takes its latest rate
});

test('the headers map to the right fields', () => {
    assert.equal(P.headerKey('Bonus (prorate)'), 'bonus');
    assert.equal(P.headerKey('Citi (C UN Equity) Stock Awarded'), 'shares');
    assert.equal(P.headerKey('YOY Bonus %'), null);
    assert.equal(P.headerKey('TC GBP'), null);
    assert.equal(P.headerKey('3Yr average'), null);
    assert.equal(P.headerKey('Cash Payment'), 'cash');
    assert.equal(P.headerKey('EV $mm'), 'ev');
    assert.equal(P.stockNameOf('Citi (C UN Equity) Stock Awarded'), 'Citi');
    assert.equal(P.stockNameOf('Stock Awarded'), '');
});

test('Pay is in the cloud backup counts, so a backup that lost years is held back', () => {
    const before = app.cloudBackupCounts({ pay: { years: [{}, {}, {}] } });
    const now = app.cloudBackupCounts({ pay: { years: [{}] } });
    assert.equal(before.payYears, 3);
    assert.match(app.cloudBackupShrink(before, now), /1 years of pay \(the last backup had 3\)/);
});

test('the Cash Flow Pay line shows the latest year with its bonus known, and the year under way', () => {
    const store = ctx.PayStore;
    assert.deepEqual(plain(store.headline()), { latest: null, current: null, count: 0, takeHome: null });
    assert.equal(store.restore({ v: 2, years: [{ year: 2024, base: 100000, bonus: 20000 }, { year: 2025, base: 110000, bonus: 30000, redundancy: 5000 },
                                               { year: 2026, base: 120000 }] }), true);
    const h = store.headline();
    assert.deepEqual([h.latest.year, h.latest.tc, round(h.latest.yoy), h.current.year, h.current.base, h.count], [2025, 145000, round(145000 / 120000 - 1), 2026, 120000, 3]);
    store.restore({ v: 2, years: [{ year: 2026, base: 120000 }] });
    assert.deepEqual([store.headline().latest, store.headline().current.year], [null, 2026]);
});

test('Settings sums up Cash Flow as pay and bills', () => {
    assert.equal(app.cashFlowSummary(0, 0), 'No pay or bills yet');
    assert.equal(app.cashFlowSummary(1, 1), '1 year of pay · 1 bill');
    assert.equal(app.cashFlowSummary(24, 0), '24 bills');
});

test('take-home: 2026/27 UK income tax and NI, with the personal allowance tapered over £100k', () => {
    const t = g => { const r = P.netPay(g, 0, null); return [Math.round(r.tax), Math.round(r.ni)]; };
    assert.deepEqual(t(30000), [3486, 1394]);
    assert.deepEqual(t(60000), [11432, 3211]);
    assert.deepEqual(t(100000), [27432, 4011]);
    assert.deepEqual(t(125140), [42516, 4513]);    // no allowance left
    assert.deepEqual(t(200000), [76203, 6011]);    // 45% above £125,140
});

test('take-home: the pension comes off before tax and NI (sacrifice), before tax (net pay) or after tax with relief (relief at source)', () => {
    const sac = P.netPay(130000, 0, P.validTakeHome({ pct: 0.05, scheme: 'sacrifice' }));
    assert.deepEqual([sac.pension, Math.round(sac.tax), Math.round(sac.ni)], [6500, Math.round(P.incomeTax(123500, 123500)), Math.round(P.nationalInsurance(123500))]);
    const net = P.netPay(130000, 0, P.validTakeHome({ pct: 0.05, scheme: 'netpay' }));
    assert.equal(Math.round(net.ni), Math.round(P.nationalInsurance(130000)));
    const ras = P.netPay(130000, 0, P.validTakeHome({ pct: 0.05, scheme: 'ras' }));
    assert.equal(ras.pension, 5200);               // 80% from pay, the pension adds the basic-rate 20%
    assert.equal(Math.round(ras.tax), 43075);      // allowance from adjusted net income £123,500; basic band £6,500 wider
    assert.ok(sac.net > ras.net && ras.net > 0);
    const bonusIn = P.netPay(100000, 20000, P.validTakeHome({ pct: 0.1, onBonus: true }));
    assert.equal(bonusIn.pension, 12000);
});

test('take-home for Cash Flow: the base of the year under way a month at a time, the latest bonus after tax on top, a payslip figure overrides', () => {
    const years = [{ year: 2025, base: 120000, bonus: 30000 }, { year: 2026, base: 130000 }].map(y => P.validYear(y));
    const state = { years, takeHome: P.validTakeHome({ pct: 0.05, scheme: 'sacrifice' }) };
    const th = P.takeHomeOf(state, P.computeYears(years));
    assert.equal(th.year, 2026);
    assert.equal(round(th.worked, 2), round(P.netPay(130000, 0, state.takeHome).net / 12, 2));
    assert.equal(th.monthly, th.worked);
    assert.equal(round(th.bonus.net, 2), round(P.netPay(130000, 30000, state.takeHome).net - P.netPay(130000, 0, state.takeHome).net, 2));
    assert.ok(th.bonus.net < 30000 * 0.55);        // 45% tax + 2% NI on top of £130k
    const slip = P.takeHomeOf(Object.assign({}, state, { takeHome: P.validTakeHome({ pct: 0.05, payslip: 6000 }) }), P.computeYears(years));
    assert.deepEqual([slip.monthly, slip.payslip, slip.set], [6000, 6000, true]);
    assert.equal(P.takeHomeOf({ years: [] }, []), null);
    assert.equal(P.validateState({ years, takeHome: { pct: 0.05, scheme: 'nonsense' } }).takeHome.scheme, 'sacrifice');
});

test('marginal rate: one figure for pay (tax and NI) and one for savings (tax only), with the 60% band and share vests in it', () => {
    const rate = (rowsIn, th) => {
        const years = rowsIn.map(y => P.validYear(y));
        const m = P.marginalOf({ years, takeHome: th || P.validTakeHome({}) }, P.computeYears(years));
        return m && [round(m.pay, 3), round(m.saving, 3)];
    };
    assert.deepEqual(rate([{ year: 2026, base: 80000 }]), [0.42, 0.4]);                          // higher rate + 2% NI
    assert.deepEqual(rate([{ year: 2025, base: 90000, bonus: 20000 }, { year: 2026, base: 90000 }]), [0.62, 0.6]);   // £110k: allowance taper
    assert.deepEqual(rate([{ year: 2026, base: 135000 }]), [0.47, 0.45]);                       // additional rate
    // £90k plus a £25k vest is £115k: the vest takes the next pound into the 60% band.
    assert.deepEqual(rate([{ year: 2025, base: 90000, bonus: 0, shares: 4000, price: 25, currency: 'GBP' }, { year: 2026, base: 90000 }]), [0.62, 0.6]);
    assert.equal(P.marginalOf({ years: [] }, []), null);
});

test('share awards vest in equal parts over the four years after the year of the award', () => {
    const rows = P.computeYears([{ year: 2022, base: 1, shares: 400, price: 10, currency: 'GBP', stockName: 'Acme' }, { year: 2026, base: 1 }, { year: 2027, base: 1 }].map(y => P.validYear(y)));
    const at = y => { const v = P.vestOf(rows, y); return v && [v.shares, v.gross]; };
    assert.equal(at(2022), null);
    assert.deepEqual([at(2023), at(2026)], [[100, 1000], [100, 1000]]);
    assert.equal(at(2027), null);                                          // a 2022 award has fully vested
});

test('take-home: the year\'s share vests come after tax and NI on top of the base and latest bonus', () => {
    // 2024's award of 4,000 and 2025's of 2,000 both vest in 2026: 1,000 + 500 shares, at the latest award price ($24 at $1.25).
    const years = [{ year: 2024, base: 90000, bonus: 5000, shares: 4000, price: 20, currency: 'USD', fx: 1.25 },
                   { year: 2025, base: 100000, bonus: 10000, shares: 2000, price: 24, currency: 'USD', fx: 1.25, stockName: 'Acme' },
                   { year: 2026, base: 100000 }].map(y => P.validYear(y));
    const state = { years, takeHome: P.validTakeHome({}) };
    const th = P.takeHomeOf(state, P.computeYears(years));
    assert.deepEqual([th.vest.shares, round(th.vest.gross, 2)], [1500, 28800]);
    assert.equal(round(th.vest.net, 2), round(P.netPay(100000, 10000, state.takeHome, { vest: 28800 }).net - P.netPay(100000, 10000, state.takeHome).net, 2));
    assert.ok(th.vest.net > 28800 * 0.4 && th.vest.net < 28800 * 0.5);    // 62% up to £125,140 and 47% above it
    assert.equal(th.monthly, th.worked);                                  // vests stay out of the monthly figure
    const plain = [P.validYear({ year: 2026, base: 100000 })];
    assert.equal(P.takeHomeOf({ years: plain, takeHome: state.takeHome }, P.computeYears(plain)).vest, null);
});

test('gilts and share plans take the marginal rate from Pay; their own figures only stand in without it', () => {
    const saved = ctx.PayStore;
    ctx.PayStore = { marginal: () => null };                  // no pay figures yet
    assert.equal(app.giltTaxRate(), 0.45);
    assert.equal(app.vestingTaxRate({ estimated_vesting_tax_rate: 0.3 }), 0.3);
    assert.equal(app.vestingTaxRate({}), 0);
    ctx.PayStore = { marginal: () => ({ pay: 0.62, saving: 0.6 }) };
    try {
        assert.equal(app.giltTaxRate(), 0.6);
        assert.equal(app.vestingTaxRate({ estimated_vesting_tax_rate: 0.3 }), 0.62);
    } finally { ctx.PayStore = saved; }
});

test('take-home: payslip deductions come off before tax and NI, before tax only, or after tax', () => {
    const th = deductions => P.validTakeHome({ pct: 0.05, scheme: 'sacrifice', deductions });
    const none = P.netPay(80000, 0, th([]));
    const sac = P.netPay(80000, 0, th([{ name: 'Cycle to work', monthly: 100, kind: 'sacrifice' }]));
    assert.equal(round(sac.tax, 2), round(P.incomeTax(74800, 74800), 2));   // £80k − £4k pension − £1,200
    assert.equal(round(sac.ni, 2), round(P.nationalInsurance(74800), 2));
    assert.equal(round(none.net - sac.net, 2), round(1200 * (1 - 0.40 - 0.02), 2));
    const pre = P.netPay(80000, 0, th([{ name: 'Give as you earn', monthly: 100, kind: 'pretax' }]));
    assert.equal(round(pre.ni, 2), round(none.ni, 2));
    assert.equal(round(none.net - pre.net, 2), round(1200 * (1 - 0.40), 2));
    const post = P.netPay(80000, 0, th([{ name: 'Sports club', monthly: 50, kind: 'post' }]));
    assert.deepEqual([round(post.tax, 2), round(post.ni, 2), round(none.net - post.net, 2)], [round(none.tax, 2), round(none.ni, 2), 600]);
    assert.deepEqual(JSON.parse(JSON.stringify(post.deductions)), [{ name: 'Sports club', kind: 'post', annual: 600 }]);
});

test('take-home: a deduction needs a name and an amount a month; an unknown kind is read as pre-tax', () => {
    const t = P.validTakeHome({ deductions: [{ name: 'Gym', monthly: 30, kind: 'post' }, { name: '', monthly: 10 }, { name: 'Blank', monthly: 0 },
        { name: 'Odd', monthly: 5, kind: 'nonsense' }, 'junk'] });
    assert.deepEqual(t.deductions.map(d => [d.name, d.monthly, d.kind]), [['Gym', 30, 'post'], ['Odd', 5, 'sacrifice']]);
    assert.deepEqual([...P.validTakeHome({ pct: 0.05 }).deductions], []);
});

test('pay review: base, bonus and total comp year on year, and bonus against base', () => {
    const rows = P.computeYears([{ year: 2024, base: 100000, bonus: 30000 }, { year: 2025, base: 110000, bonus: 22000 }, { year: 2026, base: 120000, bonus: null }]);
    // Before anything is typed: the year under way, last year's figures, no changes yet.
    let f = P.reviewFigures(rows, null);
    assert.deepEqual([f.year, f.base, f.prevBase, f.prevBonus, f.bonusChange, round(f.ratioPrev)], [2026, 120000, 110000, 22000, null, 0.2]);
    f = P.reviewFigures(rows, P.validateState({ years: [], review: { year: 2026, bonus: 33000, newBase: 126000 } }).review);
    assert.deepEqual([f.baseChange.diff, round(f.baseChange.pct)], [6000, 0.05]);
    assert.deepEqual([f.bonusChange.diff, round(f.bonusChange.pct)], [11000, 0.5]);
    assert.deepEqual([f.tcPrev, f.tc, f.tcChange.diff], [132000, 153000, 21000]);
    assert.deepEqual([round(f.ratio), round(f.ratioNew, 4)], [0.275, round(33000 / 126000)]);
    // Last year's bonus was for part of the year: compared as paid, or scaled up to a full year.
    const part = { year: 2026, bonus: 33000, newBase: 126000, prevMonths: 6 };
    assert.equal(P.reviewFigures(rows, P.validateState({ years: [], review: part }).review).prevBonus, 22000);
    f = P.reviewFigures(rows, P.validateState({ years: [], review: Object.assign({ fullYear: true }, part) }).review);
    assert.deepEqual([f.prevBonus, round(f.bonusChange.pct)], [44000, -0.25]);
    // Once the bonus is saved into 2026 the review stays on 2026 until it's cleared.
    const saved = P.computeYears([{ year: 2025, base: 110000, bonus: 22000 }, { year: 2026, base: 120000, bonus: 33000 }, { year: 2027, base: 126000 }]);
    assert.equal(P.reviewYearOf(saved, { year: 2026 }), 2026);
    assert.equal(P.reviewYearOf(saved, null), 2027);
});
