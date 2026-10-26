// The pricing engine (docs/providers.js, docs/core.js, docs/holdings.js): which previous close counts, which live quote is
// trusted, how two sources are reconciled, and how trades become holdings. A slip here shows a plausible but wrong figure,
// not an error, so the smoke test can't catch it. Every figure here is made up: the repo is public.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load.cjs');

const { app } = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const rows = (...pairs) => pairs.map(([date, close, status]) => Object.assign({ date, close }, status ? { status } : {}));

// ── Previous close for today's change ──
test('previous close: the last session before today, on the exchange calendar', () => {
    // Monday 23 Nov 2026: the previous NYSE session is Friday 20th.
    const r = app.resolveVerifiedDailyPrevClose({ ticker: 'acme', sessionDate: '2026-11-23', livePx: 101,
        dailyCloses: { ACME: rows(['2026-11-19', 99], ['2026-11-20', 100], ['2026-11-23', 101]) } });
    assert.equal(r.ok, true);
    assert.equal(r.value, 100);
    assert.equal(r.date, '2026-11-20');
});

test('previous close: a holiday is skipped, a missing session is refused', () => {
    // Friday 27 Nov 2026 follows Thanksgiving (26th): the previous session is Wednesday 25th.
    const ok = app.resolveVerifiedDailyPrevClose({ ticker: 'ACME', sessionDate: '2026-11-27', livePx: 50,
        dailyCloses: { ACME: rows(['2026-11-24', 49], ['2026-11-25', 50]) } });
    assert.equal(ok.ok, true);
    assert.equal(ok.date, '2026-11-25');
    // Without the 20th, Monday's change would be measured from the 19th: refused.
    const gap = app.resolveVerifiedDailyPrevClose({ ticker: 'ACME', sessionDate: '2026-11-23', livePx: 101,
        dailyCloses: { ACME: rows(['2026-11-19', 99]) } });
    assert.equal(gap.ok, false);
    assert.equal(gap.reason, 'prev-session-missing');
    assert.equal(gap.expectedDate, '2026-11-20');
});

test('previous close: refused when the sources disagree or the move is implausible', () => {
    const conflict = app.resolveVerifiedDailyPrevClose({ ticker: 'ACME', sessionDate: '2026-11-23', livePx: 100,
        dailyCloses: { ACME: rows(['2026-11-20', 100, 'conflict']) } });
    assert.equal(conflict.reason, 'sources-disagree');
    // A US share may move 30% in a day; 40% means the close or the quote is wrong.
    const jump = app.resolveVerifiedDailyPrevClose({ ticker: 'ACME', sessionDate: '2026-11-23', livePx: 140,
        dailyCloses: { ACME: rows(['2026-11-20', 100]) } });
    assert.equal(jump.reason, 'implausible-move');
    assert.equal(app.resolveVerifiedDailyPrevClose({ ticker: 'ACME', sessionDate: '2026-11-23', dailyCloses: {} }).reason, 'no-daily-series');
});

test('previous close: weekend FX stubs are not sessions', () => {
    // GBPUSD on Monday: a Sunday-evening tick must not stand in for Friday's close.
    const r = app.resolveVerifiedDailyPrevClose({ ticker: 'GBPUSD=X', sessionDate: '2026-11-23', livePx: 1.3,
        dailyCloses: { 'GBPUSD=X': rows(['2026-11-20', 1.29], ['2026-11-22', 1.3]) } });
    assert.equal(r.ok, true);
    assert.equal(r.value, 1.29);
    assert.equal(r.date, '2026-11-20');
});

test('previous close from a chart series: the last bar before the quote\'s day', () => {
    const ts = d => Date.parse(d + 'T21:00:00Z') / 1000;
    const r = app.getPreviousCompletedCloseFromSeries([ts('2026-11-19'), ts('2026-11-20'), ts('2026-11-23')], [99, 100, 101], ts('2026-11-23'));
    assert.deepEqual([r.value, r.date], [100, '2026-11-20']);
    // No quote time: the last bar may be today's unfinished one, so take the one before.
    assert.equal(app.getPreviousCompletedCloseFromSeries([ts('2026-11-20'), ts('2026-11-23')], [100, 101]).value, 100);
    assert.equal(app.getPreviousCompletedCloseFromSeries([ts('2026-11-23')], [101], ts('2026-11-23')), null);
});

