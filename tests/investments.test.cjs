// Investments (docs/index.html): ledger categories, money in and out, money-weighted return and prices in pounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const DAY = 864e5;

test('categoriseTransaction: Hargreaves Lansdown references', () => {
    const c = app.categoriseTransaction;
    assert.equal(c({ reference: 'FPC', description: 'ISA receipt' }), 'subscription');
    assert.equal(c({ reference: 'B123', yahooTicker: 'VWRL.L' }), 'buy');
    assert.equal(c({ reference: 'S456', yahooTicker: 'VWRL.L' }), 'sell');
    assert.equal(c({ reference: 'MANAGE FEE' }), 'fee');
    assert.equal(c({ reference: 'INTEREST' }), 'interest');
    assert.equal(c({ reference: 'FPD', description: 'Payment to client bank account' }), 'transfer');
    assert.equal(c({ reference: 'RSU VEST', yahooTicker: 'C' }), 'transfer_in');
    // "Managers" in a fund name is not a fee.
    assert.equal(c({ reference: 'B789', yahooTicker: 'X.L', description: 'Virgin Direct Unit Trust Managers' }), 'buy');
});

test('externalFlowsFromLedger: money in is positive, internal transfers are left out', () => {
    const d = s => new Date(s + 'T00:00:00Z');
    const flows = plain(app.externalFlowsFromLedger([
        { parsedDate: d('2024-03-01'), category: 'buy', value: -500 },
        { parsedDate: d('2024-01-01'), category: 'subscription', value: 1000 },
        { parsedDate: d('2024-02-01'), category: 'transfer_out', value: 200 },
        { parsedDate: d('2024-02-15'), category: 'transfer_in', value: -300 },
        { parsedDate: d('2024-02-20'), category: 'transfer_in', value: 999, internalTransfer: true },
    ]));
    assert.deepEqual(flows, [
        { date: '2024-01-01', amount: 1000 },
        { date: '2024-02-01', amount: -200 },
        { date: '2024-02-15', amount: 300 },
    ]);
});

test('xirrAnnual: £1,000 in, £1,100 out a year later is 10%', () => {
    const t0 = Date.UTC(2023, 0, 1);
    const r = app.xirrAnnual([{ t: t0, amount: -1000 }, { t: t0 + 365.25 * DAY, amount: 1100 }]);
    assert.ok(Math.abs(r - 0.10) < 1e-6, `got ${r}`);
    assert.equal(app.xirrAnnual([{ t: t0, amount: 1 }, { t: t0 + DAY, amount: 2 }]), null);   // no money in
});

test('pxToGBP: pence, dollars, and refusing an unknown currency', () => {
    assert.equal(app.pxToGBP('VWRL.L', 10000, 1.25, {}), 100);              // LSE line quoted in pence
    assert.equal(app.pxToGBP('C', 50, 1.25, { C: 'USD' }), 40);
    assert.equal(app.pxToGBP('C', 50, 1.25, {}), null);                      // never guess
});
