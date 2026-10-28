// Performance engine: the pure calculations behind the Investments chart, its cards and the risk figures.
// Each computeX takes everything it reads as one object and returns the figure; PortfolioApp wraps each in useMemo.
// Loaded by index.html before app.js; shares its globals (no module system, no build step).

// Latest close on or before a date.
function priceAt(series, dateStr) {
    if (!series || series.length === 0)
        return null;
    let result = null;
    for (const p of series) {
        if (p.date <= dateStr)
            result = p.close;
        else
            break;
    }
    return result;
}
// GBP/USD on a date: that day's close, else the current rate.
function makeGbpusdAt(prices, gbpusdRate) {
    return function gbpusdAt(dateStr) {
        const rate = priceAt(prices['GBPUSD=X'], dateStr);
        return rate != null ? rate : gbpusdRate;
    };
}

function computeGbpusdInfo({ livePrices, prices }) {
    if (livePrices['GBPUSD=X']) return { rate: livePrices['GBPUSD=X'], source: 'live' };
    const series = prices['GBPUSD=X'];
    const last = latestFiniteCloseFromSeries(series);
    if (last && last.price > 0) return { rate: last.price, source: 'history', asOf: last.date };
    return { rate: null, source: 'none' };
}

function computeWeeklyDates({ inception, today }) {
    if (!inception)
        return [];
    const dates = [];
    const d = new Date(inception);
    // align to monday
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    // Daily granularity for the last DAILY_HISTORY_DAYS (the stored history's daily stretch), so every chart up to 1Y
    // is a daily line; weekly step for everything older.
    const dailyFrom = new Date(today);
    dailyFrom.setDate(dailyFrom.getDate() - DAILY_HISTORY_DAYS);
    while (d <= today) {
        const dow = d.getUTCDay();
        // Skip weekends in the daily granularity window — markets are closed Sat/Sun.
        // Weekly spine (older history) is always Monday so no filtering needed there.
        if (dow !== 0 && dow !== 6) {
            dates.push(fmtDate(d));
        }
        if (d >= dailyFrom) {
            d.setUTCDate(d.getUTCDate() + 1); // daily for the last DAILY_HISTORY_DAYS
        } else {
            d.setUTCDate(d.getUTCDate() + 7); // weekly before that (always Monday)
        }
    }
    // Year-end anchors. YTD must run from the LAST CLOSE OF THE PREVIOUS YEAR, but the weekly spine (Mondays) rarely
    // lands on it, so YTD used to start from the first Monday of January (missing its first trading days).
    // Add the last weekday of each previous year to the spine; priceAt() handles the holiday case by looking back.
    {
        const have = new Set(dates);
        const firstD = dates.length ? dates[0] : null, todayS = fmtDate(today);
        const y0 = new Date(inception).getUTCFullYear(), y1 = parseInt(todayS.slice(0, 4), 10);
        for (let y = y0 + 1; y <= y1; y++) {
            let ms = Date.UTC(y - 1, 11, 31);
            for (let k = 0; k < 3; k++) { const w = new Date(ms).getUTCDay(); if (w === 0 || w === 6) ms -= 86400000; else break; }
            const ye = fmtDate(new Date(ms));
            if (firstD && ye >= firstD && ye <= todayS && !have.has(ye)) { dates.push(ye); have.add(ye); }
        }
        dates.sort();
    }
    // Add today only if it is a weekday (Sat/Sun → no entry; chart end is prior Friday)
    const _todayStr = fmtDate(today);
    const _todayDow = today.getUTCDay();
    if (_todayDow !== 0 && _todayDow !== 6 && dates[dates.length - 1] !== _todayStr)
        dates.push(_todayStr);
    return dates;
}