// ── Live quote gate ──
test('live gate: a normal move is accepted, a jump or a pence/pounds slip is rejected', () => {
    const daily = { 'ACME.L': rows(['2026-11-19', 400], ['2026-11-20', 410]) };
    const ok = app.assessLiveQuote({ ticker: 'ACME.L', livePx: 420, sessionDate: '2026-11-23', dailyCloses: daily });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.refDate, '2026-11-20');
    // London shares are allowed 25% a day.
    const jump = app.assessLiveQuote({ ticker: 'ACME.L', livePx: 600, sessionDate: '2026-11-23', dailyCloses: daily });
    assert.equal(jump.status, 'rejected');
    assert.match(jump.reason, /^implausible-vs-2026-11-20/);
    // History in pence, quote in pounds: 100x off is a unit change, not a move.
    const units = app.assessLiveQuote({ ticker: 'ACME.L', livePx: 4.1, sessionDate: '2026-11-23',
        historySeries: rows(['2026-10-01', 405]) });
    assert.equal(units.reason, 'units-differ-from-history');
    assert.equal(app.assessLiveQuote({ ticker: 'ACME.L', livePx: 0 }).status, 'rejected');
});

test('live gate: a reference close over 10 days old is not used for the move check', () => {
    const r = app.assessLiveQuote({ ticker: 'ACME', livePx: 200, sessionDate: '2026-11-23',
        dailyCloses: { ACME: rows(['2026-11-01', 100]) } });
    assert.equal(r.status, 'unchecked');
    assert.equal(r.reason, 'no-reference-close');
});

test('live gate: rejected quotes are dropped, the rest pass, and the currency mismatch is flagged', () => {
    const g = app.gateLiveQuotes({
        quotes: { ACME: 101, 'BAD.L': 900 },
        sessionDates: { ACME: '2026-11-23', 'BAD.L': '2026-11-23' },
        dailyCloses: { ACME: rows(['2026-11-20', 100]), 'BAD.L': rows(['2026-11-20', 400]) },
        quoteCurrencies: { ACME: 'USD' }, expectedCurrencies: { ACME: 'GBP' } });
    assert.deepEqual(plain(g.accepted), { ACME: 101 });
    assert.equal(g.checks['BAD.L'].status, 'rejected');
    assert.equal(g.checks.ACME.currencyMismatch, true);
});

test('carry forward: a quote missing this cycle keeps the last good one, marked as carried', () => {
    const r = app.carryForwardLiveQuotes({ requested: ['ACME', 'GONE', 'NEW'], fresh: { NEW: 5 }, previous: { ACME: 101 },
        freshRows: {}, previousRows: { ACME: rows(['2026-11-20', 100]) }, checks: {}, lastGoodAt: { ACME: 1000 }, now: 2000 });
    assert.deepEqual(plain(r.quotes), { NEW: 5, ACME: 101 });
    assert.equal(r.checks.ACME.carried, true);
    assert.equal(r.checks.ACME.lastGoodAt, 1000);
    assert.equal(r.checks.GONE.carried, false);
    assert.equal(r.lastGoodAt.NEW, 2000);
    assert.equal(r.rows.ACME.length, 1);
});

// ── Two sources ──
test('cross-check: closes within the tolerance are verified, the rest are conflicts', () => {
    const m = app.mergeDailyCloseSources(rows(['2026-11-19', 100], ['2026-11-20', 100]),
                                         rows(['2026-11-20', 100.4], ['2026-11-19', 103], ['2026-11-18', 98]), 0.005);
    assert.deepEqual(plain(m).map(r => [r.date, r.status, r.close]),
        [['2026-11-18', 'alt-only', 98], ['2026-11-19', 'conflict', 100], ['2026-11-20', 'verified', 100]]);
});

