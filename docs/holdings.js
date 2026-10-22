// Holdings and analytics: the pure calculations behind the holdings lists, today's moves, attribution and insights.
// Each computeX takes everything it reads as one object and returns the figure; PortfolioApp wraps each in useMemo.
// Loaded by index.html before app.js (after performance.js, whose priceAt and makeGbpusdAt these use); shares its globals
// (no module system, no build step).

function computeProcessedExternalHoldings({ externalHoldings, liveAt, liveStatus, tickerCurrencyMap, liveQuoteSessionDates, gbpusdRate, livePrices, resolvedPricesMap, liveDailyCloses }) {
    if (!externalHoldings || externalHoldings.length === 0) {
        return { processedHoldings: [], currentActualExternalCustodyValue: 0 };
    }
    // A custody ticker that is not in the HL ledger (e.g. Citi "C") has NO stored history, so it can only
    // be priced from a live quote, a remembered one, or the CSV. Order and labelling: see below.
    const _cand = getCurrentPnlSessionDateStr();
    const _glob = getEffectivePnlSessionDateStr(liveAt, _cand);
    const ciGet = (map, tk) => {
        if (!map || !tk) return null;
        const n = String(tk).toUpperCase().trim();
        if (map[n] != null) return map[n];
        const k = Object.keys(map).find(kk => String(kk).toUpperCase().trim() === n);
        return k ? map[k] : null;
    };
    const lastKnown = loadCustodyLastPrices();
    const pending = liveStatus === 'idle' || liveStatus === 'fetching';
    let totalGBP = 0;
    const processed = externalHoldings.map(h => {
        const ticker  = (h.ticker || '').trim();
        const shares  = typeof h.shares === 'number' ? h.shares : parseFloat(h.shares) || 0;
        const currency = lookupCurrency(tickerCurrencyMap, ticker) || normaliseQuoteCurrency(h.currency) || 'GBP';
        const sessionDay = getEffectiveDateForTicker(ticker.toUpperCase(), liveQuoteSessionDates, _cand, _glob) || _glob || _cand;

        // Order: today's live quote, then the stored series (live-injected), then the last live price
        // remembered from an earlier session, then the CSV spot_price. Everything but the first two is
        // labelled on the card, so a stale figure can never pass for a live one.
        let spotGBP = null, priceSource = null, priceRaw = null, priceAsOf = null;
        const take = (raw, src, asOf) => {
            if (spotGBP != null || !(Number.isFinite(raw) && raw > 0)) return;
            const g = pxToGBPWithCurrency(raw, currency, gbpusdRate);
            if (g != null && isFinite(g)) { spotGBP = g; priceSource = src; priceRaw = raw; priceAsOf = asOf || null; }
        };
        take(Number(ciGet(livePrices, ticker)), 'live', sessionDay);
        const series = resolvedPricesMap[ticker];
        if (spotGBP == null && series && series.length > 0) {
            // priceAt is available here (inside PortfolioApp scope)
            const lastPt = series[series.length - 1];
            // Fix 1: explicit currency field — avoids GBX default misvaluing USD tickers
            take(Number(priceAt(series, lastPt.date)), 'history', lastPt.date);
        }
        const lk = lastKnown[ticker.toUpperCase()];
        if (spotGBP == null && lk && String(lk.ccy || '').toUpperCase() === String(currency).toUpperCase()) take(Number(lk.px), 'lastKnown', lk.asOf);
        // Last resort: spot_price from the CSV
        if (spotGBP == null && h.spot_price != null) take(typeof h.spot_price === 'number' ? h.spot_price : parseFloat(h.spot_price), 'csv', null);

        const valueGBP = (spotGBP != null && isFinite(spotGBP)) ? shares * spotGBP : null;
        if (valueGBP != null) totalGBP += valueGBP;

        // Today's move: same gated live price + verified previous close as every other 1D figure.
        let dayAbs = null, dayPct = null;
        if (ticker && valueGBP != null) {
            const pair = resolveRestrictedDailyPricePair({ ticker, currency, dollarRate: gbpusdRate, livePrices, liveDailyCloses, todayStr: sessionDay });
            if (pair.ok && pair.prevGBP > 0) {
                dayAbs = shares * (pair.liveGBP - pair.prevGBP);
                dayPct = pair.liveGBP / pair.prevGBP - 1;
            }
        }

        // Cost basis: an explicit cost_basis_gbp wins; otherwise the vest value in sterling at the GBP/USD rate
        // on the vest date. Unknown (never guessed from today's rate) if either input is missing.
        let costBasisGBP = null, costBasisSource = null, costNote = null, fxAtVest = null;
        const vestISO = parseCustodyDate(h.vest_date);
        const vestPx  = Number(h.vest_price);
        if (Number(h.cost_basis_gbp) > 0) { costBasisGBP = Number(h.cost_basis_gbp); costBasisSource = 'csv'; }
        else if (vestISO && Number.isFinite(vestPx) && vestPx > 0 && shares > 0) {
            const cur = String(currency).toUpperCase();
            if (cur === 'GBP' || cur === 'GBX' || cur === 'GBPENCE') {
                costBasisGBP = pxToGBPWithCurrency(shares * vestPx, cur, 1); costBasisSource = 'vest';
            } else {
                const fx = rateOnOrBefore(resolvedPricesMap['GBPUSD=X'], vestISO, 7);
                if (fx && cur === 'USD') {
                    const g = pxToGBPWithCurrency(shares * vestPx, 'USD', fx.rate);
                    if (g != null && isFinite(g) && g > 0) { costBasisGBP = g; costBasisSource = 'vest'; fxAtVest = fx.rate; }
                } else if (!fx && cur === 'USD') costNote = 'no GBP/USD rate stored for the vest date';
                else costNote = 'vest cost needs a GBP/USD rate; ' + cur + ' is not supported';
            }
        } else if (h.vest_date || h.vest_price) {
            costNote = !vestISO ? 'vest_date not understood (use DD/MM/YYYY)' : 'vest_price missing or not a number';
        }

        return {
            ticker,
            displayName:     h.display_name || ticker,
            custodyPlatform: h.custody_platform || '—',
            sector:          h.sector || null,
            currency,
            shares,
            spotGBP,
            valueGBP,
            priceSource, priceRaw, priceAsOf, pricePending: pending && valueGBP == null, dayAbs, dayPct, sessionDay,
            costBasisGBP, costBasisSource, costNote, fxAtVest,
            vestDate: vestISO, vestPrice: (Number.isFinite(vestPx) && vestPx > 0) ? vestPx : null,
        };
    });
    return {
        processedHoldings: processed,
        currentActualExternalCustodyValue: totalGBP,
    };
}

