// Estate (docs/balances.js): balances over time, totals, and the house, car and mortgage formulas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { estate: E } = loadApp();
// Objects made inside the sandbox have its own prototypes; compare them as plain data.
const plain = x => JSON.parse(JSON.stringify(x));

test('parseAmount reads the spreadsheet\'s text amounts', () => {
    assert.equal(E.parseAmount('Â£\t1,234.56'), 1234.56);
    assert.equal(E.parseAmount('Â£\t(1,234.00)'), -1234);   // brackets = negative
    assert.equal(E.parseAmount('−50'), -50);                  // minus sign, not hyphen
    assert.equal(E.parseAmount('-'), 0);                      // accounting zero
    assert.equal(E.parseAmount(''), null);
    assert.equal(E.parseAmount('n/a'), null);
    assert.equal(E.parseAmount(42), 42);
});

test('resolveTimeline: a full snapshot resets, a partial one only changes what it holds', () => {
    const t = plain(E.resolveTimeline([
        { date: '2024-01-15', values: { a: 1, b: 2 } },
        { date: '2024-02-15', partial: true, values: { b: 3 } },
        { date: '2024-03-15', values: { a: 5 } },
    ]));
    assert.deepEqual(t.map(r => r.values), [{ a: 1, b: 2 }, { a: 1, b: 3 }, { a: 5 }]);
    assert.equal(t[1].asOf.a, '2024-01-15');
    assert.equal(t[1].asOf.b, '2024-02-15');
    assert.equal(t[2].since.b, undefined);   // b left in the full reset
});

test('resolveTimeline: repeating last month\'s figure keeps its original "since" date', () => {
    const t = plain(E.resolveTimeline([
        { date: '2024-01-15', values: { m: -100 } },
        { date: '2024-02-15', values: { m: -100 } },
    ]));
    assert.equal(t[1].since.m, '2024-01-15');
    assert.equal(t[1].asOf.m, '2024-02-15');
});

test('totalsFor: shares, debts, liquid and the combined cash card', () => {
    const accounts = [
        { id: 'house', group: 'property', share: 0.5 },
        { id: 'amex', group: 'cards' },
        { id: 'hsbc', group: 'current' },
    ];
    const t = plain(E.totalsFor({ values: { house: 400000, amex: -1000, hsbc: 2000 } }, E.indexAccounts(accounts)));
    assert.equal(t.total, 201000);
    assert.equal(t.liquid, 1000);          // the house isn't liquid
    assert.equal(t.groups.cash, 1000);     // current + cards
    assert.equal(t.groups.property, 200000);
});

test('workDown: interest charged daily, the payment taken off on each payment day after "from"', () => {
    const loan = { payDay: 15, deals: [{ start: '2024-01-15', end: '2050-01-15', rate: 3.65, payment: 1000 }], balances: [] };
    // 3.65% / 365 = 0.01% a day. 15 Feb: 100,000 × 1.0001^31 − 1,000. 20 Mar: that × 1.0001^34 − 1,000 (15 Mar) …
    const feb = 100000 * Math.pow(1.0001, 31) - 1000;
    const mar = (feb * Math.pow(1.0001, 29) - 1000) * Math.pow(1.0001, 5);
    assert.equal(E.workDown(loan, 100000, '2024-01-15', '2024-03-20'), Math.round(mar * 100) / 100);
    // Between payments the balance grows by the day's interest.
    assert.equal(E.workDown(loan, 100000, '2024-01-15', '2024-01-20'), Math.round(100000 * Math.pow(1.0001, 5) * 100) / 100);
    assert.equal(E.workDown(loan, 500, '2024-01-15', '2024-12-31'), 0);   // never below zero
    // A payment day past the month's end falls on its last day.
    const eom = Object.assign({}, loan, { payDay: 31 });
    assert.equal(E.workDown(eom, 100000, '2024-02-01', '2024-02-29'), Math.round((100000 * Math.pow(1.0001, 28) - 1000) * 100) / 100);
});

test('workDown: each deal\'s rate and payment from its start; a deal with no rate gives null', () => {
    const loan = { payDay: 1, deals: [{ start: '2024-01-01', rate: 0, payment: 1000 }, { start: '2024-03-01', rate: 3.65, payment: 500 }], balances: [] };
    // 1 Feb: £1,000 at 0%. 1 Mar, the new deal's first day: its £500. Then a day at 0.01%.
    assert.equal(E.workDown(loan, 10000, '2024-01-01', '2024-03-02'), Math.round(8500 * 1.0001 * 100) / 100);
    const blank = { payDay: 1, deals: [{ start: '2024-01-01', rate: null, payment: null }], balances: [] };
    assert.equal(E.workDown(blank, 10000, '2024-01-01', '2024-03-02'), null);
});

