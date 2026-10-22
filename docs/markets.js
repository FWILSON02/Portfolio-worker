// Markets: the read-only global market overview screen and its data helpers.
// Loaded by index.html after app.js; shares its globals (no module system, no build step).

// =====================================================
// MARKET OVERVIEW MODULE START
// Read-only global market context screen.
// Does not feed portfolio valuation.
// Phase 6: Holdings section; compact one-line rows;
//          age-first quote status; dynamic instrument list.
// =====================================================

// Base static instruments. Holdings added dynamically in PortfolioApp via useMemo.
// Rule: one row = one canonical symbol; liveSymbol === returnSymbol for all Markets rows.
// Futures (=F) symbols are used only in the Commodities section. schemaVersion 2.
const BASE_MARKET_OVERVIEW_INSTRUMENTS = [
    // ── Markets ───────────────────────────────────────────────────────────────
    { id: 'SPX',    label: 'S&P 500',       liveSymbol: '^GSPC',     returnSymbol: '^GSPC',     type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    { id: 'NDX',    label: 'Nasdaq 100',     liveSymbol: '^NDX',      returnSymbol: '^NDX',      type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    { id: 'RTY',    label: 'Russell 2000',   liveSymbol: '^RUT',      returnSymbol: '^RUT',      type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    { id: 'SX5E',   label: 'Euro Stoxx 50',  liveSymbol: '^STOXX50E', returnSymbol: '^STOXX50E', type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    { id: 'UKX',    label: 'FTSE 100',       liveSymbol: '^FTSE',     returnSymbol: '^FTSE',     type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    { id: 'NKY',    label: 'Nikkei 225',     liveSymbol: '^N225',     returnSymbol: '^N225',     type: 'Index', section: 'Markets', displayKind: 'pctReturn' },
    // altSymbols: tried in order when the primary returns a quote but no usable daily bars.
    // tdSymbols: Twelve Data symbols for the SAME index, tried when Yahoo's history can't
    // support 1M / YTD / 12M. Never a tracker or proxy. Which one works on your plan is
    // detected automatically (see mktTwelveDataHistory).
    { id: 'KOSPI2', label: 'KOSPI 200',      liveSymbol: '^KS200',    returnSymbol: '^KS200',    type: 'Index', section: 'Markets', displayKind: 'pctReturn', altSymbols: ['KOSPI200.KS'], tdSymbols: ['KS200', 'KOSPI200'],
      naverCode: 'KPI200',   // Naver Finance's code for the KOSPI 200 index
      primarySource: 'naver',  // Naver first for Last, 1D and periods; Yahoo only if Naver fails
      tdSearch: 'KOSPI 200', tdNameMatch: '^KOSPI\\s*200(\\s+index)?$', tdCountry: 'korea' },
    // ── Volatility ────────────────────────────────────────────────────────────
    { id: 'VIX',    label: 'VIX',            liveSymbol: '^VIX',      returnSymbol: '^VIX',      type: 'Vol',   section: 'Volatility', displayKind: 'ptChange', nowDecimals: 2, riskColorMode: 'inverse', excludeFromTopMovers: true },
    // ── FX ────────────────────────────────────────────────────────────────────
    { id: 'EURUSD', label: 'EUR/USD',        liveSymbol: 'EURUSD=X', returnSymbol: 'EURUSD=X',  type: 'FX',     section: 'FX',      displayKind: 'pctReturn', nowDecimals: 4 },
    { id: 'GBPUSD', label: 'GBP/USD',        liveSymbol: 'GBPUSD=X', returnSymbol: 'GBPUSD=X',  type: 'FX',     section: 'FX',      displayKind: 'pctReturn', nowDecimals: 4 },
    { id: 'USDJPY', label: 'USD/JPY',        liveSymbol: 'JPY=X',    returnSymbol: 'JPY=X',     type: 'FX',     section: 'FX',      displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'DXY',    label: 'US Dollar Index', liveSymbol: 'DX-Y.NYB', returnSymbol: 'DX-Y.NYB',  type: 'FX',     section: 'FX',      displayKind: 'pctReturn', nowDecimals: 2 },
    // ── Commodities — front-month futures (Yahoo continuous symbols); prices roll to the next contract at expiry ──
    { id: 'GOLD',   label: 'Gold',           liveSymbol: 'GC=F',     returnSymbol: 'GC=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'SILVER', label: 'Silver',         liveSymbol: 'SI=F',     returnSymbol: 'SI=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'COPPER', label: 'Copper',         liveSymbol: 'HG=F',     returnSymbol: 'HG=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'WTI',    label: 'WTI Crude Oil',  liveSymbol: 'CL=F',     returnSymbol: 'CL=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'BRENT',  label: 'Brent Crude Oil', liveSymbol: 'BZ=F',    returnSymbol: 'BZ=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 2 },
    { id: 'NATGAS', label: 'Natural Gas',    liveSymbol: 'NG=F',     returnSymbol: 'NG=F',      type: 'Cmdty',  section: 'Commodities', displayKind: 'pctReturn', nowDecimals: 3 },
    // ── Rates — basis-point changes; US5Y ^FVX, US10Y ^TNX ──────────────────
    { id: 'US5Y',   label: 'US 5Y',          liveSymbol: '^FVX',     returnSymbol: '^FVX',      type: 'Yld',    section: 'Rates',   displayKind: 'bpChange'  },
    { id: 'US10Y',  label: 'US 10Y',         liveSymbol: '^TNX',     returnSymbol: '^TNX',      type: 'Yld',    section: 'Rates',   displayKind: 'bpChange'  },
    // ── Crypto ────────────────────────────────────────────────────────────────
    { id: 'BTC',    label: 'Bitcoin',        liveSymbol: 'BTC-USD',  returnSymbol: 'BTC-USD',   type: 'Crypto', section: 'Crypto',  displayKind: 'pctReturn', nowDecimals: 0, excludeFromTopMovers: true },
    { id: 'ETH',    label: 'Ethereum',       liveSymbol: 'ETH-USD',  returnSymbol: 'ETH-USD',   type: 'Crypto', section: 'Crypto',  displayKind: 'pctReturn', nowDecimals: 2, excludeFromTopMovers: true },
    // ── Mag7 ─────────────────────────────────────────────────────────────────
    { id: 'AAPL',   label: 'Apple',          liveSymbol: 'AAPL',     returnSymbol: 'AAPL',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'MSFT',   label: 'Microsoft',      liveSymbol: 'MSFT',     returnSymbol: 'MSFT',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'GOOGL',  label: 'Alphabet',       liveSymbol: 'GOOGL',    returnSymbol: 'GOOGL',     type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'AMZN',   label: 'Amazon',         liveSymbol: 'AMZN',     returnSymbol: 'AMZN',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'NVDA',   label: 'Nvidia',         liveSymbol: 'NVDA',     returnSymbol: 'NVDA',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'META',   label: 'Meta',           liveSymbol: 'META',     returnSymbol: 'META',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
    { id: 'TSLA',   label: 'Tesla',          liveSymbol: 'TSLA',     returnSymbol: 'TSLA',      type: 'Equity', section: 'Mag7',    displayKind: 'pctReturn', excludeFromTopMovers: true },
];

// Module-scope history cache. Never persisted, never exported, market-overview only.
// Cache stores anchor data (historyCore) — never final return percentages.
// Schema v2: keyed on historyCore; old cached.parsed entries are silently ignored.
var MARKET_HISTORY_CACHE = {};
var MARKET_HISTORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ── Display helpers ───────────────────────────────────────────────────────────

function mktSafeFiniteNumber(v) {
    var n = Number(v);
    return (Number.isFinite(n) && n > 0) ? n : null;
}




// Yield level: e.g. 4.23 → "4.23%"
function mktFmtYieldLevel(v) {
    if (v == null || !Number.isFinite(v)) return '\u2014';
    return v.toFixed(2) + '%';
}


// Now column: yield level for bpChange rows; price for pctReturn.
// Respects row.nowDecimals when set (e.g. 4 for EUR/USD, 2 for USD/JPY).
function mktFmtRowNow(row) {
    if (!row || row.now == null || !Number.isFinite(row.now)) return '\u2014';
    if (row.displayKind === 'bpChange') return mktFmtYieldLevel(row.now);
    var v = row.now;
    if (v <= 0) return '\u2014';
    if (row.nowDecimals != null) return v.toFixed(row.nowDecimals);
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return v.toFixed(2);
}



// Colour for any move column: positive emerald, negative rose, missing muted.
// VIX uses inverse colouring: a rising VIX is risk-off (bad = rose),
// a falling VIX is risk-on (good = emerald).
function mktMoveColor(row, value) {
    if (value == null || !Number.isFinite(value)) return C.zinc700;
    var inverse = row && (row.riskColorMode === 'inverse' || row.id === 'VIX');
    if (inverse) return value >= 0 ? C.rose : C.emerald;
    return value >= 0 ? C.emerald : C.rose;
}

// ── Market Overview display helpers ──────────────────────────────────────────

// Returns true when a market row has any quality issue that warrants a
// degraded indicator. Keep the data model intact — this is display-only.
// historyFromCache alone is NOT degraded; cached anchors are expected.
function mktRowIsDegraded(row) {
    if (!row) return true;
    var dq  = String(row.dataQuality       || '').toLowerCase();
    var pdq = String(row.periodDataQuality || '').toLowerCase();
    var BAD_DQ  = {
        'stale': 1, 'unavailable': 1, 'mixed-symbol': 1,
        'chart-fallback-suppressed': 1, 'chartfallback1d-suppressed': 1,
        'bad': 1, 'suspect': 1, 'suppressed': 1,
        // 1D withheld by the daily-close check (shows "—"; tap for the reason)
        'prev-session-missing': 1, 'sources-disagree': 1, 'implausible-move': 1, 'no-prior-close': 1,
    };
    // Includes all suppressed-period values produced by the period-return engine.
    var BAD_PDQ = {
        'stale': 1, 'unavailable': 1, 'bad': 1, 'suspect': 1, 'error': 1,
        'suppressed': 1, 'emptyhistory': 1,
        'm1suppressed': 1, 'ytdsuppressed': 1, 'y1suppressed': 1,
    };
    if (dq  && BAD_DQ[dq])               return true;
    if (pdq && BAD_PDQ[pdq])             return true;
    if (row.quoteStatusKind === 'stale') return true;
    if (row.historyStale)                return true;
    if (row.liveError)                   return true;
    if (row.historyError)                return true;
    if (row.error)                       return true;
    if (row.primaryNote)                 return true;
    if (row.now == null || !Number.isFinite(row.now)) return true;
    // Any blank period return is a problem worth a reason — never a silent "—".
    if (row.m1 == null || row.ytd == null || row.y1 == null) return true;
    return false;
}

// Returns a very short degradation label for the row chip.
// Values: 'stale' | 'check' | '—'
// historyFromCache alone is not shown as 'cached' — cached anchors are normal.
function mktRowDegradationLabel(row) {
    if (!row) return 'check';
    if (row.liveError || row.historyError || row.error) return 'check';
    var dq  = String(row.dataQuality       || '').toLowerCase();
    var pdq = String(row.periodDataQuality || '').toLowerCase();
    // Unavailable / suppressed quote data → em-dash (value missing)
    if (dq === 'unavailable' || dq === 'suppressed' ||
        dq === 'chart-fallback-suppressed' || dq === 'chartfallback1d-suppressed' ||
        dq === 'prev-session-missing' || dq === 'sources-disagree' ||
        dq === 'implausible-move' || dq === 'no-prior-close') return '\u2014';
    // Suppressed or empty period returns → check
    var SUPP_PDQ = {
        'm1suppressed': 1, 'ytdsuppressed': 1, 'y1suppressed': 1,
        'emptyhistory': 1, 'suppressed': 1, 'error': 1,
    };
    if (pdq && SUPP_PDQ[pdq])            return 'check';
    if (pdq === 'unavailable' || pdq === 'bad' || pdq === 'suspect') return 'check';
    if (row.quoteStatusKind === 'stale') return 'stale';
    if (row.historyStale)                return 'stale';
    if (row.now == null || !Number.isFinite(row.now)) return '\u2014';
    return 'check';
}

// Builds one short global freshness line for the Markets header, or null when all is well
// (the refresh time sits under the Refresh button instead).
// Priority: fetching → offline → fail → cached → partial → row-level → normal.
// error alone (without fail) is treated as partial, not fatal.
function mktBuildGlobalFreshnessLine(rows, status, updatedAt, error) {
    if (status === 'fetching') return null;
    if (status === 'offline')  return 'Offline \u00b7 showing last saved market data';
    if (status === 'fail')     return 'Data unavailable \u00b7 tap Refresh';
    if (status === 'cached')   return 'Cached data \u00b7 pull to refresh';
    // partial always shows the calm partial message even when error is non-null
    if (status === 'partial')  return 'Some returns unavailable \u00b7 tap row for details';

    var allRows = Array.isArray(rows) ? rows : [];
    if (allRows.length === 0)  return 'Loading\u2026';

    var staleCount    = 0;
    var degradedCount = 0;
    allRows.forEach(function(r) {
        if (r.quoteStatusKind === 'stale' || r.historyStale) staleCount++;
        if (mktRowIsDegraded(r)) degradedCount++;
    });

    // Majority stale → offline-ish
    if (staleCount > allRows.length * 0.5) return 'Cached data \u00b7 pull to refresh';
    // Any row degraded, or a non-fatal error with rows present
    if (degradedCount > 0 || error)        return 'Some returns unavailable \u00b7 tap row for details';

    return null;
}

function mktFindLatestFiniteClose(timestamps, closes) {
    if (!Array.isArray(closes)) return null;
    for (var i = closes.length - 1; i >= 0; i--) {
        var c = Number(closes[i]);
        if (Number.isFinite(c) && c > 0) return c;
    }
    return null;
}

function mktBuildYahooChartUrl(symbol, range, interval) {
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(symbol) +
        '?range=' + (range || '5d') + '&interval=' + (interval || '1d');
}

// ── Historical helpers ────────────────────────────────────────────────────────

function mktDateOnlyUTC(date) { return date.toISOString().slice(0, 10); }

function mktAddMonthsUTC(dateStr, months) {
    var d   = new Date(dateStr + 'T00:00:00Z');
    var m   = d.getUTCMonth() + months;
    var ny  = d.getUTCFullYear() + Math.floor(m / 12);
    var nm  = ((m % 12) + 12) % 12;
    var day = d.getUTCDate();
    var max = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return mktDateOnlyUTC(new Date(Date.UTC(ny, nm, Math.min(day, max))));
}

function mktAddYearsUTC(dateStr, years) { return mktAddMonthsUTC(dateStr, years * 12); }

function mktStartOfYearAnchorDate(latestDateStr) { return latestDateStr.slice(0, 4) + '-01-01'; }

// Bars are dated in the exchange's own timezone (not UTC), so dates line up with
// Yahoo's daily rows elsewhere and with Twelve Data's exchange-local dates.
function mktParseDailyCloseSeries(chartResult) {
    var ts     = (chartResult && chartResult.timestamp) || [];
    var quote  = (chartResult && chartResult.indicators &&
                  chartResult.indicators.quote && chartResult.indicators.quote[0]) || {};
    var closes = quote.close || [];
    var meta   = (chartResult && chartResult.meta) || {};
    var pairs  = [];
    for (var i = 0; i < ts.length; i++) {
        var t = Number(ts[i]); var c = Number(closes[i]);
        if (!Number.isFinite(t) || !Number.isFinite(c) || c <= 0) continue;
        var d = exchangeLocalDate(t, meta.exchangeTimezoneName || null, meta.gmtoffset);
        if (d) pairs.push({ date: d, close: c });
    }
    pairs.sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var out = [];
    for (var j = 0; j < pairs.length; j++) {
        if (j === 0 || pairs[j].date !== pairs[j-1].date) out.push(pairs[j]);
        else out[out.length - 1] = pairs[j];
    }
    return out;
}

function mktFindCloseOnOrBefore(series, targetDateStr, maxStaleDays) {
    if (!series || series.length === 0) return null;
    var staleDays   = maxStaleDays != null ? maxStaleDays : 10;
    var targetMs    = new Date(targetDateStr + 'T00:00:00Z').getTime();
    var earliestStr = mktDateOnlyUTC(new Date(targetMs - staleDays * 86400000));
    var best = null;
    for (var i = 0; i < series.length; i++) {
        var p = series[i];
        if (p.date > targetDateStr) break;
        if (p.date >= earliestStr) best = p;
    }
    return best;
}

// ── Parse functions ───────────────────────────────────────────────────────────

// Detect whether a row's spot price changed between refresh cycles (display-only).
function mktDidNowUpdate(prevRow, nextRow) {
    if (!prevRow || !nextRow) return false;
    var a = Number(prevRow.now);
    var b = Number(nextRow.now);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    var tol = Math.max(0.000001, Math.abs(a) * 0.0000001);
    return Math.abs(a - b) > tol;
}

// Derive session status and feed latency separately.
// Returns { label, kind, compact, feed, quoteAgeMs }.
// Compact chip reflects session state (O/C/PRE/POST/K/S), not Yahoo feed latency.
// Extra params are optional; call with 3 args for a basic parse-time estimate.
function mktDeriveQuoteStatus(marketState, quoteTs, fetchedAtMs, inst, observedUpdating, liveFetchFailed, cachedRowUsable) {
    var stateUC = String(marketState || '').toUpperCase().trim();
    var nowMs   = fetchedAtMs || Date.now();
    var ageMs   = (quoteTs && Number.isFinite(Number(quoteTs)) && quoteTs > 0)
                    ? (nowMs - quoteTs * 1000) : null;
    var ageMins = ageMs != null ? ageMs / 60000 : null;

    var isFreshEnough = ageMins != null && ageMins <= 60;
    var isVeryOld     = ageMins != null && ageMins > 96 * 60;

    var id   = String(inst && inst.id   || '').toUpperCase();
    var type = String(inst && inst.type || '').toUpperCase();
    // FX and Crypto trade continuously; indices use REGULAR/CLOSED from Yahoo directly.
    var isContinuousOrExtended = (
        type === 'FX' || type === 'CRYPTO' || id === 'BTC'
    );

    function feedLabel(fresh5m) {
        return (ageMins != null && ageMins <= 5) ? 'live' : 'Yahoo delayed';
    }

    if (liveFetchFailed && cachedRowUsable) {
        return { label: 'CACHED', kind: 'cached', compact: 'K', feed: 'cached',     quoteAgeMs: ageMs };
    }
    if (liveFetchFailed && !cachedRowUsable) {
        return { label: 'STALE',  kind: 'stale',  compact: 'S', feed: 'failed',     quoteAgeMs: ageMs };
    }
    if (isVeryOld) {
        return { label: 'STALE',  kind: 'stale',  compact: 'S', feed: 'stale',      quoteAgeMs: ageMs };
    }
    if (observedUpdating) {
        return { label: 'OPEN',   kind: 'open',   compact: 'O', feed: feedLabel(),  quoteAgeMs: ageMs };
    }
    if (stateUC === 'REGULAR') {
        return { label: 'OPEN',   kind: 'open',   compact: 'O', feed: feedLabel(),  quoteAgeMs: ageMs };
    }
    if (stateUC === 'PRE' || stateUC === 'PREPRE') {
        return { label: 'PRE',    kind: 'pre',    compact: 'PRE', feed: isFreshEnough ? 'Yahoo delayed' : 'unknown', quoteAgeMs: ageMs };
    }
    if (stateUC === 'POST' || stateUC === 'POSTPOST') {
        return { label: 'POST',   kind: 'post',   compact: 'POST', feed: isFreshEnough ? 'Yahoo delayed' : 'unknown', quoteAgeMs: ageMs };
    }
    // Continuous/extended instruments (futures, FX, gold, oil) — open even without REGULAR state
    if (isContinuousOrExtended && isFreshEnough) {
        return { label: 'OPEN',   kind: 'open',   compact: 'O', feed: feedLabel(),  quoteAgeMs: ageMs };
    }
    if (stateUC === 'CLOSED') {
        return { label: 'CLOSED', kind: 'closed', compact: 'C', feed: isFreshEnough ? 'Yahoo delayed' : 'closed', quoteAgeMs: ageMs };
    }
    if (isFreshEnough) {
        return { label: 'OPEN',   kind: 'open',   compact: 'O', feed: feedLabel(),  quoteAgeMs: ageMs };
    }
    return     { label: 'CLOSED', kind: 'closed', compact: 'C', feed: 'unknown',    quoteAgeMs: ageMs };
}

// ── History helpers ───────────────────────────────────────────────────────────
// Split into two layers so the cache never stores final return percentages.
//
// Layer 1: mktParseHistoryCore — extracts anchor closes from a 2y chart result.
//   • Safe to cache: contains no live-quote-dependent numbers.
//   • Stored as MARKET_HISTORY_CACHE[symbol].historyCore
//
// Layer 2: mktComputePeriodReturnsFromHistoryCore — derives m1/ytd/y1 on every
//   refresh using the latest live quote as numerator when valid.
//   • Never cached: must re-run every fetch cycle.

function mktParseHistoryCore(chartResult, inst) {
    return mktHistoryCoreFromSeries(mktParseDailyCloseSeries(chartResult), inst);
}
function mktHistoryCoreFromSeries(series, inst) {
    try {
        series = series || [];
        if (series.length === 0) {
            return { returnAsOfDate: null, returnLatestClose: null,
                     m1AnchorDate: null,  m1AnchorClose: null,
                     ytdAnchorDate: null, ytdAnchorClose: null,
                     y1AnchorDate: null,  y1AnchorClose: null,
                     historyError: 'empty series', historyDataQuality: 'emptyHistory' };
        }
        var latest     = series[series.length - 1];
        var latestDate = latest.date;
        var MAX_STALE  = 10;

        var anch1M  = mktFindCloseOnOrBefore(series, mktAddMonthsUTC(latestDate, -1),       MAX_STALE);
        var anchYTD = mktFindCloseOnOrBefore(series, mktStartOfYearAnchorDate(latestDate),  MAX_STALE);
        var anch12M = mktFindCloseOnOrBefore(series, mktAddYearsUTC(latestDate, -1),        MAX_STALE);
        // A reference point that is an isolated spike (a bad print) is rejected
        // rather than turned into a wildly wrong 1M / YTD / 12M figure.
        var lim = dailyCheckProfileFor(inst && inst.returnSymbol).maxMove;
        var anchorRejected = {};
        if (mktAnchorIsSpike(series, anch1M,  lim)) { anchorRejected.m1  = anch1M.date;  anch1M  = null; }
        if (mktAnchorIsSpike(series, anchYTD, lim)) { anchorRejected.ytd = anchYTD.date; anchYTD = null; }
        if (mktAnchorIsSpike(series, anch12M, lim)) { anchorRejected.y1  = anch12M.date; anch12M = null; }

        return {
            returnAsOfDate:  latestDate,
            returnLatestClose: latest.close,
            m1AnchorDate:  anch1M  ? anch1M.date   : null,
            m1AnchorClose: anch1M  ? anch1M.close  : null,
            ytdAnchorDate:  anchYTD ? anchYTD.date  : null,
            ytdAnchorClose: anchYTD ? anchYTD.close : null,
            y1AnchorDate:  anch12M ? anch12M.date  : null,
            y1AnchorClose: anch12M ? anch12M.close : null,
            historySeriesCount: series.length,
            historyFirstDate:   series[0].date,
            anchorRejected:     anchorRejected,
            historyError: null,
            historyDataQuality: 'ok',
        };
    } catch(e) {
        return { returnAsOfDate: null, returnLatestClose: null,
                 m1AnchorDate: null,  m1AnchorClose: null,
                 ytdAnchorDate: null, ytdAnchorClose: null,
                 y1AnchorDate: null,  y1AnchorClose: null,
                 historyError: e.message, historyDataQuality: 'error' };
    }
}

// Compute m1/ytd/y1 from cached anchor data + the current live quote.
// Called on EVERY refresh cycle — never cached.
function mktComputePeriodReturnsFromHistoryCore(historyCore, inst, liveNow, liveDate) {
    var isBp        = (inst.displayKind === 'bpChange');
    var isPt        = (inst.displayKind === 'ptChange');   // level quoted in points (VIX): change = difference
    var latestDate  = historyCore && historyCore.returnAsOfDate;
    var latestClose = historyCore && historyCore.returnLatestClose;

    // Numerator selection: prefer live quote when same-symbol and credibly fresh
    var periodCurrentClose  = latestClose;
    var periodCurrentDate   = latestDate;
    var periodCurrentSource = 'latestHistoryClose';
    var sameSymbol = (inst.liveSymbol === inst.returnSymbol);

    if (sameSymbol &&
        liveNow != null && Number.isFinite(liveNow) && liveNow > 0 &&
        liveDate && latestDate && liveDate >= latestDate) {
        periodCurrentClose  = liveNow;
        periodCurrentDate   = liveDate;
        periodCurrentSource = 'liveQuote';
    }

    // Why a period came out blank (shown on the row and in the diagnostics export).
    var periodNullReasons = { m1: null, ytd: null, y1: null };
    var _curKey = null;
    function safeChange(anchorClose) {
        if (!historyCore) { periodNullReasons[_curKey] = 'no-history'; return null; }
        if (anchorClose == null || anchorClose <= 0) {
            periodNullReasons[_curKey] = (historyCore.anchorRejected && historyCore.anchorRejected[_curKey]) ? 'bad-anchor' : 'no-anchor';
            return null;
        }
        if (periodCurrentClose == null || periodCurrentClose <= 0) { periodNullReasons[_curKey] = 'no-current'; return null; }
        // Scale-break guard: anchor and current more than 10× apart → suspect series discontinuity
        var ratio = periodCurrentClose / anchorClose;
        if (ratio > 10 || ratio < 0.1) { periodNullReasons[_curKey] = 'scale-break'; return null; }
        var r = isBp
            ? (periodCurrentClose - anchorClose) * 100
            : isPt ? (periodCurrentClose - anchorClose)
            : (periodCurrentClose / anchorClose - 1) * 100;
        return Number.isFinite(r) ? r : null;
    }

    _curKey = 'm1';  var m1  = safeChange(historyCore && historyCore.m1AnchorClose);
    _curKey = 'ytd'; var ytd = safeChange(historyCore && historyCore.ytdAnchorClose);
    _curKey = 'y1';  var y1  = safeChange(historyCore && historyCore.y1AnchorClose);

    var periodDataQuality = (historyCore && historyCore.historyDataQuality !== 'ok')
        ? (historyCore.historyDataQuality || 'unknown')
        : 'ok';

    // Sanity backstop for broad equity indices. Bad reference points (the reason
    // this exists — e.g. SX5E 12M with a bad anchor) are now rejected directly by
    // mktAnchorIsSpike, so these limits only catch the absurd. They used to be
    // tight (12M > +150%, YTD > +100%, 1M > +50%), which would hide a genuine
    // boom such as KOSPI's 2026 rally.
    if (!isBp && inst.type === 'Index') {
        if (y1  != null && (y1  > 1000 || y1  < -95)) { y1  = null; periodNullReasons.y1  = 'suppressed'; periodDataQuality = 'y1Suppressed'; }
        if (ytd != null && (ytd > 1000 || ytd < -95)) { ytd = null; periodNullReasons.ytd = 'suppressed'; if (periodDataQuality === 'ok') periodDataQuality = 'ytdSuppressed'; }
        if (m1  != null && (m1  >  300 || m1  < -90)) { m1  = null; periodNullReasons.m1  = 'suppressed'; if (periodDataQuality === 'ok') periodDataQuality = 'm1Suppressed'; }
    }

    return {
        m1: m1, ytd: ytd, y1: y1,
        periodCurrentSource: periodCurrentSource,
        periodCurrentDate:   periodCurrentDate,
        periodCurrentClose:  periodCurrentClose,
        periodDataQuality:   periodDataQuality,
        periodNullReasons:   periodNullReasons,
    };
}


// ── Markets 1D: the same previous-close rules as Holdings ────────────────────
// Computes the 1D move for one Markets row from graded daily rows (Yahoo, plus a
// second source where one covers the instrument) via resolveVerifiedDailyPrevClose.
// Replaces the old chain (regularMarketChangePercent → meta prev-close fields →
// chart series), whose chartPreviousClose step returned the close from BEFORE the
// 5-day window — i.e. roughly a weekly move labelled 1D.
function mktComputeDayFromRows(inst, now, sessionDate, rows) {
    var sym = String(inst.liveSymbol || '').toUpperCase().trim();
    var isBp = inst.displayKind === 'bpChange';
    var isPt = inst.displayKind === 'ptChange';
    var out = {
        day: null, previousClose: null, previousCloseSource: null, previousCloseDate: null,
        daySource: 'unavailable', dataQuality: 'ok',
        dayCheckStatus: null, dayCheckReason: null, dayCheckExpected: null,
        dayCheckYahoo: null, dayCheckAlt: null, dayCheckCalendarCovered: null,
    };
    if (now == null || !Number.isFinite(now) || !sessionDate || !Array.isArray(rows) || rows.length === 0) {
        out.dataQuality = 'unavailable'; out.dayCheckStatus = 'no-data';
        out.dayCheckReason = (now == null || !Number.isFinite(now)) ? 'no-quote'
                           : !sessionDate ? 'no-ticker-or-session' : 'no-daily-series';
        return out;
    }
    var dc = {}; dc[sym] = rows;
    var vr = resolveVerifiedDailyPrevClose({ ticker: sym, sessionDate: sessionDate, livePx: now, dailyCloses: dc });
    out.dayCheckExpected        = vr.expectedDate || null;
    out.dayCheckCalendarCovered = (vr.calendarCovered != null) ? vr.calendarCovered : null;
    var refDate = vr.date || vr.foundDate || null;
    var row = refDate ? rows.find(function(r) { return r.date === refDate; }) : null;
    if (row) { out.dayCheckYahoo = row.yahoo != null ? row.yahoo : null; out.dayCheckAlt = row.alt != null ? row.alt : null; }
    if (!vr.ok) {
        var MAP = { 'prev-session-missing': 'gap', 'sources-disagree': 'conflict', 'implausible-move': 'implausible' };
        out.dayCheckStatus    = MAP[vr.reason] || 'no-data';
        out.dayCheckReason    = vr.reason || null;
        out.dataQuality       = vr.reason || 'unavailable';
        out.previousCloseDate = refDate;
        return out;
    }
    out.previousClose       = vr.value;
    out.previousCloseDate   = vr.date;
    out.previousCloseSource = 'series:' + vr.status;
    out.daySource           = vr.status;           // verified | yahoo-only | alt-only
    out.dayCheckStatus      = vr.status;
    var raw = isBp ? (now - vr.value) * 100 : isPt ? (now - vr.value) : (now / vr.value - 1) * 100;
    out.day = Number.isFinite(raw) ? raw : null;
    return out;
}

// Parse a liveSymbol 5d/1d chart result. The 1D figure here uses Yahoo's own daily
// rows only; fetchMarketOverviewData then re-runs it with the second source merged
// in (mktApplyDayCheck). _yahooDaily is internal and stripped before rows leave.
function mktParseYahooChartResult(result, inst) {
    try {
        var meta   = result.meta || {};
        var ts     = result.timestamp || [];
        var quote  = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
        var closes = quote.close || [];

        var now = mktSafeFiniteNumber(meta.regularMarketPrice);
        if (now == null) now = mktFindLatestFiniteClose(ts, closes);

        var quoteTs          = mktSafeFiniteNumber(meta.regularMarketTime);
        // Exchange-local session date (FX bars start at London midnight — 23:00 UTC in BST).
        var quoteSessionDate = yahooQuoteSessionDate(meta);
        var yahooDaily       = yahooDailyRowsFromChart(result);

        var dayRes = mktComputeDayFromRows(inst, now, quoteSessionDate, yahooDaily);

        var marketState  = String(meta.marketState || '').trim();
        var quoteAgeMs   = (quoteTs && quoteTs > 0) ? (Date.now() - quoteTs * 1000) : null;
        var qs = mktDeriveQuoteStatus(marketState, quoteTs, Date.now(), inst);

        return Object.assign({ now: now }, dayRes, {
                 quoteSessionDate: quoteSessionDate,
                 quoteTsRaw: quoteTs,
                 marketState: marketState, quoteAgeMs: quoteAgeMs,
                 quoteStatusLabel: qs.label, quoteStatusKind: qs.kind,
                 quoteStatusCompact: qs.compact, feedLabel: qs.feed,
                 source: inst.liveSymbol, error: null,
                 _yahooDaily: yahooDaily });
    } catch(e) {
        return { now: null, day: null, daySource: 'unavailable', dataQuality: 'unavailable',
                 previousClose: null, previousCloseSource: null, previousCloseDate: null,
                 dayCheckStatus: 'no-data',
                 quoteSessionDate: null,
                 marketState: null, quoteAgeMs: null,
                 quoteStatusLabel: 'STALE', quoteStatusKind: 'stale',
                 quoteStatusCompact: 'S', feedLabel: 'failed',
                 source: inst.liveSymbol, error: e.message };
    }
}

// ── Markets: Naver Finance history (Korean indices) ──────────────────────────
// Naver Finance serves daily index closes from public JSON (no key, no cookies).
// Two routes to the same data, tried in order:
//   json   — m.stock.naver.com/api/index/{code}/price  (paged, newest first)
//   fchart — fchart.stock.naver.com/sise.nhn            (one XML response)
// A year of closes is cached per London day. A route that answers "not found" is
// remembered for 7 days; a Worker that doesn't yet allow Naver is reported (not
// remembered) so it works as soon as the Worker is updated. Values are the index
// itself (KRX's published closes) and are checked against Yahoo before use.
const NAVER_HIST_CACHE_KEY = 'naver_hist_cache_v1';   // { CODE: { day, series, via } }
const NAVER_STATUS_KEY     = 'naver_status_v1';        // { 'route:CODE': { reason, until } }

function _naverNum(v) {
    const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
}
function _naverDate(v) {
    const s = String(v == null ? '' : v).trim();
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    const m = s.match(/^(\d{4})[-.](\d{2})[-.](\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
}
function parseNaverPriceJson(json) {
    const arr = Array.isArray(json) ? json : (json && (json.result || json.items || json.datas || json.priceInfos)) || [];
    return (Array.isArray(arr) ? arr : []).map(b => ({
        date:  _naverDate(b && (b.localTradedAt || b.localDate || b.tradeDate || b.bizdate || b.date)),
        close: _naverNum(b && (b.closePrice ?? b.closeValue ?? b.close_val ?? b.close)),
    })).filter(r => r.date && r.close);
}
function parseNaverFchartXml(text) {
    const out = [];
    const re = /data="(\d{8})\|[^|"]*\|[^|"]*\|[^|"]*\|([^|"]+)\|/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
        const d = _naverDate(m[1]), c = _naverNum(m[2]);
        if (d && c) out.push({ date: d, close: c });
    }
    return out;
}
function _naverSortDedupe(rows) {
    const byDate = {};
    rows.forEach(r => { byDate[r.date] = r.close; });
    return Object.keys(byDate).sort().map(d => ({ date: d, close: byDate[d] }));
}
async function _naverGet(url, signal) {
    const res = await proxyFetch(url, signal, { timeoutMs: 15000, allowHttpError: true });
    const text = await res.text();
    if (!res.ok) {
        const e = new Error(/host not allowed/i.test(text)
            ? "your Worker doesn't allow Naver yet \u2014 it redeploys when main changes, so check the latest merge went live"
            : 'HTTP ' + res.status);
        e.httpStatus = res.status; e.workerBlocked = /host not allowed/i.test(text);
        throw e;
    }
    return text;
}
async function fetchNaverIndexHistory(code, sinceDate, signal) {
    const status = _dcLoad(NAVER_STATUS_KEY);
    const reasons = [];
    const routes = [
        ['json', async () => {
            let rows = [];
            for (let page = 1; page <= 6; page++) {
                const text = await _naverGet('https://m.stock.naver.com/api/index/' + encodeURIComponent(code) +
                                             '/price?pageSize=100&page=' + page, signal);
                let json; try { json = JSON.parse(text); } catch { throw new Error('not JSON'); }
                const pageRows = parseNaverPriceJson(json);
                if (pageRows.length === 0) break;
                rows = rows.concat(pageRows);
                if (pageRows.some(r => r.date <= sinceDate)) break;
            }
            return rows;
        }],
        ['fchart', async () => parseNaverFchartXml(await _naverGet(
            'https://fchart.stock.naver.com/sise.nhn?symbol=' + encodeURIComponent(code) + '&timeframe=day&count=420&requestType=0', signal))],
    ];
    for (const [route, run] of routes) {
        const key = route + ':' + code;
        const st = status[key];
        if (st && st.until > Date.now()) {
            reasons.push(route + ': ' + st.reason);
            paSkip('naver', 'route-cooling-off', [code], { detail: { route, reason: st.reason, until: new Date(st.until).toISOString() } });
            continue;
        }
        try {
            const rows = _naverSortDedupe(await run());
            if (rows.length >= 2) return { series: rows, via: route };
            reasons.push(route + ': no daily closes');
        } catch (e) {
            const msg = (e && e.message) || 'failed';
            reasons.push(route + ': ' + msg);
            if (e && e.workerBlocked) break;   // the Worker blocks both routes alike
            if (e && (e.httpStatus === 404 || /not JSON/.test(msg))) {
                status[key] = { reason: msg, until: Date.now() + 7 * 86400000 };
                _dcSave(NAVER_STATUS_KEY, status);
            }
        }
    }
    paNote('naver', 'all routes failed: ' + (reasons.join('; ') || 'no data'), [code]);
    const err = new Error(reasons.join('; ') || 'no data');
    throw err;
}
// Returns { series, note } when Naver's closes match Yahoo's, else { error }.
async function mktNaverHistory(inst, refRows, signal) {
    const code = inst && inst.naverCode;
    if (!code) return null;
    if (!refRows || refRows.length === 0) return { error: 'Naver not tried: no Yahoo closes to check it against' };
    const cache = _dcLoad(NAVER_HIST_CACHE_KEY);
    const today = londonDateStr(Date.now());
    let entry = (cache[code] && cache[code].day === today && Array.isArray(cache[code].series)) ? cache[code] : null;
    if (!entry) {
        const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
        try {
            const r = await fetchNaverIndexHistory(code, since, signal);
            entry = cache[code] = { day: today, series: r.series, via: r.via };
            _dcSave(NAVER_HIST_CACHE_KEY, cache);
        } catch (e) {
            return { error: 'Naver ' + code + ': ' + ((e && e.message) || 'failed') };
        }
    }
    const check = mktVerifyAgainstYahoo(entry.series, refRows, 0.005);
    if (!check.ok) return { error: 'Naver ' + code + ': ' + check.reason };
    return { series: entry.series, note: 'Naver ' + code + ' (' + entry.via + ', matches Yahoo on ' + check.agree + ' days)' };
}

// ── Markets: Naver as the PRIMARY source (inst.primarySource === 'naver') ─────
// Last, 1D and 1M/YTD/12M all come from Naver's daily closes, with no Yahoo
// request and no Yahoo cross-check (Yahoo's own KOSPI 200 series is unreliable).
// With no second source, only checks that need none are applied:
//   • unit slips and isolated spikes removed (cleanHistorySeries)
//   • 1D previous close = the exact previous KRX session, inside the plausibility limit
//   • bad period anchors rejected (mktAnchorIsSpike) and the scale-break guard
//   • a feed that is behind (latest close older than the latest KRX session) is flagged
// The year of closes is fetched once per London day; the latest few days are
// refreshed at most once a minute, so "Last" follows the market during KRX hours.
async function fetchNaverRecent(code, via, signal) {
    if (via === 'fchart') {
        return parseNaverFchartXml(await _naverGet('https://fchart.stock.naver.com/sise.nhn?symbol=' +
            encodeURIComponent(code) + '&timeframe=day&count=10&requestType=0', signal));
    }
    const text = await _naverGet('https://m.stock.naver.com/api/index/' + encodeURIComponent(code) + '/price?pageSize=10&page=1', signal);
    let json; try { json = JSON.parse(text); } catch { throw new Error('not JSON'); }
    return parseNaverPriceJson(json);
}
async function mktNaverSeries(code, signal) {
    const cache = _dcLoad(NAVER_HIST_CACHE_KEY);
    const today = londonDateStr(Date.now());
    let entry = (cache[code] && cache[code].day === today && Array.isArray(cache[code].series)) ? cache[code] : null;
    if (!entry) {
        const since = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
        const r = await fetchNaverIndexHistory(code, since, signal);
        entry = cache[code] = { day: today, series: r.series, via: r.via, recentAt: Date.now() };
        _dcSave(NAVER_HIST_CACHE_KEY, cache);
        return entry;
    }
    if (Date.now() - (entry.recentAt || 0) > 60000) {
        try {
            const recent = await fetchNaverRecent(code, entry.via, signal);
            if (recent.length) {
                entry.series = _naverSortDedupe(entry.series.concat(recent));   // recent bars win on a shared date
                entry.recentAt = Date.now();
                cache[code] = entry;
                _dcSave(NAVER_HIST_CACHE_KEY, cache);
            }
        } catch (e) { /* keep today's cached year; the staleness check below will say if it's behind */ }
    }
    return entry;
}
// Returns { ok:true, live, core, note } or { ok:false, error }.
async function mktNaverPrimary(inst, signal) {
    const code = inst.naverCode;
    const prof = dailyCheckProfileFor(inst.liveSymbol);   // KRX calendar + plausibility limit
    let entry;
    try { entry = await mktNaverSeries(code, signal); }
    catch (e) { return { ok: false, error: 'Naver ' + code + ': ' + ((e && e.message) || 'failed') }; }
    const clean = cleanHistorySeries(entry.series, prof);
    const series = clean.rows;
    if (series.length < 2) return { ok: false, error: 'Naver ' + code + ': too few closes' };

    const nowMs  = Date.now();
    const latest = series[series.length - 1];
    const krx    = exchangeClock('Asia/Seoul', nowMs);
    const open   = isExchangeOpenAt('KRX', nowMs);
    const quoteTs = (open && latest.date === krx.date)
        ? Math.floor(nowMs / 1000)
        : Math.floor(Date.parse(latest.date + 'T15:30:00+09:00') / 1000);
    const rows = series.map(r => ({ date: r.date, close: r.close, status: 'naver' }));
    const day  = mktComputeDayFromRows(inst, latest.close, latest.date, rows);
    const qs   = mktDeriveQuoteStatus(open ? 'REGULAR' : 'CLOSED', quoteTs, nowMs, inst);

    // Behind? Latest close should be today's (from 15 min after the open) or the last session's.
    const tradingToday = isExchangeTradingDay('KRX', krx);
    const expected = (tradingToday && krx.minutes >= 9 * 60 + 15) ? krx.date
                   : (previousExchangeSession('KRX', krx.date) || {}).date;
    const notes = [];
    if (expected && latest.date < expected) notes.push("Naver's latest close is " + latest.date + ' (expected ' + expected + ')');
    if (clean.dropped.length) notes.push('Naver bad data removed: ' + clean.dropped.map(d => d.date + ' ' + d.reason).join(', '));

    const core = Object.assign(mktHistoryCoreFromSeries(series, inst), {
        historyNote: 'Naver ' + code + ' (' + entry.via + ', ' + series.length + ' closes)',
    });
    return {
        ok: true, core, note: notes.join(' \u00b7 ') || null,
        live: Object.assign({
            now: latest.close, quoteSessionDate: latest.date, quoteTsRaw: quoteTs,
            marketState: open ? 'REGULAR' : 'CLOSED', quoteAgeMs: nowMs - quoteTs * 1000,
            quoteStatusLabel: qs.label, quoteStatusKind: qs.kind, quoteStatusCompact: qs.compact,
            feedLabel: 'Naver', source: 'NAVER:' + code, error: null, _yahooDaily: null,
        }, day),
    };
}

// ── Markets: Twelve Data history fallback ────────────────────────────────────
// Used only when Yahoo's history can't support 1M / YTD / 12M. Costs 1 credit per
// symbol per day at most: the year of closes is cached in localStorage for the
// London day. A symbol Twelve Data rejects as unknown or not on your plan is
// remembered for 7 days so it isn't retried on every refresh; credit-limit and
// network errors are treated as temporary and retried on the next refresh.
const TD_HIST_CACHE_KEY    = 'td_hist_cache_v1';     // { SYM: { day, series } }
const TD_SYMBOL_STATUS_KEY = 'td_symbol_status_v2';  // { SYM[@EXCH]: { reason, until } } (v2: v1 stored bare "HTTP 404"s without Twelve Data's reason)
const TD_DISCOVERY_KEY     = 'td_symbol_discovery_v1'; // { INST_ID: { at, found: [{symbol, exchange}] } }

// Twelve Data answers errors with a JSON body ({code, message}) and often a matching
// HTTP status. The body is read either way, so the row shows Twelve Data's own reason
// ("symbol not found", "available on the Grow plan", …) rather than a bare "HTTP 404".
async function _tdGetJson(url, signal) {
    const res = await proxyFetch(url, signal, { timeoutMs: 20000, allowHttpError: true });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!json) {
        const e = new Error(res.ok ? 'Twelve Data returned something other than JSON' : 'HTTP ' + res.status);
        e.tdCode = res.ok ? null : res.status;
        throw e;
    }
    if (json.status === 'error' || !res.ok) {
        const e = new Error('Twelve Data: ' + String(json.message || ('HTTP ' + res.status)).replace(/\*\*/g, ''));
        e.tdCode = json.code || res.status;
        throw e;
    }
    if (Array.isArray(json.values) || Array.isArray(json.data)) paAnnotate(res, { rows: (json.values || json.data).length });
    else paAnnotate(res, { rows: 0, outcome: 'failed', category: 'no-data', message: 'response has neither values nor data', bodyExcerpt: text.slice(0, 600) });
    return json;
}
async function fetchTwelveDataHistory(tdSymbol, outputsize, signal, exchange) {
    const key = getTdApiKey();
    if (!key) throw new Error('no Twelve Data API key set');
    const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(tdSymbol) +
        (exchange ? '&exchange=' + encodeURIComponent(exchange) : '') +
        '&interval=1day&outputsize=' + (outputsize || 400) + '&apikey=' + encodeURIComponent(key);
    const json = await _tdGetJson(url, signal);
    if (!Array.isArray(json.values)) {
        const e = new Error('Twelve Data: no data for ' + tdSymbol);
        e.tdCode = json.code || null;
        throw e;
    }
    return json.values
        .map(v => ({ date: String(v.datetime).slice(0, 10), close: Number(v.close) }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
}

// Twelve Data's own symbol search. Returns [{symbol, name, type, exchange, country}].
async function fetchTwelveDataSymbolSearch(query, signal) {
    const key = getTdApiKey();
    if (!key) throw new Error('no Twelve Data API key set');
    const url = 'https://api.twelvedata.com/symbol_search?symbol=' + encodeURIComponent(query) +
        '&outputsize=30&apikey=' + encodeURIComponent(key);
    const json = await _tdGetJson(url, signal);
    return (Array.isArray(json.data) ? json.data : []).map(d => ({
        symbol: d.symbol, name: d.instrument_name || '', type: d.instrument_type || '',
        exchange: d.exchange || d.mic_code || null, country: d.country || '',
    }));
}

// Check a Twelve Data series against Yahoo closes on the days both have. Every
// shared day must agree within tolerance, and at least 2 must exist. One
// disagreement rejects the whole series (it may be a different series or scale).
function mktVerifyAgainstYahoo(series, refRows, tol) {
    tol = Number.isFinite(tol) ? tol : 0.005;
    const m = {};
    (series || []).forEach(p => { m[p.date] = p.close; });
    let agree = 0, firstBad = null, bad = 0;
    (refRows || []).forEach(r => {
        const c = m[r.date];
        if (!(c > 0) || !(r.close > 0)) return;
        if (Math.abs(c / r.close - 1) <= tol) agree++;
        else { bad++; if (!firstBad) firstBad = r.date; }
    });
    if (bad) return { ok: false, agree, reason: 'differs from Yahoo on ' + firstBad + (bad > 1 ? ' (+' + (bad - 1) + ' more)' : '') };
    if (agree < 2) return { ok: false, agree, reason: agree === 0 ? 'no shared days with Yahoo to check against' : 'only 1 shared day with Yahoo to check against' };
    return { ok: true, agree };
}

// Try the instrument's tdSymbols in order; if Twelve Data knows none of them,
// ask its symbol search (inst.tdSearch) for the index by name and try what it
// returns. Discovery only accepts an instrument whose type is an index and whose
// name matches inst.tdNameMatch exactly — never an ETF, future or other proxy —
// and is cached for 30 days. Returns { series, symbol, note } for the first
// symbol Twelve Data serves AND that matches Yahoo, else { error }.
async function mktTwelveDataHistory(inst, refRows, signal) {
    const syms = (inst && inst.tdSymbols) || [];
    if (!syms.length && !(inst && inst.tdSearch)) return null;
    if (!getTdApiKey()) return { error: 'Twelve Data: no API key set' };
    // Nothing from Yahoo to check it against → it could never be trusted, so don't spend credits.
    if (!refRows || refRows.length === 0) return { error: 'Twelve Data not tried: no Yahoo closes to check it against' };
    const status = _dcLoad(TD_SYMBOL_STATUS_KEY), cache = _dcLoad(TD_HIST_CACHE_KEY);
    const today = londonDateStr(Date.now());
    const reasons = [];   // every symbol's reason, so the most useful one isn't lost
    let allNotFound = true;

    async function tryOne(sym, exch) {
        const key = sym + (exch ? '@' + exch : '');
        const st = status[key];
        if (st && st.until > Date.now()) { reasons.push(key + ': ' + st.reason); if (!/not found|invalid/i.test(st.reason)) allNotFound = false; return null; }
        let series = (cache[key] && cache[key].day === today && Array.isArray(cache[key].series)) ? cache[key].series : null;
        if (!series) {
            if (_tdCreditsAvailable() < 1) { allNotFound = false; reasons.push('credit limit reached this minute, retried next refresh'); return 'stop'; }
            _tdSpendCredits(1);
            try {
                series = await fetchTwelveDataHistory(sym, 400, signal, exch);
            } catch (e) {
                const msg = ((e && e.message) || 'request failed').replace(/^Twelve Data:\s*/, '');
                const temporary = e.tdCode === 429 || e.timeout || /credit|minute|limit|timed out|HTTP 5|network|Load failed|fetch/i.test(msg);
                if (!/not found|invalid|HTTP 404/i.test(msg) || e.tdCode === 403) allNotFound = false;
                if (!temporary) {
                    status[key] = { reason: msg.slice(0, 110), until: Date.now() + 7 * 86400000 };
                    _dcSave(TD_SYMBOL_STATUS_KEY, status);
                }
                reasons.push(key + ': ' + msg.slice(0, 110));
                return null;
            }
            cache[key] = { day: today, series };
            _dcSave(TD_HIST_CACHE_KEY, cache);
        }
        allNotFound = false;
        const check = mktVerifyAgainstYahoo(series, refRows, 0.005);
        if (!check.ok) { reasons.push(key + ': ' + check.reason); return null; }
        return { series, symbol: key, note: 'Twelve Data ' + key + ' (matches Yahoo on ' + check.agree + ' days)' };
    }

    for (const s of syms) {
        const r = await tryOne(s, null);
        if (r === 'stop') return { error: 'Twelve Data ' + reasons.join('; ') };
        if (r) return r;
    }
    // None of the configured symbols exist on Twelve Data: look the index up by name.
    if (allNotFound && inst.tdSearch) {
        const disc = _dcLoad(TD_DISCOVERY_KEY);
        let entry = disc[inst.id];
        if (!(entry && entry.at > Date.now() - 30 * 86400000)) {
            if (_tdCreditsAvailable() < 1) return { error: 'Twelve Data ' + reasons.concat('credit limit reached this minute, retried next refresh').join('; ') };
            _tdSpendCredits(1);
            try {
                const re = new RegExp(inst.tdNameMatch || '^$', 'i');
                const found = (await fetchTwelveDataSymbolSearch(inst.tdSearch, signal))
                    .filter(d => /index/i.test(d.type) && re.test(String(d.name).trim()) &&
                                 (!inst.tdCountry || new RegExp(inst.tdCountry, 'i').test(d.country)))
                    .slice(0, 2).map(d => ({ symbol: d.symbol, exchange: d.exchange }));
                entry = disc[inst.id] = { at: Date.now(), found };
                _dcSave(TD_DISCOVERY_KEY, disc);
            } catch (e) {
                reasons.push('symbol search: ' + String((e && e.message) || 'failed').replace(/^Twelve Data:\s*/, '').slice(0, 90));
                entry = null;
            }
        }
        if (entry && entry.found.length === 0) reasons.push('symbol search found no ' + inst.tdSearch + ' index');
        for (const d of (entry ? entry.found : [])) {
            if (syms.includes(d.symbol) && !d.exchange) continue;
            const r = await tryOne(d.symbol, d.exchange);
            if (r === 'stop') break;
            if (r) return r;
        }
    }
    return { error: 'Twelve Data ' + (reasons.join('; ') || 'no usable symbol') };
}

// ── Markets history helpers ──────────────────────────────────────────────────
// An anchor is an isolated spike when it differs from BOTH neighbouring closes
// by more than the instrument's one-day plausibility limit, in the same
// direction, while the neighbours agree with each other. A genuine big move
// (a jump that holds) differs from only one neighbour and is kept.
function mktAnchorIsSpike(series, anchor, limit) {
    if (!anchor || !series) return false;
    var i = series.indexOf(anchor);
    if (i <= 0 || i >= series.length - 1) return false;
    var a = series[i - 1].close, b = anchor.close, c = series[i + 1].close;
    var up = b / a - 1, down = b / c - 1;
    return Math.abs(up) > limit && Math.abs(down) > limit && Math.sign(up) === Math.sign(down)
        && Math.abs(c / a - 1) <= limit;
}
// Anchors a history supports (0–3); 0 if its latest close is >10 days before
// the live quote's session (a frozen feed would give stale period returns).
function mktHistoryScore(core, liveSessionDate) {
    if (!core || core.historyError) return 0;
    if (liveSessionDate && core.returnAsOfDate) {
        var gap = (new Date(liveSessionDate + 'T12:00:00Z') - new Date(core.returnAsOfDate + 'T12:00:00Z')) / 86400000;
        if (gap > 10) return 0;
    }
    return (core.m1AnchorClose ? 1 : 0) + (core.ytdAnchorClose ? 1 : 0) + (core.y1AnchorClose ? 1 : 0);
}
// Join an older series with a more recent one: older rows before the recent
// series starts, then the recent series. Only if ≥3 overlapping dates agree
// within 0.5% (same instrument, same scale) and the older series really does
// reach further back. Returns the joined series or null.
function mktStitchSeries(older, recent) {
    if (!older || !recent || older.length === 0 || recent.length === 0) return null;
    if (older[0].date >= recent[0].date) return null;
    var rMap = {}; recent.forEach(function(p) { rMap[p.date] = p.close; });
    var overlap = older.filter(function(p) { return rMap[p.date] != null; });
    if (overlap.length < 3) return null;
    for (var k = 0; k < overlap.length; k++) {
        if (Math.abs(overlap[k].close / rMap[overlap[k].date] - 1) > 0.005) return null;
    }
    var start = recent[0].date;
    return older.filter(function(p) { return p.date < start; }).concat(recent);
}

// ── Markets: symbol fallback + 1D third reference ─────────────────────────────
// Session-only memory of which Yahoo symbol last worked per instrument, so a
// fallback symbol costs one extra request once, not on every refresh.
var MKT_SYMBOL_PREF = {};

function mktLiveResultUsable(r) {
    return !!(r && r.meta && mktSafeFiniteNumber(r.meta.regularMarketPrice) != null &&
              yahooDailyRowsFromChart(r).length >= 2);
}

// From a range=1d chart: the close of the session before the quote's session.
function mktQuoteWitnessFromChart(cr) {
    var meta = (cr && cr.meta) || {};
    var prev = mktSafeFiniteNumber(meta.chartPreviousClose);
    if (prev == null) prev = mktSafeFiniteNumber(meta.previousClose);
    if (prev == null) return null;
    return { prevClose: prev, sessionDate: yahooQuoteSessionDate(meta) };
}

// Use the quote-level previous close to settle a blank 1D (mutates row).
//   conflict → two-out-of-three: take whichever of Yahoo's bar / the second
//              source matches the quote's previous close; neither → stays blank.
//   no-data / gap → the quote's previous close, single source ('yahoo-quote').
// Always: same session as the row's quote, and inside the instrument's
// plausibility limit; otherwise the row stays blank with a note saying why.
function mktApplyQuoteWitness(row, w) {
    if (!row) return false;
    if (!w || !(w.prevClose > 0)) { row.dayWitnessNote = 'Yahoo quote has no previous close'; return false; }
    if (w.sessionDate && row.quoteSessionDate && w.sessionDate !== row.quoteSessionDate) {
        row.dayWitnessNote = 'Yahoo quote is for ' + w.sessionDate; return false;
    }
    var prof = dailyCheckProfileFor(row.liveSymbol);
    var isBp = row.displayKind === 'bpChange';
    var isPt = row.displayKind === 'ptChange';
    var chosen = null, status = null;
    if (row.dayCheckStatus === 'conflict') {
        var y = Number(row.dayCheckYahoo), a = Number(row.dayCheckAlt);
        var agreeY = y > 0 && Math.abs(y / w.prevClose - 1) <= prof.tolerance;
        var agreeA = a > 0 && Math.abs(a / w.prevClose - 1) <= prof.tolerance;
        if (agreeY)      { chosen = y; status = 'verified-2of3'; }
        else if (agreeA) { chosen = a; status = 'verified-2of3'; }
        else { row.dayWitnessNote = 'Yahoo quote matches neither'; return false; }
    } else {
        chosen = w.prevClose; status = 'yahoo-quote';
    }
    if (Math.abs(row.now / chosen - 1) > prof.maxMove) { row.dayWitnessNote = 'quote move beyond plausibility limit'; return false; }
    var raw = isBp ? (row.now - chosen) * 100 : isPt ? (row.now - chosen) : (row.now / chosen - 1) * 100;
    if (!Number.isFinite(raw)) return false;
    row.dayWitnessFrom      = row.dayCheckReason || row.dayCheckStatus;
    row.day                 = raw;
    row.previousClose       = chosen;
    row.previousCloseSource = 'quote:' + status;
    row.daySource           = status;
    row.dayCheckStatus      = status;
    row.dataQuality         = row.liveError ? 'stale' : 'ok';
    row.dayWitnessNote      = null;
    return true;
}

// Re-compute a Markets row's 1D with its second source merged in (mutates row).
function mktApplyDayCheck(row, sec) {
    var sym = String(row.liveSymbol || '').toUpperCase().trim();
    var merged = mergeYahooWithSecondary(sym, row._yahooDaily || [], sec, row.now);
    var res = mktComputeDayFromRows(row, row.now, row.quoteSessionDate, merged.rows);
    Object.assign(row, res, {
        dayCheckProvider:     sec ? (sec.provider || null) : null,
        dayCheckError:        sec ? (sec.error || null) : null,
        dayCheckPending:      !!(sec && sec.pending),
        dayCheckUnitMismatch: !!merged.unitMismatch,
    });
    // A live-fetch failure still wins as the row's data quality.
    if (row.liveError) row.dataQuality = 'stale';
}

// A plain, always-available line showing exactly what a row's figures came from:
// live/1D source and previous close, plus the anchor date and price behind each
// period return. This is what lets a number be checked against another source
// (Bloomberg, Investing.com, ...) without an export — tap any row to see it.
function mktFmtAnchorPx(v) {
    if (v == null || !Number.isFinite(v)) return null;
    return Math.abs(v) >= 100 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(5);
}
function mktFmtAnchorDate(d) {
    if (!d) return null;
    var p = String(d).split('-');
    return p.length === 3 ? p[2] + ' ' + ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(p[1])] + " '" + p[0].slice(2) : d;
}
function mktBuildSourceLine(row) {
    var parts = [];
    var src = row.primarySource === 'naver' ? 'Naver' : (row.fetchedLiveSymbol || row.source || 'Yahoo');
    parts.push(src);
    var pc = mktFmtAnchorPx(row.previousClose);
    if (pc) parts.push('prev ' + pc + (row.previousCloseDate ? ' (' + mktFmtAnchorDate(row.previousCloseDate) + ')' : ''));
    [['1M', row.m1AnchorDate, row.m1AnchorClose], ['YTD', row.ytdAnchorDate, row.ytdAnchorClose], ['12M', row.y1AnchorDate, row.y1AnchorClose]]
        .forEach(function(a) {
            var px = mktFmtAnchorPx(a[2]);
            if (px && a[1]) parts.push(a[0] + ' anchor ' + px + ' (' + mktFmtAnchorDate(a[1]) + ')');
        });
    return parts.join(' \u00b7 ');
}

// Compact move: drops the % sign for pctReturn rows (colour + sign are enough
// in the table context). Rates keep the bp suffix unless noUnit is set — the
// Markets table passes it because its column headers already say "bp".
function mktFmtCompact(row, value, decimals, noUnit) {
    if (value == null || !Number.isFinite(value)) return '\u2014';
    if (row.displayKind === 'bpChange') {
        return (value >= 0 ? '+' : '') + Math.round(value) + (noUnit ? '' : 'bp');
    }
    if (row.displayKind === 'ptChange') return (value >= 0 ? '+' : '') + value.toFixed(2);
    var dp = (decimals != null) ? decimals : 1;
    return (value >= 0 ? '+' : '') + value.toFixed(dp);
}

// Compact status chip label — accepts a row object or a plain label string.
// Prefers row.quoteStatusCompact (set by mktDeriveQuoteStatus) over legacy label map.
function mktCompactChip(rowOrLabel) {
    if (rowOrLabel && typeof rowOrLabel === 'object' && rowOrLabel.quoteStatusCompact) {
        return rowOrLabel.quoteStatusCompact;
    }
    var label = typeof rowOrLabel === 'string'
        ? rowOrLabel
        : (rowOrLabel && rowOrLabel.quoteStatusLabel) || '';
    label = String(label).toUpperCase();
    var map = {
        OPEN: 'O', LIVE: 'O', DELAYED: 'O',
        PRE: 'PRE', POST: 'POST',
        CLOSED: 'C', CACHED: 'K', STALE: 'S'
    };
    return map[label] || label.slice(0, 4) || 'C';
}

// ── buildHoldingMarketInstruments ─────────────────────────────────────────────
// Derives a Holdings instrument list from active portfolio holdings + restricted
// comp configs. Module-scope so it can reference BASE_MARKET_OVERVIEW_INSTRUMENTS
// and GILT_LADDER_REGISTRY without being trapped inside PortfolioApp's closure.
// Returns rows compatible with the existing fetch pipeline.
var MKT_PSEUDO_TICKERS = new Set([
    'N/A','NA','UNTICKERED','CASH','JPM_MM','VANG_MM','ABRDN_MM',
]);

function buildHoldingMarketInstruments(activeHoldingsWithDelta, compConfigs) {
    // Tickers already covered by base instruments — don't duplicate
    var baseLiveSymbols = new Set(BASE_MARKET_OVERVIEW_INSTRUMENTS.map(function(i) { return i.liveSymbol; }));

    function isPseudo(tk) {
        if (!tk) return true;
        var u = tk.toUpperCase();
        if (MKT_PSEUDO_TICKERS.has(u)) return true;
        if (u.indexOf('_MM') !== -1) return true;
        return false;
    }

    function isGilt(tk) {
        if (!tk) return false;
        if (GILT_LADDER_REGISTRY && GILT_LADDER_REGISTRY[tk]) return true;
        // UK gilt ticker patterns: TG, TN, T26-T40
        return /^T(G|N|2[6-9]|[3-4]\d)/.test(tk);
    }

    var seen = new Set();
    var rows = [];

    // ── Active portfolio holdings ────────────────────────────────────────────
    (activeHoldingsWithDelta || []).forEach(function(h) {
        var tk = String(h.ticker || '').toUpperCase().trim();
        if (!tk || isPseudo(tk) || isGilt(tk)) return;
        if (seen.has(tk) || baseLiveSymbols.has(tk)) return;
        seen.add(tk);
        rows.push({
            id:           'HOLDING:' + tk,
            label:        tk,
            type:         'Hold',
            section:      'Holdings',
            displayKind:  'pctReturn',
            liveSymbol:   tk,
            returnSymbol: tk,
            source:       'holding',
            holdingName:  h.name || h.displayName || tk,
            holdingValue: (h.marketValue != null && Number.isFinite(h.marketValue)) ? h.marketValue : null,
        });
    });

    // ── Restricted equity underlyings from comp configs ──────────────────────
    (compConfigs || []).forEach(function(plan) {
        var tk = String(
            plan.yahoo_ticker || plan.yahooTicker ||
            plan.ticker || plan.underlyingTicker || plan.underlying_ticker || ''
        ).toUpperCase().trim();
        if (!tk || tk === 'N/A' || isPseudo(tk) || isGilt(tk)) return;
        if (seen.has(tk) || baseLiveSymbols.has(tk)) return;
        seen.add(tk);
        rows.push({
            id:           'HOLDING:' + tk,
            label:        tk,
            type:         'Hold',
            section:      'Holdings',
            displayKind:  'pctReturn',
            liveSymbol:   tk,
            returnSymbol: tk,
            source:       'restricted',
            holdingName:  ((plan.institution || '') + ' ' + (plan.plan_type || plan.category || '')).trim(),
            holdingValue: null,
        });
    });

    // Sort: valued holdings largest first, then unvalued alphabetically
    rows.sort(function(a, b) {
        if (a.holdingValue != null && b.holdingValue != null) return b.holdingValue - a.holdingValue;
        if (a.holdingValue != null) return -1;
        if (b.holdingValue != null) return  1;
        return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });

    return rows;
}

// ── fetchMarketOverviewData ───────────────────────────────────────────────────
// Live (Now/Day): always fetches liveSymbol 5d/1d fresh.
// History (1M/YTD/12M): MARKET_HISTORY_CACHE TTL 30 min; forceHistory bypasses.
// Independent live / history failures preserved per row.
async function fetchMarketOverviewData(opts) {
    opts = opts || {};
    var signal       = opts.signal || null;
    var forceHistory = !!opts.forceHistory;
    var instruments  = opts.instruments || BASE_MARKET_OVERVIEW_INSTRUMENTS;

    if (!navigator.onLine) {
        return { rows: null, okCount: 0, failCount: instruments.length,
                 updatedAt: Date.now(), errors: ['offline'], offline: true };
    }
    if (!getWorkerUrl()) {
        return { rows: null, okCount: 0, failCount: instruments.length,
                 updatedAt: Date.now(), errors: ['no worker URL configured'], offline: false };
    }

    // The 2y history call returns a much larger payload than the 5d live chart —
    // give it more room before timing out under load, rather than sharing the
    // 5d call's tighter budget.
    async function mktYahooFetch(symbol, range) {
        var timeoutMs = (range === '2y') ? 20000 : NET_TIMEOUT_MS;
        return mktYahooFetchUrl(mktBuildYahooChartUrl(symbol, range, '1d'), timeoutMs);
    }
    // Same history, requested with explicit dates instead of a range keyword. Yahoo
    // sometimes serves the two differently for the same symbol.
    async function mktYahooFetchDated(symbol, days) {
        var nowS = Math.floor(Date.now() / 1000);
        var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
                  '?period1=' + (nowS - days * 86400) + '&period2=' + (nowS + 86400) + '&interval=1d';
        return mktYahooFetchUrl(url, 20000);
    }
    async function mktYahooFetchUrl(url, timeoutMs) {
        var res = await proxyFetch(url, signal, { timeoutMs: timeoutMs });
        var j   = JSON.parse(await res.text());
        var cr  = j && j.chart && j.chart.result && j.chart.result[0];
        if (!cr) throw new Error((j && j.chart && j.chart.error && j.chart.error.description) || 'no chart result');
        paYahooResult(res, cr, null);
        return cr;
    }

    async function mktProcessOneInstrument(inst) {
            // ── Live: fetch then IMMEDIATELY parse ────────────────────────────
            // Symbols are tried in order (last-good first, then primary, then
            // inst.altSymbols) until one returns a quote WITH daily bars. A quote
            // without bars is kept as a fallback so "Last" still shows.
            // Naver-primary instruments: everything from Naver; Yahoo only if Naver fails.
            var naverPrimary = null, primaryNote = null;
            if (inst.primarySource === 'naver' && inst.naverCode) {
                naverPrimary = await mktNaverPrimary(inst, signal);
                if (!naverPrimary.ok) { primaryNote = naverPrimary.error + ' \u2014 using Yahoo'; naverPrimary = null; }
                else primaryNote = naverPrimary.note;
            }
            var liveResult = null, liveError = null, liveSymbolUsed = inst.liveSymbol;
            var liveTry = naverPrimary ? { result: null, symbol: 'NAVER:' + inst.naverCode, error: null }
                                       : await mktFetchFirstUsable(inst, 'live', '5d', mktLiveResultUsable);
            liveResult = liveTry.result; liveError = liveTry.result ? null : liveTry.error;
            if (liveTry.symbol) liveSymbolUsed = liveTry.symbol;

            // liveParsed must be assigned BEFORE history processing so that
            // mktComputePeriodReturnsFromHistoryCore receives the correct live quote.
            var liveParsed = naverPrimary ? naverPrimary.live : liveResult
                ? mktParseYahooChartResult(liveResult, inst)
                : { now: null, day: null, daySource: 'unavailable', dataQuality: 'stale',
                    previousClose: null, previousCloseSource: null,
                    quoteSessionDate: null, quoteTsRaw: null,
                    marketState: null, quoteAgeMs: null,
                    quoteStatusLabel: 'STALE', quoteStatusKind: 'stale',
                    quoteStatusCompact: 'S', feedLabel: 'failed',
                    source: inst.liveSymbol, error: liveError };

            // ── History: cache stores anchor data ONLY, not final returns ─────
            // Final m1/ytd/y1 are always recomputed fresh below using liveParsed.
            var historyCore = null;
            var historyFromCache = false, historyStale = false, historyCacheAgeMs = 0;
            var histFetchError = null;

            var cached   = MARKET_HISTORY_CACHE[inst.returnSymbol];
            var cacheAge = cached ? (Date.now() - cached.at) : Infinity;
            var useCached = !forceHistory && (cacheAge < MARKET_HISTORY_TTL_MS) &&
                            cached && cached.historyCore;

            var historySymbolUsed = (cached && cached.symbol) || inst.returnSymbol;
            if (naverPrimary) {
                historyCore       = naverPrimary.core;
                historySymbolUsed = 'NAVER:' + inst.naverCode;
            } else if (useCached) {
                historyCore      = cached.historyCore;
                historyFromCache = true;
                historyCacheAgeMs = cacheAge;
            } else {
                try {
                    // Pick the history that can support 1M / YTD / 12M (see mktFetchBestHistory).
                    var histTry = await mktFetchBestHistory(inst, liveParsed.quoteSessionDate, liveParsed._yahooDaily);
                    if (!histTry.core) throw new Error(histTry.error || 'history fetch failed');
                    historySymbolUsed = histTry.symbol || inst.returnSymbol;
                    historyCore = Object.assign({}, histTry.core, { historyNote: histTry.note || null });
                    // Only cache a usable history: an error result would otherwise be
                    // served for the full 30-minute TTL instead of being retried.
                    if (!historyCore.historyError) {
                        MARKET_HISTORY_CACHE[inst.returnSymbol] = { at: Date.now(), historyCore: historyCore, symbol: historySymbolUsed };
                    }
                } catch(e) {
                    histFetchError = (e && e.message) || 'history fetch failed';
                    if (cached && cached.historyCore) {
                        historyCore      = cached.historyCore;
                        historyFromCache = true;
                        historyStale     = true;
                        historyCacheAgeMs = cacheAge;
                    } else {
                        historyCore = { returnAsOfDate: null, returnLatestClose: null,
                                        m1AnchorDate: null,  m1AnchorClose: null,
                                        ytdAnchorDate: null, ytdAnchorClose: null,
                                        y1AnchorDate: null,  y1AnchorClose: null,
                                        historyError: histFetchError, historyDataQuality: 'failed' };
                    }
                }
            }

            // ── Period returns: recomputed every refresh with latest live quote ─
            // The live price may be the period-return numerator only when it came from
            // the same Yahoo symbol as the history anchors (a fallback symbol can be
            // quoted on a different scale).
            var periods = mktComputePeriodReturnsFromHistoryCore(
                historyCore,
                // (for a joined history 'A+B', the recent part B is what matters)
                Object.assign({}, inst, { liveSymbol: liveSymbolUsed, returnSymbol: String(historySymbolUsed).split('+').pop() }),
                liveParsed.now, liveParsed.quoteSessionDate
            );

            var hasData = (liveParsed.now != null || liveParsed.day != null ||
                           periods.m1 != null || periods.ytd != null || periods.y1 != null);

            // Derive status chip — degrade to CACHED/STALE only when live fetch itself failed
            var qsl = liveError
                ? (historyFromCache ? 'CACHED' : 'STALE')
                : (liveParsed.quoteStatusLabel   || 'CLOSED');
            var qsk = liveError
                ? (historyFromCache ? 'cached' : 'stale')
                : (liveParsed.quoteStatusKind    || 'closed');
            var qsc = liveError
                ? (historyFromCache ? 'K' : 'S')
                : (liveParsed.quoteStatusCompact || 'C');
            var qfl = liveError
                ? (historyFromCache ? 'cached' : 'failed')
                : (liveParsed.feedLabel          || 'unknown');
            // Note: historyStale/historyFromCache are preserved on the row for the
            // diagnostic strip, but must NOT override a valid live/last quote status.

            return {
                id: inst.id, label: inst.label, type: inst.type,
                section: inst.section, displayKind: inst.displayKind,
                liveSymbol: inst.liveSymbol, returnSymbol: inst.returnSymbol,
                nowDecimals: inst.nowDecimals != null ? inst.nowDecimals : null,
                riskColorMode:       inst.riskColorMode    || null,
                excludeFromTopMovers: !!inst.excludeFromTopMovers,
                dataQuality:         liveError ? 'stale' : (liveParsed.dataQuality || 'ok'),
                now:                 liveParsed.now,
                day:                 liveParsed.day,
                daySource:           liveParsed.daySource  || null,
                previousClose:       liveParsed.previousClose,
                previousCloseSource: liveParsed.previousCloseSource,
                previousCloseDate:   liveParsed.previousCloseDate || null,
                dayCheckStatus:      liveParsed.dayCheckStatus || null,
                dayCheckReason:      liveParsed.dayCheckReason || null,
                dayCheckExpected:    liveParsed.dayCheckExpected || null,
                dayCheckYahoo:       liveParsed.dayCheckYahoo != null ? liveParsed.dayCheckYahoo : null,
                dayCheckAlt:         liveParsed.dayCheckAlt != null ? liveParsed.dayCheckAlt : null,
                dayCheckCalendarCovered: liveParsed.dayCheckCalendarCovered != null ? liveParsed.dayCheckCalendarCovered : null,
                dayCheckProvider:    null,
                dayCheckError:       null,
                dayCheckPending:     false,
                _yahooDaily:         liveParsed._yahooDaily || null,
                fetchedLiveSymbol:   liveSymbolUsed,
                fetchedHistorySymbol: historySymbolUsed,
                primarySource:       naverPrimary ? 'naver' : null,
                primaryNote:         primaryNote,
                historyNote:         (historyCore && historyCore.historyNote) || null,
                historySeriesCount:  (historyCore && historyCore.historySeriesCount) || null,
                historyFirstDate:    (historyCore && historyCore.historyFirstDate) || null,
                periodNullReasons:   periods.periodNullReasons || null,
                quoteSessionDate:    liveParsed.quoteSessionDate,
                quoteTsRaw:          liveParsed.quoteTsRaw          || null,
                marketState:         liveParsed.marketState          || null,
                quoteAgeMs:          liveParsed.quoteAgeMs           || null,
                quoteStatusLabel:    qsl,
                quoteStatusKind:     qsk,
                quoteStatusCompact:  qsc,
                feedLabel:           qfl,
                observedUpdating:    false,
                lastObservedUpdateAt: null,
                m1:                  periods.m1,
                ytd:                 periods.ytd,
                y1:                  periods.y1,
                returnAsOfDate:      historyCore.returnAsOfDate,
                returnLatestClose:   historyCore.returnLatestClose,
                m1AnchorDate:        historyCore.m1AnchorDate   || null,
                m1AnchorClose:       historyCore.m1AnchorClose  || null,
                ytdAnchorDate:       historyCore.ytdAnchorDate  || null,
                ytdAnchorClose:      historyCore.ytdAnchorClose || null,
                y1AnchorDate:        historyCore.y1AnchorDate   || null,
                y1AnchorClose:       historyCore.y1AnchorClose  || null,
                periodCurrentSource: periods.periodCurrentSource || null,
                periodCurrentDate:   periods.periodCurrentDate   || null,
                periodCurrentClose:  periods.periodCurrentClose  || null,
                periodDataQuality:   periods.periodDataQuality   || null,
                periodSource:        inst.returnSymbol,
                historyFromCache:    historyFromCache,
                historyStale:        historyStale,
                historyCacheAgeMs:   historyCacheAgeMs,
                source:              inst.liveSymbol,
                liveError:           liveError || liveParsed.error || null,
                historyError:        (historyCore && historyCore.historyError) || histFetchError || null,
                error:               hasData ? null : (liveError || histFetchError || 'no data'),
            };
    }

    // Try an instrument's candidate symbols in order until one gives a usable
    // result. Returns { result, symbol, error }. If none is usable, the first
    // result that at least had a quote is returned (so "Last" can still show),
    // flagged partial:true. The symbol that worked is remembered for the session.
    async function mktFetchFirstUsable(inst, kind, range, usableFn) {
        var prefKey = inst.id + ':' + kind;
        var primary = kind === 'hist' ? inst.returnSymbol : inst.liveSymbol;
        var cands = [MKT_SYMBOL_PREF[prefKey], primary].concat(inst.altSymbols || [])
            .filter(function(s, i, a) { return s && a.indexOf(s) === i; });
        var partial = null, partialSym = null, lastErr = null;
        for (var ci = 0; ci < cands.length; ci++) {
            try {
                var r = await mktYahooFetch(cands[ci], range);
                if (usableFn(r)) { MKT_SYMBOL_PREF[prefKey] = cands[ci]; return { result: r, symbol: cands[ci], error: null }; }
                if (!partial && r && r.meta && mktSafeFiniteNumber(r.meta.regularMarketPrice) != null) { partial = r; partialSym = cands[ci]; }
                lastErr = cands[ci] + ': no usable daily bars';
            } catch (e) {
                lastErr = cands[ci] + ': ' + ((e && e.message) || 'fetch failed');
            }
        }
        if (partial) return { result: partial, symbol: partialSym, error: lastErr, partial: true };
        return { result: null, symbol: null, error: lastErr };
    }

    // History for 1M / YTD / 12M. Each candidate symbol's 2y history is scored by
    // how many of the three anchors it supports; a history whose latest close is
    // more than 10 days older than the live quote counts as frozen and scores 0.
    // First full score wins. Otherwise, if one symbol has the older history and
    // another the recent data (e.g. Yahoo moving an index to a new symbol), they
    // are joined — but only when at least 3 overlapping days agree within 0.5%,
    // which proves both are the same series on the same scale. Else the best
    // partial is used and the row says what's missing.
    async function mktFetchBestHistory(inst, liveSessionDate, liveRows) {
        var prefKey = inst.id + ':hist';
        var cands = [MKT_SYMBOL_PREF[prefKey], inst.returnSymbol].concat(inst.altSymbols || [])
            .filter(function(s, i, a) { return s && a.indexOf(s) === i; });
        var got = [], lastErr = null, attempts = [];
        for (var ci = 0; ci < cands.length; ci++) {
            var forms = [['2y', function(sym) { return mktYahooFetch(sym, '2y'); }],
                         ['dated', function(sym) { return mktYahooFetchDated(sym, 740); }]];
            for (var fi = 0; fi < forms.length; fi++) {
                var tag = cands[ci] + ' ' + forms[fi][0];
                try {
                    var r = await forms[fi][1](cands[ci]);
                    var series = mktParseDailyCloseSeries(r);
                    if (series.length === 0) { attempts.push(tag + ': no daily bars'); lastErr = tag + ': no daily bars'; continue; }
                    var core = mktHistoryCoreFromSeries(series, inst);
                    var sc = mktHistoryScore(core, liveSessionDate);
                    got.push({ symbol: cands[ci], series: series, core: core, score: sc });
                    attempts.push(tag + ': ' + series.length + ' close' + (series.length === 1 ? '' : 's') + ' ' +
                                  series[0].date + '\u2192' + series[series.length - 1].date);
                    if (sc === 3) { MKT_SYMBOL_PREF[prefKey] = cands[ci]; return { core: core, symbol: cands[ci], note: null }; }
                    if (series.length >= 200) break;   // a long series won't be fixed by another request format
                } catch (e) {
                    var em = (e && e.message) || 'fetch failed';
                    attempts.push(tag + ': ' + em); lastErr = tag + ': ' + em;
                    if (/HTTP 404/.test(em)) break;    // symbol doesn't exist — no point trying other formats
                }
            }
        }
        var best = got.length ? got.slice().sort(function(a, b) { return b.score - a.score; })[0] : null;
        for (var i = 0; i < got.length; i++) for (var j = 0; j < got.length; j++) {
            if (i === j) continue;
            var joined = mktStitchSeries(got[i].series, got[j].series);
            if (!joined) continue;
            var jc = mktHistoryCoreFromSeries(joined, inst), js = mktHistoryScore(jc, liveSessionDate);
            if (js > best.score) best = { symbol: got[i].symbol + '+' + got[j].symbol, core: jc, score: js,
                                          note: 'joined ' + got[i].symbol + ' (older) with ' + got[j].symbol + ' (recent)' };
        }
        if (best && !best.note) best.note = 'Yahoo ' + attempts.join('; ');
        // Yahoo can't support all three periods: try other sources for the SAME index —
        // Naver (free, no key) first, then Twelve Data. Each source's closes must match
        // Yahoo's on shared days before it is used; it is then used on its own or joined
        // under Yahoo's recent closes, whichever supports more periods.
        var otherNotes = [];
        var naverSecondary  = !!(inst.naverCode && inst.primarySource !== 'naver');   // primary instruments already tried Naver
        var hasOtherSources = !!(naverSecondary || (inst.tdSymbols && inst.tdSymbols.length) || inst.tdSearch);
        if ((!best || best.score < 3) && hasOtherSources) {
            // Yahoo reference closes to check other sources against: every Yahoo history
            // bar, the live chart's completed bars, and — when that's under two days — the
            // quote's own previous close (dated to the calendar's previous session).
            var refRows = [];
            got.forEach(function(g) { refRows = refRows.concat(g.series); });
            (liveRows || []).forEach(function(r) { if (!liveSessionDate || r.date < liveSessionDate) refRows.push(r); });
            var refDates = {}; refRows.forEach(function(r) { refDates[r.date] = 1; });
            var cal = dailyCheckProfileFor(inst.liveSymbol).calendar;
            if (Object.keys(refDates).length < 2 && cal) {
                try {
                    var wcr = await mktYahooFetch(inst.liveSymbol, '1d');
                    var w = mktQuoteWitnessFromChart(wcr);
                    var prevS = (w && w.sessionDate) ? previousExchangeSession(cal, w.sessionDate) : null;
                    if (w && prevS && !refDates[prevS.date]) refRows.push({ date: prevS.date, close: w.prevClose });
                } catch (e) { /* the sources below will say they had too little to check against */ }
            }
            var takeCandidate = function(src) {
                var sym = src.symbol;
                var c0 = mktHistoryCoreFromSeries(src.series, inst);
                var cand = { symbol: sym, core: c0, score: mktHistoryScore(c0, liveSessionDate), note: src.note };
                got.forEach(function(g) {
                    var joined = mktStitchSeries(src.series, g.series);
                    if (!joined) return;
                    var jc = mktHistoryCoreFromSeries(joined, inst), js = mktHistoryScore(jc, liveSessionDate);
                    if (js >= cand.score) cand = { symbol: sym + '+' + g.symbol, core: jc, score: js,
                                                   note: src.note + ', joined with Yahoo ' + g.symbol + ' for recent days' };
                });
                if (!best || cand.score > best.score) best = cand;
            };
            if (naverSecondary) {
                var nv = await mktNaverHistory(inst, refRows, signal);
                if (nv && nv.series) takeCandidate({ symbol: 'NAVER:' + inst.naverCode, series: nv.series, note: nv.note });
                else if (nv && nv.error) otherNotes.push(nv.error);
            }
            if ((!best || best.score < 3) && ((inst.tdSymbols && inst.tdSymbols.length) || inst.tdSearch)) {
                var td = await mktTwelveDataHistory(inst, refRows, signal);
                if (td && td.series) takeCandidate({ symbol: 'TD:' + td.symbol, series: td.series, note: td.note });
                else if (td && td.error) otherNotes.push(td.error);
            }
            if (otherNotes.length) {
                if (best && best.score < 3) best.note = best.note + ' \u00b7 ' + otherNotes.join(' \u00b7 ');
                else if (!best) lastErr = 'Yahoo ' + attempts.join('; ') + ' \u00b7 ' + otherNotes.join(' \u00b7 ');
            }
        }
        if (!best) return { core: null, symbol: null, error: lastErr || ('Yahoo ' + attempts.join('; ')) };
        return { core: best.core, symbol: best.symbol, note: best.note };
    }

    // Requests are chunked (not all ~20 instruments at once) so a burst of ~40
    // simultaneous calls through the single Worker never crowds out a slower or
    // less-cached symbol (foreign indices in particular) into a timeout. Each
    // chunk still runs its two calls per instrument in parallel; only the chunk
    // count is throttled. Order is preserved so settled[i] still matches instruments[i].
    var MKT_FETCH_CHUNK_SIZE = 6;
    var settled = [];
    for (var _mci = 0; _mci < instruments.length; _mci += MKT_FETCH_CHUNK_SIZE) {
        var _mchunk = instruments.slice(_mci, _mci + MKT_FETCH_CHUNK_SIZE);
        var _mchunkSettled = await Promise.allSettled(_mchunk.map(mktProcessOneInstrument));
        settled = settled.concat(_mchunkSettled);
    }

    var rows = [], okCount = 0, failCount = 0, errorCount = 0, errors = [];
    settled.forEach(function(r, i) {
        var inst = instruments[i];
        if (r.status === 'fulfilled') {
            var row = r.value;
            rows.push(row);
            var hasUseful = (row.now != null || row.day != null ||
                             row.m1  != null || row.ytd != null || row.y1 != null);
            if (hasUseful) okCount++; else failCount++;
            // Count any row-level issue (live error, history error, or total failure)
            if (row.liveError || row.historyError || row.error) errorCount++;
            if (row.liveError)    errors.push(inst.id + ' live: '    + row.liveError);
            if (row.historyError) errors.push(inst.id + ' history: ' + row.historyError);
        } else {
            var msg = (r.reason && r.reason.message) || String(r.reason);
            failCount++;
            errorCount++;
            errors.push(inst.id + ': ' + msg);
            rows.push({
                id: inst.id, label: inst.label, type: inst.type,
                section: inst.section, displayKind: inst.displayKind,
                liveSymbol: inst.liveSymbol, returnSymbol: inst.returnSymbol,
                nowDecimals: inst.nowDecimals != null ? inst.nowDecimals : null,
                riskColorMode: inst.riskColorMode || null,
                excludeFromTopMovers: !!inst.excludeFromTopMovers,
                dataQuality: 'stale',
                now: null, day: null, daySource: 'unavailable',
                previousClose: null, previousCloseSource: null, quoteSessionDate: null,
                marketState: null, quoteAgeMs: null,
                quoteStatusLabel: 'STALE', quoteStatusKind: 'stale',
                quoteStatusCompact: 'S', feedLabel: 'failed',
                observedUpdating: false, lastObservedUpdateAt: null,
                m1: null, ytd: null, y1: null,
                returnAsOfDate: null, returnLatestClose: null,
                m1AnchorDate: null, m1AnchorClose: null,
                ytdAnchorDate: null, ytdAnchorClose: null,
                y1AnchorDate: null, y1AnchorClose: null,
                periodCurrentSource: null, periodCurrentDate: null, periodCurrentClose: null,
                periodDataQuality: 'stale', periodSource: inst.returnSymbol,
                historyFromCache: false, historyStale: false, historyCacheAgeMs: 0,
                source: inst.liveSymbol, liveError: msg, historyError: msg, error: msg,
            });
        }
    });

    // ── 1D cross-check: merge each row's second source (same module as Holdings) ─
    // Twelve Data is fetched here (one batch, within its 8-credit/minute budget —
    // anything over the budget is picked up on a later 15-second refresh). Alpha
    // Vantage is cache-only here: its calls are spaced 13 s apart, so the Holdings
    // pipeline fetches it in the background and Markets reuses that cache — the
    // LSE rows in Markets are your holdings, so the data is shared.
    try {
        var secRows = rows.filter(function(r) {
            return r && Array.isArray(r._yahooDaily) && dailyCheckProfileFor(r.liveSymbol).provider;
        });
        var secMap = {};
        if (secRows.length > 0) {
            var sessBySym = {};
            secRows.forEach(function(r) { sessBySym[String(r.liveSymbol).toUpperCase().trim()] = r.quoteSessionDate; });
            secMap = await fetchSecondaryDailyCloses(secRows.map(function(r) { return r.liveSymbol; }), {
                allowFetch: { td: true, av: false }, signal: signal,
                sessionDateFor: function(tk) { return sessBySym[tk] || null; },
            });
        }
        secRows.forEach(function(r) {
            mktApplyDayCheck(r, secMap[String(r.liveSymbol).toUpperCase().trim()] || null);
        });
    } catch(e) {
        // Yahoo-only 1D (already gap-checked in the parser) stands if the cross-check fails.
        console.warn('[markets] 1D cross-check failed:', e && e.message);
    }
    // ── 1D third reference: Yahoo's own previous close for the current session ─
    // Only for rows whose 1D is still blank because the daily bars were missing
    // (no-data / gap) or the two sources disagreed (conflict). One extra request
    // per such row: the range=1d chart, whose chartPreviousClose is the close of
    // the session before the quote's session. See mktApplyQuoteWitness for rules.
    try {
        var needWitness = rows.filter(function(r) {
            return r && r.primarySource !== 'naver' && r.day == null && r.now != null && Number.isFinite(r.now) &&
                   (r.dayCheckStatus === 'no-data' || r.dayCheckStatus === 'gap' || r.dayCheckStatus === 'conflict');
        });
        for (var _wi = 0; _wi < needWitness.length; _wi += MKT_FETCH_CHUNK_SIZE) {
            await Promise.allSettled(needWitness.slice(_wi, _wi + MKT_FETCH_CHUNK_SIZE).map(async function(r) {
                try {
                    var cr = await mktYahooFetch(r.fetchedLiveSymbol || r.liveSymbol, '1d');
                    mktApplyQuoteWitness(r, mktQuoteWitnessFromChart(cr));
                } catch (e) {
                    r.dayWitnessNote = 'quote check failed';
                }
            }));
        }
    } catch (e) {
        console.warn('[markets] 1D quote check failed:', e && e.message);
    }
    rows.forEach(function(r) { if (r) delete r._yahooDaily; });

    return { rows: rows, okCount: okCount, failCount: failCount,
             errorCount: errorCount,
             updatedAt: Date.now(), errors: errors, offline: false };
}

// ── MarketOverviewScreen ──────────────────────────────────────────────────────
// Tap a degraded row to reveal a compact one-line diagnostic; clean rows show no expansion.
function MarketOverviewScreen({ rows, status, updatedAt, error, onRefresh }) {
    var expandedState = React.useState(null);
    var expandedRowId = expandedState[0];
    var setExpandedRowId = expandedState[1];
    var isFetching = (status === 'fetching');

    // Global freshness line — single line replacing per-row status noise.
    var freshnessText  = mktBuildGlobalFreshnessLine(rows, status, updatedAt, error);
    var freshnessColor = (status === 'offline' || status === 'fail') ? C.rose
                       : (status === 'partial') ? C.amber
                       : C.zinc600;

    // Build section groups, in the order below (anything unlisted follows, in order of first appearance).
    // Grouping uses the stored section name; MKT_SECTION_LABEL is only what the header says. VIX is forced
    // into Volatility so rows saved before it had its own section don't split the Markets list. Sorting here
    // (not just in the instrument list) means rows saved in an older order still display in this order.
    var MKT_SECTION_ORDER = ['Markets', 'Volatility', 'FX', 'Commodities', 'Rates', 'Crypto', 'Mag7'];
    var MKT_SECTION_LABEL = { Markets: 'EQ Indices', Volatility: 'Vol' };
    var sectionGroups = [];
    var groupByName = {};
    (rows || []).forEach(function(row) {
        var sec = row.id === 'VIX' ? 'Volatility' : (row.section || 'Markets');
        if (!groupByName[sec]) {
            groupByName[sec] = { name: sec, label: MKT_SECTION_LABEL[sec] || sec, rows: [] };
            sectionGroups.push(groupByName[sec]);
        }
        groupByName[sec].rows.push(row);
    });
    function mktSectionRank(name) { var i = MKT_SECTION_ORDER.indexOf(name); return i < 0 ? MKT_SECTION_ORDER.length : i; }
    sectionGroups = sectionGroups
        .map(function(g, i) { return { g: g, i: i }; })
        .sort(function(a, b) { return (mktSectionRank(a.g.name) - mktSectionRank(b.g.name)) || (a.i - b.i); })
        .map(function(x) { return x.g; });

    // Grid columns: ticker | last+chip | 1D | 1M | YTD | 12M
    // Same template used by both section header and data rows for alignment.
    // ticker | last | chip | 1D | 1M | YTD | 12M. The four move columns are minmax(0,1fr) so they share what is left and can
    // never widen the row past the screen.
    var MKT_GRID = '56px minmax(54px,auto) 22px repeat(4, minmax(0, 1fr))';

    function mktStatusChipColor(kind) {
        var map = {
            open:   C.emerald, live: C.emerald, delayed: C.emerald,
            pre:    C.blue,    post: C.blue,
            closed: C.zinc600,
            cached: C.amber,
            stale:  C.rose,
        };
        return map[kind] || C.zinc600;
    }

    // Section column header row (once per section).
    function renderSectionHeader(sec, first) {
        var isBp = sec.rows.length > 0 && sec.rows[0].displayKind === 'bpChange';
        var isPt = sec.rows.length > 0 && sec.rows[0].displayKind === 'ptChange';
        var unit = isBp ? ' bp' : isPt ? ' pt' : ' %';   // move columns: basis points for rates, index points for VIX, else % returns
        return React.createElement('div', {
            key: 'hdr-' + sec.name,
            style: { display: 'flex', flexDirection: 'column' }
        },
            // Section label — a large title-case heading, so it reads as a different kind of line from the uppercase ticker
            // codes below it. On the page colour, not a tinted band: a lighter band under the dark tab looked off (Fergus).
            React.createElement('div', {
                style: { padding: first ? '8px 20px 0' : '12px 20px 0', borderTop: first ? 'none' : '1px solid ' + C.border }
            },
                React.createElement('span', {
                    style: { fontFamily: sys, fontSize: 17, color: C.white,
                             letterSpacing: '-0.01em', fontWeight: 700 }
                }, sec.label)
            ),
            // Column header
            React.createElement('div', {
                style: {
                    display: 'grid', gridTemplateColumns: MKT_GRID,
                    padding: '1px 20px 4px', gap: '0 4px', alignItems: 'baseline',
                    borderBottom: '1px solid ' + C.border,
                }
            },
                React.createElement('span', { style: { fontFamily: sys, fontSize: 9, color: C.zinc700 } }, ''),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 12, fontWeight: 500, color: C.zinc500, letterSpacing: '0.01em' } }, 'Last'),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 9, color: C.zinc700 } }, ''),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 12, fontWeight: 500, color: C.zinc500, letterSpacing: '0.01em', textAlign: 'right' } }, '1D' + unit),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 12, fontWeight: 500, color: C.zinc500, letterSpacing: '0.01em', textAlign: 'right' } }, '1M' + unit),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 12, fontWeight: 500, color: C.zinc500, letterSpacing: '0.01em', textAlign: 'right' } }, 'YTD' + unit),
                React.createElement('span', { style: { fontFamily: sys, fontSize: 12, fontWeight: 500, color: C.zinc500, letterSpacing: '0.01em', textAlign: 'right' } }, '12M' + unit)
            )
        );
    }

    // Compact one-line row. Degraded rows are tappable to reveal a one-line
    // diagnostic. Clean rows show no diagnostics and are not tappable.
    function renderRow(row) {
        var isDegraded = mktRowIsDegraded(row);
        // Every row is tappable, not just degraded ones — a figure can look
        // perfectly plausible and still be worth checking against another source
        // (e.g. "1M doesn't match Bloomberg"), and there is no way to see what a
        // clean row is actually built from without this.
        var isExpanded = (expandedRowId === row.id);
        var hasNow = (row.now != null && Number.isFinite(row.now));
        var hasDay = (row.day != null && Number.isFinite(row.day));
        var hasM1  = (row.m1  != null && Number.isFinite(row.m1));
        var hasYTD = (row.ytd != null && Number.isFinite(row.ytd));
        var hasY1  = (row.y1  != null && Number.isFinite(row.y1));
        var qkind  = row.quoteStatusKind || 'closed';
        var chip   = mktCompactChip(row);

        // Chip colour: amber/rose for degraded rows; normal status colour for clean.
        var chipColor;
        if (isDegraded) {
            chipColor = (qkind === 'stale' || row.historyStale || row.liveError || row.historyError || row.error)
                ? C.rose : C.amber;
        } else {
            chipColor = mktStatusChipColor(qkind);
        }

        // Build a short one-line detail string for degraded rows.
        function buildDegradedDetail() {
            var parts = [];
            if (row.primaryNote) parts.push(row.primaryNote);
            // 1D withheld by the daily-close check — say exactly why.
            var provAbbr = row.dayCheckProvider === 'Alpha Vantage' ? 'AV'
                         : row.dayCheckProvider === 'Twelve Data'   ? 'TD' : null;
            var fmtPx = function(v) {
                if (v == null || !Number.isFinite(v)) return '\u2014';
                return Math.abs(v) >= 100 ? v.toFixed(2) : v.toPrecision(5);
            };
            if (row.dayCheckStatus === 'gap') {
                parts.push('1D: no close for ' + (row.dayCheckExpected || 'prev session') +
                           ' from Yahoo' + (provAbbr ? ' or ' + provAbbr : ''));
            } else if (row.dayCheckStatus === 'conflict') {
                parts.push('1D: ' + (row.previousCloseDate || '') + ' Yahoo ' + fmtPx(row.dayCheckYahoo) +
                           ' vs ' + (provAbbr || 'alt') + ' ' + fmtPx(row.dayCheckAlt));
            } else if (row.dayCheckStatus === 'implausible') {
                parts.push('1D: move beyond plausibility limit \u2014 held back');
            } else if (row.dayCheckStatus === 'no-data' && row.now != null) {
                parts.push('1D: ' + ({
                    'no-daily-series':      'Yahoo sent a price but no daily bars',
                    'no-prior-close':       'no earlier close in Yahoo\u2019s bars',
                    'no-ticker-or-session': 'Yahoo quote has no session time',
                }[row.dayCheckReason] || 'no daily data'));
            }
            if (row.dayWitnessNote && parts.length > 0) parts.push(row.dayWitnessNote);
            if (row.fetchedLiveSymbol && row.fetchedLiveSymbol !== row.liveSymbol) parts.push('via ' + row.fetchedLiveSymbol);
            if (row.dayCheckError && parts.length > 0) parts.push(String(row.dayCheckError).slice(0, 40));
            var hasDayMsg = parts.length > 0;
            var dq   = row.dataQuality       || null;
            var pdq  = row.periodDataQuality  || null;
            var pdqL = pdq ? pdq.toLowerCase() : '';
            var src  = row.daySource          || null;
            var age  = (row.historyCacheAgeMs != null)
                ? Math.round(row.historyCacheAgeMs / 60000) + 'm' : null;

            // Suppressed period returns: surface the relevant anchor date.
            var SUPP_ANCHOR = {
                'm1suppressed': 'm1AnchorDate',
                'ytdsuppressed': 'ytdAnchorDate',
                'y1suppressed': 'y1AnchorDate',
            };
            if (pdqL && SUPP_ANCHOR[pdqL]) {
                var anchDate = row[SUPP_ANCHOR[pdqL]] ||
                    row.ytdAnchorDate || row.m1AnchorDate || row.y1AnchorDate || null;
                parts.push('return suppressed');
                if (anchDate) parts.push('anchor: ' + anchDate);
                if (row.historyStale) parts.push('stale' + (age ? ' ' + age : ''));
            } else {
                if (hasDayMsg)                { /* 1D reason already explained above */ }
                else if (src && src !== 'quote') parts.push('source: ' + src);
                else if (dq && dq !== 'ok')   parts.push('dq: ' + dq);
                var anch = row.ytdAnchorDate || row.m1AnchorDate || row.y1AnchorDate || null;
                if (anch)                     parts.push('anchor: ' + anch);
                // Only show history status when genuinely stale (not merely cached)
                if (row.historyStale)         parts.push('stale' + (age ? ' ' + age : ''));
                if (pdq && pdqL !== 'ok' && !SUPP_ANCHOR[pdqL])
                                              parts.push('period: ' + pdq);
            }
            // Blank periods: say which ones and why.
            var pnr = row.periodNullReasons || {};
            var PNR_TXT = { 'no-anchor': 'history too short', 'bad-anchor': 'bad data point in history, held back', 'scale-break': 'scale break in history',
                            'suppressed': 'implausible, held back', 'no-current': 'no current price', 'no-history': 'no history' };
            var blanks = [['1M', 'm1'], ['YTD', 'ytd'], ['12M', 'y1']].filter(function(p) { return row[p[1]] == null; });
            if (blanks.length && !(pdqL && SUPP_ANCHOR[pdqL])) {
                var why = {};
                blanks.forEach(function(p) { var t = PNR_TXT[pnr[p[1]]] || 'unavailable'; (why[t] = why[t] || []).push(p[0]); });
                Object.keys(why).forEach(function(t) { parts.push(why[t].join('/') + ': ' + t); });
                if (row.historyNote) parts.push(row.historyNote);
            }
            if (row.liveError)    parts.push('live err: ' + String(row.liveError).slice(0, 40));
            if (row.historyError) parts.push('hist err: ' + String(row.historyError).slice(0, 40));
            var issues = parts.length > 0 ? parts : (isDegraded && mktRowDegradationLabel(row) ? [mktRowDegradationLabel(row)] : []);
            // Source line -> label / value pairs: "Yahoo", "prev 123 (2 Oct)", "1M anchor 123 (2 Sep)" ...
            var facts = [];
            mktBuildSourceLine(row).split(' \u00b7 ').forEach(function(seg, i) {
                if (i === 0) { facts.push(['Source', seg]); return; }
                var m = /^(prev|1M anchor|YTD anchor|12M anchor) (.*)$/.exec(seg);
                if (m) facts.push([m[1] === 'prev' ? 'Prev close' : m[1].replace('anchor', 'anchor'), m[2]]);
                else facts.push(['', seg]);
            });
            return { issues: issues, facts: facts };
        }

        return React.createElement('div', { key: row.id },

            // ── One-line data row ─────────────────────────────────────────────
            React.createElement('div', {
                style: {
                    display: 'grid', gridTemplateColumns: MKT_GRID,
                    padding: '9px 20px', gap: '0 4px', alignItems: 'baseline',
                    borderBottom: isExpanded
                        ? '1px solid rgba(255,255,255,0.02)'
                        : '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    WebkitTapHighlightColor: 'transparent',
                },
                onClick: function() { setExpandedRowId(isExpanded ? null : row.id); }
            },
                // Col 1: Ticker
                React.createElement('span', {
                    style: { fontFamily: sys, fontSize: 13, fontWeight: 500, letterSpacing: '0.02em',
                             color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                }, row.id.replace(/^HOLDING:/, '')),
                // Col 2: Last price
                React.createElement('span', {
                    style: { fontFamily: rounded, fontSize: 13, fontWeight: 500, letterSpacing: '-0.02em',
                             color: hasNow ? C.spotPrice : C.zinc600, fontVariantNumeric: 'tabular-nums',
                             overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                }, hasNow ? mktFmtRowNow(row) : '\u2014'),
                // Col 3: Status chip — amber/rose tint for degraded rows
                React.createElement('span', {
                    style: { fontFamily: sys, fontSize: 8, fontWeight: 700, color: chipColor,
                             letterSpacing: '0.02em', whiteSpace: 'nowrap' }
                }, chip),
                // Col 4: 1D
                React.createElement('span', {
                    style: { fontFamily: rounded, fontSize: 13, fontWeight: 400, letterSpacing: '-0.02em',
                             color: hasDay ? mktMoveColor(row, row.day) : C.zinc700,
                             textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                }, hasDay ? mktFmtCompact(row, row.day, 2, true) : '\u2014'),
                // Col 5: 1M
                React.createElement('span', {
                    style: { fontFamily: rounded, fontSize: 13, fontWeight: 400, letterSpacing: '-0.02em',
                             color: hasM1 ? mktMoveColor(row, row.m1) : C.zinc700,
                             textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                }, hasM1 ? mktFmtCompact(row, row.m1, 1, true) : '\u2014'),
                // Col 6: YTD
                React.createElement('span', {
                    style: { fontFamily: rounded, fontSize: 13, fontWeight: 400, letterSpacing: '-0.02em',
                             color: hasYTD ? mktMoveColor(row, row.ytd) : C.zinc700,
                             textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                }, hasYTD ? mktFmtCompact(row, row.ytd, 1, true) : '\u2014'),
                // Col 7: 12M
                React.createElement('span', {
                    style: { fontFamily: rounded, fontSize: 13, fontWeight: 400, letterSpacing: '-0.02em',
                             color: hasY1 ? mktMoveColor(row, row.y1) : C.zinc700,
                             textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
                }, hasY1 ? mktFmtCompact(row, row.y1, 1, true) : '\u2014')
            ),

            // ── Compact degraded detail (degraded rows only, tap to expand) ──
            // Source panel: wraps inside the screen (nothing is clipped or scrolls sideways), one fact per line, selectable.
            isExpanded && (function() {
                var d = buildDegradedDetail();
                var issueColor = isDegraded ? chipColor : C.zinc400;
                return React.createElement('div', {
                    style: {
                        boxSizing: 'border-box', width: '100%', minWidth: 0,
                        padding: '10px 20px 12px',
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        background: C.surfaceHigh,
                        userSelect: 'text', WebkitUserSelect: 'text',
                    }
                },
                    // What needs attention (only when something does): one wrapped line per issue
                    d.issues.length > 0 && React.createElement('div', { style: { marginBottom: 8 } },
                        d.issues.map(function(t, i) {
                            return React.createElement('div', {
                                key: 'is' + i,
                                style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: i === d.issues.length - 1 ? 0 : 4 }
                            },
                                React.createElement('span', { style: { width: 5, height: 5, borderRadius: '50%', background: issueColor, flexShrink: 0, marginTop: 6 } }),
                                React.createElement('span', {
                                    style: { fontFamily: sys, fontSize: 12, lineHeight: '17px', color: C.zinc300 || C.zinc400,
                                             minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' }
                                }, t)
                            );
                        })
                    ),
                    // Where the numbers come from: label on the left, value on the right, values wrap
                    React.createElement('div', {
                        style: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', columnGap: 14, rowGap: 4, alignItems: 'baseline' }
                    },
                        d.facts.map(function(f, i) {
                            return [
                                React.createElement('span', {
                                    key: 'fk' + i,
                                    style: { fontFamily: sys, fontSize: 11, color: C.zinc500, whiteSpace: 'nowrap' }
                                }, f[0]),
                                React.createElement('span', {
                                    key: 'fv' + i,
                                    style: { fontFamily: rounded, fontSize: 12, lineHeight: '17px', color: C.zinc400, fontVariantNumeric: 'tabular-nums',
                                             minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' }
                                }, f[1])
                            ];
                        })
                    )
                );
            })()
        );
    }

    // Sits under the app's tab bar (its height is published as --topbar-h), so the tabs stay visible.
    return React.createElement('div', {
        'data-swipe-tabs': '', 'data-tab-screen': 'markets',
        style: {
            position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995,
            background: C.bg, display: 'flex', flexDirection: 'column',
            WebkitTapHighlightColor: 'transparent', userSelect: 'none',
        }
    },

        // ── Scrollable body ────────────────────────────────────────────────────
        React.createElement('div', {
            className: 'ios-scroll',
            style: { flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'max(env(safe-area-inset-bottom), 24px)' }
        },
            // A warning line (offline, cached, partial) only takes space when there is something to say.
            freshnessText && React.createElement('div', {
                style: { fontFamily: sys, fontSize: 11, color: freshnessColor, padding: '0 20px 10px' }
            }, freshnessText),

            // Loading / error (no rows yet)
            !rows && React.createElement('div', { style: { padding: '32px 20px', textAlign: 'center' } },
                (status === 'fail' || status === 'offline')
                    ? React.createElement('div', null,
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: C.rose, marginBottom: 6 } },
                            status === 'offline' ? 'No network connection' : 'Could not load market data'),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.zinc600 } },
                            'Tap Refresh below to try again.')
                      )
                    : React.createElement('div', { style: { fontFamily: sys, fontSize: 13, color: C.zinc600 } },
                        isFetching ? 'Loading market data\u2026' : 'Opening Markets\u2026')
            ),

            // Section groups with headers
            rows && sectionGroups.map(function(sec, i) {
                return React.createElement('div', { key: sec.name },
                    renderSectionHeader(sec, i === 0),
                    sec.rows.map(renderRow)
                );
            }),

            // Footer: Refresh and the "As of" time sit at the bottom; refreshing is automatic enough that it rarely needs
            // a tap (Fergus moved it down from the top).
            React.createElement('div', {
                style: { padding: '16px 20px 8px', borderTop: '1px solid ' + C.border, marginTop: 8,
                         display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }
            },
                React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 } },
                    React.createElement('button', {
                        onClick: onRefresh, disabled: isFetching,
                        style: {
                            background: 'none', border: '1px solid ' + C.border, borderRadius: 999, padding: '8px 16px',
                            color: isFetching ? C.blue : C.zinc400, fontFamily: sys, fontSize: 13, fontWeight: 500,
                            display: 'flex', alignItems: 'center', gap: 6,
                            opacity: isFetching ? 0.6 : 1,
                        }
                    },
                        React.createElement(RefreshCw, {
                            className: isFetching ? 'spinning' : '',
                            style: { width: 12, height: 12 }, strokeWidth: 2
                        }),
                        'Refresh'
                    ),
                    // Time of the last successful refresh, with seconds (device local time)
                    updatedAt && React.createElement('span', {
                        style: { fontFamily: rounded, fontSize: 11, color: C.zinc600, fontVariantNumeric: 'tabular-nums',
                                 whiteSpace: 'nowrap', lineHeight: '16px', marginTop: 4 }
                    }, 'As of ' + new Date(updatedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
                ),
                React.createElement('p', {
                    style: { fontFamily: sys, fontSize: 11, color: C.zinc600,
                             margin: 0, lineHeight: 1.6, textAlign: 'center', fontStyle: 'italic' }
                }, '1M/YTD/12M use canonical index symbol \u00b7 rates in bp \u00b7 read-only')
            )
        ) // end scrollable body
    ); // end MarketOverviewScreen
}

// =====================================================
// MARKET OVERVIEW MODULE END