test('cross-check: the other source\'s units are found (same, x100 or /100), or refused', () => {
    const y = rows(['2026-11-19', 4.0], ['2026-11-20', 4.1]);
    assert.equal(app.crossSourceUnitFactor(y, rows(['2026-11-20', 410])), 100);
    assert.equal(app.crossSourceUnitFactor(y, rows(['2026-11-20', 4.12])), 1);
    assert.equal(app.crossSourceUnitFactor(rows(['2026-11-20', 410]), rows(['2026-11-20', 4.1])), 0.01);
    assert.equal(app.crossSourceUnitFactor(y, rows(['2026-11-20', 7])), null);
    // No common date: judged against the live price, more loosely.
    assert.equal(app.crossSourceUnitFactor([], rows(['2026-11-20', 430]), 4.1), 100);
});

// ── Holdings ──
test('holdings: buys, sells and transfers become units, cost and value per account', () => {
    const t = (date, category, ticker, quantity, value, account = 'ISA') => ({ parsedDate: new Date(date + 'T12:00:00Z'), category,
        instrument: { name: ticker + ' plc', ticker }, quantity: String(quantity), value, account });
    const enriched = [
        t('2025-01-10', 'buy', 'ACME.L', 100, -1000),
        t('2025-06-10', 'sell', 'ACME.L', 40, 500),
        t('2025-02-01', 'buy', 'ACME.L', 10, -120, 'SIPP'),
        t('2025-03-01', 'transfer_in', 'WIDG', 5, 0),
        t('2027-01-01', 'buy', 'ACME.L', 999, -1),      // after the holdings date: ignored
        { parsedDate: new Date('2025-04-01'), category: 'fee', instrument: { name: 'x', ticker: 'X' }, quantity: '', value: -5 },
    ];
    const resolvedPricesMap = { 'ACME.L': rows(['2025-12-31', 1500]), WIDG: rows(['2025-12-31', 20]) };
    const h = app.computeHoldings({ enriched, holdingsDate: '2026-01-01', resolvedPricesMap, gbpusdRate: 1.25,
                                    tickerCurrencyMap: { 'ACME.L': 'GBp', WIDG: 'USD' } });
    const by = Object.fromEntries(h.map(x => [x.ticker + '/' + x.account, x]));
    assert.equal(by['ACME.L/ISA'].units, 60);
    assert.equal(by['ACME.L/ISA'].marketValue, 900);            // 60 x 1500p
    assert.equal(by['ACME.L/ISA'].unrealisedPL, 900 - (1000 - 500));
    assert.equal(by['ACME.L/SIPP'].units, 10);
    assert.equal(by['WIDG/ISA'].marketValue, 80);               // 5 x $20 at 1.25
    assert.equal(by['WIDG/ISA'].totalCost, 0);                  // a zero-value transfer adds no cost
    assert.equal(h.length, 3);
});

test('today\'s change: units x (live - previous close), each in pounds at its own day\'s GBP/USD', () => {
    // Built around the real current session so the session checks pass on any day the tests run.
    const session = app.getCurrentPnlSessionDateStr();
    const prev = app.previousExchangeSession('NYSE', session).date;
    const base = { giltLadderState: null, liveAt: Date.now(), liveStatus: 'ok', prices: {}, gbpusdRate: 1.3,
                   tickerCurrencyMap: { ACME: 'USD' }, liveQuoteChecks: {}, liveQuoteSessionDates: { ACME: session },
                   liveDailyCloses: { ACME: rows([prev, 100]), 'GBPUSD=X': rows([prev, 1.25]) } };
    const holding = { ticker: 'ACME', name: 'Acme', account: 'ISA', units: 10, totalCost: 700, totalProceeds: 0 };
    const [h] = app.computeLedgerHoldingsWithDelta(Object.assign({}, base, { activeHoldings: [holding], livePrices: { ACME: 110 } }));
    assert.ok(Math.abs(h.todayAbsChange - 10 * (110 / 1.3 - 100 / 1.25)) < 1e-9);
    assert.equal(h.todayPrevDate, prev);
    // No live session yet: no change is claimed.
    const [none] = app.computeLedgerHoldingsWithDelta(Object.assign({}, base, { activeHoldings: [holding], livePrices: {}, liveStatus: 'idle' }));
    assert.equal(none.todayAbsChange, null);
    // A previous close the sources disagree on: no change, and the reason is kept.
    const [held] = app.computeLedgerHoldingsWithDelta(Object.assign({}, base, { activeHoldings: [holding], livePrices: { ACME: 110 },
        liveDailyCloses: { ACME: rows([prev, 100, 'conflict']) } }));
    assert.equal(held.todayAbsChange, null);
    assert.equal(held.todayPrevReason, 'sources-disagree');
});

