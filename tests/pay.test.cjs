// Pay (docs/pay.js): a pay sheet pasted in, the figures worked out from it, stock vesting, backups.
// Every figure here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { pay: P, app } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const round = (v, dp = 4) => (v == null ? v : Math.round(v * 10 ** dp) / 10 ** dp);

// The shape of the pay sheet: no header over the year column, worked-out columns (TC, YoY, average) between the
// inputs, and each bonus's cash payment and shares on the row of the year they were paid (the year after the bonus).
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

test('parsePaste reads the sheet: inputs only, cash and shares moved to the bonus they paid', () => {
    const r = P.parsePaste(SHEET);
    assert.equal(r.rows.length, 7);
    assert.equal(r.skipped, 1);                       // 2023 has nothing in it
    assert.equal(r.stockName, 'Acme');
    assert.equal(r.detected, true);                   // 2021 paid out £16,000 cash against a £0 bonus
    const by = Object.fromEntries(r.rows.map(y => [y.year, y]));
    assert.deepEqual([by[2018].title, by[2018].base, by[2018].bonus], ['Associate', 60000, 20000]);
    // Paid in 2020: the 2019 bonus (£40,000 = £30,000 cash + 400 shares). Paid in 2021: the 2020 bonus.
    assert.deepEqual([by[2019].cash, by[2019].shares, by[2019].price, by[2019].stockName], [30000, 400, 25, 'Acme']);
    assert.deepEqual([by[2020].cash, by[2020].shares], [16000, 200]);
    assert.deepEqual([by[2021].cash, by[2021].shares, by[2021].redundancy, by[2021].bonus], [null, null, 100000, 0]);
    // A blank bonus before the last known one was none; the year under way is still to come.
    assert.equal(by[2016].bonus, 0);
    assert.equal(by[2022].bonus, null);
});

test('parsePaste can be told the cash and shares are on the bonus year\'s own row', () => {
    const r = P.parsePaste(SHEET, false);
    const by = Object.fromEntries(r.rows.map(y => [y.year, y]));
    assert.equal(r.paidNextYear, false);
    assert.deepEqual([by[2020].cash, by[2020].shares], [20000, 400]);   // clamped: cash can't be more than the bonus
    assert.equal(by[2021].cash, 0);
});

test('parsePaste does not move cash that fits its own bonus', () => {
    const r = P.parsePaste('\tTitle\tBase\tBonus\tCash Payment\tShares\tAward Price\n2020\tVP\t100\t50\t40\t2\t5\n2021\tVP\t110\t60\t45\t3\t5');
    assert.equal(r.detected, false);
    assert.deepEqual(plain(r.rows.map(y => [y.year, y.cash, y.shares])), [[2020, 40, 2], [2021, 45, 3]]);
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
    // Stock: the bonus less its cash part, and the dollar rate that implies.
    assert.deepEqual([by[2019].stock, by[2019].cashPart, by[2019].impliedFx], [10000, 30000, 1]);
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

test('stockAwards vests each award in equal parts from a year after it is awarded', () => {
    const rows = P.computeYears(P.parsePaste(SHEET).rows);
    const [a2019, a2020] = P.stockAwards(rows, '2023-02-15');
    // The 2019 bonus is awarded in 2020 and vests 2021 to 2024, 100 shares and £2,500 a year.
    assert.equal(a2019.awarded, 2020);
    assert.deepEqual(plain(a2019.tranches.map(t => [t.year, t.shares, t.value, t.vested])),
        [[2021, 100, 2500, true], [2022, 100, 2500, true], [2023, 100, 2500, false], [2024, 100, 2500, false]]);
    assert.equal(a2019.unvestedValue, 5000);
    assert.equal(a2019.unvestedShares, 200);
    // From March, that year's part counts as vested.
    assert.equal(P.stockAwards(rows, '2023-03-01')[0].tranches[2].vested, true);
    assert.equal(a2020.value, 4000);
    assert.deepEqual(plain(a2020.tranches.map(t => t.year)), [2022, 2023, 2024, 2025]);
});

test('receivedByYear puts each bonus in the year it was paid and the stock in the years it vests', () => {
    const rows = P.computeYears(P.parsePaste(SHEET).rows);
    const by = Object.fromEntries(P.receivedByYear(rows, '2023-06-01').map(b => [b.year, b]));
    assert.deepEqual([by[2020].base, by[2020].cash, by[2020].stock], [90000, 30000, 0]);   // the 2019 bonus's cash
    assert.deepEqual([by[2021].cash, by[2021].redundancy], [16000, 100000]);
    assert.deepEqual([by[2022].stock, by[2022].due], [2500 + 1000, 0]);
    assert.deepEqual([by[2024].stock, by[2024].due], [0, 2500 + 1000]);
    assert.equal(by[2025].due, 1000);
    assert.equal(by[2025].base, 0);
});

test('validateState keeps one entry per year, oldest first, and drops nonsense', () => {
    const s = P.validateState({ years: [
        { year: 2021, base: 100, bonus: 50, cash: 80, vest: 9 },
        { year: 2019, base: 90, title: 'x'.repeat(100) },
        { year: 'soon', base: 1 },
        { year: 2021, base: 120, bonus: null },
    ] });
    assert.deepEqual(plain(s.years.map(y => [y.year, y.base])), [[2019, 90], [2021, 120]]);
    assert.equal(s.years[0].title.length, 40);
    assert.equal(s.years[1].bonus, null);
    assert.equal(P.validYear({ year: 2021, bonus: 50, cash: 80 }).cash, 50);
    assert.equal(P.validYear({ year: 2021, vest: 9 }).vest, 4);
    assert.equal(P.validateState({ bills: [] }), null);
});

test('mergeYears updates a pasted year in place and keeps its notes and vesting', () => {
    const old = [P.validYear({ id: 'keep', year: 2020, base: 1, notes: 'promoted', vest: 3, shares: 10, cash: 1, bonus: 2 })];
    const res = P.mergeYears(old, [P.validYear({ year: 2020, base: 2, shares: 12, cash: 1, bonus: 3 }), P.validYear({ year: 2021, base: 3 })]);
    assert.deepEqual([res.added, res.updated], [1, 1]);
    assert.deepEqual([res.years[0].id, res.years[0].base, res.years[0].notes, res.years[0].vest], ['keep', 2, 'promoted', 3]);
});

test('the headers map to the right fields', () => {
    assert.equal(P.headerKey('Bonus (prorate)'), 'bonus');
    assert.equal(P.headerKey('Citi (C UN Equity) Stock Awarded'), 'shares');
    assert.equal(P.headerKey('YOY Bonus %'), null);
    assert.equal(P.headerKey('TC GBP'), null);
    assert.equal(P.headerKey('3Yr average'), null);
    assert.equal(P.headerKey('Cash Payment'), 'cash');
    assert.equal(P.stockNameOf('Citi (C UN Equity) Stock Awarded'), 'Citi');
    assert.equal(P.stockNameOf('Stock Awarded'), '');
});

test('Pay is in the cloud backup counts, so a backup that lost years is held back', () => {
    const before = app.cloudBackupCounts({ pay: { years: [{}, {}, {}] } });
    const now = app.cloudBackupCounts({ pay: { years: [{}] } });
    assert.equal(before.payYears, 3);
    assert.match(app.cloudBackupShrink(before, now), /1 Pay years \(the last backup had 3\)/);
});