function computeResolvedPrices({ prices, enriched, tickerCurrencyMap, gbpusdAt, liveAt, livePrices, liveQuoteSessionDates, liveDailyCloses }) {
    const map = Object.assign({}, prices);
    const meta = {};
    for (const [ticker, cfg] of Object.entries(PROXIES)) {
        const rawSeries = prices[ticker];
        const fxSeries = prices[cfg.fxSheet];
        if (!rawSeries || rawSeries.length === 0) {
            meta[ticker] = { ok: false, reason: 'no raw series uploaded', sourceLabel: cfg.sourceLabel };
            continue;
        }
        if (!fxSeries || fxSeries.length === 0) {
            meta[ticker] = { ok: false, reason: 'FX series ' + cfg.fxSheet + ' missing', sourceLabel: cfg.sourceLabel };
            continue;
        }
        const converted = rawSeries.map(p => {
            const fx = priceAt(fxSeries, p.date);
            if (fx == null)
                return null;
            return { date: p.date, close: p.close * fx * cfg.scaleUnit };
        }).filter(Boolean);
        if (converted.length === 0) {
            meta[ticker] = { ok: false, reason: 'no overlapping FX dates', sourceLabel: cfg.sourceLabel };
            continue;
        }
        const firstBuy = [...enriched]
            .filter(t => t.instrument && t.instrument.ticker === ticker && t.category === 'buy' && (parseFloat((t.quantity || "").replace(/,/g, "")) || 0) > 0 && t.value !== 0)
            .sort((a, b) => a.parsedDate - b.parsedDate)[0];
        let scaleFactor = 1;
        let anchorDate = null;
        let anchorGBX = null;
        if (firstBuy) {
            anchorGBX = (Math.abs(firstBuy.value) / firstBuy.qty) * 100;
            anchorDate = fmtDate(firstBuy.parsedDate);
            const convertedOnAnchor = priceAt(converted, anchorDate);
            if (convertedOnAnchor && convertedOnAnchor > 0) {
                scaleFactor = anchorGBX / convertedOnAnchor;
            }
        }
        const scaled = converted.map(p => ({ date: p.date, close: p.close * scaleFactor }));
        map[ticker] = scaled;
        meta[ticker] = { ok: true, sourceLabel: cfg.sourceLabel, anchorDate, anchorGBX, scaleFactor, rowCount: scaled.length };
    }
    // ── Synthetic price series for zero-data tickers ──────────────────────
    // If a ticker appears in transactions but has no price rows in the uploaded
    // sheet (e.g. QQQ3.L whose Google Sheet tab uses ArrayFormula and exports
    // null values), synthesise a price series from the transaction ledger:
    //   • At each buy: price = |value| / qty  (cost basis per unit, already in GBP)
    //   • At each sell: price = |value| / qty (sale price per unit, in GBP)
    //   • priceAt() forward-fills between these anchors automatically.
    // This is honest: the position is marked at cost between buy and sale,
    // and P&L is realised at the actual trade price. Not mark-to-market,
    // but eliminates the phantom crash (buy week) + phantom spike (sell week).
    const tickeredInTx = new Set(enriched
        .filter(t => { var _a; const tk = (_a = t.instrument) === null || _a === void 0 ? void 0 : _a.ticker; return tk && tk !== 'UNTICKERED' && (t.category === 'buy' || t.category === 'sell' || t.category === 'transfer_in'); })
        .map(t => t.instrument.ticker));
    for (const ticker of tickeredInTx) {
        const existing = map[ticker];
        if (existing && existing.length > 0)
            continue; // already has real data
        // Build synthetic series from trade prices.
        // transfer_in rows are included as anchor points when a ticker has no buy history
        // (e.g. a pre-existing position transferred in from a spouse). Only use transfer_in
        // rows with a non-zero value; a £0-value row carries no reliable price signal.
        const trades = enriched
            .filter(t => { var _a; return ((_a = t.instrument) === null || _a === void 0 ? void 0 : _a.ticker) === ticker && (t.category === 'buy' || t.category === 'sell' || (t.category === 'transfer_in' && Math.abs(t.value) > 0.001)); })
            .sort((a, b) => a.parsedDate - b.parsedDate);
        if (trades.length === 0)
            continue;
        const synthetic = [];
        const tkCurrency = resolveQuoteCurrency(ticker, tickerCurrencyMap) || 'GBX';
        for (const t of trades) {
            const qty = parseFloat((t.quantity || '').replace(/,/g, '')) || 0;
            if (qty <= 0)
                continue;
            // t.value is always in GBP (£) from HL. Convert to the ticker's native
            // currency so pxToGBP() produces the right GBP value when applied later.
            const priceGBP = Math.abs(t.value) / qty;
            let priceNative;
            if (tkCurrency === 'GBX')
                priceNative = priceGBP * 100; // £ → pence
            else if (tkCurrency === 'USD')
                priceNative = priceGBP * (gbpusdAt(fmtDate(t.parsedDate)) || 1.3); // £ → $
            else
                priceNative = priceGBP; // GBP passthrough
            const dateStr = fmtDate(t.parsedDate);
            // Avoid duplicate date entries
            if (synthetic.length === 0 || synthetic[synthetic.length - 1].date !== dateStr) {
                synthetic.push({ date: dateStr, close: priceNative });
            }
        }
        if (synthetic.length > 0) {
            map[ticker] = synthetic;
            meta[ticker] = {
                ok: true,
                sourceLabel: 'tx-derived',
                synthetic: true,
                rowCount: synthetic.length,
            };
        }
    }
    // ── Per-name synthetic series for UNTICKERED assets ─────────────────
    // The tickeredInTx loop above handles assets with a real exchange ticker.
    // For assets tagged with the UNTICKERED sentinel, build a separate cost-basis
    // series keyed by instrument.name so each asset has its own price track.
    // Prices are derived from buy/sell trade rows (value ÷ qty) and stored in GBP
    // because HL exports values in sterling. Avoids the single-blended-track problem
    // where all untickered assets would collapse into one shared pricing timeline.
    const untickeredByName = new Map();
    for (const t of enriched) {
        if (!t.instrument || t.instrument.ticker !== 'UNTICKERED') continue;
        if (t.category !== 'buy' && t.category !== 'sell') continue;
        const name = t.instrument.name;
        if (!name) continue;
        if (!untickeredByName.has(name)) untickeredByName.set(name, []);
        untickeredByName.get(name).push(t);
    }
    for (const [name, trades] of untickeredByName) {
        if (map[name] && map[name].length > 0) continue; // already has uploaded data
        const sorted = [...trades].sort((a, b) => a.parsedDate - b.parsedDate);
        const synthetic = [];
        for (const t of sorted) {
            const qty = parseFloat((t.quantity || '').replace(/,/g, '')) || 0;
            if (qty <= 0) continue;
            // t.value is already in GBP from HL — store price as GBP directly.
            const priceGBP = Math.abs(t.value) / qty;
            const dateStr = fmtDate(t.parsedDate);
            if (synthetic.length === 0 || synthetic[synthetic.length - 1].date !== dateStr) {
                synthetic.push({ date: dateStr, close: priceGBP });
            }
        }
        if (synthetic.length > 0) {
            map[name] = synthetic;
        }
    }
    // (The 30-day "carry-forward scrub" that used to sit here deleted any recent
    // close equal to the current price and interpolated invented prices into the
    // gap. Its cause — Monday-dated weekly bars carrying later closes, and partial
    // current-session bars stored as closes — is now fixed where history is
    // ingested (yahooHistoryRowsFromChart), so it has been removed.)

    // ── Inject live intraday prices ──────────────────────────────────────
    // Override (or append) the latest data point with the real-time quote
    // so holdings valuation reflects the current price, not last week's close.
    // Completed sessions the stored history lacks are bridged from
    // liveDailyCloses first (withLiveTail).
    //
    // Per-ticker injection using actual market-session dates from liveQuoteSessionDates.
    // Falls back to global effective date for tickers without liveDailyCloses data.
    // Skips injection if session date is stale or unresolvable (no global fallback).
    const _rmpCandidate = getCurrentPnlSessionDateStr();
    const _rmpGlobal    = getEffectivePnlSessionDateStr(liveAt, _rmpCandidate);
    for (const [ticker, px] of Object.entries(livePrices)) {
        const normTk = String(ticker || '').toUpperCase().trim();
        const tickerInjectDate = getEffectiveDateForTicker(
            normTk, liveQuoteSessionDates, _rmpCandidate, _rmpGlobal
        );
        if (!tickerInjectDate) continue;   // skip — stale or no per-ticker metadata
        const existingKey = Object.keys(map).find(k => k.toUpperCase().trim() === normTk) || normTk;
        const existing = map[existingKey];
        if (!existing || existing.length === 0) continue;
        map[existingKey] = withLiveTail(existing, normTk, tickerInjectDate, px, liveDailyCloses);
    }
    return { resolvedPricesMap: map, proxyMeta: meta };
}