// The exchange holiday calendars cover listed years only. From 1 December, next year must be there too, or the daily close
// check can't verify sessions from 1 January. Runs weekly in CI (the Tests workflow).
test('the exchange holiday calendars cover next year from December', () => {
    const now = new Date();
    const need = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const calendars = app.EXCHANGE_CALENDARS;
    const missing = Object.keys(calendars).filter(k => calendars[k].holidays && !calendars[k].years.includes(need));
    assert.deepEqual(missing, [], 'add ' + need + '\'s holidays to EXCHANGE_CALENDARS in docs/providers.js');
});

// ── Gilt closes (giltsyield.com snapshots) ──
// Times in UTC; London is UTC+0 from 25 Oct 2026. Fri 23 Oct 2026 is BST (UTC+1).
test('gilt closes: a stored close is never replaced by a later weekend or pre-open fetch', () => {
    const at = iso => Date.parse(iso);
    let c = { v: 1, snaps: {}, meta: {} };
    c = app.gyRecordSnapshots(c, { TX30: { dirty: 84.10 } }, at('2026-10-23T16:00:00Z'));   // Fri 17:00 BST: Friday's close
    c = app.gyRecordSnapshots(c, { TX30: { dirty: 84.10 } }, at('2026-10-24T10:00:00Z'));   // Saturday: same session, kept
    c = app.gyRecordSnapshots(c, { TX30: { dirty: 84.02 } }, at('2026-10-26T07:30:00Z'));   // Mon 07:30: Monday's early price
    c = app.gyRecordSnapshots(c, { TX30: { dirty: 84.00 } }, at('2026-10-26T15:10:00Z'));   // Mon intraday
    assert.equal(c.snaps.TX30['2026-10-23'].dirty, 84.10);
    assert.equal(c.snaps.TX30['2026-10-23'].t, at('2026-10-23T16:00:00Z'));
    const mk = app.gyMarketFor(c, 'TX30', at('2026-10-26T15:16:00Z'));
    assert.equal(mk.session, '2026-10-26');
    assert.equal(mk.dirty, 84.00);
    assert.equal(mk.prevCloseDirty, 84.10);
});

test('gilt closes: a pre-open fetch still fills a missing close, and replaces an intraday price', () => {
    const at = iso => Date.parse(iso);
    let c = app.gyRecordSnapshots({ v: 1, snaps: {}, meta: {} }, { TX30: { dirty: 84.05 } }, at('2026-10-23T13:00:00Z'));   // Fri intraday
    assert.equal(c.snaps.TX30['2026-10-23'].final, false);
    c = app.gyRecordSnapshots(c, { TX30: { dirty: 84.10 } }, at('2026-10-26T07:30:00Z'));
    assert.equal(c.snaps.TX30['2026-10-23'].dirty, 84.10);
    assert.equal(c.snaps.TX30['2026-10-23'].final, true);
});

test('gilt closes: restoring a backup keeps the first close stored for a session', () => {
    const first = { dirty: 84.10, t: 1000, final: true }, later = { dirty: 84.02, t: 2000, final: true };
    assert.equal(app.mergeGiltSnapshots({ snaps: { TX30: { '2026-10-23': first } } }, { TX30: { '2026-10-23': later } }).snaps.TX30['2026-10-23'].dirty, 84.10);
    assert.equal(app.mergeGiltSnapshots({ snaps: { TX30: { '2026-10-23': later } } }, { TX30: { '2026-10-23': first } }).snaps.TX30['2026-10-23'].dirty, 84.10);
});