function computeAttribution({ performanceChart, perfLedger, resolvedPricesMap, gbpusdAt, tickerCurrencyMap, tickerNameMap }) {
    var _a, _b;
    if (performanceChart.length < 2)
        return null;
    const orderedDates = performanceChart.map(p => p.date);
    // S&P 500 in GBP from the canonical series (the same one the chart and cards use).
    const spxByDate = new Map(performanceChart.filter(p => p.spxGbp != null).map(p => [p.date, p.spxGbp]));
    if (spxByDate.size < 2)
        return null;
    const sortedTx = [...perfLedger].sort((a, b) => a.parsedDate - b.parsedDate);
    const allTickers = new Set();
    for (const t of sortedTx) {
        const tk = (_a = t.instrument) === null || _a === void 0 ? void 0 : _a.ticker;
        // Collect tickers from all position-changing events; exclude the UNTICKERED sentinel
        // (no price series exists for it, so attribution correctly skips it at valuation time).
        if (tk && tk !== 'UNTICKERED' && (t.category === 'buy' || t.category === 'sell' || t.category === 'transfer_in' || t.category === 'transfer_out')) {
            allTickers.add(tk);
        }
    }
    // weeklyUnits[date] = {ticker: units}
    const weeklyUnits = {};
    for (const dateStr of orderedDates) {
        const cutoff = new Date(dateStr + 'T23:59:59Z');
        const units = {};
        for (const t of sortedTx) {
            if (t.parsedDate > cutoff)
                break;
            const tk = (_b = t.instrument) === null || _b === void 0 ? void 0 : _b.ticker;
            if (!tk || tk === 'UNTICKERED')
                continue;
            const qty = parseFloat((t.quantity || "").replace(/,/g, "")) || 0;
            if (t.category === 'buy' || t.category === 'transfer_in')
                units[tk] = (units[tk] || 0) + qty;
            else if (t.category === 'sell' || t.category === 'transfer_out')
                units[tk] = (units[tk] || 0) - qty;
        }
        weeklyUnits[dateStr] = units;
    }
    // Per-ticker per-week price+value snapshot
    const snap = {}; // snap[date][ticker] = { value, price, weight }
    const totalByDate = {};
    for (const dateStr of orderedDates) {
        const row = {};
        let total = 0;
        for (const [tk, qty] of Object.entries(weeklyUnits[dateStr])) {
            if (Math.abs(qty) < 0.0001)
                continue;
            const series = resolvedPricesMap[tk];
            if (!series)
                continue;
            const px = priceAt(series, dateStr);
            if (px == null)
                continue;
            const gbp2 = pxToGBP(tk, px, gbpusdAt(dateStr), tickerCurrencyMap);
            if (gbp2 == null)
                continue;
            const value = qty * gbp2;
            row[tk] = { value, price: px };
            total += value;
        }
        totalByDate[dateStr] = total;
        // Assign weights now that we have the total
        for (const tk of Object.keys(row)) {
            row[tk].weight = total > 0 ? row[tk].value / total : 0;
        }
        snap[dateStr] = row;
    }
    // Compute weekly portfolio (invested-only) returns by chaining per-position contributions.
    // r_p_t = sum_i weight_i_{t-1} × return_i_t
    // For tickers held at t-1 but not at t (sold during the week): return them using the
    // last available price at t. For tickers added during the week: skip — they contribute next week.
    const weeklyData = []; // {date, rp_port, rp_spx, perTicker: {tk: contribution}, perTickerSPX: {tk: contribution}}
    for (let i = 1; i < orderedDates.length; i++) {
        const prevDate = orderedDates[i - 1];
        const currDate = orderedDates[i];
        const prevSnap = snap[prevDate];
        const currSnap = snap[currDate];
        const prevTotal = totalByDate[prevDate];
        const currTotal = totalByDate[currDate];
        const perTicker = {};
        const perTickerSPX = {};
        let rp = 0;
        let rpSPX = 0;
        // SPX weekly return (in GBP)
        const spxPrev = spxByDate.get(prevDate);
        const spxCurr = spxByDate.get(currDate);
        const spxRet = (spxPrev && spxCurr && spxPrev > 0) ? (spxCurr / spxPrev - 1) : 0;
        // Only attribute if there was something to weight against last week
        if (prevTotal <= 0) {
            weeklyData.push({ date: currDate, rp: 0, rpSPX: 0, perTicker, perTickerSPX });
            continue;
        }
        for (const tk of Object.keys(prevSnap)) {
            const prevPos = prevSnap[tk];
            // Try to find a current price for this ticker even if position was closed mid-week.
            const series = resolvedPricesMap[tk];
            if (!series)
                continue;
            const currPx = priceAt(series, currDate);
            if (currPx == null)
                continue;
            const weeklyRet = prevPos.price > 0 ? (currPx / prevPos.price - 1) : 0;
            const contrib = prevPos.weight * weeklyRet;
            const contribSPX = prevPos.weight * spxRet;
            perTicker[tk] = contrib;
            perTickerSPX[tk] = contribSPX;
            rp += contrib;
            rpSPX += contribSPX;
        }
        weeklyData.push({ date: currDate, rp, rpSPX, perTicker, perTickerSPX });
    }
    // Carino smoothing factors. For each week, compute k_t such that sum(k_t × r_p_t) = R.
    // R = compound return over the whole period.
    const compoundPort = weeklyData.reduce((p, w) => p * (1 + w.rp), 1) - 1;
    const compoundSPX = weeklyData.reduce((p, w) => p * (1 + w.rpSPX), 1) - 1;
    // Logarithmic mean function: A(r) = ln(1+r)/r when r != 0, else 1
    const logMean = (r) => {
        if (Math.abs(r) < 1e-9)
            return 1;
        if (r <= -1)
            return null; // would blow up
        return Math.log(1 + r) / r;
    };
    const kFactor = (rWeek, rTotal) => {
        const At = logMean(rWeek);
        const A = logMean(rTotal);
        if (At == null || A == null || A === 0)
            return 1; // safe fallback
        return At / A;
    };
    // Per-ticker totals (summed across weeks, with Carino scaling)
    const tickerContrib = {}; // ticker → contribution to portfolio TWR
    const tickerSPXContrib = {}; // ticker → contribution to SPX counterfactual TWR
    const tickerWeekCount = {}; // ticker → number of weeks contributed
    const tickerFirstDate = {};
    const tickerLastDate = {};
    const tickerWeightSum = {}; // for computing avg weight (using prev-week weights)
    const tickerPxFirst = {}; // ticker → first price observed
    const tickerPxLast = {}; // ticker → last price observed
    for (const w of weeklyData) {
        const kP = kFactor(w.rp, compoundPort);
        const kS = kFactor(w.rpSPX, compoundSPX);
        for (const tk of Object.keys(w.perTicker)) {
            tickerContrib[tk] = (tickerContrib[tk] || 0) + kP * w.perTicker[tk];
            tickerSPXContrib[tk] = (tickerSPXContrib[tk] || 0) + kS * w.perTickerSPX[tk];
            tickerWeekCount[tk] = (tickerWeekCount[tk] || 0) + 1;
            if (!tickerFirstDate[tk])
                tickerFirstDate[tk] = w.date;
            tickerLastDate[tk] = w.date;
        }
    }
    // Avg weight + first/last price per ticker (for the table display)
    for (const tk of allTickers) {
        let wSum = 0, count = 0;
        let pxFirst = null, pxLast = null;
        for (const dateStr of orderedDates) {
            const s = snap[dateStr][tk];
            if (!s)
                continue;
            wSum += s.weight;
            count++;
            if (pxFirst == null)
                pxFirst = s.price;
            pxLast = s.price;
        }
        tickerWeightSum[tk] = count > 0 ? wSum / count : 0;
        tickerPxFirst[tk] = pxFirst;
        tickerPxLast[tk] = pxLast;
    }
    // Build rows
    const results = [];
    for (const tk of Object.keys(tickerContrib)) {
        // Name and status now come from the CSV-sourced tickerNameMap — no TICKER_MAP.
        const tkName   = tickerNameMap[tk] || tk;
        const contribution = tickerContrib[tk];
        const spxCounterfactual = tickerSPXContrib[tk];
        const alpha = contribution - spxCounterfactual;
        // Simple position TWR (price-relative chain). Useful as a context column.
        const tickerTWR = (tickerPxFirst[tk] && tickerPxLast[tk] && tickerPxFirst[tk] > 0)
            ? (tickerPxLast[tk] / tickerPxFirst[tk] - 1) : null;
        // SPX TWR over the same window
        const spxStart = spxByDate.get(tickerFirstDate[tk]);
        const spxEnd = spxByDate.get(tickerLastDate[tk]);
        const spxTWR = (spxStart && spxEnd) ? (spxEnd / spxStart - 1) : null;
        results.push({
            ticker: tk,
            name: tkName,
            status: 'active',
            firstDate: tickerFirstDate[tk],
            lastDate: tickerLastDate[tk],
            weeksHeld: tickerWeekCount[tk],
            avgWeight: tickerWeightSum[tk],
            tickerTWR,
            spxTWR,
            contribution,
            spxCounterfactual,
            alpha,
        });
    }
    results.sort((a, b) => Math.abs(b.alpha) - Math.abs(a.alpha));
    const totalContribution = results.reduce((s, r) => s + r.contribution, 0);
    const totalSpxCounterfactual = results.reduce((s, r) => s + r.spxCounterfactual, 0);
    const totalAlpha = results.reduce((s, r) => s + r.alpha, 0);
    return {
        rows: results,
        totalContribution,
        totalSpxCounterfactual,
        totalAlpha,
        compoundPort, // portfolio invested-only TWR over window (decomposition target)
        compoundSPX, // SPX-counterfactual TWR over window
    };
}