test('grow: compounds yearly', () => {
    const v = E.grow(100000, 5, '2020-01-01', '2022-01-01');
    assert.ok(Math.abs(v - 110250) < 50, `got ${v}`);
    assert.equal(E.grow(100000, 5, '2022-01-01', '2020-01-01'), 100000);   // no growth backwards
});

test('loanOwed: worked down from each known balance, fitted to meet the next one', () => {
    const loan = E.validLoan({ drawn: '2021-03-17', amount: 652999, payDay: 31,
        deals: [{ start: '2021-03-17' }, { start: '2024-12-31', end: '2029-12-31', rate: 3.8, payment: 2782.18 }],
        balances: [{ date: '2024-12-31', value: 608678 }, { date: '2026-10-20', value: 589241.54 }] });
    assert.equal(E.loanOwed(loan, '2021-03-16'), null);
    assert.equal(E.loanOwed(loan, '2021-03-17'), 652999);
    // The first deal has no rate: a straight line to the next balance.
    const half = E.loanOwed(loan, '2023-02-07');
    assert.ok(Math.abs(half - (652999 + 608678) / 2) < 400, `got ${half}`);
    // Every balance the lender gave is met exactly.
    assert.equal(E.loanOwed(loan, '2024-12-31'), 608678);
    assert.equal(E.loanOwed(loan, '2026-10-20'), 589241.54);
    // In between, the deal's own steps: the balance falls on each payment day.
    assert.ok(E.loanOwed(loan, '2025-06-30') < E.loanOwed(loan, '2025-06-29'));
    // After the last balance: daily interest, then the payment on the 31st (30 Oct in a 30-day month… October has 31).
    const d = 0.038 / 365;
    assert.equal(E.loanOwed(loan, '2026-10-30'), Math.round(589241.54 * Math.pow(1 + d, 10) * 100) / 100);
    assert.equal(E.loanOwed(loan, '2026-10-31'), Math.round((589241.54 * Math.pow(1 + d, 11) - 2782.18) * 100) / 100);
});

test('validLoan: reads the earlier shape (remortgage points and the current deal) into deals and balances', () => {
    const l = plain(E.validLoan({ drawn: '2015-01-01', amount: 200000, points: [{ date: '2020-01-01', value: 150000 }],
                                  start: '2022-01-15', balance: 120000, rate: 6, payment: 1000, end: '2050-01-15' }));
    assert.deepEqual(l, { drawn: '2015-01-01', amount: 200000, payDay: 15,
        deals: [{ start: '2015-01-01', end: null, rate: null, payment: null }, { start: '2020-01-01', end: null, rate: null, payment: null },
                { start: '2022-01-15', end: '2050-01-15', rate: 6, payment: 1000 }],
        balances: [{ date: '2020-01-01', value: 150000 }, { date: '2022-01-15', value: 120000 }] });
    assert.equal(E.validLoan({}), null);
    // A remortgage point on the current deal's start is that deal, not another one.
    const same = E.validLoan({ drawn: '2021-03-17', amount: 1, points: [{ date: '2024-12-31', value: 9 }], start: '2024-12-31', balance: 9, rate: 3.8, payment: 2 });
    assert.deepEqual(plain(same.deals.map(d => d.start)), ['2021-03-17', '2024-12-31']);
    // A sheet rate saved as a fraction is fixed before the shape is read.
    const s = E.validateState({ accounts: [{ id: 'm', name: 'Mortgage', group: 'property', debt: true, rate: 0.038,
        loan: { start: '2024-12-31', balance: 600000, rate: 0.038, payment: 2800 } }], snapshots: [] });
    assert.equal(s.accounts[0].loan.deals[0].rate, 3.8);
});

test('assetValue: straight line between valuations, then the yearly rate', () => {
    const car = { bought: '2020-01-01', price: 300000, rate: 0, valuations: [{ date: '2022-01-01', value: 400000 }] };
    assert.equal(E.assetValue(car, '2019-12-31'), null);
    assert.equal(E.assetValue(car, '2020-01-01'), 300000);
    assert.equal(E.assetValue(car, '2021-01-01'), 350068.4);  // 366 of 731 days
    assert.equal(E.assetValue(car, '2025-06-01'), 400000);    // 0% after the last valuation
});

test('liveLinked: an account waits until every linked value is priced', () => {
    const accounts = [
        { id: 'isa', appLinks: ['acct:ISA'] },
        { id: 'both', appLinks: ['acct:ISA', 'acct:SIPP'] },
        { id: 'shut', appLinks: ['acct:ISA'], closed: true },
    ];
    const live = plain(E.liveLinked(accounts, [
        { key: 'acct:ISA', value: 1000.004 },
        { key: 'acct:SIPP', value: 50, ready: false },
    ]));
    assert.deepEqual(live, { isa: 1000 });
});