function computePortfolioTimeline({ weeklyDates, resolvedPricesMap, perfLedger, gbpusdRate, tickerCurrencyMap }) {
    if (weeklyDates.length === 0 || Object.keys(resolvedPricesMap).length === 0)
        return [];
    const sortedTx = [...perfLedger].sort((a, b) => a.parsedDate - b.parsedDate);
    // Use the live-injected FX series from resolvedPricesMap so today's chart
    // point reflects the real-time GBP/USD rate rather than last week's close.
    const resolvedFxSeries = resolvedPricesMap['GBPUSD=X'] || null;
    return weeklyDates.map(dateStr => {
        var _a, _b;
        const cutoff = new Date(dateStr + 'T23:59:59Z');
        // Units held per ticker as of dateStr
        const units = {};
        // Per-instrument book: maps a stable description key → cost in GBP.
        // Each untickered buy adds its cost; the matching sell clears that cost.
        // This prevents "ghost wealth" gaps when instruments without a price series
        // (IL Gilts, abrdn Money Market, etc.) are bought and later sold.
        const bookCost = {};
        // Per-ticker book cost for tickered positions that lack a price series.
        // Mirrors the bookCost approach used for UNTICKERED assets: accumulated
        // during buys/transfer_ins and cleared on full exit. Used as a flat-line
        // valuation floor in the holdings valuation loop below.
        const tickerCostBasis = {};
        let cashFlow = 0; // cumulative net subscriptions
        let cash = 0; // cash balance
        for (const t of sortedTx) {
            if (t.parsedDate > cutoff)
                break;
            const qty = parseFloat((t.quantity || "").replace(/,/g, "")) || 0;
            const tk = (_a = t.instrument) === null || _a === void 0 ? void 0 : _a.ticker;
            if (t.category === 'subscription' || t.category === 'transfer') {
                cashFlow += t.value;
                cash += t.value;
            }
            else if (t.category === 'transfer_out') {
                // External Capital Extraction: asset leaves the portfolio without generating
                // cash proceeds. We reduce the cashFlow baseline (withdrawal) and zero the
                // unit position so the TWR curve stays flat across the transfer date.
                // Crucially, cash is NOT increased — no phantom proceeds enter the wallet.
                if (!t.internalTransfer) cashFlow -= t.value;   // a matched internal transfer is not a withdrawal
                if (tk && tk !== 'UNTICKERED') {
                    const unitsBefore = units[tk] || 0;
                    units[tk] = (units[tk] || 0) - qty;
                    // Proportionally scale down the cost basis by the fraction transferred out
                    // (Section 104 pooling logic — mirrors the sell block below).
                    if (unitsBefore > 0) {
                        tickerCostBasis[tk] = (tickerCostBasis[tk] || 0) *
                            Math.max(0, (unitsBefore - qty) / unitsBefore);
                    }
                    if ((units[tk] || 0) <= 0.0001) tickerCostBasis[tk] = 0;
                } else {
                    // Untickered asset leaving — clear the book-cost entry so it stops
                    // contributing to untickeredValue after the transfer date.
                    const key = (t.description || '').slice(0, 40).trim();
                    bookCost[key] = 0;
                }
            }
            else if (t.category === 'transfer_in') {
                // Inbound spousal / in-specie transfer: assets arrive without a cash purchase.
                // Treat as external capital injection so the TWR baseline doesn't misread
                // the unit gain as investment performance.
                if (Math.abs(t.value) > 0.001 && !t.internalTransfer) {   // a matched internal transfer is not a deposit
                    cashFlow += Math.abs(t.value);
                }
                if (tk && tk !== 'UNTICKERED') {
                    units[tk] = (units[tk] || 0) + qty;
                    // Record cost anchor for in-specie transfers with a stated value
                    // so positions carried via spousal gift are not priced at zero.
                    if (Math.abs(t.value) > 0.001) {
                        tickerCostBasis[tk] = (tickerCostBasis[tk] || 0) + Math.abs(t.value);
                    }
                } else {
                    // Untickered inbound — hold at cost so wealth doesn't vanish.
                    const key = (t.description || '').slice(0, 40).trim();
                    if (Math.abs(t.value) > 0.001) {
                        bookCost[key] = (bookCost[key] || 0) + Math.abs(t.value);
                    }
                }
            }
            else if (t.category === 'fee') {
                cash += t.value;
            }
            else if (t.category === 'interest') {
                cash += t.value;
            }
            else if (t.category === 'buy' && tk && tk !== 'UNTICKERED') {
                // Real tickered buy: debit cash, credit units.
                units[tk] = (units[tk] || 0) + qty;
                tickerCostBasis[tk] = (tickerCostBasis[tk] || 0) + Math.abs(t.value);
                cash += t.value; // negative
            }
            else if (t.category === 'sell' && tk && tk !== 'UNTICKERED') {
                // Real tickered sell: credit cash, debit units.
                // Proportionally reduce the cost basis by the fraction being sold
                // (Section 104 pooling). Without this, a partial sale leaves the
                // full original cost in the floor, inflating the chart until full exit.
                const unitsBefore = units[tk] || 0;
                units[tk] = (units[tk] || 0) - qty;
                if (unitsBefore > 0) {
                    tickerCostBasis[tk] = (tickerCostBasis[tk] || 0) *
                        Math.max(0, (unitsBefore - qty) / unitsBefore);
                }
                if ((units[tk] || 0) <= 0.0001) tickerCostBasis[tk] = 0;
                cash += t.value; // positive
            }
            else if (t.category === 'buy' && t.instrument) {
                // Untickered instrument (sentinel or no ticker): hold at cost basis so wealth doesn't vanish.
                // Key on the first 40 chars of description — stable within HL exports for the same fund.
                const key = (t.description || '').slice(0, 40).trim();
                bookCost[key] = (bookCost[key] || 0) + Math.abs(t.value);
                cash += t.value; // cash reduces (buy happened)
            }
            else if (t.category === 'sell' && t.instrument) {
                // Clear cost basis on sell. P&L (proceeds − cost) has already flowed into cash
                // via cash += t.value below. We just need to remove the book entry so we don't
                // double-count the position after it's gone.
                const key = (t.description || '').slice(0, 40).trim();
                bookCost[key] = 0; // clear — position fully exited
                cash += t.value; // positive proceeds land in cash
            }
            else if (t.category === 'buy' || t.category === 'sell') {
                // No instrument match at all — cash effect only.
                cash += t.value;
            }
        }
        const untickered = Object.values(bookCost).reduce((s, v) => s + v, 0);
        // Value tickered holdings
        let holdingsValue = 0;
        // Per-ticker breakdown of holdingsValue (and each ticker's GBP unit price), read only by the
        // pressed-day contributors on the performance chart. Sum of byTk === holdingsValue.
        const byTk = {}, pxTk = {};
        for (const [tk, qty] of Object.entries(units)) {
            if (Math.abs(qty) < 0.0001)
                continue;
            const series = resolvedPricesMap[tk];
            if (!series || series.length === 0) {
                // No price series exists for this ticker (e.g. fixed-income gilt,
                // IL gilt, or a delisted instrument whose history could not be
                // fetched). Rather than silently dropping the position to zero —
                // which produces an artificially deflated chart — carry it at its
                // accumulated book cost as a flat-line valuation floor.
                // For closed positions the cost floor will already be zero (cleared
                // by the sell/transfer_out branch above), so no phantom wealth leaks.
                holdingsValue += tickerCostBasis[tk] || 0;
                if (tickerCostBasis[tk]) byTk[tk] = tickerCostBasis[tk];
                continue;
            }
            // priceAt returns the last price on or before dateStr.
            // If dateStr is before the series starts (price data uploaded only covers recent history),
            // priceAt returns null and the holding vanishes from portfolioValue — then reappears
            // when data starts, creating a phantom gain in the Dietz chain.
            // Fix: fall back to the first available price in the series as best-effort valuation.
            const px = (_b = priceAt(series, dateStr)) !== null && _b !== void 0 ? _b : series[0].close;
            // Prefer the live-injected FX series; fall back to gbpusdRate (which
            // is also the live quote) so USD-denominated holdings are correctly
            // converted on the chart's final node.
            const fxRate = (resolvedFxSeries ? priceAt(resolvedFxSeries, dateStr) : null) ?? gbpusdRate;
            const gbp = pxToGBP(tk, px, fxRate, tickerCurrencyMap);
            if (gbp == null)
                continue;
            holdingsValue += qty * gbp;
            byTk[tk] = qty * gbp;
            pxTk[tk] = gbp;
        }
        return {
            date: dateStr,
            portfolioValue: holdingsValue + untickered + cash,
            contributed: cashFlow,
            holdingsValue,
            untickeredValue: untickered,
            cash,
            byTicker: byTk,
            pxTicker: pxTk,
        };
    });
}