function computeHoldings({ enriched, holdingsDate, resolvedPricesMap, endDate, gbpusdRate, tickerCurrencyMap }) {
    const map = new Map();
    const sorted = [...enriched].sort((a, b) => a.parsedDate - b.parsedDate);
    for (const t of sorted) {
        if (!t.instrument || !t.instrument.name)
            continue;
        // Include transfer_in so inbound spousal gifts build up the receiving account.
        // transfer_out still passes so positions resolve to zero rather than persisting at full size.
        const isHoldingImpact = t.category === 'buy' || t.category === 'sell' || t.category === 'transfer_out' || t.category === 'transfer_in';
        if (!isHoldingImpact)
            continue;
        // Only include trades up to the holdings date
        if (fmtDate(t.parsedDate) > holdingsDate)
            continue;
        // Key on ticker + account to separate same-instrument positions across accounts.
        // Fall back to asset name signature if ticker is the UNTICKERED sentinel.
        const acct = (t.account || 'UNASSIGNED ACCOUNT').trim().toUpperCase();
        const tkBase = (t.instrument.ticker && t.instrument.ticker !== 'UNTICKERED') ? t.instrument.ticker : t.instrument.name;
        const key = `${tkBase}||${acct}`;
        if (!map.has(key)) {
            map.set(key, { ...t.instrument, account: acct, units: 0, totalCost: 0, totalProceeds: 0, trades: 0, firstDate: t.parsedDate, lastDate: t.parsedDate });
        }
        const h = map.get(key);
        const qty = parseFloat((t.quantity || "").replace(/,/g, "")) || 0;
        if (t.category === 'buy') {
            h.units += qty;
            h.totalCost += Math.abs(t.value);
        } else if (t.category === 'transfer_in') {
            h.units += qty;
            // UK No Gain/No Loss: spousal transfers carry the donor's S104 cost basis,
            // not market value at transfer date. HL often exports these with value=0 or
            // with market value. Only accumulate cost if the row carries a non-zero value;
            // a zero-value row means the cost basis must be sourced from the donor's ledger
            // and entered as a manual adjustment — avoid corrupting totalCost with a false £0.
            if (Math.abs(t.value) > 0.001) {
                h.totalCost += Math.abs(t.value);
            }
        }
        else if (t.category === 'transfer_out') {
            // No Gain / No Loss: deduct units, book cost set to cost basis (not proceeds)
            // so the exit doesn't create a taxable event. Cash is unchanged.
            h.units -= qty;
            // We do NOT add to totalProceeds — the transfer is at cost, creating £0 P&L
            // SECTION 104 cost provenance tracking goes here if downstream extraction is calculated
        }
        else {
            // sell: normal disposal
            h.units -= qty;
            h.totalProceeds += t.value;
        }
        h.trades += 1;
        if (t.parsedDate < h.firstDate)
            h.firstDate = t.parsedDate;
        if (t.parsedDate > h.lastDate)
            h.lastDate = t.parsedDate;
    }
    return Array.from(map.values()).map(h => {
        // Untickered assets use instrument.name as their resolvedPricesMap key (per-name
        // synthetic series). Real tickers use the ticker as normal.
        const priceKey = (h.ticker && h.ticker !== 'UNTICKERED') ? h.ticker : h.name;
        const series = priceKey ? resolvedPricesMap[priceKey] : null;
        const px = series ? priceAt(series, holdingsDate) : null;
        const fxRate = endDate ? (priceAt(resolvedPricesMap['GBPUSD=X'], holdingsDate) || gbpusdRate) : gbpusdRate;
        // Untickered synthetic prices are stored in GBP (derived from HL £ values).
        // Real tickers go through pxToGBP for GBX/USD conversion.
        let gbpH = null;
        if (px != null) {
            if (h.ticker && h.ticker !== 'UNTICKERED') {
                gbpH = pxToGBP(h.ticker, px, fxRate, tickerCurrencyMap);
            } else {
                gbpH = px; // already in GBP
            }
        }
        const marketValue = gbpH != null ? h.units * gbpH : null;
        const netCost = h.totalCost - h.totalProceeds;
        const holdingYears = (h.lastDate - h.firstDate) / (365.25 * 86400 * 1000);
        return { ...h, currentPrice: px, marketValue, unrealisedPL: marketValue != null ? marketValue - netCost : null, holdingYears };
    });
}

