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

test('payDown: a month\'s interest then the payment, on each payment day after "from"', () => {
    const loan = { rate: 6, payment: 1000, start: '2024-01-15', end: '2050-01-15' };
    // 15 Feb: 100,000 × 1.005 − 1,000 = 99,500. 15 Mar: 99,500 × 1.005 − 1,000 = 98,997.50.
    assert.equal(E.payDown(-100000, loan, '2024-01-15', '2024-03-20'), -98997.5);
    assert.equal(E.payDown(-100000, loan, '2024-01-15', '2024-01-20'), -100000);
    assert.ok(E.payDown(-500, loan, '2024-01-15', '2024-12-31') === 0);   // never below zero (-0 counts as 0)
});

test('grow: compounds yearly', () => {
    const v = E.grow(100000, 5, '2020-01-01', '2022-01-01');
    assert.ok(Math.abs(v - 110250) < 50, `got ${v}`);
    assert.equal(E.grow(100000, 5, '2022-01-01', '2020-01-01'), 100000);   // no growth backwards
});

test('loanOwed: straight line between earlier points, then worked down from the current deal', () => {
    const loan = { drawn: '2015-01-01', amount: 200000, points: [{ date: '2020-01-01', value: 150000 }],
                   start: '2022-01-15', balance: 120000, rate: 6, payment: 1000, end: '2050-01-15' };
    assert.equal(E.loanOwed(loan, '2014-12-31'), null);
    assert.equal(E.loanOwed(loan, '2015-01-01'), 200000);
    assert.equal(E.loanOwed(loan, '2017-07-02'), 175000);    // halfway from 2015 to 2020
    assert.equal(E.loanOwed(loan, '2020-01-01'), 150000);
    assert.equal(E.loanOwed(loan, '2022-02-20'), 119600);    // 120,000 × 1.005 − 1,000
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

test('chart x-axis: a few round months', () => {
    const mi = (y, m) => y * 12 + m - 1;
    const labels = (a, b) => plain(E.monthTicks(a, b)).map(t => t.label);
    assert.deepEqual(labels(mi(2024, 10), mi(2025, 10)), ['Oct', '2025', 'Apr', 'Jul', 'Oct']);
    assert.deepEqual(labels(mi(2022, 10), mi(2025, 10)), ['2023', '2024', '2025']);
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
