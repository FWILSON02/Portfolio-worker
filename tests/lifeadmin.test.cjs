// Cash Flow (docs/lifeadmin.js, formerly Life Admin): bills pasted from a spreadsheet, their costs, the Estate mortgage, renewal alerts.
// Every bill here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { lifeAdmin: L, app } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));

// The shape of a Bills sheet copied out of Excel: the header has no names over the first two columns, and copying it
// can drop those blank cells, so it is two cells shorter than the rows.
const SHEET = [
    'Account Number\tUser Name\tContract End Date\tAnnual Cost\tMonthly Cost',
    'Mortgage\tNorthbank\t1111222233\t4.1%\t31 December 2030\t£24,000\t£2,000',
    'Energy\tBrightwell\tBW001\temail\t16 August 2027\t£1,800\t',
    'Council Tax\tRiverside\t555\t\t\t£2,400\t',
    'Cleaner \t\t\t\t\t£1,300\t£50',
    'Water\tRiverside Water\t777\temail\t\t£600\t£50',
    'Contents Insurance\tHarbour\tHB-1/2\t\t12 October 2026\t£120\t',
    '\t\t\t\tTotal\t£30,220\t£2,518',
    '\t\t\t\t1\t87%\t£2,000',
].join('\n');
const ESTATE = { accounts: [
    { id: 'mort', name: 'Northbank Mortgage', debt: true, closed: false, link: 'https://bank.example', loan: { deals: [{ start: '2025-01-01', end: '2030-12-31', rate: 4.1, payment: 2100 }], balances: [] } },
    { id: 'old', name: 'Old Mortgage', debt: true, closed: true, loan: { deals: [{ start: '2015-01-01', end: '2020-01-01', rate: null, payment: 900 }], balances: [] } },
] };

test('parsePaste reads a Bills sheet: header lined up on the right, totals skipped', () => {
    const r = L.parsePaste(SHEET, ESTATE);
    assert.equal(r.rows.length, 6);
    assert.equal(r.skipped, 2);
    const by = Object.fromEntries(r.rows.map(x => [x.bill.name, x.bill]));
    assert.equal(by.Energy.provider, 'Brightwell');
    assert.equal(by.Energy.account, 'BW001');
    assert.equal(by.Energy.username, 'email');
    assert.equal(by.Energy.end, '2027-08-16');
    assert.deepEqual([by.Energy.amount, by.Energy.every], [1800, 'year']);
    assert.equal(by.Energy.category, 'utilities');
    // Annual and monthly agree: monthly. £50 against £1,300 a year: every 2 weeks.
    assert.deepEqual([by.Water.amount, by.Water.every], [50, 'month']);
    assert.deepEqual([by.Cleaner.amount, by.Cleaner.every], [50, '2weeks']);
    assert.equal(by.Cleaner.category, 'services');
    assert.equal(by['Contents Insurance'].category, 'insurance');
    assert.equal(by['Council Tax'].category, 'home');
    // The mortgage follows the open Estate mortgage, and the rate in the user name column is dropped.
    assert.equal(by.Mortgage.estate, 'mort');
    assert.equal(by.Mortgage.username, '');
});

test('parsePaste without a header uses the sheet\'s column order', () => {
    const r = L.parsePaste('Internet\tFibrelink\t123\temail\t26 Dec 2026\t£300\t£25', null);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(plain(r.rows[0].bill), Object.assign(plain(r.rows[0].bill), { name: 'Internet', provider: 'Fibrelink', account: '123', end: '2026-12-26', amount: 25, every: 'month' }));
});

test('parsePaste keeps a pasted hint apart from the bill', () => {
    const r = L.parsePaste('Bill\tProvider\tWebsite\tPassword hint\tAnnual\nPet Insurance\tPaws\tpaws.example\tdog name\t200', null);
    assert.equal(r.rows[0].bill.link, 'https://paws.example');
    assert.equal(JSON.stringify(r.rows[0].bill).includes('dog name'), false);
    assert.deepEqual(plain(r.rows[0].hint), { key: 'paws', hint: 'dog name' });
});

test('parseDate reads UK dates only when real', () => {
    assert.equal(L.parseDate('31 December 2029'), '2029-12-31');
    assert.equal(L.parseDate('2 April 2027'), '2027-04-02');
    assert.equal(L.parseDate('02/04/2027'), '2027-04-02');
    assert.equal(L.parseDate('2027-04-02'), '2027-04-02');
    assert.equal(L.parseDate('31/02/2027'), null);
    assert.equal(L.parseDate('email'), null);
});