function computePricingWarnings({ gbpusdInfo, activeHoldings, tickerCurrencyMap, enriched, externalHoldings }) {
    const w = [];
    if (gbpusdInfo.source === 'none')
        w.push('GBP/USD: no live or stored rate yet — USD lines are not valued until one arrives.');
    const noCcy = activeHoldings.map(h => h.ticker)
        .filter(tk => tk && tk !== 'UNTICKERED' && isListedTicker(tk, tickerCurrencyMap) && !GILT_LADDER_REGISTRY[tk]
                      && resolveQuoteCurrency(tk, tickerCurrencyMap) == null);
    if (noCcy.length)
        w.push('No currency yet for ' + noCcy.join(', ') + ' — valued once Yahoo returns a quote.');
    // Award vests: the sterling Value in the ledger is the recorded fact. When the row also states the local
    // price and the GBP/USD rate, check they agree, so a typo in a hand-entered value is caught.
    for (const t of enriched) {
        if (String(t.reference || '').toUpperCase() !== 'AWARD VEST') continue;
        const tk = t.instrument && t.instrument.ticker;
        const qty = parseFloat(String(t.quantity || '').replace(/,/g, '')) || 0;
        const val = Math.abs(t.value || 0);
        if (!(val > 0.001)) { w.push('Award vest ' + tk + ' ' + t.tradeDate + ' has no sterling Value (\u00a3) \u2014 its cost basis is unknown.'); continue; }
        const ccy = String((t.instrument && t.instrument.currency) || 'GBP').toUpperCase();
        if (t.localPrice && qty > 0) {
            const fx = ccy === 'USD' ? t.fxRate : 1;
            if (ccy === 'USD' && !(fx > 0)) continue;
            const expected = ccy === 'GBX' ? qty * t.localPrice / 100 : (qty * t.localPrice) / fx;
            if (Math.abs(expected - val) / val > 0.01)
                w.push('Award vest ' + tk + ' ' + t.tradeDate + ': Value \u00a3' + val.toFixed(2) + ' does not match ' + qty + ' \u00d7 ' + ccy + ' ' + t.localPrice +
                       (ccy === 'USD' ? ' \u00f7 ' + fx : '') + ' = \u00a3' + expected.toFixed(2) + ' \u2014 check the row.');
        }
    }
    // A custody-file row for a position that is now in the ledger is ignored (it would count twice).
    for (const h of (externalHoldings || [])) {
        const tk = String(h.ticker || '').toUpperCase().trim(), ac = String(h.custody_platform || '').toUpperCase().trim();
        if (tk && activeHoldings.some(l => String(l.ticker || '').toUpperCase() === tk && String(l.account || '').toUpperCase() === ac))
            w.push('External custody row ' + tk + ' (' + ac + ') is also in the ledger \u2014 the ledger is used; remove it from the custody file.');
    }
    return w;
}