function computeBenchmarkTimeline({ portfolioTimeline, resolvedPricesMap }) {
    if (portfolioTimeline.length === 0)
        return [];
    const spxRaw = resolvedPricesMap['^GSPC'];
    const fx = resolvedPricesMap['GBPUSD=X'];
    if (!spxRaw || !fx)
        return [];
    // (Removed: a 'carry-forward scrub' here deleted recent closes and interpolated invented ones. The S&P benchmark
    // is now built once, from real closes only, in performanceChart.)
    const spx = spxRaw;
    return portfolioTimeline.map(p => {
        const spxPx = priceAt(spx, p.date);
        const fxPx = priceAt(fx, p.date);
        // spxNative: raw USD index value — kept for attribution analytics and spxByDate map.
        // NOTE: spxNative is NO LONGER used for the visible chart benchmark line.
        // The chart uses an independent pipeline (normalizeMarketSeries + exact Map lookup)
        // built directly inside performanceChart. spxGBP is used for attribution/risk only.
        // spxGBP: GBP-converted value — kept for attribution, risk panel, spxByDate
        const spxNative = spxPx != null ? spxPx : null;
        const spxGBP = (spxPx == null || fxPx == null) ? null : spxPx / fxPx;
        // Build a map of {benchId: gbpPrice} for every benchmark with data, regardless of whether
        // it's currently selected — selection happens at render time.
        const benchGBP = {};
        for (const b of BENCHMARKS) {
            const series = resolvedPricesMap[b.id];
            if (!series)
                continue;
            const px = priceAt(series, p.date);
            if (px == null)
                continue;
            if (b.fxTicker) {
                const fxPxB = resolvedPricesMap[b.fxTicker] ? priceAt(resolvedPricesMap[b.fxTicker], p.date) : null;
                if (fxPxB == null)
                    continue;
                benchGBP[b.id] = px / fxPxB;
            }
            else {
                benchGBP[b.id] = px;
            }
        }
        return Object.assign(Object.assign({}, p), { spxNative, spxGBP, benchGBP });
    });
}

function computeConsolidatedTimeline({ portfolioTimeline, restrictedTimeline }) {
    if (portfolioTimeline.length === 0) return [];
    // O(1) date lookup: index restrictedTimeline once by date string
    const compByDate = new Map(restrictedTimeline.map(r => [r.date, r]));
    const ZERO_COMP = {
        restrictedCompensationValue:     0,
        liquidCompensationValue:         0,
        restrictedPerformanceBasisValue: 0,
        restrictedPerformanceBasisValid: true,
        activeAlerts: [],
        planDetails: {},
    };
    return portfolioTimeline.map(p => {
        const r = compByDate.get(p.date) || ZERO_COMP;
        const liquidPortfolioValue            = p.portfolioValue || 0;
        const liquidCompensationValue         = r.liquidCompensationValue;
        const restrictedCompensationValue     = r.restrictedCompensationValue;
        const restrictedPerformanceBasisValue = r.restrictedPerformanceBasisValue;
        // Propagate validity: any false from the engine stays false; missing key defaults true
        const restrictedPerformanceBasisValid = r.restrictedPerformanceBasisValid !== false;
        const liquidNetWorth  = liquidPortfolioValue + liquidCompensationValue;
        const totalNetWorth   = liquidPortfolioValue + liquidCompensationValue + restrictedCompensationValue;
        const consolidatedWealth = totalNetWorth;
        return {
            ...p,
            liquidPortfolioValue,
            liquidCompensationValue,
            restrictedCompensationValue,
            restrictedPerformanceBasisValue,
            restrictedPerformanceBasisValid,
            liquidNetWorth,
            totalNetWorth,
            consolidatedWealth,
            activeAlerts: r.activeAlerts,
            planDetails:  r.planDetails,
        };
    });
}