test('validLink keeps websites and app addresses, never scripts or plain http', () => {
    assert.equal(L.validLink('example.co.uk'), 'https://example.co.uk');
    assert.equal(L.validLink('https://example.com/login'), 'https://example.com/login');
    assert.equal(L.validLink('shortcuts://run-shortcut?name=X'), 'shortcuts://run-shortcut?name=X');
    assert.equal(L.validLink('javascript://alert(1)'), null);
    assert.equal(L.validLink('http://example.com'), null);
});

test('resolveBill: a bill on the Estate mortgage takes its payment and deal end', () => {
    const b = L.validBill({ name: 'Mortgage', amount: 1, every: 'year', end: '2026-01-01', estate: 'mort' });
    const r = L.resolveBill(b, ESTATE);
    assert.equal(r.amount, 2100);
    assert.equal(r.monthly, 2100);
    assert.equal(r.annual, 25200);
    assert.equal(r.end, '2030-12-31');
    assert.equal(r.provider, 'Northbank Mortgage');
    assert.equal(r.link, 'https://bank.example');
    // Gone from Estate (or closed): its own figures, flagged.
    const gone = L.resolveBill(L.validBill({ name: 'Mortgage', amount: 1200, every: 'month', estate: 'old' }), ESTATE);
    assert.equal(gone.missing, true);
    assert.equal(gone.monthly, 1200);
});

test('totals: per month, per year and per category', () => {
    const bills = L.resolveAll(L.validateState({ bills: [
        { name: 'Energy', amount: 1200, every: 'year' },
        { name: 'Cleaner', amount: 50, every: '2weeks' },
        { name: 'Water', amount: 50, every: 'month' },
        { name: 'Thing' },
    ] }), null);
    const t = L.totals(bills);
    assert.equal(t.count, 4);
    assert.equal(t.annual, 1200 + 1300 + 600);
    assert.ok(Math.abs(t.monthly - 3100 / 12) < 1e-9);
    assert.deepEqual(plain(t.categories.map(c => c.id)), ['utilities', 'services']);
    // Each category carries its yearly figure too, for the Yearly view.
    assert.deepEqual(plain(t.categories.map(c => c.annual)), [1800, 1300]);
});

test('mergeBills updates a bill with the same name and provider, keeping what the paste left blank', () => {
    const old = [L.validBill({ id: 'a', name: 'Energy', provider: 'Brightwell', account: 'BW001', username: 'me', amount: 100, every: 'month' })];
    const res = L.mergeBills(old, [L.validBill({ name: 'energy', provider: 'BRIGHTWELL', amount: 1500, every: 'year' }), L.validBill({ name: 'Water' })]);
    assert.equal(res.added, 1);
    assert.equal(res.updated, 1);
    assert.equal(res.bills[0].id, 'a');
    assert.equal(res.bills[0].username, 'me');
    assert.deepEqual([res.bills[0].amount, res.bills[0].every], [1500, 'year']);
});

test('validateState drops bills with no name and repairs duplicate ids', () => {
    const s = L.validateState({ bills: [{ id: 'x', name: 'A' }, { id: 'x', name: 'B' }, { name: '' }, null] });
    assert.equal(s.bills.length, 2);
    assert.notEqual(s.bills[0].id, s.bills[1].id);
    assert.equal(L.validateState({ accounts: [] }), null);
});

test('renewalAlerts: a contract end inside the window, not the Estate mortgage', () => {
    const bills = L.resolveAll({ bills: [
        { id: 'c', name: 'Contents Insurance', provider: 'Harbour', amount: 120, every: 'year', end: '2026-11-09' },
        { id: 'f', name: 'Energy', amount: 100, every: 'month', end: '2027-08-16' },
        { id: 'm', name: 'Mortgage', estate: 'mort' },
    ] }, ESTATE);
    const a = plain(L.renewalAlerts(bills, '2026-10-19'));
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, 'renewal');
    assert.equal(a[0].title, 'Contents Insurance contract ends in 21 days');
    assert.equal(a[0].stage, 'amber');
    assert.equal(plain(L.renewalAlerts(bills, '2026-11-05'))[0].stage, 'red');
});

