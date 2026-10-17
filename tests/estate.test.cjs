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

test('buildSeries: one point per month, from the month\'s last entry', () => {
    const state = plain(E.validateState({ v: 1, accounts: [{ id: 'bank', name: 'Bank', group: 'current' }], snapshots: [
        { date: '2024-01-05', values: { bank: 100 } },
        { date: '2024-01-20', values: { bank: 150 } },
        { date: '2024-02-18', values: { bank: 175 } },
    ] }));
    const s = plain(E.buildSeries(state));
    assert.deepEqual(s.map(p => [p.month, p.total]), [['2024-01', 150], ['2024-02', 175]]);
});

test('changeSources: investment growth is the change less money paid in; the house is its own line', () => {
    const accounts = [
        { id: 'isa', group: 'investments', appLinks: ['acct:ISA'] },
        { id: 'house', group: 'property', share: 0.5, asset: { bought: '2020-01-01', price: 1, valuations: [] } },
        { id: 'bank', group: 'current', appLinks: [] },
        { id: 'rsu', group: 'investments', appLinks: ['restricted:C:Unvested'] },
    ];
    const base = { date: '2024-01-15', total: 0, values: { isa: 10000, house: 300000, bank: 2000, rsu: 1000 } };
    const latest = { date: '2024-02-15', values: { isa: 11500, house: 302000, bank: 1500, rsu: 1200 } };
    base.total = 10000 + 150000 + 2000 + 1000;
    latest.total = 11500 + 151000 + 1500 + 1200;
    const appValues = [
        { key: 'acct:ISA', value: 11500, ledgerFrom: '2019-04-06', flows: [
            { date: '2024-01-15', amount: 999 },    // on the base date: already in the base value
            { date: '2024-02-01', amount: 1000 },   // paid in during the period
        ] },
        { key: 'restricted:C:Unvested', value: 1200 },   // no ledger
    ];
    const s = plain(E.changeSources(base, latest, accounts, appValues));
    assert.deepEqual(s, { total: 2200, markets: 500, assets: 1000, other: 700, linked: 1 });   // other = bank −500 + shares +200 + the £1,000 paid in
});

test('changeSources: unknown when a linked account held money before its ledger starts', () => {
    const accounts = [{ id: 'isa', group: 'investments', appLinks: ['acct:ISA'] }];
    const base = { date: '2018-01-15', total: 5000, values: { isa: 5000 } };
    const latest = { date: '2024-01-15', total: 9000, values: { isa: 9000 } };
    const s = plain(E.changeSources(base, latest, accounts, [{ key: 'acct:ISA', value: 9000, ledgerFrom: '2019-04-06', flows: [] }]));
    assert.equal(s.markets, null);
    assert.equal(s.other, null);
    assert.equal(s.total, 4000);
});