test('applyLinked: saves only the balances that changed, as a partial entry for today', () => {
    const state = plain(E.validateState({ v: 1, accounts: [
        { id: 'isa', name: 'ISA', group: 'investments', appLinks: ['acct:ISA'] },
        { id: 'bank', name: 'Bank', group: 'current' },
    ], snapshots: [{ date: '2024-01-15', values: { isa: 900, bank: 2000 } }] }));
    const next = plain(E.applyLinked(state, [{ key: 'acct:ISA', value: 1000 }], '2024-02-01'));
    assert.deepEqual(next.snapshots.at(-1), { date: '2024-02-01', partial: true, values: { isa: 1000 } });
    assert.equal(E.applyLinked(next, [{ key: 'acct:ISA', value: 1000 }], '2024-02-02'), null);   // nothing changed
});

test('paydayOf: the 20th, or the working day before a weekend or Easter bank holiday', () => {
    assert.equal(E.paydayOf('2026-10'), '2026-10-20');   // Tuesday
    assert.equal(E.paydayOf('2026-06'), '2026-06-19');   // Saturday → Friday
    assert.equal(E.paydayOf('2026-09'), '2026-09-18');   // Sunday → Friday
    assert.equal(E.paydayOf('2025-04'), '2025-04-17');   // Easter Sunday, then Saturday, then Good Friday → Thursday
    assert.equal(E.paydayOf('2014-04'), '2014-04-17');   // Easter Sunday 2014 too
    assert.equal(E.paydayOf('2020-04'), '2020-04-20');   // Monday after Easter Monday
});

test('buildSeries: a finished month takes its payday entry, else the next one, else its last', () => {
    const state = plain(E.validateState({ v: 1, accounts: [{ id: 'bank', name: 'Bank', group: 'current' }], snapshots: [
        { date: '2026-06-05', values: { bank: 100 } },
        { date: '2026-06-19', values: { bank: 150 } },   // payday (the 20th is a Saturday)
        { date: '2026-06-27', values: { bank: 120 } },
        { date: '2026-08-10', values: { bank: 90 } },
        { date: '2026-08-22', values: { bank: 200 } },   // missed payday (the 20th), next entry
        { date: '2026-08-28', values: { bank: 180 } },
        { date: '2026-09-16', values: { bank: 170 } },   // nothing from payday on: the month's last
        { date: '2026-10-20', values: { bank: 300 } },
        { date: '2026-10-25', values: { bank: 260 } },   // latest month: the latest entry
    ] }));
    const s = plain(E.buildSeries(state));
    assert.deepEqual(s.map(p => [p.month, p.date, p.total]), [
        ['2026-06', '2026-06-19', 150], ['2026-08', '2026-08-22', 200], ['2026-09', '2026-09-16', 170], ['2026-10', '2026-10-25', 260]]);
});

test('chart C&C: only Current and Credit cards, in the series and the breakdown', () => {
    const state = plain(E.validateState({ v: 1, accounts: [
        { id: 'bank', name: 'Bank', group: 'current' },
        { id: 'amex', name: 'Amex', group: 'cards' },
        { id: 'isa', name: 'ISA', group: 'investments' },
    ], snapshots: [
        { date: '2024-01-31', values: { bank: 2000, amex: -500, isa: 50000 } },
        { date: '2024-02-28', values: { bank: 2600, amex: -800, isa: 52000 } },
    ] }));
    const s = plain(E.buildSeries(state));
    assert.deepEqual(s.map(p => p.cash), [1500, 1800]);
    assert.deepEqual(s.map(p => p.liquid), [51500, 53800]);
    const bd = plain(E.breakdown(s[0], s[1], state.accounts, 'cash'));
    assert.deepEqual(bd.rows.map(g => g.id), ['cash']);   // Investments left out
    assert.equal(bd.total, 300);
    assert.equal(E.groupValue(s[1], 'investments', state.accounts, 'cash'), 0);
    assert.equal(E.groupValue(s[1], 'a:amex', state.accounts, 'cash'), -800);
});

test('chart y-axis: round steps and labels', () => {
    assert.equal(E.niceStep(8700), 10000);
    assert.equal(E.niceStep(2200), 2500);
    assert.equal(E.niceStep(140), 200);
    assert.equal(E.axisLabel(250000, 10000, 260000), '£250k');
    assert.equal(E.axisLabel(237500, 2500, 260000), '£237.5k');
    assert.equal(E.axisLabel(1250000, 250000, 1500000), '£1.25m');
    assert.equal(E.axisLabel(-500, 500, 1000), '−£0.5k');
    assert.equal(E.axisLabel(0, 500, 1000), '£0');
});