test('cloud backup counts bills, so losing them holds the backup back', () => {
    const before = app.cloudBackupCounts({ lifeAdmin: { bills: [{}, {}] } });
    const now = app.cloudBackupCounts({});
    assert.equal(before.bills, 2);
    assert.match(app.cloudBackupShrink(before, now), /0 Cash Flow bills \(the last backup had 2\)/);
});

// ── Energy usage ──
// The shape of a usage sheet copied out of Numbers (made-up figures): two header rows, a row per month, meter numbers
// in side columns, a month in progress with only rates and a part cost, and empty months.
function usageSheet() {
    const rows = [
        '\t\tStanding Cost\tUnit Cost\t\t\tStanding Cost\tUnit Cost\t\t\t\t\t\t',
        '\tHistorical Electricity Usage kWh\t\t\tElectricity Cost\tHistorical Gas Usage kWh\t\t\tGas Cost\tGovernment Support\tAnnual Cost\t\tAverage Electricity Use\tAverage Gas Use',
        'January 2021\t\t\t\t\t\t\t\t\t\t\tJanuary\t300\t3,000',
    ];
    const elec = [300, 280, 260, 240, 220, 200, 200, 210, 230, 260, 290, 320];
    const gas = [3000, 2500, 2000, 1400, 700, 400, 250, 250, 500, 1300, 2200, 2900];
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    for (let y = 2023; y <= 2025; y++) for (let m = 0; m < 12; m++) {
        const k = y === 2025 ? 1.1 : 1;             // the last year uses 10% more
        const e = Math.round(elec[m] * k), g = Math.round(gas[m] * k);
        const side = y === 2024 && m === 0 ? 'MPAN\t1234567890123\t' : y === 2024 && m === 1 ? 'MPRN\t98765\t' : '\t\t';
        rows.push([names[m] + ' ' + y, e, '£0.50', '£0.25', '£' + Math.round(e * 0.25 + 15), g, '£0.30', '£0.06', '£' + Math.round(g * 0.06 + 9),
                   y === 2023 && m === 0 ? '£50' : '', '', side].join('\t'));
    }
    rows.push('January 2026\t\t£0.50\t£0.25\t£10\t\t£0.30\t£0.06\t£5\t\t\t\t\t');
    rows.push('February 2026' + '\t'.repeat(13));
    return rows.join('\n');
}

test('parseUsagePaste reads the usage sheet: columns from the headers, meters, the month in progress', () => {
    const p = L.parseUsagePaste(usageSheet());
    assert.equal(p.months.length, 37);
    assert.deepEqual(plain(p.meters), { mpan: '1234567890123', mprn: '98765' });
    assert.deepEqual(plain(p.months[0]), { month: '2023-01', elec: { kwh: 300, standing: 0.5, unit: 0.25, cost: 90 },
                                           gas: { kwh: 3000, standing: 0.3, unit: 0.06, cost: 189 }, support: 50 });
    assert.deepEqual(plain(p.months[36].elec), { kwh: null, standing: 0.5, unit: 0.25, cost: 10 });
});

test('usageStats: the rolling year, averages and the weighted forecast', () => {
    const u = L.mergeUsage(null, L.parseUsagePaste(usageSheet()));
    const st = L.usageStats(u);
    assert.equal(st.latest, '2025-12');                                   // January 2026 has no reading yet
    const y25 = u.months.filter(m => m.month.startsWith('2025'));
    assert.equal(st.annual, y25.reduce((s, m) => s + L.monthCost(m), 0));
    assert.equal(st.running.elec, y25.reduce((s, m) => s + m.elec.kwh, 0));
    assert.ok(Math.abs(st.vsLastYear.elec - 0.1) < 0.01);
    assert.ok(Math.abs(st.avg.elec[0] - (300 + 300 + 330) / 3) < 1e-9);
    // Default weight 2/3 on the last 12 months: January = 2/3 × 330 + 1/3 × 300.
    assert.equal(st.forecast.months[0].month, '2026-01');
    assert.ok(Math.abs(st.forecast.months[0].elec - 320) < 1e-9);
    const jan = 320 * 0.25 + 0.5 * 31 + st.forecast.months[0].gas * 0.06 + 0.3 * 31;
    assert.ok(Math.abs(st.forecast.months[0].cost - jan) < 1e-9);
    // 100% repeats the last year's use.
    const full = L.usageStats(Object.assign({}, u, { weight: 1 }));
    assert.equal(Math.round(full.forecast.kwh.elec), st.running.elec);
});

