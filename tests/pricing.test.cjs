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

// ── Gilt prices (giltsyield.com /api/bond/price/, dated by updated_at) ──
// Shaped like real replies; prices are illustrative.
const gyReply = (dirty, updatedAt, extra) => Object.assign({ dirty_price: dirty, market_dirty_price: dirty, updated_at: updatedAt,
    isin_code: 'GB00TEST0001', maturity_date: '2030-10-22', coupon: 0.375 }, extra || {});

test('gilt prices: a price is dated by its data time, not by when it was asked for', () => {
    // Asked for Wednesday 28 Oct at 13:13, but the newest data is Tuesday 14:05: it is Tuesday's price.
    const p = app.gyParseBondPrice(gyReply(84.047, '2026-10-27 14:05'), '2026-10-28');
    assert.equal(p.session, '2026-10-27');
    assert.equal(p.asOf, '2026-10-27 14:05');
    // Asked for Saturday: Friday's data is Friday's session.
    assert.equal(app.gyParseBondPrice(gyReply(84.0, '2026-10-23 16:40'), '2026-10-24').session, '2026-10-23');
    // Never later than the date asked for, and a weekend date is never a session.
    assert.equal(app.gyParseBondPrice(gyReply(84.0, '2026-10-26 01:00'), '2026-10-24').session, '2026-10-23');
    // Undated or implausible replies are refused.
    assert.ok(app.gyParseBondPrice(gyReply(84.0, ''), '2026-10-28').error);
    assert.ok(app.gyParseBondPrice(gyReply(12, '2026-10-27 14:05'), '2026-10-28').error);
});

test('gilt prices: Today is the move between two dated closes, tagged with its session', () => {
    const at = iso => Date.parse(iso);
    const cur = app.gyParseBondPrice(gyReply(84.047, '2026-10-27 14:05'), '2026-10-28');
    const prev = app.gyParseBondPrice(gyReply(84.015, '2026-10-26 20:06'), '2026-10-26');
    // An older app dated a fetch by its time: a stale '2026-10-28' entry holding Tuesday's price. It must go.
    let c = { v: 1, snaps: { TX30: { '2026-10-28': { dirty: 84.047, t: at('2026-10-28T09:00:00Z'), final: false } } }, meta: {} };
    c = app.gyRecordSnapshots(c, { TX30: { cur, prev } }, at('2026-10-28T13:13:00Z'));
    assert.deepEqual(plain(Object.keys(c.snaps.TX30).sort()), ['2026-10-26', '2026-10-27']);
    assert.equal(c.snaps.TX30['2026-10-27'].final, true);       // Tuesday has closed
    const mk = app.gyMarketFor(c, 'TX30', at('2026-10-28T13:14:00Z'));
    assert.equal(mk.session, '2026-10-27');
    assert.equal(mk.dirty, 84.047);
    assert.equal(mk.prevCloseDirty, 84.015);
});

test('gilt prices: a revised price replaces the stored one; no dated previous close means no move', () => {
    const at = iso => Date.parse(iso);
    let c = app.gyRecordSnapshots({ v: 1, snaps: {}, meta: {} },
        { TX30: { cur: app.gyParseBondPrice(gyReply(84.02, '2026-10-26 20:06'), '2026-10-26'), prev: null } }, at('2026-10-26T20:10:00Z'));
    assert.equal(app.gyMarketFor(c, 'TX30', at('2026-10-26T20:11:00Z')).prevCloseDirty, null);
    c = app.gyRecordSnapshots(c, { TX30: { cur: app.gyParseBondPrice(gyReply(84.01, '2026-10-26 20:06'), '2026-10-27'), prev: null } }, at('2026-10-27T07:00:00Z'));
    assert.equal(c.snaps.TX30['2026-10-26'].dirty, 84.01);
    // A price whose session is more than four days old is not used at all.
    assert.equal(app.gyMarketFor(c, 'TX30', at('2026-11-02T12:00:00Z')), null);
});

test('gilt prices: restoring a backup keeps the later fetch', () => {
    const older = { dirty: 84.10, t: 1000, final: true }, newer = { dirty: 84.02, t: 2000, final: true };
    assert.equal(app.mergeGiltSnapshots({ snaps: { TX30: { '2026-10-23': older } } }, { TX30: { '2026-10-23': newer } }).snaps.TX30['2026-10-23'].dirty, 84.02);
    assert.equal(app.mergeGiltSnapshots({ snaps: { TX30: { '2026-10-23': newer } } }, { TX30: { '2026-10-23': older } }).snaps.TX30['2026-10-23'].dirty, 84.02);
});

test('secrets file: the retired giltsyield portfolio row is skipped quietly', () => {
    const r = app.parseApiKeyCsv('setting,value\ngiltsyield_portfolio,Ferg\n');
    assert.equal(r.unknown.length, 0);
    assert.equal(r.updates.length, 0);
});