test('chart x-axis: the first month with its year, then a few round months', () => {
    const mi = (y, m) => y * 12 + m - 1;
    const labels = (a, b) => plain(E.monthTicks(a, b)).map(t => t.label);
    assert.deepEqual(labels(mi(2024, 10), mi(2025, 10)), ['Oct 2024', '2025', 'Apr', 'Jul', 'Oct']);
    assert.deepEqual(labels(mi(2022, 10), mi(2025, 10)), ['Oct 2022', '2024', '2025']);   // 2023 too close to fit
    assert.deepEqual(labels(mi(2024, 9), mi(2026, 10)), ['Sep 2024', 'Jul', '2026', 'Jul']);   // 3Y with 2 years of data
    assert.ok(labels(mi(2015, 1), mi(2025, 10)).length <= 5);
});

test('validLink: websites and app addresses only', () => {
    assert.equal(E.validLink(' https://www.hsbc.co.uk/ '), 'https://www.hsbc.co.uk/');
    assert.equal(E.validLink('shortcuts://run-shortcut?name=HSBC'), 'shortcuts://run-shortcut?name=HSBC');
    assert.equal(E.validLink('javascript://%0aalert(1)'), null);
    assert.equal(E.validLink('JavaScript:alert(1)'), null);
    assert.equal(E.validLink('data://text/html,x'), null);
    assert.equal(E.validLink('http://example.com'), null);   // not secure
    assert.equal(E.validLink('www.hsbc.co.uk'), null);
    assert.equal(plain(E.validateState({ v: 1, accounts: [{ id: 'a', name: 'A', group: 'current', link: 'javascript:x' }], snapshots: [] })).accounts[0].link, null);
});

test('fixed-term saving: grows at its AER from the start, holds at the end until a later balance', () => {
    const term = { start: '2025-01-01', end: '2027-01-01', rate: 5, amount: 10000 };
    assert.equal(E.termValue(term, '2024-12-31'), null);
    assert.equal(E.termValue(term, '2025-01-01'), 10000);
    assert.ok(Math.abs(E.termValue(term, '2026-01-01') - 10500) < 1);    // one year at 5% AER
    assert.ok(Math.abs(E.termValue(term, '2028-06-01') - 11025) < 2);    // held at the end value
    const state = plain(E.validateState({ v: 1, accounts: [{ id: 'fb', name: 'Fixed bond', group: 'savings', term }], snapshots: [
        { date: '2025-06-20', values: { fb: 1 } },          // typed while the term runs: ignored
        { date: '2027-03-20', partial: true, values: { fb: 11100 } },   // entered after the end: used
    ] }));
    const s = plain(E.buildSeries(state));
    assert.ok(Math.abs(s[0].total - E.termValue(term, '2025-06-20')) < 0.01);
    assert.equal(s[1].total, 11100);
    // Only savings accounts keep a term.
    assert.equal(plain(E.validateState({ v: 1, accounts: [{ id: 'c', name: 'C', group: 'current', term }], snapshots: [] })).accounts[0].term, null);
});

test('old Monzo links are dropped, so those accounts go back to being typed in', () => {
    const state = plain(E.validateState({ v: 1, accounts: [
        { id: 'm', name: 'Monzo', group: 'current', appLinks: ['monzo:acc_1'] },
        { id: 'i', name: 'ISA', group: 'savings', appLinks: ['acct:ISA', 'monzo:pot_1'] },
    ], snapshots: [] }));
    assert.deepEqual(state.accounts.map(a => [a.group, a.appLinks]), [['current', []], ['investments', ['acct:ISA']]]);
});

test('perMonth: change between two points over the time between their dates', () => {
    const a = { month: '2025-10', date: '2025-10-20', cash: 5000 };
    const b = { month: '2026-10', date: '2026-10-20', cash: 2600 };
    assert.equal(Math.round(E.perMonth(a, b, 'cash')), -200);          // −£2,400 over 12 months
    // A latest point taken before payday counts the part-month, not a whole one.
    const early = { month: '2026-10', date: '2026-10-05', cash: 2600 };
    assert.ok(E.perMonth(a, early, 'cash') < -200);
    // One month apart: that is the change itself, so none.
    assert.equal(E.perMonth({ month: '2026-09', date: '2026-09-19', cash: 1 }, b, 'cash'), null);
    assert.equal(E.perMonth(null, b, 'cash'), null);
});