test('a month\'s cost: the one entered, else kWh × rate + standing × days, less support', () => {
    assert.equal(L.monthCost({ month: '2024-02', elec: { kwh: 100, unit: 0.25, standing: 0.5, cost: null }, gas: null, support: 10 }), 25 + 0.5 * 29 - 10);
    assert.equal(L.monthCost({ month: '2024-02', elec: { kwh: 100, unit: 0.25, standing: 0.5, cost: 40 }, gas: null, support: null }), 40);
    assert.equal(L.monthCost({ month: '2024-02', elec: { kwh: 100 }, gas: null }), null);
});

test('usage rides on the bill: validated, merged by month, kept when the bill is edited', () => {
    const b = L.validBill({ name: 'Energy', usage: { months: [{ month: '2025-13', elec: { kwh: 1 } }, { month: '2025-01', elec: { kwh: 5 } }], meters: { mpan: 'X' }, weight: 0.8 } });
    assert.deepEqual(plain(b.usage), { months: [{ month: '2025-01', elec: { kwh: 5, standing: null, unit: null, cost: null }, gas: null, support: null }], meters: { mpan: 'X' }, weight: 0.8 });
    const merged = L.mergeUsage(b.usage, { months: [{ month: '2025-01', elec: { kwh: 7 } }, { month: '2025-02', gas: { kwh: 9 } }], meters: { mprn: 'Y' } });
    assert.deepEqual(plain(merged.months.map(m => m.month)), ['2025-01', '2025-02']);
    assert.equal(merged.months[0].elec.kwh, 7);
    assert.deepEqual(plain(merged.meters), { mpan: 'X', mprn: 'Y' });
    assert.equal(merged.weight, 0.8);
    assert.equal(L.isEnergyBill({ name: 'Energy' }), true);
    assert.equal(L.isEnergyBill({ name: 'Water' }), false);
});

test('cloud backup counts energy usage months', () => {
    const c = app.cloudBackupCounts({ lifeAdmin: { bills: [{ usage: { months: [{}, {}, {}] } }, {}] } });
    assert.equal(c.usage, 3);
});

test('gas in m³ converts to kWh the way suppliers bill it: m³ × 1.02264 × CV ÷ 3.6', () => {
    assert.ok(Math.abs(L.m3ToKwh(247, 39.6) - 247 * 1.02264 * 39.6 / 3.6) < 1e-9);
    const u = L.validUsage({ months: [{ month: '2026-09', gas: { m3: 100, cv: 39.2 } }, { month: '2026-10', gas: { m3: 100 } }] });
    assert.equal(u.months[0].gas.kwh, Math.round(100 * 1.02264 * 39.2 / 3.6 * 10) / 10);
    assert.equal(u.months[0].gas.m3, 100);
    assert.equal(u.months[1].gas.kwh, Math.round(100 * 1.02264 * 39.5 / 3.6 * 10) / 10);   // no CV: the typical 39.5
    // A sheet with a gas m³ column instead of kWh.
    const p = L.parseUsagePaste('Month\tElectricity usage kWh\tElectricity cost\tGas usage m3\tCalorific value\tGas cost\nMarch 2026\t250\t£70\t120\t39.1\t£60');
    assert.equal(p.months[0].gas.m3, 120);
    assert.equal(p.months[0].gas.cv, 39.1);
    assert.ok(Math.abs(p.months[0].gas.kwh - 120 * 1.02264 * 39.1 / 3.6) < 0.1);
});

test('forecast rates: the tariff entered wins, gaps fall back to the latest month, and the sum is shown', () => {
    const u = L.mergeUsage(null, L.parseUsagePaste(usageSheet()));
    const withTariff = L.validUsage(Object.assign({}, u, { tariff: { elec: { unit: 0.30, standing: 0.60 }, gas: { unit: null, standing: null } } }));
    assert.deepEqual(plain(withTariff.tariff), { elec: { unit: 0.3, standing: 0.6 } });
    const st = L.usageStats(withTariff), fc = st.forecast;
    assert.equal(st.rates.elec.from, 'tariff');
    assert.equal(st.rates.gas.unit, 0.06);                                 // the latest month's
    assert.equal(fc.days, 365);
    const e = fc.parts.elec, g = fc.parts.gas;
    assert.ok(Math.abs(e.energy - fc.kwh.elec * 0.3) < 1e-9);
    assert.ok(Math.abs(e.standingCost - 365 * 0.6) < 1e-9);
    assert.ok(Math.abs(fc.cost - (e.energy + e.standingCost + g.energy + g.standingCost)) < 1e-6);
    // Pasting more months keeps the tariff.
    assert.deepEqual(plain(L.mergeUsage(withTariff, { months: [], meters: {} }).tariff), { elec: { unit: 0.3, standing: 0.6 } });
});