function computeLedgerHoldingsWithDelta({ giltLadderState, liveAt, liveStatus, livePrices, activeHoldings, prices, gbpusdRate, tickerCurrencyMap, liveQuoteChecks, liveQuoteSessionDates, liveDailyCloses }) {
    // Gilt valuation override map (acyclic — derived from enriched only, not from holdings).
    // Only gilts with a verified market price (or a matured redemption bridge) have a rung. A gilt with no
    // price has none, so it falls through to the generic holdings path like any other unpriced holding.
    const giltRungByTicker = giltLadderState
        ? new Map(giltLadderState.rungs.map(r => [r.ticker, r]))
        : new Map();
    const giltUnpricedTickers = new Set(giltLadderState ? giltLadderState.unpriced.map(r => r.ticker) : []);

    // Helper: apply gilt override to a holding, preserving all cost-basis fields.
    // Returns a NEW object — never mutates h in place.
    function applyGiltOverride(h, rung) {
        const netCost = h.totalCost - h.totalProceeds;
        const overriddenValue = rung.dirtyValue + rung.maturedCashValue;
        // todayPctChange uses yesterday's dirty value as the safe denominator
        const prevDirty = overriddenValue - (rung.dailyPnL ?? 0);
        return Object.assign({}, h, {
            // ── Override: current valuation display fields only ───────
            marketValue:        overriddenValue,
            unrealisedPL:       overriddenValue - netCost,
            todayAbsChange:     rung.dailyPnL,
            todayPctChange:     (rung.dailyPnL != null && prevDirty > 0) ? rung.dailyPnL / prevDirty : null,
            // ── Injected gilt metadata (display only) ─────────────────
            // The London session this gilt's daily move was measured on (null when not market-priced).
            todaySessionDate:   rung.marketSession || null,
            valuationMethod:    'gilt_market_dirty',
            displayValueLabel:  rung.priceSource === 'market' ? 'Market Dirty Value (giltsyield.com)' : 'Matured \u00b7 valued at par until settlement',
            accruedInterest:    rung.accruedInterest,
            cleanPrice:         rung.cleanPrice,
            isCouponDay:        rung.isCouponDay,
            couponCashToday:    rung.couponCashToday,
            daysToMaturity:     rung.daysToMaturity,
            nominal:            rung.nominal,
            // Today's market price and yields for the holdings sheets. Present only for a verified giltsyield.com price.
            giltSpot: (rung.priceSource === 'market' && Number.isFinite(rung.cleanPrice)) ? {
                clean: rung.cleanPrice, dirty: rung.marketDirty,
                session: rung.marketSession, final: rung.marketFinal,
                ytmGross: rung.ytmGross, ytmNet: rung.ytmNet,
            } : null,
        });
    }

    // Session validity guard: suppress Today deltas if live quote state is
    // stale, from a prior day's JSON backup, or not yet fetched this session.
    // Uses isLiveQuoteUsableForPnl so a Friday fetch remains valid on weekends —
    // aligning liquid holdings with restricted stock's weekend P&L behaviour.
    // Two-stage session date resolution:
    //   candidate = what getCurrentPnlSessionDateStr thinks the session is.
    //   effective  = what the live data actually represents (may be previous session).
    // Using the effective date as todayStr ensures prevClose resolves to the
    // correct prior session (e.g. Thursday on Monday pre-market, not Friday).
    const candidatePnlDate       = getCurrentPnlSessionDateStr();
    const globalEffectivePnlDate = getEffectivePnlSessionDateStr(liveAt, candidatePnlDate);
    const hasValidLiveSession =
        liveStatus === 'ok'
        && Object.keys(livePrices || {}).length > 0;

    return activeHoldings.map(h => {
        // ── Gilt tickers: market-priced (or matured) rung overrides the value; otherwise unpriced ──
        const giltRung = giltRungByTicker.get(h.ticker);
        if (giltRung && Number.isFinite(giltRung.dirtyValue) && giltRung.dirtyValue >= 0) {
            return applyGiltOverride(h, giltRung);
        }
        // A held gilt with no verified price is left unpriced. Its value stays on the generic holdings path
        // (last trade price) so the totals do not jump, but it must not claim a gain or a move: the row shows
        // Today and Total as "\u2014" (display-only flag; no figure feeding any total changes).
        if (giltUnpricedTickers.has(h.ticker)) {
            return { ...h, todayAbsChange: null, todayPctChange: null, isUnpricedGilt: true };
        }

        // ── All other holdings: live price delta ───────────────────────
        const ticker     = h.ticker;
        const normTicker = (ticker || '').toUpperCase().trim();

        // ── Display spot price fields — resolve via priority waterfall ──
        const spot = resolveDisplaySpotPrice({
            ticker, livePrices, prices, liveStatus, liveAt, gbpusdRate, tickerCurrencyMap, liveQuoteChecks,
        });
        const hasLiveSpot = spot.quoteStatus === 'live';
        const spotFields  = { ...spot, hasLiveSpot };

        if (!hasValidLiveSession) {
            return { ...h, todayAbsChange: null, todayPctChange: null, ...spotFields };
        }

        // ── Per-holding session date ───────────────────────────────────
        // Uses ticker-level metadata (last date in liveDailyCloses) — the actual
        // market-session timestamp, not liveAt (fetch time).
        // STALE-REJECT: if ticker metadata exists but is too old, returns null.
        // Only falls back to globalEffectivePnlDate when no per-ticker data exists.
        const holdingEffectiveDate = getEffectiveDateForTicker(
            normTicker, liveQuoteSessionDates, candidatePnlDate, globalEffectivePnlDate
        );
        if (!holdingEffectiveDate) {
            // Ticker session stale or unresolvable — suppress Today P&L for this holding
            return { ...h, todayAbsChange: null, todayPctChange: null, ...spotFields };
        }
        const todayStr = holdingEffectiveDate;

        if (!ticker || livePrices[normTicker] == null) {
            // A quote rejected by the live-quote gate never reaches livePrices;
            // record why Today is blank so diagnostics can show it.
            const gate = liveQuoteChecks && liveQuoteChecks[normTicker];
            const heldMeta = (gate && gate.status === 'rejected')
                ? { todayPrevReason: 'live-quote-held:' + gate.reason } : {};
            return { ...h, todayAbsChange: null, todayPctChange: null, ...spotFields, ...heldMeta };
        }
        // ── Previous close: the single verified resolver ─────────────────────
        // Must come from the exchange's previous trading session (Yahoo, cross-
        // checked with the routed second source where one exists). If no source
        // has it, sources disagree, or the move is implausible, Today shows "—";
        // there is no fallback to older closes.
        const verifiedPrev = resolveVerifiedDailyPrevClose({
            ticker: normTicker, sessionDate: todayStr,
            livePx: Number(livePrices[normTicker]), dailyCloses: liveDailyCloses,
        });
        const prevMeta = {
            todayPrevDate:     verifiedPrev.date || null,
            todayPrevStatus:   verifiedPrev.ok ? verifiedPrev.status : null,
            todayPrevReason:   verifiedPrev.ok ? null : verifiedPrev.reason,
            todayPrevExpected: verifiedPrev.expectedDate || null,
        };
        if (!verifiedPrev.ok) {
            return { ...h, todayAbsChange: null, todayPctChange: null, ...spotFields, ...prevMeta };
        }
        const reliablePrevClose = verifiedPrev.value;
        const fxRate  = gbpusdRate;
        // USD lines: previous close at the previous session's GBP/USD (see fxCloseOnOrBefore).
        const fxPrev  = resolveQuoteCurrency(ticker, tickerCurrencyMap) === 'USD'
            ? fxCloseOnOrBefore(liveDailyCloses, 'GBPUSD=X', verifiedPrev.date, 5) : null;
        const currGBP = pxToGBP(ticker, livePrices[normTicker], fxRate, tickerCurrencyMap);
        const prevGBP = pxToGBP(ticker, reliablePrevClose, fxPrev ? fxPrev.rate : fxRate, tickerCurrencyMap);
        if (currGBP == null || prevGBP == null || prevGBP === 0) {
            return { ...h, todayAbsChange: null, todayPctChange: null, ...spotFields };
        }
        const todayAbsChange = h.units * (currGBP - prevGBP);
        const todayPctChange = (currGBP / prevGBP) - 1;
        // todaySessionDate = the trading session this move belongs to (the date the move was measured on).
        // The Insights panel uses it so moves from different sessions are never shown side by side.
        return { ...h, todayAbsChange, todayPctChange, todaySessionDate: todayStr, ...spotFields, ...prevMeta };
    });
}