function computePerformanceChart({ benchmarkTimeline, spxGbpSeries, perfLedger, consolidatedTimeline }) {
    var _a, _b, _c;
    if (benchmarkTimeline.length === 0)
        return [];

    // ── Benchmark: the ONE canonical series (S&P 500 in GBP, price only). The chart, the cards and the
    // attribution all read the fields set on these rows, so they can never disagree.
    const _bench = spxGbpSeries;
    let _benchBase = null;   // GBP level at the first row that has a benchmark; that row is 100
    const _benchFor = (dateStr) => {
        // Latest S&P close on or before the row date: on a weekend or US holiday the index simply did not move.
        const k = seriesValueOnOrBefore(_bench.rows, dateStr, BENCH_MAX_STALE_DAYS);
        if (!k) return { benchmark: null };
        if (_benchBase == null) _benchBase = k.row.gbp;
        return { benchmark: _benchBase > 0 ? (k.row.gbp / _benchBase) * 100 : null,
                 spxNative: k.row.usd, spxGbp: k.row.gbp, spxSourceDate: k.row.date, spxStale: k.staleDays > 3 };
    };

    // The chart starts at the first row with a portfolio value. SPX data is not required there: the benchmark series is
    // independent and starts from the first valid SPX close on or after it.
    const anchorRow = benchmarkTimeline.find(p => p.portfolioValue > 0);
    if (!anchorRow)
        return [];
    const anchor = anchorRow.date;
    const sortedTx = [...perfLedger].sort((a, b) => a.parsedDate - b.parsedDate);
    // Bases for each additional benchmark — null if no price at the anchor date
    const benchBase = {};
    for (const b of BENCHMARKS) {
        if (b.id === '^GSPC')
            continue; // ^GSPC is handled by the canonical S&P-in-GBP series (_benchFor) above
        benchBase[b.id] = (_b = (_a = anchorRow.benchGBP) === null || _a === void 0 ? void 0 : _a[b.id]) !== null && _b !== void 0 ? _b : null;
    }
    // For portfolio: chain weekly Modified Dietz returns starting from anchor
    const filtered = benchmarkTimeline.filter(p => p.date >= anchor);
    let portfolioIndex = 100;
    // Parallel "invested-only" index: tracks the return of just the equity + untickered book
    // (i.e. excluding cash). Cash flows into this sub-portfolio are buys (cash → equity); flows
    // out are sells (equity → cash). External subscriptions don't flow in until a buy happens.
    // The delta between this and portfolioIndex is the cash drag.
    let investedIndex = 100;
    let investedAnchorValue = anchorRow.holdingsValue + (anchorRow.untickeredValue || 0);
    // ── Stage 3.2: O(1) compensation overlay lookup ────────────────────
    // keyed by date string — same weekly spine as benchmarkTimeline.
    // rawValue, portfolioIndex, investedIndex and all benchmark indices are
    // left strictly unmodified; these two fields are purely additive.
    const compMap = new Map(consolidatedTimeline.map(p => [p.date, p]));
    // ── investedAll: the chart's line. The same invested-only chain with the restricted schemes added as
    // positions (HSBC (R), Citi (R)): their price moves count as return; grants arriving, tranches vesting out
    // and Sharesave contributions are flows (restrictedChartFlows), booked at the end of the step. `invested`
    // itself stays ledger-only for the stats that compare it with the cash-inclusive return.
    let investedAllIndex = 100;
    let prevRP = null;
    let investedAllAnchorValue = 0;
    const result = [];
    for (let i = 0; i < filtered.length; i++) {
        const row = filtered[i];
        const investedValue = row.holdingsValue + (row.untickeredValue || 0);
        // Build per-row benchmark map. Each value is the rebased-to-100 index for that benchmark
        // at this date. Stored under bench_<id> so Recharts can use dataKey to pick them up.
        const benchSeries = {};
        for (const b of BENCHMARKS) {
            if (b.id === '^GSPC')
                continue;
            const px = (_c = row.benchGBP) === null || _c === void 0 ? void 0 : _c[b.id];
            const base = benchBase[b.id];
            benchSeries[`bench_${b.id}`] = (px != null && base != null && base > 0) ? (px / base) * 100 : null;
        }
        const rp = restrictedChartPoint((compMap.get(row.date) || {}).planDetails, row.date);
        const investedAllValue = investedValue + rp.total;
        if (i === 0) {
            const c0 = compMap.get(row.date) || {};
            investedAllAnchorValue = investedAllValue;
            prevRP = rp;
            // benchmark at the anchor row: 100 (the first row with an S&P close on or before it).
            const _b0x = _benchFor(row.date);
            const _b0 = _b0x.benchmark;
            result.push(Object.assign({ date: row.date, portfolio: 100, invested: investedValue > 0 ? 100 : null, benchmark: _b0, spxNative: _b0x.spxNative, spxGbp: _b0x.spxGbp, spxSourceDate: _b0x.spxSourceDate, spxStale: _b0x.spxStale, rawValue: row.portfolioValue, investedRawValue: investedValue, contributed: row.contributed, liquidNetWorthValue: c0.liquidNetWorth != null ? c0.liquidNetWorth : (row.portfolioValue || 0), totalWealthValue: c0.totalNetWorth != null ? c0.totalNetWorth : (row.portfolioValue || 0), investedAll: investedAllValue > 0 ? 100 : null, investedAllRawValue: investedAllValue, rBy: rp.by, rPx: rp.px, rFlow: {}, rFlowTotal: 0 }, benchSeries));
            continue;
        }
        const prev = filtered[i - 1];
        const prevInvestedValue = prev.holdingsValue + (prev.untickeredValue || 0);
        const periodMs = new Date(row.date) - new Date(prev.date);
        // Total portfolio: subscriptions/transfers are external CFs
        let netCF = 0, weightedCF = 0;
        // Invested-only: buys/sells are external CFs (buy = +, sell = −)
        let netInvestedCF = 0, weightedInvestedCF = 0;
        for (const t of sortedTx) {
            const ts = fmtDate(t.parsedDate);
            if (ts <= prev.date || ts > row.date)
                continue;
            if (t.internalTransfer)
                continue;   // a matched transfer between two accounts in this ledger is not an external flow
            const w = (new Date(row.date) - t.parsedDate) / periodMs;
            if (t.category === 'subscription' || t.category === 'transfer') {
                netCF += t.value;
                weightedCF += t.value * w;
            }
            else if (t.category === 'transfer_out') {
                // External capital extraction: mirror of cashFlow -= t.value in portfolioTimeline.
                // Removing it from the Dietz denominator prevents the return engine from
                // interpreting the asset departure as an investment loss.
                netCF -= t.value;
                weightedCF -= t.value * w;
                // Mirror to invested-only sub-portfolio: assets left the equity pool externally.
                netInvestedCF -= Math.abs(t.value);
                weightedInvestedCF -= Math.abs(t.value) * w;
            }
            else if (t.category === 'transfer_in') {
                // Inbound spousal transfer: treat as external capital injection for TWR purposes.
                // Adding to netCF/weightedCF ensures the arriving assets don't masquerade as
                // investment performance in the Modified Dietz return calculation.
                if (Math.abs(t.value) > 0.001) {
                    netCF += Math.abs(t.value);
                    weightedCF += Math.abs(t.value) * w;
                    // Mirror to invested-only sub-portfolio: assets arrived externally, not via a buy.
                    netInvestedCF += Math.abs(t.value);
                    weightedInvestedCF += Math.abs(t.value) * w;
                }
            }
            else if (t.category === 'buy' || t.category === 'sell') {
                // Sign flip: buy has t.value < 0 (cash leaves wallet); from invested's view that's +CF.
                // sell has t.value > 0 (cash enters wallet); from invested's view that's −CF.
                const invCF = -t.value;
                netInvestedCF += invCF;
                weightedInvestedCF += invCF * w;
            }
        }
        const denom = prev.portfolioValue + weightedCF;
        let r = 0;
        if (denom > 1) {
            r = (row.portfolioValue - prev.portfolioValue - netCF) / denom;
            // Same stability clamp as invested-only: Modified Dietz becomes unreliable when
            // a large external flow (subscription/transfer) dwarfs the starting portfolio value.
            // e.g. a transfer larger than the whole portfolio landing in one week, where a same-day
            // transfer (weight=0) inflates the denominator gap.
            // Clamp to ±50% per week; genuine weekly moves never approach this.
            if (r < -0.5)
                r = -0.5;
            if (r > 0.5)
                r = 0.5;
        }
        portfolioIndex *= (1 + r);
        const investedDenom = prevInvestedValue + weightedInvestedCF;
        // Only chain when there's something invested. If prev was zero (no positions yet),
        // skip the period — investedIndex stays at 100 until the first holding shows up.
        let investedR = 0;
        if (investedDenom > 1) { // gate: tiny denominators produce wild returns
            investedR = (investedValue - prevInvestedValue - netInvestedCF) / investedDenom;
            // Modified Dietz becomes unstable when intra-period cash flows are comparable to starting
            // invested value (e.g. a £10k buy into a £7k position followed by a same-week drawdown
            // produces returns like −125% that aren't real). Clamp to a sane weekly band to prevent
            // these from dominating the chain. The threshold is wide enough that genuine large weekly
            // moves still register; only numerical pathologies are clipped.
            if (investedR < -0.5)
                investedR = -0.5;
            if (investedR > 0.5)
                investedR = 0.5;
        }
        // Once we have a positive invested base, start chaining
        if (investedAnchorValue <= 0 && investedValue > 0) {
            investedAnchorValue = investedValue;
            // Don't chain this step — first equity entrance is itself a cash flow, not a return
        }
        else if (investedDenom > 1) {
            investedIndex *= (1 + investedR);
        }
        // investedAll: same step with the restricted positions in (see above).
        const rFl = restrictedChartFlows(prevRP, rp);
        const prevInvestedAllValue = prevInvestedValue + prevRP.total;
        const investedAllDenom = prevInvestedAllValue + weightedInvestedCF;
        let investedAllR = 0;
        if (investedAllDenom > 1) {
            investedAllR = (investedAllValue - prevInvestedAllValue - netInvestedCF - rFl.total) / investedAllDenom;
            if (investedAllR < -0.5) investedAllR = -0.5;
            if (investedAllR > 0.5) investedAllR = 0.5;
        }
        if (investedAllAnchorValue <= 0 && investedAllValue > 0) investedAllAnchorValue = investedAllValue;
        else if (investedAllDenom > 1) investedAllIndex *= (1 + investedAllR);
        prevRP = rp;
        const c = compMap.get(row.date) || {};
        // benchmark: S&P 500 in GBP at this row (latest close on or before the row date), rebased to 100 at the first row.
        const _rowX = _benchFor(row.date);
        const _rowBench = _rowX.benchmark;
        result.push(Object.assign({ date: row.date, portfolio: portfolioIndex, invested: investedValue > 0 ? investedIndex : null, benchmark: _rowBench, spxNative: _rowX.spxNative, spxGbp: _rowX.spxGbp, spxSourceDate: _rowX.spxSourceDate, spxStale: _rowX.spxStale, rawValue: row.portfolioValue, investedRawValue: investedValue, contributed: row.contributed, liquidNetWorthValue: c.liquidNetWorth != null ? c.liquidNetWorth : (row.portfolioValue || 0), totalWealthValue: c.totalNetWorth != null ? c.totalNetWorth : (row.portfolioValue || 0), investedAll: investedAllValue > 0 ? investedAllIndex : null, investedAllRawValue: investedAllValue, rBy: rp.by, rPx: rp.px, rFlow: rFl.flow, rFlowTotal: rFl.total }, benchSeries));
    }
    return result;
}