test('pasted rates keep their decimals and read pence', () => {
    const p = L.parseUsagePaste('Month,Electricity usage kWh,Electricity standing £/day,Electricity unit rate £/kWh,Electricity cost £,Gas usage kWh,Gas standing £/day,Gas unit rate £/kWh,Gas cost £\n' +
                                'March 2026,300,0.43762,22.45p,80,2000,0.30184,0.05476,120');
    assert.deepEqual(plain(p.months[0].elec), { kwh: 300, standing: 0.43762, unit: 0.2245, cost: 80 });
    assert.equal(p.months[0].gas.unit, 0.05476);
});

test('forecast adjustment scales one fuel and survives a paste', () => {
    const u = L.mergeUsage(null, L.parseUsagePaste(usageSheet()));
    const base = L.usageStats(u).forecast;
    const adj = L.validUsage(Object.assign({}, u, { adjust: { elec: -0.1, gas: 0 } }));
    assert.deepEqual(plain(adj.adjust), { elec: -0.1 });
    const fc = L.usageStats(adj).forecast;
    assert.ok(Math.abs(fc.kwh.elec - base.kwh.elec * 0.9) < 1e-6);
    assert.ok(Math.abs(fc.kwh.gas - base.kwh.gas) < 1e-6);
    assert.ok(fc.cost < base.cost);
    assert.deepEqual(plain(L.mergeUsage(adj, { months: [], meters: {} }).adjust), { elec: -0.1 });
    assert.equal(L.validUsage(Object.assign({}, u, { adjust: { elec: 3 } })).adjust, undefined);
});

test('Mortgage and Childcare: guessed from the name, and older bills move over', () => {
    assert.equal(L.guessCategory('Mortgage'), 'mortgage');
    assert.equal(L.guessCategory('Nursery fees'), 'childcare');
    assert.equal(L.guessCategory('Council Tax'), 'home');
    const s = L.validateState({ bills: [{ name: 'Mortgage', category: 'home' }, { name: 'Home loan', category: 'home', estate: 'acc1' },
                                        { name: 'Nursery', category: 'services' }, { name: 'Council Tax', category: 'home' }] });
    assert.deepEqual(plain(s.bills.map(b => b.category)), ['mortgage', 'mortgage', 'childcare', 'home']);
});

test('Subscriptions: guessed from the name; older bills move over once, then a category you pick stays', () => {
    for (const n of ['Mobile phone contract', 'Gym', 'Netflix', 'Amazon Prime', 'Ring', 'RHS magazine', 'Spotify']) assert.equal(L.guessCategory(n), 'subscriptions', n);
    assert.equal(L.guessCategory('Broadband'), 'utilities');
    assert.equal(L.guessCategory('Mobile phone insurance'), 'insurance');
    assert.equal(L.guessCategory('Engineering course'), 'other');
    const old = L.validateState({ v: 1, bills: [{ name: 'Gym', category: 'services' }, { name: 'Mobile', category: 'utilities' },
                                               { name: 'Netflix', category: 'other' }, { name: 'Energy', category: 'utilities' }] });
    assert.equal(old.v, 2);
    assert.deepEqual(plain(old.bills.map(b => b.category)), ['subscriptions', 'subscriptions', 'subscriptions', 'utilities']);
    // A pasted list under a 'Subscriptions' heading: every name in it is a subscription, the heading is not a bill.
    const r = L.parsePaste('Subscriptions\nNetflix\nRing\nWhich\nDiscovery +\nStrava\nWindow cleaner', null);
    assert.deepEqual(plain(r.rows.map(x => [x.bill.name, x.bill.category])), [['Netflix', 'subscriptions'], ['Ring', 'subscriptions'],
        ['Which', 'subscriptions'], ['Discovery +', 'subscriptions'], ['Strava', 'subscriptions'], ['Window cleaner', 'subscriptions']]);
    assert.equal(L.guessCategory('Discovery +'), 'subscriptions');
    assert.equal(L.guessCategory('Boiler cover'), 'insurance');
    const kept = L.validateState({ v: 2, bills: [{ name: 'Gym', category: 'services' }] });
    assert.equal(kept.bills[0].category, 'services');
});