function computeAccountGroups({ activeHoldingsWithDelta, accountCashMap }) {
    const groups = {};
    for (const h of activeHoldingsWithDelta) {
        const acct = h.account || 'UNASSIGNED ACCOUNT';
        if (!groups[acct]) groups[acct] = { name: acct, holdings: [], investedValue: 0, todayAbsChange: 0, todayAbsKnown: 0, netCost: 0,
                                            noBasisValue: 0, custodyValue: 0, custodyTodayAbs: 0, custodyTodayKnown: 0 };
        const grp = groups[acct];
        grp.holdings.push(h);
        if (h.marketValue != null) {
            grp.investedValue += h.marketValue;
            if (h.isExternalCustody) grp.custodyValue += h.marketValue;
            if (h.noCostBasis)       grp.noBasisValue += h.marketValue;   // no cost basis: kept out of P&L
        }
        if (h.todayAbsChange != null) {
            grp.todayAbsChange += h.todayAbsChange;
            grp.todayAbsKnown += 1;
            if (h.isExternalCustody) { grp.custodyTodayAbs += h.todayAbsChange; grp.custodyTodayKnown += 1; }
        }
        if (!h.noCostBasis) grp.netCost += h.totalCost - h.totalProceeds;
    }
    // Supplement: accounts with only cash flows (no active holdings) were
    // previously invisible. Surface them so nothing is orphaned.
    for (const [acctName, cashBal] of Object.entries(accountCashMap)) {
        if (!groups[acctName] && Math.abs(cashBal) > 0.01) {
            groups[acctName] = { name: acctName, holdings: [], investedValue: 0, todayAbsChange: 0, todayAbsKnown: 0, netCost: 0 };
        }
    }
    return Object.values(groups).map(g => {
        const cash = accountCashMap[g.name] || 0;
        // No clamp — negative cash nets cleanly against invested assets.
        const totalValue = g.investedValue + cash;
        // P&L only over holdings whose cost is known; a group made only of no-cost-basis holdings has none.
        const hasBasis = g.holdings.length === 0 || g.holdings.some(h => !h.noCostBasis);
        const unrealisedPL = hasBasis ? (g.investedValue - g.noBasisValue) - g.netCost : null;
        const totalPctChange = (unrealisedPL != null && g.netCost > 0) ? unrealisedPL / g.netCost : null;
        // hasTodayData: true only when at least one holding contributed a valid Today delta.
        // Unknown must be null, not 0 — zero is a valid calculated result and must remain
        // distinguishable from "no data available". Cash-only accounts always show hasTodayData=false.
        const hasTodayData = g.todayAbsKnown > 0;
        const todayAbsChange = hasTodayData ? g.todayAbsChange : null;
        const prevDayInvested = hasTodayData ? g.investedValue - g.todayAbsChange : null;
        const todayPctChange = (hasTodayData && prevDayInvested != null && prevDayInvested > 0)
            ? g.todayAbsChange / prevDayInvested
            : null;
        return { ...g, totalValue, cash, unrealisedPL, totalPctChange, todayAbsChange, todayPctChange, hasTodayData };
    }).sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));
}

function computeInsightsData({ activeHoldingsWithDelta, masterPortfolio, restrictedPositions, resolvedPricesMap, gbpusdAt, tickerCurrencyMap }) {
    // The hero's Today is the sum of every holding that has a daily change on the latest session (gilts included), so the
    // contributors are the same set: a holding whose market has not yet opened that day is held back from both until it
    // does (see latestTodaySession). Gilts are priced from giltsyield.com, and a
    // gilt only has a daily change when the previous session's close is in the gilt cache, so it is not always there.
    // A gilt-like holding therefore joins the contributors and the best / worst movers whenever it has a daily change
    // (from the current session), and is left out when it has none. No gilt-like holding counts towards the dominant
    // position or its weight.
    function isGiltLikeHolding(h) {
        const ticker = String(h.ticker || '').toUpperCase().trim();
        const name   = String(h.name || h.displayName || '').toUpperCase().trim();
        const type   = String(h.type || h.assetType || h.assetClass || h.category || '').toUpperCase().trim();
        const source = String(h.source || h.priceSource || h.pricingSource || '').toUpperCase().trim();
        return (
            ticker.startsWith('TG')  ||
            ticker.startsWith('TN')  ||
            ticker.startsWith('T26') ||
            ticker.startsWith('T27') ||
            ticker.startsWith('T28') ||
            ticker.startsWith('T29') ||
            ticker.startsWith('T30') ||
            ticker.startsWith('T31') ||
            ticker.startsWith('T32') ||
            ticker.startsWith('T33') ||
            ticker.startsWith('T34') ||
            ticker.startsWith('T35') ||
            ticker.startsWith('T36') ||
            ticker.startsWith('T37') ||
            ticker.startsWith('T38') ||
            ticker.startsWith('T39') ||
            ticker.startsWith('T40') ||
            ticker.includes('GILT')  ||
            name.includes('GILT')    ||
            name.includes('TREASURY') ||
            type.includes('GILT')    ||
            type.includes('FIXED INCOME') ||
            source.includes('SYNTHETIC') ||
            source.includes('PROXY')
        );
    }

    const raw = activeHoldingsWithDelta.filter(h =>
        h.marketValue != null &&
        h.units > 0.001 &&
        !isGiltLikeHolding(h)
    );
    if (raw.length === 0) return null;
    // A gilt-like holding with a real daily change (it counts in the hero's Today, so it must show in the rows).
    const giltMoves = activeHoldingsWithDelta.filter(h =>
        h.marketValue != null && h.units > 0.001 && isGiltLikeHolding(h) && Number.isFinite(h.todayAbsChange)
    );
    const giltMoveSet = new Set(giltMoves);

    // Consolidate cross-account positions by ticker (same logic as sheetHoldings 'all' view)
    // so a holding split across ISA + GIA appears as a single merged entry here.
    const groups = {};
    raw.concat(giltMoves).forEach(h => {
        const key = h.ticker && h.ticker !== 'UNTICKERED' ? h.ticker : h.name;
        if (!groups[key]) {
            groups[key] = { ...h, units: 0, marketValue: 0, totalCost: 0, totalProceeds: 0, todayAbsChange: 0, _todayKnown: 0, _giltLike: giltMoveSet.has(h) };
        }
        const g = groups[key];
        g.units          += h.units;
        g.marketValue    += (h.marketValue || 0);
        g.totalCost      += (h.totalCost || 0);
        g.totalProceeds  += (h.totalProceeds || 0);
        if (h.todayAbsChange != null) {
            g.todayAbsChange += h.todayAbsChange;
            g._todayKnown    += 1;
        }
    });
    const holdings = Object.values(groups).map(g => {
        const netCost    = g.totalCost - g.totalProceeds;
        g.unrealisedPL   = g.marketValue - netCost;
        const prevDay    = g.marketValue - g.todayAbsChange;
        g.todayPctChange = g._todayKnown > 0 && prevDay > 0 ? g.todayAbsChange / prevDay : null;
        if (g._todayKnown === 0) g.todayAbsChange = null;
        return g;
    });

    const total = masterPortfolio.totalValue || 1;

    // 1. Dominant position — single largest by market value (Core Weight Concentration)
    const equityHoldings = holdings.filter(h => !h._giltLike);
    const byValue = [...equityHoldings].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
    const dominant = byValue[0] || null;
    const dominantWeight = dominant ? dominant.marketValue / total : null;

    // 2. ΔP × U contributors — every holding with a move, sorted by absolute £ change. A holding behind the latest
    // session already has no Today (withLatestSessionToday), so the rows here and the hero total are on the same session.
    // The restricted schemes join as HSBC (R) / Citi (R) once their share has a move today; they count in the hero's
    // Today too. They are never the dominant position (that is about the holdings you can trade).
    const withToday = holdings.filter(h => h.todayAbsChange != null)
        .concat(restrictedPositions.filter(h => h.todayAbsChange != null));
    const contributors = [...withToday]
        .sort((a, b) => Math.abs(b.todayAbsChange) - Math.abs(a.todayAbsChange));

    // 3. Velocity margins — best and worst session mover by % (only from holdings with live data)
    let bestMover = null, worstMover = null;
    if (withToday.length > 0) {
        const byPct = [...withToday].sort((a, b) => (b.todayPctChange || 0) - (a.todayPctChange || 0));
        bestMover  = byPct[0];
        worstMover = byPct[byPct.length - 1];
        // Don't show best = worst when there's only one live holding
        if (bestMover === worstMover) worstMover = null;
    }

    // 4. 12-month rolling return for the dominant position
    let return12mAbs = null;
    let return12mPct = null;
    if (dominant) {
        const series = resolvedPricesMap[dominant.ticker];
        if (series && series.length > 0) {
            const todayStr = fmtDate(new Date());
            const targetDate = new Date();
            targetDate.setFullYear(targetDate.getFullYear() - 1);
            const targetDateStr = fmtDate(targetDate);
            const priceToday = priceAt(series, todayStr) || series[series.length - 1].close;
            const price12mAgo = priceAt(series, targetDateStr) || series[0].close;
            if (priceToday && price12mAgo) {
                const fxRateToday = gbpusdAt(todayStr);
                const fxRate12m = gbpusdAt(targetDateStr);
                const gbpToday = pxToGBP(dominant.ticker, priceToday, fxRateToday, tickerCurrencyMap);
                const gbp12m = pxToGBP(dominant.ticker, price12mAgo, fxRate12m, tickerCurrencyMap);
                if (gbpToday && gbp12m) {
                    return12mPct = (gbpToday / gbp12m) - 1;
                    return12mAbs = dominant.units * (gbpToday - gbp12m);
                }
            }
        }
    }

    return {
        dominant, dominantWeight,
        totalHoldings: equityHoldings.length,
        contributors,
        bestMover, worstMover,
        // "Live" = the live equity feed. Gilts add rows when they have a daily change, but never make the panel look live.
        hasLiveData: withToday.some(h => !h._giltLike),
        liveCount: withToday.filter(h => !h._giltLike).length,
        giltCount: withToday.filter(h => h._giltLike).length,
        return12mAbs, return12mPct,
    };
}