function computeRisk({ performanceChart, cashRate }) {
    if (performanceChart.length < 3)
        return null;
    // Risk statistics use a WEEKLY sample of the rows (the history is weekly for older data and daily for the
    // last ~year; mixing the two made 'weekly' returns, volatility and drawdown inconsistent).
    const wkRows = sampleWeeklyRows(performanceChart);
    const n = wkRows.length;
    if (n < 3)
        return null;
    const portIdx = wkRows.map(p => p.portfolio);
    const benchIdx = wkRows.map(p => p.benchmark);
    const dates = wkRows.map(p => p.date);
    // Weekly returns
    const portRets = [];
    const benchRets = [];
    for (let i = 1; i < n; i++) {
        if (portIdx[i - 1] > 0)
            portRets.push(portIdx[i] / portIdx[i - 1] - 1);
        if (benchIdx[i] != null && benchIdx[i - 1] != null && benchIdx[i - 1] > 0) {
            benchRets.push(benchIdx[i] / benchIdx[i - 1] - 1);
        }
    }
    if (portRets.length < 2)
        return null;
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const stdev = (a) => {
        if (a.length < 2)
            return 0;
        const m = mean(a);
        const v = a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
        return Math.sqrt(v);
    };
    // Annualised stats (weekly → annual: × √52 for vol, compounding for return)
    const periodYears = (new Date(dates[n - 1]) - new Date(dates[0])) / (365.25 * 86400 * 1000);
    // Steps per year actually observed (about 52), used to annualise instead of a hard-coded 52.
    const stepsPerYear = periodYears > 0 ? (n - 1) / periodYears : 52;
    const totalPortRet = portIdx[n - 1] / portIdx[0] - 1;
    const annPortRet = periodYears > 0 ? Math.pow(1 + totalPortRet, 1 / periodYears) - 1 : 0;
    const annPortVol = stdev(portRets) * Math.sqrt(stepsPerYear);
    const downsidePort = portRets.filter(r => r < 0);
    const annPortDownsideVol = downsidePort.length > 1 ? stdev(downsidePort) * Math.sqrt(stepsPerYear) : 0;
    // Drawdown series: at each step, current vs running peak
    let peak = portIdx[0];
    let maxDD = 0;
    let maxDDDate = dates[0];
    let maxDDPeakDate = dates[0];
    let currentPeakDate = dates[0];
    const ddCurve = portIdx.map((v, i) => {
        if (v > peak) {
            peak = v;
            currentPeakDate = dates[i];
        }
        const dd = v / peak - 1; // negative or zero
        if (dd < maxDD) {
            maxDD = dd;
            maxDDDate = dates[i];
            maxDDPeakDate = currentPeakDate;
        }
        return { date: dates[i], drawdown: dd * 100 };
    });
    // Benchmark equivalents (if we have a benchmark series)
    let benchStats = null;
    if (benchRets.length >= 2 && benchIdx[0] != null && benchIdx[n - 1] != null) {
        const totalBenchRet = benchIdx[n - 1] / benchIdx[0] - 1;
        const annBenchRet = periodYears > 0 ? Math.pow(1 + totalBenchRet, 1 / periodYears) - 1 : 0;
        const annBenchVol = stdev(benchRets) * Math.sqrt(stepsPerYear);
        // Bench drawdown
        let bpeak = benchIdx[0];
        let bMaxDD = 0;
        for (let i = 0; i < n; i++) {
            if (benchIdx[i] == null)
                continue;
            if (benchIdx[i] > bpeak)
                bpeak = benchIdx[i];
            const dd = benchIdx[i] / bpeak - 1;
            if (dd < bMaxDD)
                bMaxDD = dd;
        }
        const cashDecimal = (cashRate || 0) / 100;
        const benchSharpe = annBenchVol > 0 ? (annBenchRet - cashDecimal) / annBenchVol : null;
        benchStats = { annReturn: annBenchRet, annVol: annBenchVol, maxDD: bMaxDD, sharpe: benchSharpe };
    }
    const cashDecimal = (cashRate || 0) / 100;
    const sharpe = annPortVol > 0 ? (annPortRet - cashDecimal) / annPortVol : null;
    const sortino = annPortDownsideVol > 0 ? (annPortRet - cashDecimal) / annPortDownsideVol : null;
    // Win rate: share of weeks with a positive return; plus best/worst single week.
    const winCount = portRets.filter(r => r > 0).length;
    const winRate = portRets.length > 0 ? winCount / portRets.length : null;
    const bestWeek = portRets.length ? Math.max(...portRets) : null;
    const worstWeek = portRets.length ? Math.min(...portRets) : null;
    // Beat-benchmark rate: share of weeks the portfolio outperformed SPX (aligned weeks only).
    let beatCount = 0, alignedWeeks = 0;
    {
        let bi = 0;
        for (let i = 1; i < n; i++) {
            if (portIdx[i - 1] > 0 && benchIdx[i] != null && benchIdx[i - 1] != null && benchIdx[i - 1] > 0) {
                const pr = portIdx[i] / portIdx[i - 1] - 1;
                const br = benchIdx[i] / benchIdx[i - 1] - 1;
                alignedWeeks++;
                if (pr > br)
                    beatCount++;
            }
        }
    }
    const beatRate = alignedWeeks > 0 ? beatCount / alignedWeeks : null;
    return {
        ddCurve,
        maxDD,
        maxDDDate,
        maxDDPeakDate,
        annReturn: annPortRet,
        annVol: annPortVol,
        annDownsideVol: annPortDownsideVol,
        sharpe,
        sortino,
        winRate,
        bestWeek,
        worstWeek,
        beatRate,
        periodYears,
        weeks: portRets.length,
        bench: benchStats,
    };
}