test('an energy bill can take its cost from the usage page', () => {
    const u = L.mergeUsage(null, L.parseUsagePaste(usageSheet()));
    const st = L.usageStats(u);
    const base = { name: 'Energy', amount: 150, every: 'month', usage: u };
    const last = L.resolveBill(L.validBill(Object.assign({ costFrom: 'last12' }, base)), null);
    assert.equal(last.formula, 'last12');
    // Last 12 months' kWh priced at today's rates, not what those months cost.
    const r = st.rates, want = st.running.elec * r.elec.unit + st.running.gas * r.gas.unit + (r.elec.standing + r.gas.standing) * st.forecast.days;
    assert.ok(Math.abs(st.current.cost - want) < 1e-6);
    assert.equal(last.annual, Math.round(want * 100) / 100);
    const fc = L.resolveBill(L.validBill(Object.assign({ costFrom: 'forecast' }, base)), null);
    assert.equal(fc.annual, Math.round(st.forecast.cost * 100) / 100);
    // Not enough usage yet: the typed amount stands.
    const thin = L.resolveBill(L.validBill({ name: 'Energy', amount: 150, every: 'month', costFrom: 'last12', usage: { months: u.months.slice(0, 3) } }), null);
    assert.equal(thin.formula, null);
    assert.equal(thin.annual, 1800);
    assert.equal(L.validBill({ name: 'Energy', costFrom: 'nonsense' }).costFrom, null);
});

test('a bill switched to split counts Fergus\'s share against him; the rest he pays in full', () => {
    const bills = L.resolveAll(L.validateState({ myShare: 0.6, bills: [
        { name: 'Mortgage', amount: 1000, every: 'month', split: true },
        { name: 'Netflix', amount: 50, every: 'month' },
        { name: 'Odd', amount: 10, every: 'month', split: 'yes' }] }), null);
    assert.deepEqual([...bills.map(b => b.split)], [true, false, false]);
    const t = L.totals(bills, 0.6);
    assert.equal(Math.round(t.monthly), 1060);
    assert.equal(Math.round(t.mine.monthly), 660);   // 600 + 50 + 10
    assert.equal(Math.round(t.wife.monthly), 400);
    assert.equal(t.split, true);
    assert.equal(L.totals(bills.filter(b => !b.split)).split, false);
    assert.equal(L.shareOf(L.validateState({ bills: [], myShare: 0.6 })), 0.6);
    assert.equal(L.shareOf(L.validateState({ bills: [], myShare: 2 })), 0.5);   // out of range: back to half
    assert.deepEqual([0, 1].map(v => L.shareOf(L.validateState({ bills: [], myShare: v }))), [0, 1]);   // she isn't working / he isn't
    assert.equal(Math.round(L.totals(bills, 1).mine.monthly), 1060);
    assert.equal(L.totals(bills).share, 0.5);
});

test('cashFlow: take-home less his part of the bills, the bonus only when switched on', () => {
    const t = { mine: { monthly: 1000, annual: 12000 } };
    const th = { monthly: 5000, bonus: { year: 2025, net: 12000 } };
    let f = L.cashFlow(t, th, 'month', false);
    assert.equal(f.pay, 5000); assert.equal(f.bonus, 1000); assert.equal(f.inflow, 5000); assert.equal(f.left, 4000);
    f = L.cashFlow(t, th, 'month', true);
    assert.equal(f.inflow, 6000); assert.equal(f.left, 5000);
    f = L.cashFlow(t, th, 'year', true);
    assert.equal(f.pay, 60000); assert.equal(f.bonus, 12000); assert.equal(f.left, 60000);
    // No bonus known yet: the switch changes nothing. No pay: nothing left to show.
    assert.equal(L.cashFlow(t, { monthly: 5000, bonus: null }, 'month', true).left, 4000);
    f = L.cashFlow(t, null, 'month', true);
    assert.equal(f.inflow, null); assert.equal(f.left, null); assert.equal(f.out, 1000);
});