function computeTickerDetail({ selectedTicker, enriched, holdingsDate, resolvedPricesMap, endDate, gbpusdRate, tickerCurrencyMap }) {
    if (!selectedTicker)
        return null;
    const trades = enriched
        .filter(t => t.instrument && (t.instrument.ticker === selectedTicker || t.instrument.name === selectedTicker))
        .filter(t => t.category === 'buy' || t.category === 'sell' || t.category === 'transfer_out')
        .filter(t => fmtDate(t.parsedDate) <= holdingsDate)
        .sort((a, b) => a.parsedDate - b.parsedDate);
    if (trades.length === 0)
        return null;
    const name = trades[0].instrument.name;
    const ticker = trades[0].instrument.ticker;
    const series = ticker ? resolvedPricesMap[ticker] : null;
    // Running position + cost-basis ledger
    let runUnits = 0, runCost = 0, runProceeds = 0;
    const ledger = trades.map(t => {
        const qty = parseFloat((t.quantity || '').replace(/,/g, '')) || 0;
        const px = qty > 0 ? Math.abs(t.value) / qty : null; // GBP per unit actually paid/received
        if (t.category === 'buy') {
            runUnits += qty;
            runCost += Math.abs(t.value);
        }
        else {
            runUnits -= qty;
            runProceeds += t.value;
        }
        return {
            date: fmtDate(t.parsedDate),
            side: t.category,
            qty,
            pricePerUnit: px,
            value: Math.abs(t.value),
            runUnits,
            runNetCost: runCost - runProceeds,
        };
    });
    // Price line for the holding period (first trade → holdingsDate), with markers
    let priceLine = [];
    if (series && series.length) {
        const firstDate = ledger[0].date;
        priceLine = series
            .filter(p => p.date >= firstDate && p.date <= holdingsDate)
            .map(p => {
            const gbp = pxToGBP(ticker, p.close, endDate ? (priceAt(resolvedPricesMap['GBPUSD=X'], p.date) || gbpusdRate) : gbpusdRate, tickerCurrencyMap);
            return { date: p.date, price: gbp };
        })
            .filter(p => p.price != null);
        // Attach trade markers at the actual transacted price level. For each trade, find the
        // nearest price-line point at/after the trade date and stamp a buyPrice/sellPrice on it so
        // the Scatter layer renders a dot sitting on the price curve.
        for (const l of ledger) {
            if (l.pricePerUnit == null)
                continue;
            // Find nearest priceLine point on or after the trade date (fallback: last point before)
            let target = priceLine.find(p => p.date >= l.date);
            if (!target)
                target = priceLine[priceLine.length - 1];
            if (!target)
                continue;
            if (l.side === 'buy')
                target.buyPrice = l.pricePerUnit;
            else
                target.sellPrice = l.pricePerUnit;
        }
    }
    // Final figures
    const finalUnits = runUnits;
    const netCost = runCost - runProceeds;
    const lastPx = series ? priceAt(series, holdingsDate) : null;
    const lastGbp = lastPx != null ? pxToGBP(ticker, lastPx, gbpusdRate, tickerCurrencyMap) : null;
    const marketValue = (lastGbp != null && Math.abs(finalUnits) > 0.001) ? finalUnits * lastGbp : null;
    const isClosed = Math.abs(finalUnits) < 0.001;
    // Total return: realised (proceeds − cost on closed portion) + unrealised
    const totalPL = isClosed ? (runProceeds - runCost) : (marketValue != null ? marketValue - netCost : null);
    const totalReturnPct = runCost > 0 && totalPL != null ? (totalPL / runCost) * 100 : null;
    return {
        ticker, name, ledger, priceLine,
        finalUnits, netCost, marketValue, isClosed,
        totalCost: runCost, totalProceeds: runProceeds,
        totalPL, totalReturnPct,
        firstDate: ledger[0].date, lastTradeDate: ledger[ledger.length - 1].date,
    };
}