function computeChartData({ today, chartTimeframe, chartTodayPnl, performanceChart, liveAt, liveQuoteSessionDates }) {
    const todayStr = fmtDate(today);
    if (chartTimeframe === '1D') {
        // heroTodayPnl already has the todayPnlSnapshot fallback baked in —
        // so this path works even when liveStatus is 'fail' (sandbox/offline).
        if (chartTodayPnl.abs == null || chartTodayPnl.totalValue == null) return [];
        const todayVal  = chartTodayPnl.totalValue;
        const yestVal   = todayVal - chartTodayPnl.abs;
        const lastPt    = performanceChart.length ? performanceChart[performanceChart.length - 1] : null;
        const lastTWR   = lastPt ? lastPt.portfolio : 100;
        const todayTWR  = chartTodayPnl.pct != null
            ? lastTWR * (1 + chartTodayPnl.pct) : lastTWR;
        const pnl1dStr  = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr())
            || getCurrentPnlSessionDateStr();
        const yestStr   = previousTradingDayStr(pnl1dStr);
        return [
            { date: yestStr,  rawValue: yestVal,  portfolio: 100 },
            { date: pnl1dStr, rawValue: todayVal, portfolio: (lastTWR > 0 ? todayTWR / lastTWR * 100 : 100) },
        ];
    }
    if (performanceChart.length === 0) return [];
    let anchorStr = null;
    if (chartTimeframe === 'ALL') {
        anchorStr = '2023-01-01'; // Locks the ALL window to Jan 2023 as the earliest useful anchor
    } else {
        const d = new Date(today);
        if (chartTimeframe === '1W')       d.setDate(d.getDate() - 7);
        else if (chartTimeframe === '1M')   d.setMonth(d.getMonth() - 1);
        else if (chartTimeframe === '3M')   d.setMonth(d.getMonth() - 3);
        else if (chartTimeframe === 'YTD')  d.setMonth(0, 1);
        else if (chartTimeframe === '1Y')   d.setFullYear(d.getFullYear() - 1);
        anchorStr = fmtDate(d);
    }
    let base = anchorStr
        ? performanceChart.filter(p => p.date >= anchorStr)
        : performanceChart;
    if (chartTimeframe === 'YTD') {
        // YTD starts from the last close of the previous year (the last row on/before 31 Dec), not the first row of January.
        const _ye = (parseInt(todayStr.slice(0, 4), 10) - 1) + '-12-31';
        let _k = -1;
        for (let i = 0; i < performanceChart.length; i++) { if (performanceChart[i].date <= _ye) _k = i; else break; }
        if (_k >= 0) base = performanceChart.slice(_k);
    }
    if (base.length === 0) return performanceChart.slice(-2);
    // Strip trailing weekend dates — don't plot flat Sat/Sun market-closed segments.
    // Chart should end at the latest completed trading session (normally Friday).
    {
        let trimmed = base;
        while (trimmed.length > 1) {
            const lastDate = trimmed[trimmed.length - 1].date;
            const dow = new Date(lastDate + 'T12:00:00Z').getUTCDay();
            if (dow === 0 || dow === 6) { trimmed = trimmed.slice(0, -1); } else { break; }
        }
        if (trimmed.length > 0) base = trimmed;
    }
    // ── Final-point reconciliation ───────────────────────────────────────
    // performanceChart can forward-fill stale Thursday prices into Friday when
    // live injection was skipped (e.g. backup restore with empty liveQuoteSessionDates).
    // Override the final base row so the chart agrees with the hero Today P&L.
    // This is display-layer only — no TWR or valuation engine is recalculated.
    // Reconciliation source: prefer live masterPortfolio; fall back to the
    // frozen todayPnlSnapshot from the backup when offline or in the sandbox.
    // The sessionDate guard prevents a stale snapshot from patching the wrong day.
    const effectiveChartDate = getEffectivePnlSessionDateStr(liveAt, getCurrentPnlSessionDateStr())
        || getCurrentPnlSessionDateStr();
    const pnlForChart = (chartTodayPnl.abs != null && chartTodayPnl.totalValue != null)
        ? { totalValue: chartTodayPnl.totalValue, todayAbsChange: chartTodayPnl.abs, todayPctChange: chartTodayPnl.pct }
        : null;

    if (base.length >= 2 && pnlForChart != null) {
        const lastBase = base[base.length - 1];

        if (lastBase.date === effectiveChartDate) {
            const penult = base[base.length - 2];
            const patched = { ...lastBase };

            // Portfolio: override rawValue (value mode) and portfolio index (twr mode)
            // Uses pnlForChart (live masterPortfolio OR frozen todayPnlSnapshot fallback)
            patched.rawValue = pnlForChart.totalValue;
            if (pnlForChart.todayPctChange != null
                && penult.portfolio != null
                && Number.isFinite(penult.portfolio)) {
                patched.portfolio = penult.portfolio * (1 + pnlForChart.todayPctChange);
            }

            // Benchmark for today: performanceChart's row for this date already holds the S&P in GBP built from the live
            // S&P quote and the live GBP/USD rate, so nothing is patched. If the US market has not traded on this
            // date (pre-open, or a US holiday) the benchmark line ends at the prior session instead of a flat step.
            const _spxSessionDate = liveQuoteSessionDates && liveQuoteSessionDates['^GSPC'];
            if (_spxSessionDate !== effectiveChartDate) patched.benchmark = null;

            base = [...base.slice(0, -1), patched];
        }
    }

    // Rebase all series to 100 at the start of this window so every line
    // starts together regardless of which timeframe is selected.
    const twrBase     = base[0].portfolio  || 100;
    const benchBase   = (base.find(p => p.benchmark != null && p.benchmark > 0) || {}).benchmark || null;   // first row that has a benchmark
    const investedBase = base[0].invested  || 100;
    const investedAllBase = base[0].investedAll || 100;
    // Collect bases for secondary benchmark overlays (bench_<id> keys)
    const secondaryBases = {};
    Object.keys(base[0]).forEach(k => {
        if (k.startsWith('bench_')) secondaryBases[k] = base[0][k] || 100;
    });
    return base.map(p => {
        const out = {
            ...p,
            portfolio: twrBase     > 0 ? (p.portfolio  / twrBase)     * 100 : p.portfolio,
            benchmark: (p.benchmark != null && benchBase > 0) ? (p.benchmark / benchBase) * 100 : null,
            invested:  investedBase > 0 ? (p.invested  / investedBase) * 100 : p.invested,
            investedAll: (p.investedAll != null && investedAllBase > 0) ? (p.investedAll / investedAllBase) * 100 : p.investedAll,
        };
        Object.keys(secondaryBases).forEach(k => {
            const bBase = secondaryBases[k];
            out[k] = (p[k] != null && bBase > 0) ? (p[k] / bBase) * 100 : p[k];
        });
        return out;
    });
}
