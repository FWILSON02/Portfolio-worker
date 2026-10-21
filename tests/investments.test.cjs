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

test('contribution ranges in £: each holding\'s gain net of what was put in, then the money in, adding up to the move', () => {
    const d = s => new Date(s + 'T12:00:00Z');
    const chart = [{ date: '2026-01-05', investedAll: 100 }, { date: '2026-01-06', investedAll: 103 }, { date: '2026-01-07', investedAll: 104 }];
    const rows = [
        { date: '2026-01-05', holdingsValue: 1500, byTicker: { A: 1000, B: 500 }, pxTicker: { A: 10, B: 5 } },
        { date: '2026-01-06', holdingsValue: 1750, byTicker: { A: 1300, B: 450 }, pxTicker: { A: 11, B: 4.5 } },
        { date: '2026-01-07', holdingsValue: 1350, byTicker: { A: 1350 }, pxTicker: { A: 11.4 } },
    ];
    const ledger = [
        { parsedDate: d('2026-01-06'), category: 'buy', value: -200, instrument: { ticker: 'A' } },
        { parsedDate: d('2026-01-07'), category: 'sell', value: 460, instrument: { ticker: 'B' } },
    ];
    const f = app.makeContribRange(app.buildContribSteps(chart, rows, ledger), 5);
    const one = plain(f.gains('2026-01-05', '2026-01-06'));
    assert.deepEqual(one.rows.map(r => [r.tk, Math.round(r.c)]), [['A', 100], ['B', -50]]);
    assert.equal(Math.round(one.flows), 200);
    assert.equal(Math.round(one.total), 250);
    const two = plain(f.gains('2026-01-05', '2026-01-07'));
    assert.deepEqual(two.rows.map(r => [r.tk, Math.round(r.c), r.sold]), [['A', 150, false], ['B', -40, true]]);
    assert.equal(Math.round(two.flows), -260);
    assert.equal(Math.round(two.total), -150);
    assert.ok(Math.abs(two.other) < 0.01);
});

// 21 Oct 2026: stored history ended 19 Oct for every LSE line (that day's refresh failed for them), so the chart priced
// 20 Oct at the 19 Oct close and the 1W chart's last segment showed SMGB.L -1.1% on a +1.2% day.
test('withLiveTail: completed sessions missing from stored history come from the daily closes, then the live quote', () => {
    const stored = [{ date: '2026-10-16', close: 75.81 }, { date: '2026-10-19', close: 77.40 }];
    const daily = { 'SMGB.L': [
        { date: '2026-10-19', close: 77.40, status: 'verified' },
        { date: '2026-10-20', close: 75.58, status: 'verified' },
        { date: '2026-10-21', close: 76.52, status: 'yahoo-only' },   // today's partial bar: the live quote owns it
    ] };
    const out = plain(app.withLiveTail(stored, 'smgb.l', '2026-10-21', 76.57, daily));
    assert.deepEqual(out, [{ date: '2026-10-16', close: 75.81 }, { date: '2026-10-19', close: 77.40 },
                           { date: '2026-10-20', close: 75.58 }, { date: '2026-10-21', close: 76.57 }]);
    assert.ok(out[3].close / out[2].close - 1 > 0.012, 'the last segment is the same move Today shows');
    assert.equal(stored.length, 2, 'the stored series is not mutated');
});

test('withLiveTail: replaces a same-day point, skips conflicts and weekend stubs, never goes backwards', () => {
    const stored = [{ date: '2026-10-15', close: 10 }, { date: '2026-10-16', close: 11 }];
    const daily = { 'EQGB.L': [
        { date: '2026-10-17', close: 11.5 },                           // Saturday stub on an exchange shut at weekends
        { date: '2026-10-19', close: 12, status: 'conflict' },         // sources disagree: never used
        { date: '2026-10-20', close: 13 },                             // no status (restored from an older backup)
    ] };
    assert.deepEqual(plain(app.withLiveTail(stored, 'EQGB.L', '2026-10-21', 14, daily)).map(r => r.date),
        ['2026-10-15', '2026-10-16', '2026-10-20', '2026-10-21']);
    assert.deepEqual(plain(app.withLiveTail(stored, 'EQGB.L', '2026-10-16', 12, daily)),
        [{ date: '2026-10-15', close: 10 }, { date: '2026-10-16', close: 12 }]);
    assert.deepEqual(plain(app.withLiveTail(stored, 'EQGB.L', '2026-10-14', 12, daily)), stored, 'retrograde live date');
    assert.deepEqual(plain(app.withLiveTail(stored, 'EQGB.L', null, 12, daily)), stored, 'stale quote: no tail at all');
    assert.deepEqual(plain(app.withLiveTail([], 'X.L', '2026-10-21', 5, {})), [{ date: '2026-10-21', close: 5 }]);
    // A backup exported before this fix carries today's live point straight after the stale close: still bridged.
    const restored = [...stored, { date: '2026-10-21', close: 13.9 }];
    assert.deepEqual(plain(app.withLiveTail(restored, 'EQGB.L', '2026-10-21', 14, daily)).map(r => [r.date, r.close]),
        [['2026-10-15', 10], ['2026-10-16', 11], ['2026-10-20', 13], ['2026-10-21', 14]]);
});

test('history refresh: tickers that failed stay pending for a retry the same day', () => {
    const noon = Date.parse('2026-10-21T11:00:00Z');
    app.localStorage.clear();
    assert.equal(app.historyRefreshDue(noon), true);
    app.markHistoryRefreshed(noon, ['SMGB.L', 'EQGB.L']);
    assert.equal(app.historyRefreshDue(noon), false);
    assert.deepEqual(plain(app.historyRefreshPending(noon)), ['EQGB.L', 'SMGB.L']);
    app.markHistoryRefreshed(noon + 36e5, []);
    assert.deepEqual(plain(app.historyRefreshPending(noon + 36e5)), []);
    // Next London day: a full refresh is due, nothing is left pending from yesterday.
    assert.equal(app.historyRefreshDue(noon + DAY), true);
    assert.deepEqual(plain(app.historyRefreshPending(noon + DAY)), []);
});