function computeIsaYears({ enriched }) {
    // Only count genuine new-money subscriptions landing in ISA wrappers.
    // Filtering on account prevents negative legs from Bed & ISA operations
    // (which generate a negative entry in the non-ISA account) from distorting totals.
    // Filtering on value > 0 removes any reversal rows.
    const inflows = enriched.filter(t =>
        t.category === 'subscription' &&
        (t.account || '').toUpperCase().includes('ISA') &&
        t.value > 0
    );
    if (inflows.length === 0)
        return [];
    const byYear = {};
    for (const t of inflows) {
        const d = t.parsedDate;
        const calYear = d.getUTCFullYear();
        const taxYear = (d.getUTCMonth() > 3 || (d.getUTCMonth() === 3 && d.getUTCDate() >= 6))
            ? calYear : calYear - 1;
        const key = `${taxYear}/${String(taxYear + 1).slice(2)}`;
        if (!byYear[key])
            byYear[key] = { subscriptions: 0, transfers: 0 };
        if (t.category === 'subscription')
            byYear[key].subscriptions += t.value;
        else
            byYear[key].transfers += t.value;
    }
    return Object.entries(byYear)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([year, { subscriptions, transfers }]) => ({
        year,
        subscriptions,
        transfers,
        subPct: Math.min((subscriptions / 20000) * 100, 100),
        remaining: Math.max(20000 - subscriptions, 0),
    }));
}

function computeSheetHoldings({ activeHoldingsWithDelta, sheetContext, sheetSearch, sheetSort, masterPortfolio, tickerCurrencyMap }) {
    let base = [...activeHoldingsWithDelta];

    if (sheetContext && sheetContext !== 'all') {
        base = base.filter(h => h.account === sheetContext);
    } else if (sheetContext === 'all') {
        // Aggregate positions sharing the same ticker across all accounts
        const groups = {};
        base.forEach(h => {
            const key = h.ticker && h.ticker !== 'UNTICKERED' ? h.ticker : h.name;
            if (!groups[key]) {
                groups[key] = { ...h, units: 0, marketValue: 0, totalCost: 0, totalProceeds: 0, todayAbsChange: 0, _todayKnown: 0, accountsBreakdown: [], _plValue: 0, _hasBasis: false };
            }
            const g = groups[key];
            g.units            += h.units;
            if (!h.noCostBasis) { g._plValue += (h.marketValue || 0); g._hasBasis = true; }
            g.marketValue      += (h.marketValue || 0);
            g.totalCost        += (h.totalCost || 0);
            g.totalProceeds    += (h.totalProceeds || 0);
            if (h.todayAbsChange != null) { g.todayAbsChange += h.todayAbsChange; g._todayKnown += 1; }
            g.accountsBreakdown.push({
                account:      h.account,
                units:        h.units,
                marketValue:  h.marketValue,
                netCost:      h.totalCost - h.totalProceeds,
                unrealisedPL: h.noCostBasis ? null : (h.marketValue || 0) - (h.totalCost - h.totalProceeds),
            });
        });
        base = Object.values(groups).map(g => {
            const netCost       = g.totalCost - g.totalProceeds;
            g.unrealisedPL      = g._hasBasis ? g._plValue - netCost : null;
            const prevDay = g.marketValue - g.todayAbsChange;
            g.todayPctChange = g._todayKnown > 0 && prevDay > 0 ? g.todayAbsChange / prevDay : null;
            if (g._todayKnown === 0) g.todayAbsChange = null;
            return g;
        });
    }

    // Dynamic string match across ticker, name, account, sector
    if (sheetSearch.trim()) {
        const q = sheetSearch.toLowerCase();
        base = base.filter(h =>
            (h.ticker||'').toLowerCase().includes(q) ||
            (h.name||'').toLowerCase().includes(q) ||
            (h.account||'').toLowerCase().includes(q) ||
            (h.sector||'').toLowerCase().includes(q)
        );
    }
    const sortFn = (a, b) => {
        if (sheetSort === 'value')  return (b.marketValue||0) - (a.marketValue||0);
        if (sheetSort === 'today')  return Math.abs(b.todayAbsChange||0) - Math.abs(a.todayAbsChange||0);
        if (sheetSort === 'total')  return (b.unrealisedPL||0) - (a.unrealisedPL||0);
        if (sheetSort === 'weight') { const tot = masterPortfolio.totalValue || 1; return ((b.marketValue||0)/tot) - ((a.marketValue||0)/tot); }
        return 0;
    };

    // For metric sorts (value/today/total), partition priced equities from
    // untickered/synthetic holdings so unpriced assets always sink to a
    // separate sub-section rather than polluting the sorted equity ranking.
    const isPricedSort = ['value', 'today', 'total'].includes(sheetSort);
    if (isPricedSort) {
        // isSyntheticTicker() treats any ticker with no exchange suffix as an internal code, which is right for
        // gilts and untickered assets but wrong for a listed US stock such as Citi ("C"). An external-custody
        // holding is always a real, priced security, so it belongs in the ranked list, not the unpriced tail.
        const isUnpricedRow = h => h.ticker === 'UNTICKERED' || (!isListedTicker(h.ticker, tickerCurrencyMap) && !h.isExternalCustody);
        const priced   = base.filter(h => !isUnpricedRow(h)).sort(sortFn);
        const unpriced = base.filter(h => isUnpricedRow(h)).sort(sortFn);
        if (unpriced.length > 0) unpriced[0] = { ...unpriced[0], isFirstUnpricedMarker: true };
        return [...priced, ...unpriced];
    }
    return base.sort(sortFn);
}
