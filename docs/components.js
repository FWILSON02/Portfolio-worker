// Shared screen pieces: holding rows, the bottom sheet, cards, the portfolio chart and the insights panel.
// Loaded by index.html before app.js, in the order core, providers, sync, widgets, components; shares their globals (no module system, no build step).



// ── Display spot price helpers ────────────────────────────────────────────────
// Safe latest-close walker: scans from the end of the series, returning the
// first finite close value found (plus its date). Avoids assuming the last
// array row is valid (it may have null/NaN close after a partial data load).
function latestFiniteCloseFromSeries(series) {
    if (!Array.isArray(series)) return null;
    for (let i = series.length - 1; i >= 0; i--) {
        const close = Number(series[i]?.close);
        if (Number.isFinite(close)) return { price: close, date: series[i]?.date || null };
    }
    return null;
}
// Case-insensitive ticker series lookup — handles mismatched capitalisation
// between the CSV ticker column and the prices map keys.
function findPriceSeries(prices, normTicker) {
    if (!prices || !normTicker) return null;
    if (prices[normTicker]) return prices[normTicker];
    const matchKey = Object.keys(prices).find(
        k => String(k).toUpperCase().trim() === normTicker
    );
    return matchKey ? prices[matchKey] : null;
}
// resolveDisplaySpotPrice — waterfall spot price resolver (display-only).
// Priority A: valid same-session live quote  → quoteStatus 'live',    badge null
// Priority B: stale/imported live quote      → quoteStatus 'delayed', badge 'd'
// Priority C: latest historical close        → quoteStatus 'closed',  badge 'c'
// Priority D: no usable price               → quoteStatus 'missing',  badge null
// When the live quote was rejected by the live-quote gate (liveQuoteChecks), the
// Priority C historical close is shown as quoteStatus 'held', badge '!', so a
// held-back quote is distinguishable from an ordinary closed-market price.
// NEVER overwrites marketValue, portfolio totals, daily P&L calculations.
function resolveDisplaySpotPrice({ ticker, livePrices, prices, liveStatus, liveAt, gbpusdRate, tickerCurrencyMap, liveQuoteChecks }) {
    const normTicker = String(ticker || '').toUpperCase().trim();
    if (!normTicker) {
        return { currentPriceRaw: null, currentPriceGBP: null, currentPriceCurrency: null,
                 hasSpotPrice: false, quoteStatus: 'missing', quoteBadge: null, quoteAsOf: null };
    }
    const currency = resolveQuoteCurrency(normTicker, tickerCurrencyMap);
    const gateInfo = liveQuoteChecks ? liveQuoteChecks[normTicker] : null;
    const rawLive  = livePrices?.[normTicker];
    const hasRawLive = Number.isFinite(Number(rawLive));
    const hasFreshLiveSession =
        liveStatus === 'ok' && liveAt != null && isSameCalendarDay(liveAt);
    // Priority A or B: we have a finite live price
    if (hasRawLive) {
        const raw = Number(rawLive);
        const currentPriceGBP = pxToGBP(normTicker, raw, gbpusdRate, tickerCurrencyMap);
        if (currentPriceGBP != null && Number.isFinite(currentPriceGBP)) {
            return {
                currentPriceRaw: raw, currentPriceGBP, currentPriceCurrency: currency,
                hasSpotPrice: true,
                // A carried last-good quote (this cycle's request failed or was held
                // back by the gate) is shown as delayed; '!' when the gate held it.
                quoteStatus: (hasFreshLiveSession && !(gateInfo && gateInfo.carried)) ? 'live' : 'delayed',
                quoteBadge:  (gateInfo && gateInfo.carried && gateInfo.status === 'rejected') ? '!'
                           : (hasFreshLiveSession && !(gateInfo && gateInfo.carried)) ? null : 'd',
                quoteAsOf: (gateInfo && gateInfo.carried && gateInfo.lastGoodAt) ? new Date(gateInfo.lastGoodAt) : (liveAt || null),
            };
        }
    }
    // Priority C: fall back to latest finite historical close
    const held   = !!(gateInfo && gateInfo.status === 'rejected');
    const series = findPriceSeries(prices, normTicker);
    const last   = latestFiniteCloseFromSeries(series);
    if (last && Number.isFinite(Number(last.price))) {
        const raw = Number(last.price);
        const currentPriceGBP = pxToGBP(normTicker, raw, gbpusdRate, tickerCurrencyMap);
        if (currentPriceGBP != null && Number.isFinite(currentPriceGBP)) {
            return {
                currentPriceRaw: raw, currentPriceGBP, currentPriceCurrency: currency,
                hasSpotPrice: true,
                quoteStatus: held ? 'held' : 'closed',
                quoteBadge:  held ? '!' : 'c',
                quoteAsOf: last.date || null,
                heldReason: held ? gateInfo.reason : null,
            };
        }
    }
    // Priority D: no usable price
    return { currentPriceRaw: null, currentPriceGBP: null, currentPriceCurrency: currency,
             hasSpotPrice: false, quoteStatus: 'missing', quoteBadge: null, quoteAsOf: null };
}

// ── formatSpotPrice — rich display formatter for account HoldingRow cards ─────
// Returns { text, badge, status } with native currency symbols/units:
//   GBX → "78.51p"    USD → "$195.20"    GBP/other → "£97.42"
// Includes optional superscript badge: 'c' (closed) or 'd' (delayed).
// Returns null when no usable price is available.
function formatSpotPrice(h) {
    if (!h || h.currentPriceGBP == null || !Number.isFinite(h.currentPriceGBP)) return null;
    const ccy = String(h.currentPriceCurrency || '').toUpperCase();
    const raw = h.currentPriceRaw != null ? Number(h.currentPriceRaw) : null;
    let text;
    if (ccy === 'GBX' && raw != null && Number.isFinite(raw)) {
        text = raw.toFixed(2) + 'p';
    } else if (ccy === 'USD' && raw != null && Number.isFinite(raw)) {
        text = '$' + raw.toFixed(2);
    } else {
        text = fmtV(h.currentPriceGBP, 2);
    }
    return { text, badge: h.quoteBadge || null, status: h.quoteStatus || null };
}

// ── formatGiltSpot — gilt price + yields for the holdings sheets ───────────────
// Price is the CLEAN price per £100 nominal (the market quote). Returns null unless the gilt has a verified giltsyield.com
// price: a model estimate is never shown as a price. Badge follows the stock convention: 'c' closed, '!' from an earlier session.
function formatGiltSpot(h) {
    const g = h && h.giltSpot;
    if (!g || !Number.isFinite(g.clean)) return null;
    let badge = g.final ? 'c' : null;
    try { if (g.session && g.session !== gySessionOf(Date.now()).session) badge = '!'; } catch (e) {}
    const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(2) + '%' : null);
    return { text: g.clean.toFixed(2), badge, status: badge === '!' ? 'held' : (badge === 'c' ? 'closed' : 'live'),
             ytmNet: pct(g.ytmNet), ytmGross: pct(g.ytmGross) };
}

// ── formatInsightSpotPrice — clean numeric formatter for InsightsPanel ─────────
// Returns { text, badge, status } with NO currency symbols, units, or codes.
// Examples: "78.51" + badge 'c',  "195.20" (no badge for live),  "912.40" + badge 'd'
// Returns null when no usable price is available.
function formatInsightSpotPrice(h) {
    if (!h || h.currentPriceGBP == null || !Number.isFinite(h.currentPriceGBP)) return null;
    const raw = h.currentPriceRaw != null ? Number(h.currentPriceRaw) : null;
    if (raw != null && Number.isFinite(raw)) {
        return { text: raw.toFixed(2), badge: h.quoteBadge || null, status: h.quoteStatus || null };
    }
    return { text: Number(h.currentPriceGBP).toFixed(2), badge: h.quoteBadge || null, status: h.quoteStatus || null };
}

// ── Holdings-sheet Today / Total line ───────────────────────────────────────────────────────────
// ONE place decides what a row's Today / Total line shows (holdingMetricVals → holdingMetricTexts), so the sheet can size
// its columns from exactly the text the rows will print and every row lines up with every other.
//
// holdingMetricVals — the four numbers. Restricted display rows carry explicit canonical total P&L fields that match the
// RestrictedSchemesWidget hero exactly, independent of ordinary cost-basis derivation; ordinary holdings resolve to
// unrealisedPL / return-on-cost. An unpriced gilt is carried at its last trade price, so its "gain" would be a
// meaningless £0: its Total is null (shown as —).
function holdingMetricVals(h) {
    const netCost   = h.totalCost - h.totalProceeds;
    const returnPct = netCost > 0 && h.unrealisedPL != null ? h.unrealisedPL / netCost : null;
    const restricted = h.isRestrictedDisplayOnly === true;
    const totalAbs = (restricted && h.restrictedTotalPnl    !== undefined) ? h.restrictedTotalPnl    : h.unrealisedPL;
    const totalPct = (restricted && h.restrictedTotalPnlPct !== undefined) ? h.restrictedTotalPnlPct : returnPct;
    return {
        todayAbs: h.todayAbsChange, todayPct: h.todayPctChange,
        totalAbs: h.isUnpricedGilt ? null : totalAbs,
        totalPct: h.isUnpricedGilt ? null : totalPct,
    };
}
// null abs → —, null % → blank, privacy swaps the £ amount for •• (the % stays visible). Unchanged rules.
function holdingMetricTexts(v, privacyMode) {
    return {
        ta: v.todayAbs == null ? '—' : (privacyMode ? '••' : fmtA(v.todayAbs)),
        tp: v.todayPct == null ? '' : fmtP(v.todayPct),
        ma: v.totalAbs == null ? '—' : (privacyMode ? '••' : fmtA(v.totalAbs)),
        mp: v.totalPct == null ? '' : fmtP(v.totalPct),
    };
}
// Rendered width of a figure string, in px. Glyph widths (em) are the iOS system font's, read off a device screenshot at
// 13px with tabular figures: digit/+/£ 0.61, comma 0.31, point 0.30, % 0.89 (hyphen-minus 0.37). Digits and £ are now 0.62: the
// figures are SF Pro Rounded, which has not been measured on a device, so that is a small allowance. Every character carries the
// line's -0.02em tracking. An estimate, used only to pick a column width; columns never shrink below their content.
const _HM_EM = { '+': 0.61, '£': 0.61, '−': 0.61, '-': 0.37, ',': 0.31, '.': 0.30, '%': 0.89, '—': 1.0, '•': 0.4 };
function holdingTextPx(s, size) {
    let w = 0;
    for (const ch of String(s || '')) w += ((/\d/.test(ch) ? 0.62 : (_HM_EM[ch] != null ? _HM_EM[ch] : 0.62)) - 0.02) * size;
    return w;
}
// The four figure columns for a whole list: each as wide as its widest entry, so right-aligned figures share one edge.
function holdingMetricCols(rows, privacyMode) {
    const m = { ta: 0, tp: 0, ma: 0, mp: 0 };
    for (const h of rows || []) {
        const t = holdingMetricTexts(holdingMetricVals(h), privacyMode);
        for (const k of Object.keys(m)) m[k] = Math.max(m[k], holdingTextPx(t[k], 13));
    }
    for (const k of Object.keys(m)) m[k] = Math.ceil(m[k]) + 1;
    return m;
}

// HoldingMetricLine — label | £ | % for Today, a gap, then label | £ | % for Total, on columns shared by every row.
// Typography: SF Pro Rounded, regular weight; figures 13px green/red, labels grey sentence case at 0.85em; Today and Total at the
// same brightness, no brackets. £ and % are right-aligned in their columns, so each figure's right edge — and the "TOTAL"
// label — sits at the same x on every row; the eye no longer darts left and right down the list. Column widths come from
// the widest entry in the list (holdingMetricCols), so the columns are only as wide as the numbers need.
// Everything is sized in em off the line's own font-size, which is 13px on an iPhone 17 and scales down just enough on a
// narrower screen for the whole table to fit the row (so a wide value can never push it past the edge).
function HoldingMetricLine({ vals, cols, privacyMode }) {
    const E = React.createElement;
    const FS = 13;                                   // design size, px
    const em = px => (px / FS).toFixed(3) + 'em';
    const c = cols || { ta: 0, tp: 0, ma: 0, mp: 0 };
    const t = holdingMetricTexts(vals, privacyMode);
    const PAD = 6, GAP = 18, LBL_T = 36, LBL_M = 30;  // label widths: "Today" / "Total" at 11px sentence case (estimate)
    const totalPx = LBL_T + PAD + c.ta + (c.tp + PAD) + GAP + LBL_M + PAD + c.ma + (c.mp + PAD);
    const lbl = { color: C.zinc500, fontSize: '0.85em', letterSpacing: 0, whiteSpace: 'nowrap', paddingRight: em(PAD) };
    const num = (color, extra) => ({ color, textAlign: 'right', whiteSpace: 'nowrap', ...(extra || {}) });
    const pad = { paddingLeft: em(PAD) };
    return E('div', {
        style: {
            display: 'grid', justifyContent: 'start', alignItems: 'baseline',
            gridTemplateColumns: 'auto minmax(' + em(c.ta) + ', auto) minmax(' + em(c.tp + PAD) + ', auto) ' + em(GAP) + ' auto minmax(' + em(c.ma) + ', auto) minmax(' + em(c.mp + PAD) + ', auto)',
            // 100vw − 40px = the row's content width (sheet is full width, 20px padding each side); 0.97 = safety for the estimate
            fontSize: 'min(' + FS + 'px, calc((100vw - 40px) * 0.96 / ' + (totalPx / FS).toFixed(3) + '))',
            fontFamily: rounded, fontWeight: 400, lineHeight: '16px', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
        }
    },
        E('span', { key: 'tl', style: lbl }, 'Today'),
        E('span', { key: 'ta', style: num(signColor(vals.todayAbs)) }, t.ta),
        E('span', { key: 'tp', style: num(signColor(vals.todayPct), pad) }, t.tp),
        E('span', { key: 'sp' }),
        E('span', { key: 'ml', style: lbl }, 'Total'),
        E('span', { key: 'ma', style: num(signColor(vals.totalAbs)) }, t.ma),
        E('span', { key: 'mp', style: num(signColor(vals.totalPct), pad) }, t.mp)
    );
}

// ── HoldingRow — global scope (stable identity prevents modal remount) ────────
function HoldingRow({ h, onTap, privacyMode, totalValue, metricCols }) {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const netCost = h.totalCost - h.totalProceeds;
    // Full position name: it wraps onto a second line (clamped at two) instead of being cut at 32 characters.
    // Name trimming: everything after the LAST "UCITS" is dropped ("iShares Core MSCI World UCITS ETF USD (Acc)" -> "iShares Core MSCI World UCITS"),
    // and everything after the first "Gilt"/"Gilts"; if both appear, the earlier cut wins.
    const shortName = (() => {
        const nm = h.name || '';
        let cut = nm.length, m, re = /\bUCITS\b/gi, lastU = -1;
        while ((m = re.exec(nm)) !== null) lastU = m.index + m[0].length;
        if (lastU >= 0) cut = Math.min(cut, lastU);
        const g = /\bGilts?\b/i.exec(nm);
        if (g) cut = Math.min(cut, g.index + g[0].length);
        return nm.slice(0, cut).trim();
    })();
    const tickerLabel = h.ticker || (h.name || '').split(' ').slice(0, 2).join(' ');
    const portWeight = totalValue > 0 && h.marketValue != null
        ? (h.marketValue / totalValue) * 100 : null;
    // Today / Total figures (incl. the restricted-row override and the unpriced-gilt rule): see holdingMetricVals.
    const metricVals = holdingMetricVals(h);

    return React.createElement('div', {
        style: { borderBottom: `1px solid ${C.border}` }
    },
        React.createElement('button', {
            onClick: () => setIsExpanded(e => !e),
            style: { width: '100%', textAlign: 'left', background: 'none', border: 'none', padding: '13px 20px 11px', cursor: 'pointer', WebkitTapHighlightColor: 'transparent', display: 'block' }
        },
            React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 2 } },
                React.createElement('div', { style: { minWidth: 0, flex: 1 } },
                    React.createElement('div', {
                        style: { fontFamily: sys, fontSize: 13, fontWeight: 500, lineHeight: '16px', color: C.amber, marginBottom: 0, letterSpacing: '0.02em', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
                    },
                        React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tickerLabel),
                        (() => {
                            // Gilts: clean price + net yield from giltsyield.com (null without a verified price). Everything else: spot price.
                            const sp = h.valuationMethod === 'gilt_market_dirty' ? formatGiltSpot(h) : formatSpotPrice(h);
                            if (!sp) return null;
                            return React.createElement(React.Fragment, null,
                                React.createElement('span', {
                                    style: { fontSize: 11, lineHeight: '15px', color: C.zinc500, fontWeight: 400, letterSpacing: 0, whiteSpace: 'nowrap',
                                             display: 'inline-flex', alignItems: 'baseline', gap: 0 }
                                },
                                    '\u00b7 ' + sp.text,
                                    sp.badge && React.createElement('sup', {
                                        style: { fontFamily: sys, fontSize: 8, lineHeight: 0, color: sp.badge === '!' ? '#fbbf24' : C.zinc600, marginLeft: 1 }
                                    }, sp.badge)
                                ),
                                sp.ytmNet && React.createElement('span', {
                                    style: { fontSize: 11, lineHeight: '15px', color: C.zinc500, fontWeight: 400, letterSpacing: 0, whiteSpace: 'nowrap' }
                                }, '\u00b7 ' + sp.ytmNet + ' net YTM')
                            );
                        })()
                    ),
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, lineHeight: '14px', color: C.zinc500, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' } }, shortName)
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingLeft: 10 } },
                    React.createElement('div', { style: { fontFamily: rounded, fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', color: C.text } },
                        h.marketValue != null ? (privacyMode ? '••••' : fmtV(h.marketValue)) : '—'),
                    React.createElement('div', { style: { fontSize: 11, color: C.zinc600, transition: 'transform 150ms ease', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', lineHeight: 1 } }, '▾')
                )
            ),
            React.createElement(HoldingMetricLine, { vals: metricVals, cols: metricCols, privacyMode })

        ),
        isExpanded && React.createElement('div', {
            style: { background: 'rgba(0,0,0,0.22)', borderTop: `1px solid ${C.border}`, padding: '14px 20px 14px 24px', display: 'flex', flexDirection: 'column', gap: 10, color: C.text }
        },
            h.accountsBreakdown && h.accountsBreakdown.length > 0
                // ── Multi-account aggregated breakdown ────────────────────────────
                ? React.createElement(React.Fragment, null,
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 } }, 'Account Breakdown'),
                    h.accountsBreakdown.map((b, idx) => {
                        const returnPct = (b.netCost > 0 && b.unrealisedPL != null) ? (b.unrealisedPL / b.netCost) * 100 : null;
                        return React.createElement('div', { key: idx, style: { background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 } },
                            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, fontWeight: 600, color: C.white } }, b.account),
                                React.createElement('span', { style: { fontFamily: sys, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: signColor(b.unrealisedPL) } },
                                    privacyMode ? '••' : fmtA(b.unrealisedPL))
                            ),
                            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, borderTop: '1px solid rgba(255,255,255,0.03)', paddingTop: 8 } },
                                React.createElement('div', null,
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 9, color: C.zinc500 } }, 'Market Value'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums', marginTop: 1 } }, privacyMode ? '••••' : fmtV(b.marketValue)),
                                    React.createElement('div', { style: { fontFamily: mono, fontSize: 10, color: C.zinc600 } }, `${b.units.toLocaleString('en-GB', { maximumFractionDigits: 2 })} units`)
                                ),
                                React.createElement('div', { style: { textAlign: 'right' } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 9, color: C.zinc500 } }, 'Performance'),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontWeight: 600, color: signColor(b.unrealisedPL), marginTop: 1 } }, returnPct == null ? '\u2014' : `${returnPct >= 0 ? '▲' : '▼'} ${Math.abs(returnPct).toFixed(1)}%`),
                                    React.createElement('div', { style: { fontFamily: mono, fontSize: 10, color: C.zinc600 } }, (b.units > 0 && b.netCost > 0) ? `avg £${(b.netCost / b.units).toFixed(2)}` : '—')
                                )
                            )
                        );
                    })
                  )
                // ── Single-account position detail ────────────────────────────────
                : React.createElement(React.Fragment, null,
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 } },
                        h.valuationMethod === 'gilt_market_dirty' ? 'Fixed-Income Position' : 'Position detail'),
                    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' } },
                        ...[
                            { label: 'Units', value: h.units != null ? h.units.toLocaleString('en-GB', {maximumFractionDigits: 4}) : '—' },
                            { label: 'Net cost', value: privacyMode ? '••••' : (h.noCostBasis ? 'Not tracked' : fmtV(netCost)) },
                            { label: 'Portfolio weight', value: portWeight != null ? `${portWeight.toFixed(1)}%` : '—' },
                            { label: 'Account', value: h.account || '\u2014' },
                            ...(h.isExternalCustody && h.vestDate ? [
                                { label: 'Vest date', value: new Date(h.vestDate + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) },
                                { label: 'Vest price', value: (h.vestCurrency === 'USD' ? '$' : (h.vestCurrency || '') + ' ') + Number(h.vestPrice).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) },
                                ...(h.fxAtVest ? [{ label: 'GBP/USD at vest', value: Number(h.fxAtVest).toFixed(4) }] : []),
                            ] : []),
                            ...(h.isExternalCustody && h.noCostBasis && h.costNote ? [{ label: 'Cost basis', value: h.costNote }] : []),
                        ].map(({ label, value }) =>
                            React.createElement('div', { key: label },
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, marginBottom: 1 } }, label),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em', color: C.zinc300 } }, value)
                            )
                        )
                    ),
                    // ── Gilt valuation panel (shown only for market-priced / matured gilts) ─
                    h.valuationMethod === 'gilt_market_dirty' && React.createElement('div', {
                        style: {
                            marginTop: 10, padding: '10px 12px',
                            background: `rgba(251,191,36,0.06)`,
                            border: `1px solid rgba(251,191,36,0.18)`,
                            borderRadius: 10,
                        }
                    },
                        React.createElement('div', {
                            style: { fontFamily: sys, fontSize: 9, color: C.amber, fontWeight: 600,
                                     textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8 }
                        }, h.displayValueLabel || 'Market Dirty Value'),
                        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px' } },
                            ...[
                                { label: 'Nominal', value: h.nominal != null ? `£${Number(h.nominal).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` : '—' },
                                { label: 'Clean price', value: h.cleanPrice != null ? h.cleanPrice.toFixed(3) : '—' },
                                { label: 'Accrued interest', value: h.accruedInterest != null ? fmtV(h.accruedInterest, 2) : '—' },
                                { label: 'Days to mat.', value: h.daysToMaturity != null ? (h.daysToMaturity <= 0 ? 'Matured' : `${h.daysToMaturity}d`) : '—' },
                                ...(h.giltSpot ? [
                                    { label: 'Dirty price', value: Number.isFinite(h.giltSpot.dirty) ? h.giltSpot.dirty.toFixed(3) : '—' },
                                    { label: 'Price as of', value: h.giltSpot.session ? new Date(h.giltSpot.session + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) + (h.giltSpot.final ? ' close' : ' (intraday)') : '—' },
                                    { label: 'Gross yield to mat.', value: Number.isFinite(h.giltSpot.ytmGross) ? (h.giltSpot.ytmGross * 100).toFixed(2) + '%' : '—' },
                                    { label: 'Net yield (' + Math.round(giltTaxRate() * 100) + '% tax)', value: Number.isFinite(h.giltSpot.ytmNet) ? (h.giltSpot.ytmNet * 100).toFixed(2) + '%' : '—' },
                                ] : []),
                            ].map(({ label, value }) =>
                                React.createElement('div', { key: label },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 9, color: C.zinc600, marginBottom: 1 } }, label),
                                    React.createElement('div', { style: { fontFamily: mono, fontSize: 11, fontWeight: 600, color: C.amber } }, value)
                                )
                            )
                        ),
                        // Coupon event chip
                        h.isCouponDay && React.createElement('div', {
                            style: { marginTop: 8, fontFamily: sys, fontSize: 10, color: C.emerald }
                        }, `Coupon payment today: +${fmtV(h.couponCashToday, 2)}`),

                    )
                  ),
            !h.isRestrictedDisplayOnly && !h.isExternalCustody && typeof onTap === 'function' &&
            React.createElement('button', {
                onClick: e => { e.stopPropagation(); if (typeof onTap === 'function') onTap(); },
                style: { marginTop: 8, alignSelf: 'flex-start', fontFamily: sys, fontSize: 11, fontWeight: 600, color: C.amber, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' }
            }, 'View Trade Ledger →')
        )
    );
}

// ── BottomSheet — global scope (stable identity prevents sort-tab remount) ────
function BottomSheet({ context, onDismiss, sheetDragY, setSheetDragY, sheetDragStart, sheetHoldings, sheetSort, setSheetSort, sheetSearch, setSheetSearch, privacyMode, setSelectedTicker, totalValue, restrictedDisplayRows }) {
    const contextLabel = context === 'all' ? 'All Holdings' : context;
    // Header position count: for 'all', restricted display rows are appended
    // as a separate section below sheetHoldings, so the visible row count is
    // the sum of both. Non-'all' contexts never render restricted rows, so
    // the count is sheetHoldings.length exactly as before.
    const visibleCount = sheetHoldings.length +
        (context === 'all' && restrictedDisplayRows ? restrictedDisplayRows.length : 0);
    // One set of Today / Total column widths for every row on the sheet (restricted rows included), so the
    // figures line up from the first holding to the last.
    const metricCols = holdingMetricCols(
        sheetHoldings.concat(context === 'all' && restrictedDisplayRows ? restrictedDisplayRows : []), privacyMode);
    // ── Drag-to-dismiss: ONLY from the grab handle / title header zone ───────
    // Scrolling inside the holdings list must never dismiss the sheet, so these
    // handlers are attached to the handle bar and title row only — not the
    // sheet container or the scrollable content. Dismissal also now requires a
    // deliberate gesture: ≥110px downward drag, or a clear fast flick (>0.7
    // px/ms) that has still travelled ≥48px. The X button always closes.
    const DISMISS_DISTANCE = 110;   // px — minimum deliberate downward drag
    const DISMISS_VELOCITY = 0.7;   // px/ms — fast-flick escape hatch
    const handleDragStart = e => { sheetDragStart.current = { y: e.touches[0].clientY, time: Date.now() }; };
    const handleDragMove  = e => { if (!sheetDragStart.current) return; const d = e.touches[0].clientY - sheetDragStart.current.y; if (d > 0) setSheetDragY(d); };
    const handleDragEnd   = e => {
        if (!sheetDragStart.current) return;
        const delta = (e.changedTouches[0]?.clientY ?? 0) - sheetDragStart.current.y;
        const vel = delta / Math.max(1, Date.now() - sheetDragStart.current.time);
        sheetDragStart.current = null;
        if (delta > DISMISS_DISTANCE || (vel > DISMISS_VELOCITY && delta > 48)) { onDismiss(); }
        setSheetDragY(0);
    };
    return React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9980, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'flex-end' },
        className: 'ios-tap-backdrop',
        onClick: onDismiss,
    },
        React.createElement('div', {
            // maxHeight now lives in the .holdings-sheet CSS class (80vh with a
            // dvh @supports upgrade) so the sheet opens lower with a visible
            // top gap on iPhone instead of a near-full-screen takeover.
            style: { width: '100%', background: C.surface, border: `1px solid ${C.borderMid}`, borderRadius: '20px 20px 0 0', display: 'flex', flexDirection: 'column', transform: `translateY(${sheetDragY}px)`, transition: sheetDragY === 0 ? 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)' : 'none', willChange: 'transform' },
            className: 'sheet-up holdings-sheet',
            onClick: e => e.stopPropagation(),
        },
            React.createElement('div', {
                style: { display: 'flex', justifyContent: 'center', padding: '12px 0 6px', touchAction: 'none' },
                onTouchStart: handleDragStart, onTouchMove: handleDragMove, onTouchEnd: handleDragEnd,
            },
                React.createElement('div', { style: { width: 40, height: 4, borderRadius: 9999, background: C.zinc700 } })
            ),
            React.createElement('div', { style: { padding: '8px 20px 12px', flexShrink: 0 } },
                React.createElement('div', {
                    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, touchAction: 'none' },
                    onTouchStart: handleDragStart, onTouchMove: handleDragMove, onTouchEnd: handleDragEnd,
                },
                    React.createElement('div', { style: { fontFamily: serif, fontSize: 18, color: C.white, fontWeight: 500 } }, contextLabel),
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        visibleCount > 0 && React.createElement('span', { style: { fontFamily: sys, fontSize: 11, color: C.zinc500 } }, `${visibleCount} positions`),
                        React.createElement('button', { onClick: onDismiss, 'aria-label': 'Close', style: { color: C.zinc500, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 10, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                            React.createElement(X, { style: { width: 14, height: 14 }, strokeWidth: 2 })
                        )
                    )
                ),
                sheetHoldings.length > 1 && React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
                    [['value','Size'],['today','Today'],['total','Total P&L']].map(([v, label]) =>
                        React.createElement('button', {
                            key: v,
                            onClick: e => { e.stopPropagation(); setSheetSort(v); },
                            style: { fontFamily: sys, fontSize: 11, padding: '6px 12px', borderRadius: 8, border: `1px solid ${sheetSort === v ? C.amber + '60' : C.border}`, background: sheetSort === v ? C.amber + '15' : 'transparent', color: sheetSort === v ? C.amber : C.zinc500, cursor: 'pointer' }
                        }, label)
                    )
                ),
                // (The search bar was removed: the list is short enough to scan, and the sort chips above are kept.)
            ),
            React.createElement('div', { className: 'ios-scroll', style: { flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' } },
                sheetHoldings.length === 0
                    ? React.createElement('div', { style: { padding: '60px 20px', textAlign: 'center', fontFamily: serif, fontStyle: 'italic', color: C.zinc600, fontSize: 15 } }, 'No holdings here yet')
                    : sheetHoldings.map(h => {
                        const rowStack = [];
                        // Inject a section separator above the first unpriced/synthetic holding
                        if (h.isFirstUnpricedMarker && ['value', 'today', 'total'].includes(sheetSort)) {
                            rowStack.push(React.createElement('div', {
                                key: 'unpriced_hdr',
                                style: {
                                    padding: '16px 20px 8px',
                                    fontFamily: sys, fontSize: 10, fontWeight: 700,
                                    color: C.zinc600, textTransform: 'uppercase',
                                    letterSpacing: '0.12em',
                                    borderTop: `1px dashed ${C.zinc700}`,
                                    marginTop: 12,
                                }
                            }, 'Fixed-Income'));
                        }
                        rowStack.push(React.createElement(HoldingRow, {
                            key: (h.ticker || h.name) + '||' + h.account,
                            h,
                            onTap: () => setSelectedTicker(h.ticker || h.name),
                            privacyMode,
                            totalValue,
                            metricCols,
                        }));
                        return React.createElement(React.Fragment, {
                            key: 'fr_' + (h.ticker || h.name) + '||' + h.account,
                        }, ...rowStack);
                      }),
                // ── Restricted Corporate Schemes — display-only, uses HoldingRow ──────
                // GUARDRAIL: isRestrictedDisplayOnly rows never feed into portfolio maths.
                context === 'all' && restrictedDisplayRows && restrictedDisplayRows.length > 0 &&
                    React.createElement('div', { key: 'restricted_section' },
                        // Section divider header
                        React.createElement('div', {
                            style: {
                                padding: '16px 20px 8px',
                                fontFamily: sys, fontSize: 10, fontWeight: 700,
                                color: C.zinc600, textTransform: 'uppercase',
                                letterSpacing: '0.12em',
                                borderTop: `1px dashed ${C.zinc700}`,
                                marginTop: 12,
                            }
                        }, 'Restricted Corporate Schemes'),
                        // Each restricted row rendered through HoldingRow for consistent layout
                        ...restrictedDisplayRows.map((row, ri) =>
                            React.createElement(HoldingRow, {
                                key: 'rest_' + ri,
                                h: row,
                                onTap: undefined,
                                privacyMode: privacyMode,
                                totalValue: totalValue,
                                metricCols,
                            })
                        )
                    )
            )
        )
    );
}


// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL MODULE-SCOPE COMPONENTS
// Moved outside PortfolioApp so React sees stable function references across
// the 5-second live-price polling cycle. State is passed as flat props.
// ══════════════════════════════════════════════════════════════════════════════

const formatPct    = (n) => n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const formatPctRaw = (n) => n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

function card(children, extra={}) {
    return React.createElement('div', {
        style: {
            background: `linear-gradient(180deg, ${C.surfaceHigh} 0%, ${C.surface} 100%)`,
            border: `1px solid ${C.border}`, borderRadius: 20,
            padding: '18px 20px', ...extra
        }
    }, children);
}



function SectionLabel({ label, right }) {
    return React.createElement('div', { style: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
    } },
        React.createElement('span', { style: {
            fontFamily: sys, fontSize: 10, fontWeight: 600,
            color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.1em',
        } }, label),
        right && React.createElement('span', { style: {
            fontFamily: sys, fontSize: 10, color: C.zinc700,
        } }, right)
    );
}

function Row({ icon: Icon, iconColor, iconBg, label, sub, right, onClick, isLabel, inputProps, disabled, last }) {
    const style = {
        display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', width: '100%',
        textAlign: 'left', background: 'transparent', border: 'none',
        borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.04)',
        opacity: disabled ? 0.38 : 1, cursor: disabled ? 'default' : 'pointer',
        WebkitTapHighlightColor: 'transparent',
    };
    const inner = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { width: 34, height: 34, borderRadius: 9, background: iconBg || `${iconColor}1a`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
            React.createElement(Icon, { style: { width: 18, height: 18, color: iconColor }, strokeWidth: 1.75 })
        ),
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
            React.createElement('div', { style: { fontFamily: sys, fontSize: 14, color: disabled ? C.zinc700 : C.text } }, label),
            sub && React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.zinc500, marginTop: 2 } }, sub)
        ),
        right !== undefined ? right : React.createElement('span', { style: { color: C.zinc600, fontSize: 16, lineHeight: 1 } }, '›')
    );
    if (isLabel) {
        return React.createElement('label', { style: { ...style, cursor: 'pointer', opacity: 1, display: 'flex' } },
            inner,
            React.createElement('input', { ...inputProps, style: { display: 'none' } })
        );
    }
    return React.createElement('button', { style, onClick, disabled }, inner);
}


// One total: the portfolio plus employer equity (restricted capital and any modelled vested comp), with Today and
// Total covering all of it. The figures are combined in PortfolioApp (heroCombined); the restricted card further down
// still shows the schemes on their own.
const HeroCard = React.memo(function HeroCard({ onTap, transactions, masterPortfolio, sheetContext, liveStatus, privacyMode, heroValue, heroTodayAbs, heroTodayPct, heroTotalAbs, heroTotalPct, pricingBadge, onPricingTap }) {
    const hasData = transactions.length > 0;
    const isEmpty = !hasData || masterPortfolio.totalValue === 0;
    return React.createElement('div', {
        onClick: onTap,
        style: {
            width: '100%', textAlign: 'left',
            padding: 0, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        }
    },
        card(
            React.createElement('div', null,
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
                    React.createElement('span', { style: { fontFamily: sys, fontSize: 10, color: C.zinc500, textTransform: 'uppercase', letterSpacing: '0.18em' } }, 'Portfolio Value'),
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        // Pricing status: icon + a word, in the card's own header line (no row of its own), so it costs no height
                        // and scrolls away with the page. Tap opens Settings → Daily close check. Padding gives a finger-sized
                        // target; the negative margin keeps it from making the line taller.
                        pricingBadge && React.createElement('button', {
                            'aria-label': pricingBadge.label,
                            onClick: e => { e.stopPropagation(); if (onPricingTap) onPricingTap(); },
                            style: { display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: '8px 6px', margin: '-8px -6px',
                                     color: pricingBadge.color, fontFamily: sys, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
                                     whiteSpace: 'nowrap', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }
                        },
                            React.createElement(pricingBadge.icon, { className: pricingBadge.iconSpin ? 'spinning' : '', style: { width: 11, height: 11, flexShrink: 0 }, strokeWidth: 2.25 }),
                            pricingBadge.label.replace(/^Pricing\s+/, '').replace('Fetching Prices', 'Fetching\u2026')),
                        liveStatus === 'fetching'
                            ? React.createElement('div', { style: { width: 6, height: 6, borderRadius: '50%', background: C.amber }, className: 'pulse-dot' })
                            : liveStatus === 'ok'
                                ? React.createElement('div', { style: { width: 6, height: 6, borderRadius: '50%', background: C.emerald } })
                                : React.createElement('div', { style: { width: 6, height: 6, borderRadius: '50%', background: C.zinc700 } }))
                ),
                isEmpty
                    ? React.createElement('div', { style: { fontFamily: serif, fontSize: 15, fontStyle: 'italic', color: C.zinc600, paddingTop: 4, paddingBottom: 4 } }, 'Upload a CSV to begin')
                    : (() => {
                        // Compact two-zone row: the total left, Today/Total table right.
                        const heroRealText = fmtV(heroValue);
                        // Caps at 32px; shrinks only if the width can't hold value + table.
                        const heroSize = compactFitSize(32, heroRealText.length, 20);
                        return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                            React.createElement('div', { style: compactValueStyle(heroSize, privacyMode) },
                                privacyMode ? '£ •••,•••' : heroRealText),
                            React.createElement(CompactMetricGrid, {
                                todayAbs: heroTodayAbs,
                                todayPct: heroTodayPct,
                                totalAbs: heroTotalAbs,
                                totalPct: heroTotalPct,
                                privacyMode,
                            })
                        );
                    })()
            ),
            { cursor: 'pointer', transition: 'border-color 120ms', borderColor: sheetContext === 'all' ? C.amber + '55' : C.border }
        )
    );
});

// ── Compact metric table (shared by HeroCard, AccountCard, RestrictedSchemesWidget) ──
// Presentation-only. Today / Total / Cash as a genuine 3-column grid
// (label | £ | %) with the £ and % columns right-aligned, so figures form clean
// vertical edges. MetricBlock is deliberately NOT modified. Null/zero semantics
// mirror MetricBlock exactly:
//   Today: isValidNumber (a genuine 0 renders +£0, null/NaN renders —)
//   Total: == null → —
//   Cash : whole pounds (no decimals). Row only exists when the cash rounds to at
//          least £1 (|cash| >= 0.5) so it can never read £0 or -£0; callers with no
//          cash data simply omit the prop. Privacy replaces the text with ••••
// Typography: SF Pro Rounded; all three rows share one size and ONE regular weight — sentence-case labels 11px,
// every figure (£ and %) 13px, weight 400. Every cell has the same fixed line-height, so a
// missing value or percentage can never change a row's height or shift a column.
function CompactMetricGrid({ todayAbs, todayPct, totalAbs, totalPct, cash, privacyMode }) {
    // Privacy mode blurs £ amounts only; the % columns always stay readable.
    const blur = privacyMode ? 'blur(6px)' : 'none';
    const isValidNumber = (v) => v != null && Number.isFinite(Number(v));
    const ROW_H = '16px';
    const lbl = {
        fontSize: 11, color: C.zinc500, letterSpacing: 0,
        fontWeight: 400, lineHeight: ROW_H, whiteSpace: 'nowrap', paddingRight: 14,
    };
    const num = (size, color, extra) => ({
        fontSize: size, fontWeight: 400, color, lineHeight: ROW_H,
        textAlign: 'right', justifySelf: 'end', whiteSpace: 'nowrap', ...(extra || {}),
    });
    const pctCell = { paddingLeft: 8 };
    const showCash = Math.abs(cash || 0) >= 0.5;
    const E = React.createElement;
    return E('div', {
        style: {
            // £ and % columns have width floors so the table's edges (and the label column's
            // left edge) sit at the same x on every card in the stack. The % floor is sized
            // for a 3-digit move like "+101.5%" (13px, incl. 8px left pad) so a big restricted-
            // scheme gain doesn't shift that card's table out of line with the others.
            display: 'grid', gridTemplateColumns: 'auto minmax(60px, auto) minmax(66px, auto)',
            alignItems: 'baseline', rowGap: 1, flexShrink: 0,
            fontFamily: rounded, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
        }
    },
        // TODAY
        E('span', { key: 'tl', style: lbl }, 'Today'),
        E('span', { key: 'ta', style: num(13, signColor(todayAbs), { filter: blur }) },
            isValidNumber(todayAbs) ? fmtA(todayAbs) : '—'),
        E('span', { key: 'tp', style: num(13, signColor(todayPct), { ...pctCell }) },
            isValidNumber(todayPct) ? fmtP(todayPct) : ''),
        // TOTAL
        E('span', { key: 'ml', style: lbl }, 'Total'),
        E('span', { key: 'ma', style: num(13, signColor(totalAbs), { filter: blur }) },
            totalAbs == null ? '—' : fmtA(totalAbs)),
        E('span', { key: 'mp', style: num(13, signColor(totalPct), { ...pctCell }) },
            totalPct == null ? '' : fmtP(totalPct)),
        // CASH — same condition/formatting as before; grey (not green/red) so it reads as a balance, not a move
        showCash && E('span', { key: 'cl', style: lbl }, 'Cash'),
        showCash && E('span', { key: 'ca', style: num(13, C.zinc400) },
            privacyMode ? '••••' : formatGBP(cash, { dp: 0 })),
        showCash && E('span', { key: 'cp', style: { ...pctCell, fontSize: 13, lineHeight: ROW_H } }, '')
    );
}

// Value font-size that shrinks to fit narrow screens instead of squeezing the table.
// available = 100vw − (page padding 32 + card border/padding + gap 12 + table ≈172);
// width per px of font-size ≈ 0.535 × characters (tabular bold, with ~7% safety for SF Pro).
// Caps at `base`, so on an iPhone 17 (402pt) the value stays at its designed size.
function compactFitSize(base, chars, cardPadX) {
    const chrome = 2 * cardPadX + 2 + 32 + 12 + 172;
    return 'min(' + base + 'px, calc((100vw - ' + chrome + 'px) / ' + (chars * 0.535).toFixed(2) + '))';
}

// Primary value (left zone of every compact card). Same look as MetricBlock's value line.
function compactValueStyle(size, privacyMode) {
    return {
        fontFamily: rounded, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
        fontSize: size, fontWeight: 700, color: C.white, lineHeight: 1.05,
        whiteSpace: 'nowrap', flexShrink: 0, filter: privacyMode ? 'blur(8px)' : 'none',
    };
}

const AccountCard = React.memo(function AccountCard({ acct, isActive, onTap, privacyMode }) {
    // Color by keyword match against normalised (uppercase) account name,
    // with deterministic hash fallback for unknown wrapper types.
    function resolveAcctColor(name) {
        const n = (name || '').toUpperCase();
        if (n.includes('ISA'))                       return C.amber;
        if (n.includes('GIA') || n.includes('GENERAL')) return C.blue;
        if (n.includes('SIPP') || n.includes('PENSION')) return C.violet;
        if (n.includes('WALLET') || n.includes('CASH')) return C.emerald;
        if (n.includes('FUND') || n.includes('SHARES') || n.includes('STOCKS')) return C.blue;
        // Deterministic palette for any other account name
        const palette = [C.blue, C.violet, '#fb923c', '#f472b6', C.emerald];
        let h = 0;
        for (let i = 0; i < n.length; i++) h = (h << 5) - h + n.charCodeAt(i);
        return palette[Math.abs(h) % palette.length];
    }
    const color = resolveAcctColor(acct.name);
    // Layout: header row (dot · name · holdings count) above a two-zone content row
    // (market value left, Today/Total/Cash table right). Data props are unchanged.
    const valueText = privacyMode ? '••••' : fmtV(acct.totalValue);
    // Real digit count (not the privacy placeholder) so size is identical in both modes.
    const valueSize = compactFitSize(26, fmtV(acct.totalValue).length, 16);
    const nHold = acct.holdings.length;
    return React.createElement('div', {
        onClick: onTap,
        style: {
            width: '100%', textAlign: 'left',
            padding: 0, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        }
    },
        card(
            React.createElement('div', null,
                // Header — account name yields (ellipsis) before any financial figure does
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
                    React.createElement('div', { style: { width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 } }),
                    React.createElement('div', {
                        style: {
                            flex: 1, minWidth: 0, fontFamily: sys, fontSize: 12, lineHeight: '14px',
                            color: C.zinc400, textTransform: 'uppercase', letterSpacing: '0.12em',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }
                    }, acct.name),
                    React.createElement('div', {
                        style: { fontFamily: sys, fontSize: 11, lineHeight: '14px', color: C.zinc600, flexShrink: 0, whiteSpace: 'nowrap' }
                    }, `${nHold} holding${nHold !== 1 ? 's' : ''}`)
                ),
                // Content row
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                    React.createElement('div', { style: compactValueStyle(valueSize, privacyMode) }, valueText),
                    React.createElement(CompactMetricGrid, {
                        todayAbs: acct.todayAbsChange,
                        todayPct: acct.todayPctChange,
                        totalAbs: acct.unrealisedPL,
                        totalPct: acct.totalPctChange,
                        cash: acct.cash,
                        privacyMode,
                    })
                )
            ),
            {
                padding: '14px 16px',
                borderColor: isActive ? color + '55' : C.border,
                transition: 'border-color 120ms',
                cursor: 'pointer',
            }
        )
    );
});

function TickerModal({ selectedTicker, tickerDetail, privacyMode, setSelectedTicker, modalDragY, setModalDragY, modalDragStart }) {
    if (!selectedTicker) return null;
    return React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9997, display: 'flex', alignItems: 'flex-end', background: 'rgba(0,0,0,0.7)', cursor: 'pointer' },
        onClick: () => { setSelectedTicker(null); setModalDragY(0); }
    }, React.createElement('div', {
        className: 'ticker-sheet',
        style: { width: '100%', background: C.surface, border: `1px solid ${C.borderMid}`, maxHeight: '88vh', display: 'flex', flexDirection: 'column', transform: `translateY(${modalDragY}px)`, transition: modalDragY === 0 ? 'transform 0.42s cubic-bezier(0.22, 1, 0.36, 1)' : 'none', willChange: 'transform' },
        onClick: e => e.stopPropagation(),
        onTouchStart: e => { modalDragStart.current = { y: e.touches[0].clientY, time: Date.now() }; },
        onTouchMove: e => { if (!modalDragStart.current) return; const delta = e.touches[0].clientY - modalDragStart.current.y; if (delta > 0) setModalDragY(delta); },
        onTouchEnd: e => {
            if (!modalDragStart.current) return;
            const delta = (e.changedTouches[0]?.clientY ?? 0) - modalDragStart.current.y;
            const velocity = delta / Math.max(1, Date.now() - modalDragStart.current.time);
            modalDragStart.current = null;
            if (delta > 100 || velocity > 0.5) { setSelectedTicker(null); setModalDragY(0); }
            else setModalDragY(0);
        }
    },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'center', padding: '12px 0 4px', touchAction: 'none' } },
            React.createElement('div', { style: { width: 40, height: 4, borderRadius: 9999, background: C.zinc700 } })
        ),
        React.createElement('div', { className: 'ios-scroll', style: { flex: 1, padding: '0 20px 8px' } },
            tickerDetail ? React.createElement(React.Fragment, null,
                React.createElement('div', { style: { marginBottom: 20 } },
                    React.createElement('div', { style: { fontFamily: mono, fontSize: 17, color: C.amber, marginBottom: 2 } }, tickerDetail.ticker || tickerDetail.name),
                    React.createElement('div', { style: { fontSize: 13, color: C.zinc500 } }, tickerDetail.name),
                    tickerDetail.isClosed && React.createElement('span', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, background: C.surfaceHigh, border: `1px solid ${C.zinc700}`, borderRadius: 6, padding: '2px 8px', marginTop: 6, display: 'inline-block' } }, 'CLOSED')
                ),
                React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 } },
                    ...[
                        { label: 'Market Value', value: tickerDetail.marketValue != null ? (privacyMode ? '••••' : fmtV(tickerDetail.marketValue)) : '—', color: C.text },
                        { label: 'Total Return', value: tickerDetail.totalReturnPct != null ? `${tickerDetail.totalReturnPct >= 0 ? '+' : ''}${tickerDetail.totalReturnPct.toFixed(1)}%` : '—', color: signColor(tickerDetail.totalReturnPct) },
                        { label: 'Units Held', value: tickerDetail.finalUnits > 0.001 ? tickerDetail.finalUnits.toLocaleString('en-GB', {maximumFractionDigits:4}) : '—', color: C.zinc400 },
                        { label: 'Net Cost', value: privacyMode ? '••••' : fmtV(tickerDetail.netCost), color: C.zinc400 },
                    ].map(s => React.createElement('div', { key: s.label, style: { background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 14px' } },
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 } }, s.label),
                        React.createElement('div', { style: { fontFamily: sys, fontSize: 17, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em', color: s.color } }, s.value)
                    ))
                ),
                tickerDetail.priceLine && tickerDetail.priceLine.length > 2 && React.createElement('div', { style: { marginBottom: 20, background: C.surfaceHigh, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, height: 120, overflow: 'hidden' } },
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 } }, 'Price history'),
                    React.createElement(SvgResponsive, { height: 72 },
                        React.createElement(SvgChart, {
                            data: tickerDetail.priceLine, xKey: 'date',
                            xFormat: d => d ? d.slice(0, 7) : '',
                            yFormat: v => '£' + v.toFixed(2),
                            margin: { top: 4, right: 8, left: 40, bottom: 24 },
                            series: [{ key: 'price', label: 'Price (GBP)', color: C.amber, width: 1.5 }],
                        })
                    )
                ),
                React.createElement('div', { style: { marginBottom: 20 } },
                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 } }, `Trade history · ${tickerDetail.ledger.length} trades`),
                    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                        tickerDetail.ledger.slice().reverse().map((l, i) => {
                            const isTransferOut = l.side === 'transfer_out';
                            const isBuy = l.side === 'buy';
                            const dotColor = isTransferOut ? '#fb923c' : isBuy ? C.emerald : C.rose;
                            const valColor = isTransferOut ? '#fb923c' : isBuy ? C.emerald : C.rose;
                            const valPrefix = isBuy ? '−' : isTransferOut ? '⇒' : '+';
                            const sideLabel = isTransferOut ? 'Transfer Out' : null;
                            return React.createElement('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: C.surfaceHigh, border: `1px solid ${isTransferOut ? 'rgba(251,146,60,0.15)' : C.border}`, borderRadius: 10 } },
                                React.createElement('div', { style: { width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: dotColor } }),
                                React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 11, color: C.zinc400 } }, l.date + (sideLabel ? ` · ${sideLabel}` : '')),
                                    React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600, marginTop: 2 } }, `${l.qty.toLocaleString('en-GB', {maximumFractionDigits:4})} units @ ${l.pricePerUnit ? fmtV(l.pricePerUnit, 4) : '—'}`)
                                ),
                                React.createElement('div', { style: { fontFamily: sys, fontSize: 13, fontVariantNumeric: 'tabular-nums', color: valColor, flexShrink: 0 } },
                                    valPrefix + (privacyMode ? '••••' : fmtV(l.value))
                                )
                            );
                        })
                    )
                )
            ) : React.createElement('div', { style: { color: C.zinc600, fontFamily: sys, fontSize: 13, padding: '40px 0', textAlign: 'center' } }, 'No detail available')
        ),
        React.createElement('div', { style: { padding: '12px 20px', borderTop: `1px solid ${C.border}`, paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' } },
            React.createElement('button', { onClick: () => setSelectedTicker(null), style: { width: '100%', minHeight: 48, borderRadius: 14, background: C.surfaceHigh, color: C.text, fontFamily: sys, fontSize: 14, border: 'none' } }, 'Close')
        )
    ));
}

function UploadSection({ transactions, cacheMeta, tickersUsed, loading, handleFiles, fetchAllPrices, fetchLivePrices, liveStatus, clearCache }) {
    const [dragging, setDragging] = React.useState(false);
    const hasData = transactions.length > 0;
    const sectionStyle = {
        background: `linear-gradient(180deg, ${C.surfaceHigh} 0%, ${C.surface} 100%)`,
        border: `1px dashed ${dragging ? C.amber + '80' : C.border}`,
        borderRadius: 16, padding: '20px',
        transition: 'border-color 150ms',
    };
    return React.createElement('div', { style: sectionStyle,
        onDragOver: e => { e.preventDefault(); setDragging(true); },
        onDragLeave: () => setDragging(false),
        onDrop: e => { e.preventDefault(); setDragging(false); const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.csv')); if (files.length) handleFiles(files); }
    },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hasData ? 12 : 0 } },
            React.createElement('div', null,
                React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc500, textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 4 } }, 'Transaction Data'),
                cacheMeta && React.createElement('div', { style: { fontFamily: sys, fontSize: 10, color: C.zinc600 } }, `${transactions.length} trades · ${relTime(cacheMeta.savedAt)}`)
            ),
            React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontFamily: sys, fontSize: 12, color: C.zinc400, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 14px', cursor: 'pointer' } },
                React.createElement(Upload, { style: { width: 14, height: 14 }, strokeWidth: 1.5 }),
                'CSV',
                React.createElement('input', { type: 'file', accept: '.csv', multiple: true, style: { display: 'none' }, onChange: e => { handleFiles(Array.from(e.target.files)); e.target.value = ''; } })
            )
        ),
        hasData && React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            tickersUsed.length > 0 && React.createElement('button', {
                onClick: fetchAllPrices,
                disabled: loading,
                style: { display: 'flex', alignItems: 'center', gap: 6, fontFamily: sys, fontSize: 11, color: loading ? C.zinc600 : C.amber, background: 'transparent', border: `1px solid ${loading ? C.zinc700 : C.amber + '40'}`, borderRadius: 8, padding: '6px 10px', cursor: loading ? 'not-allowed' : 'pointer' }
            }, React.createElement(RefreshCw, { style: { width: 12, height: 12 }, className: loading ? 'spinning' : '' }), loading ? 'Fetching…' : 'Fetch history'),
            tickersUsed.length > 0 && React.createElement('button', {
                onClick: fetchLivePrices,
                disabled: liveStatus === 'fetching',
                style: { display: 'flex', alignItems: 'center', gap: 6, fontFamily: sys, fontSize: 11, color: liveStatus === 'fetching' ? C.zinc600 : C.emerald, background: 'transparent', border: `1px solid ${liveStatus === 'fetching' ? C.zinc700 : C.emerald + '40'}`, borderRadius: 8, padding: '6px 10px', cursor: liveStatus === 'fetching' ? 'not-allowed' : 'pointer' }
            }, React.createElement(Activity, { style: { width: 12, height: 12 } }), liveStatus === 'fetching' ? 'Live…' : 'Live prices'),
            React.createElement('button', {
                onClick: clearCache,
                style: { display: 'flex', alignItems: 'center', gap: 6, fontFamily: sys, fontSize: 11, color: C.zinc600, background: 'transparent', border: `1px solid ${C.zinc700}`, borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }
            }, React.createElement(Trash2, { style: { width: 12, height: 12 }, strokeWidth: 1.5 }), 'Clear')
        )
    );
}


// ── Contributors to the plotted line ─────────────────────────────────────────────────────────────────────────────
// Splits the plotted "invested" TWR line into per-holding contributions, so the chart's pressed-day bubble can show
// WHAT built the move from the start of the visible window to the pressed day. Pure functions, no React.
//
// Step maths (row i-1 -> row i), mirroring the invested-only Modified Dietz in performanceChart:
//   g_k  = V_k(i) - V_k(i-1) - CF_k          flow-adjusted GBP gain of holding k (CF_k = its own buys/sells/transfers)
//   c_k  = g_k / denom                        denom = invested value(i-1) + time-weighted invested flows (as the line)
//   r    = the step return read straight off the plotted series (inv_i / inv_{i-1} - 1)
//   other = r - sum(c_k)                      untickered items, dealing costs, the +/-50% clamp: so the rows always add up.
// Steps are then linked over any window with Carino smoothing: sum_k contribution_k + other = window return exactly,
// and the window return is exactly the bubble's "Port" figure because both come from the same series.
// The plotted line is investedAll: the restricted positions (HSBC (R), Citi (R)) ride along as holdings, from each
// row's rBy / rPx, with their flows (rFlow) booked at the end of the step exactly as the line books them.
function buildContribSteps(performanceChart, benchmarkTimeline, perfLedger) {
    if (!performanceChart || performanceChart.length < 2 || !benchmarkTimeline || benchmarkTimeline.length === 0) return null;
    const rowsByDate = new Map(benchmarkTimeline.map(r => [r.date, r]));
    const sortedTx = [...(perfLedger || [])].sort((a, b) => a.parsedDate - b.parsedDate);
    const txDates = sortedTx.map(t => fmtDate(t.parsedDate));
    const n = performanceChart.length;
    const idxByDate = new Map();
    const steps = new Array(n).fill(null);
    const px = new Array(n).fill(null);
    const dates = new Array(n).fill(null);
    const inv = new Array(n).fill(null);
    const by = new Array(n).fill(null);
    const rSum = row => { let t = 0; for (const k in (row && row.rBy) || {}) t += row.rBy[k]; return t; };
    const withR = (base, extra) => (extra && Object.keys(extra).length) ? Object.assign({}, base || {}, extra) : (base || null);
    let txPtr = 0;
    for (let i = 0; i < n; i++) {
        const date = performanceChart[i].date;
        idxByDate.set(date, i);
        dates[i] = date;
        const cRow = rowsByDate.get(date);
        const pc = performanceChart[i], pp = i > 0 ? performanceChart[i - 1] : null;
        px[i] = withR(cRow && cRow.pxTicker, pc.rPx);
        by[i] = withR(cRow && cRow.byTicker, pc.rBy);
        inv[i] = cRow ? cRow.holdingsValue + (cRow.untickeredValue || 0) + rSum(pc) : null;
        if (i === 0) continue;
        const prevDate = pp.date;
        const pRow = rowsByDate.get(prevDate);
        // The step's own invested cash flows, exactly as the line treats them (internal transfers are not flows).
        // Kept on every step (cf per holding, f in all) for the £ breakdown, which needs them even when the line is flat.
        const rowMs = new Date(date).getTime();
        const periodMs = rowMs - new Date(prevDate).getTime();
        const cf = {};
        let netCF = 0, wCF = 0;
        while (txPtr < txDates.length && txDates[txPtr] <= prevDate) txPtr++;
        for (let j = txPtr; j < txDates.length && txDates[j] <= date; j++) {
            const t = sortedTx[j];
            if (t.internalTransfer) continue;
            let f;
            if (t.category === 'transfer_out') f = -Math.abs(t.value);
            else if (t.category === 'transfer_in') { if (Math.abs(t.value) > 0.001) f = Math.abs(t.value); else continue; }
            else if (t.category === 'buy' || t.category === 'sell') f = -t.value;
            else continue;
            if (!isFinite(f)) continue;
            const w = periodMs > 0 ? (rowMs - t.parsedDate) / periodMs : 0;
            netCF += f; wCF += f * w;
            const tk = t.instrument && t.instrument.ticker;
            if (tk && tk !== 'UNTICKERED') cf[tk] = (cf[tk] || 0) + f;
        }
        // Restricted flows: end of step (weight 0), as in the line.
        for (const k in (pc.rFlow || {})) { cf[k] = (cf[k] || 0) + pc.rFlow[k]; netCF += pc.rFlow[k]; }
        const lineKey = pc.investedAll !== undefined ? 'investedAll' : 'invested';
        const invPrev = pp[lineKey], invCurr = pc[lineKey];
        const okSeries = invPrev != null && invCurr != null && isFinite(invPrev) && isFinite(invCurr) && invPrev > 0 && invCurr > 0;
        const r = okSeries ? (invCurr / invPrev - 1) : 0;
        if (Math.abs(r) < 1e-12) { steps[i] = { r: 0, c: null, o: 0, cf, f: netCF }; continue; }
        if (!pRow || !cRow) { steps[i] = { r, c: null, o: r, cf, f: netCF }; continue; }
        const prevInv = pRow.holdingsValue + (pRow.untickeredValue || 0) + rSum(pp);
        const currInv = cRow.holdingsValue + (cRow.untickeredValue || 0) + rSum(pc);
        const denom = prevInv + wCF;
        if (!(denom > 1)) { steps[i] = { r, c: null, o: r, cf, f: netCF }; continue; }
        const rawR = (currInv - prevInv - netCF) / denom;
        // If the line clamped this step (|r| capped at 50%), scale the holdings the same way; fall back to 1 on anything odd.
        let scale = Math.abs(rawR) > 1e-9 ? r / rawR : 1;
        if (!isFinite(scale) || scale <= 0 || scale > 5) scale = 1;
        const prevBy = by[i - 1] || {}, currBy = by[i] || {};
        const keys = new Set([...Object.keys(prevBy), ...Object.keys(currBy), ...Object.keys(cf)]);
        const c = {};
        let sumC = 0;
        for (const tk of keys) {
            const g = (currBy[tk] || 0) - (prevBy[tk] || 0) - (cf[tk] || 0);
            const ci = scale * g / denom;
            if (ci !== 0 && isFinite(ci)) { c[tk] = ci; sumC += ci; }
        }
        steps[i] = { r, c, o: r - sumC, cf, f: netCF };
    }
    return { steps, idxByDate, px, dates, inv, by };
}

// Returns a function (startDate, endDate) -> { total, rows: [{tk, c, own}], other, moreCount, showOther } or null.
// rows = the top 5 holdings by absolute contribution; `other` = everything else (smaller holdings + untickered/costs).
// Exactly one holding past the top 5 (a six-holding list) is listed by name too: an "Other (1)" row would take the same
// space as that row and say less.
function makeContribRange(S, topN) {
    if (!S) return null;
    const N = topN || 5;
    const cache = new Map();
    const A = x => (Math.abs(x) < 1e-9 ? 1 : Math.log(1 + x) / x);   // Carino log-mean helper
    // Per-holding facts for the table, all measured over rows a -> b:
    //  held    price return (GBP) chained over only the steps the holding was held at both ends of
    //  heldDays  calendar days those steps cover;  pa  annualised held return, only when held >= 1 year
    //  sold    true if the holding is no longer held on row b;  weight  its share of invested value there
    const statsFor = function (r, a, b) {
        let g = 1, days = 0, n = 0;
        for (let i = a + 1; i <= b; i++) {
            const p1 = S.px[i] && S.px[i][r.tk], p0 = S.px[i - 1] && S.px[i - 1][r.tk];
            if (p1 > 0 && p0 > 0) {
                g *= p1 / p0;
                days += (Date.parse(S.dates[i]) - Date.parse(S.dates[i - 1])) / 86400000;
                n++;
            }
        }
        r.held = n > 0 ? g - 1 : null;
        r.heldDays = n > 0 ? days : 0;
        r.pa = (n > 0 && days >= 365) ? Math.pow(g, 365.25 / days) - 1 : null;
        const vEnd = S.by[b] ? (S.by[b][r.tk] || 0) : 0;
        r.sold = Math.abs(vEnd) < 1e-9;
        r.weight = (!r.sold && S.inv[b] > 0) ? vEnd / S.inv[b] : null;
    };
    // The tickers with a value on any row a..b (bought, held or sold within the range).
    const heldIn = function (a, b) {
        const out = new Set();
        for (let i = a; i <= b; i++) for (const tk in (S.by[i] || {})) if (Math.abs(S.by[i][tk]) > 1e-9) out.add(tk);
        return out;
    };
    const contribForRange = function (startDate, endDate) {
        const key = startDate + '|' + endDate;
        if (cache.has(key)) return cache.get(key);
        let out = null;
        const a = S.idxByDate.get(startDate), b = S.idxByDate.get(endDate);
        if (a != null && b != null && b > a) {
            let growth = 1, bad = false;
            for (let i = a + 1; i <= b; i++) { growth *= (1 + S.steps[i].r); }
            if (!(growth > 0) || !isFinite(growth)) bad = true;
            if (!bad) {
                const R = growth - 1, AR = A(R);
                const tot = {};
                let other = 0;
                for (let i = a + 1; i <= b; i++) {
                    const st = S.steps[i];
                    const k = A(st.r) / AR;
                    other += k * st.o;
                    if (st.c) for (const tk in st.c) tot[tk] = (tot[tk] || 0) + k * st.c[tk];
                }
                // Every holding held in the range is listed, even one whose moves netted out to ~0 over it (FLRK.L,
                // 23 -> 30 Oct 2026: 64.15 -> 64.20, so it vanished from the table) or that never moved. Only float noise
                // on tickers not held in the range folds into Other.
                const held = heldIn(a, b);
                for (const tk of held) if (!(tk in tot)) tot[tk] = 0;
                const all = Object.keys(tot).map(tk => ({ tk, c: tot[tk] }));
                all.sort((x, y) => Math.abs(y.c) - Math.abs(x.c));
                const listed = all.filter(r => Math.abs(r.c) >= 5e-6 || held.has(r.tk));
                const top = listed.slice(0, listed.length === N + 1 ? N + 1 : N);
                // Listed biggest absolute contribution first, gainers and drags alike: that is what explains the move.
                // (`all` is already sorted that way, so `top` keeps that order.)
                const heldStats = r => statsFor(r, a, b);
                // "Other" = every holding beyond the top N (listed again, with stats, in `rest`) + `tail`, the part no holding
                // explains (untickered items, dealing costs, the clamp, and noise on tickers not held).
                const restShown = listed.filter(r => top.indexOf(r) < 0);
                const tiny = all.filter(r => listed.indexOf(r) < 0);
                top.forEach(heldStats);
                restShown.forEach(heldStats);
                let tail = other;
                for (const r of tiny) tail += r.c;
                let otherSum = tail;
                for (const r of restShown) otherSum += r.c;
                const moreCount = restShown.length;
                out = { total: R, startDate, endDate, rows: top, rest: restShown, tail, other: otherSum, moreCount,
                        showOther: moreCount > 0 || Math.abs(otherSum) >= 5e-5 };
            }
        }
        cache.set(key, out);
        return out;
    };
    // The £ move of the invested value from startDate to endDate, split the same way (Fergus asked for Analyse in £):
    // each holding's gain = its value at the end - at the start - the money put into it (buys, transfers in) + taken
    // out (sells); `flows` = all the money put in less taken out; `other` = what is left (untickered items, costs), so
    // rows + other + flows = total exactly. Same shape as contribForRange, with `c` in £.
    const gainCache = new Map();
    contribForRange.gains = function (startDate, endDate) {
        const key = startDate + '|' + endDate;
        if (gainCache.has(key)) return gainCache.get(key);
        let out = null;
        const a = S.idxByDate.get(startDate), b = S.idxByDate.get(endDate);
        if (a != null && b != null && b > a && Number.isFinite(S.inv[a]) && Number.isFinite(S.inv[b])) {
            const by0 = S.by[a] || {}, by1 = S.by[b] || {}, cfSum = {};
            let flows = 0;
            for (let i = a + 1; i <= b; i++) {
                const st = S.steps[i];
                if (!st) continue;
                flows += st.f || 0;
                for (const tk in (st.cf || {})) cfSum[tk] = (cfSum[tk] || 0) + st.cf[tk];
            }
            const keys = new Set([...Object.keys(by0), ...Object.keys(by1), ...Object.keys(cfSum)]);
            const all = [];
            for (const tk of keys) {
                const g = (by1[tk] || 0) - (by0[tk] || 0) - (cfSum[tk] || 0);
                if (isFinite(g)) all.push({ tk, c: g });
            }
            all.sort((x, y) => Math.abs(y.c) - Math.abs(x.c));
            const total = S.inv[b] - S.inv[a];
            // As in % mode: every holding held in the range is listed, however small its gain.
            const held = heldIn(a, b);
            const listed = all.filter(r => Math.abs(r.c) >= 0.5 || held.has(r.tk));
            const top = listed.slice(0, listed.length === N + 1 ? N + 1 : N);
            const restShown = listed.filter(r => top.indexOf(r) < 0);
            let tail = total - flows;
            for (const r of all) tail -= r.c;
            for (const r of all) if (listed.indexOf(r) < 0) tail += r.c;
            let otherSum = tail;
            for (const r of restShown) otherSum += r.c;
            top.forEach(r => statsFor(r, a, b));
            restShown.forEach(r => statsFor(r, a, b));
            out = { total, flows, startDate, endDate, rows: top, rest: restShown, tail, other: otherSum, moreCount: restShown.length,
                    showOther: restShown.length > 0 || Math.abs(otherSum) >= 0.5 };
        }
        gainCache.set(key, out);
        return out;
    };
    // One holding's own line for the chart, on the chart's dates: an index (100 = the first date in `dateList` it is
    // priced on), chained over the same steps as its Held return, so the line ends where that figure says. null where it
    // is not held (or the date is not on the spine), which breaks the line.
    const seriesCache = new Map();
    contribForRange.holdingSeries = function (tk, dateList) {
        if (!tk || !dateList || !dateList.length) return null;
        const key = tk + '|' + dateList[0] + '|' + dateList[dateList.length - 1] + '|' + dateList.length;
        if (seriesCache.has(key)) return seriesCache.get(key);
        const a = S.idxByDate.get(dateList[0]), b = S.idxByDate.get(dateList[dateList.length - 1]);
        let out = null;
        if (a != null && b != null && b > a) {
            const pxAt = i => { const p = S.px[i] && S.px[i][tk]; return p > 0 ? p : null; };
            const idx = new Map();
            let g = null;
            for (let i = a; i <= b; i++) {
                if (g == null) { if (pxAt(i) != null) { g = 1; idx.set(i, 100); } continue; }
                const p1 = pxAt(i), p0 = pxAt(i - 1);
                if (p1 != null && p0 != null) g *= p1 / p0;
                if (p1 != null) idx.set(i, 100 * g);
            }
            out = dateList.map(d => { const i = S.idxByDate.get(d); return i != null && idx.has(i) ? idx.get(i) : null; });
            if (!out.some(v => v != null)) out = null;
        }
        seriesCache.set(key, out);
        return out;
    };
    return contribForRange;
}

// Segmented control, the same look as the Estate tab's (balances.js Segmented): a dark track, the chosen option lifted.
// fill: takes the room left in its row and shares it between the options, so a long row (the six ranges) still fits a
// 320px phone.
// Whether a touch starting at `el` may swipe between tabs. Not from a chart (it drags to read values), a form field,
// something that scrolls sideways, or any overlay (a sheet, Settings, a form): only from a tab's own screen, which is
// a screen marked data-swipe-tabs: the app's own page (Investments), Markets, and Estate's main view.
function swipeAllowed(el) {
    for (let n = el; n && n !== document.body && n.nodeType === 1; n = n.parentElement) {
        if (n.hasAttribute('data-swipe-tabs')) return true;
        if (n.hasAttribute('data-no-swipe') || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.tagName.toLowerCase() === 'svg') return false;
        const cs = getComputedStyle(n);
        if (cs.position === 'fixed') return false;
        if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) return false;
    }
    return false;
}

function SegmentedControl({ options, value, onChange, fill }) {
    return React.createElement('div', { style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2, minWidth: 0,
                                                 flex: fill ? '0 1 260px' : '0 0 auto' } },
        options.map(o => {
            const on = o.id === value;
            return React.createElement('button', {
                key: o.id, onClick: () => onChange(o.id),
                style: { border: 'none', borderRadius: 7, padding: fill ? '5px 0' : '5px 10px', fontFamily: sys, fontSize: 12, fontWeight: 600,
                         flex: fill ? '1 1 0' : 'none', minWidth: 0, textAlign: 'center',
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? C.white : C.zinc600, cursor: 'pointer', whiteSpace: 'nowrap' }
            }, o.label);
        })
    );
}

const PortfolioChart = React.memo(function PortfolioChart({ data, timeframe, setTimeframe, mode, setMode, privacyMode, spxLatestPrice, spxSessionDate, contribFn }) {
    const [scrubIdx, setScrubIdx] = React.useState(null);
    // The pop-out stays on the last pressed day after the finger lifts, so it can be read. It goes when the page scrolls,
    // a tap lands anywhere off the chart, or the timeframe or mode changes.
    const [stickyIdx, setStickyIdx] = React.useState(null);
    React.useEffect(() => { setStickyIdx(null); }, [timeframe, mode]);
    // The contributors table (% mode) only opens from a timeframe chip or the Analyse button, never from a press on the
    // chart (a finger landing on the chart while scrolling used to open it). Once open, it is pinned to the last pressed
    // day until dismissed (x), a new press replaces it, and it clears when the timeframe or mode changes. The day is
    // stored as a date so it survives data refreshes.
    const [tableOpen, setTableOpen] = React.useState(false);
    const [pinDate, setPinDate] = React.useState(null);
    const [prevPinDate, setPrevPinDate] = React.useState(null);   // the press before the pinned one (for "vs last press")
    const [cmpMode, setCmpMode] = React.useState('start');        // 'start' = window start -> day, 'prev' = last press <-> day
    const [otherOpen, setOtherOpen] = React.useState(false);      // "Other (n)" expanded
    const [sel, setSel] = React.useState([]);                      // holdings drawn instead of the portfolio: [{ tk, slot }]
    const lastScrubRef = React.useRef(null);
    const lastTouchRef = React.useRef(0);                         // when a finger last touched the chart (see touchedRecently)
    const pinRef = React.useRef(null);
    pinRef.current = pinDate;
    const hideTable = () => { setTableOpen(false); setPinDate(null); setPrevPinDate(null); setCmpMode('start'); setOtherOpen(false); setSel([]); setScrubIdx(null); setStickyIdx(null); lastScrubRef.current = null; };
    // iPhone Safari follows every tap with emulated mouse events. On the chart those used to re-start a "scrub" right after
    // the finger lifted (the crosshair stuck on), and the next tap anywhere else then made Safari fire mouseleave on the chart,
    // which changed the page, and Safari drops the click when a mouse event changes the page. That is how a tap on the x or
    // on a chip could be swallowed. So mouse events that arrive just after a touch are ignored; the touch already did the work.
    const touchedRecently = () => Date.now() - lastTouchRef.current < 800;
    React.useEffect(() => {
        if (stickyIdx == null) return;
        const clear = () => setStickyIdx(null);
        const offChart = e => { if (!containerRef.current || !containerRef.current.contains(e.target)) clear(); };
        window.addEventListener('scroll', clear, true);          // capture: any scrolling area, not only the window
        document.addEventListener('touchstart', offChart, true);
        document.addEventListener('mousedown', offChart, true);
        return () => {
            window.removeEventListener('scroll', clear, true);
            document.removeEventListener('touchstart', offChart, true);
            document.removeEventListener('mousedown', offChart, true);
        };
    }, [stickyIdx]);
    // Selecting a timeframe opens the table straight away for the whole window (start -> latest day), % mode only. The flag
    // is raised on a timeframe change (not on first load or a £/% switch) and consumed once data for the window is there.
    const prevTfRef = React.useRef(timeframe);
    const autoShowRef = React.useRef(false);
    React.useEffect(() => {
        hideTable();
        if (prevTfRef.current !== timeframe) { prevTfRef.current = timeframe; autoShowRef.current = true; }
    }, [timeframe, mode]);
    React.useEffect(() => {
        if (!autoShowRef.current) return;
        if (mode !== 'twr') { autoShowRef.current = false; return; }
        if (!(data && data.length >= 2)) return;
        autoShowRef.current = false;
        setPinDate(data[data.length - 1].date);
        setTableOpen(true);
    }, [data, timeframe, mode]);
    // Analyse (and a tap on the timeframe already selected): open the table for the whole window, in £ or % as the chart
    // is (Fergus asked for £: each holding's gain in £ and the money put in, rather than switching to %).
    const openTable = () => {
        if (!(data && data.length >= 2)) return;
        setPrevPinDate(null); setCmpMode('start'); setOtherOpen(false);
        setPinDate(data[data.length - 1].date);
        setTableOpen(true);
    };
    const containerRef = React.useRef(null);
    const { width: cw } = useDimensions(containerRef);

    const TF = ['1W','1M','3M','YTD','1Y','ALL'];
    const PAD = { top: 18, right: 16, bottom: 26, left: 10 };
    const SVG_H = 158;
    const W = Math.max(0, (cw || 0) - PAD.left - PAD.right);
    const CH = SVG_H - PAD.top - PAD.bottom;

    const hasData = data && data.length >= 2;
    // The line always shows the equity-only series (cash excluded, so cash never drags the return), with the restricted
    // schemes in as HSBC (R) / Citi (R).
    const yKey = mode === 'twr' ? 'investedAll' : 'investedAllRawValue';
    // Tapping holdings in the table (up to three) swaps the portfolio line for each holding's own price line over the same
    // window (% mode, table open), so they can be read against the S&P. The table, its Portfolio figure and the line colour
    // stay the portfolio's, and the portfolio stays on the chart as a dashed grey line (the same grey as its label above the
    // table). Each holding keeps the colour slot it was given while it stays selected: teal, fuchsia, then orange. None of
    // them is the portfolio's yellow (or its red when down), so yellow only ever means the portfolio, and all three stay well
    // apart from each other, the S&P blue and the grey portfolio line. Violet sits too close to the blue, pink to the red,
    // and an off-white line read as a second neutral next to the grey portfolio.
    const HOLD_MAX = 3;
    const holdLines = (sel.length && tableOpen && mode === 'twr' && hasData && contribFn && typeof contribFn.holdingSeries === 'function')
        ? sel.slice().sort((a, b) => a.slot - b.slot)
            .map(s => ({ tk: s.tk, slot: s.slot, vals: contribFn.holdingSeries(s.tk, data.map(d => d.date)) }))
            .filter(l => l.vals)
        : [];
    const showHold = holdLines.length > 0;
    const holdVals = showHold ? holdLines[0].vals : null;           // the first line: area fill, chip, markers
    const lineV = i => (showHold ? holdVals[i] : (data[i] ? data[i][yKey] : null));
    const portValues = hasData ? data.map(d => d[yKey]).filter(v => v != null && isFinite(v)) : [];
    const values = showHold ? holdVals.filter(v => v != null && isFinite(v)) : portValues;
    const scaleValues = showHold ? [].concat(portValues, ...holdLines.map(l => l.vals.filter(v => v != null && isFinite(v)))) : portValues;
    const toggleSel = tk => setSel(cur => {
        if (cur.some(s => s.tk === tk)) return cur.filter(s => s.tk !== tk);
        if (cur.length >= HOLD_MAX) return cur.slice(1).concat([{ tk, slot: cur[0].slot }]);   // a fourth replaces the oldest
        let slot = 0;
        while (cur.some(s => s.slot === slot)) slot++;
        return cur.concat([{ tk, slot }]);
    });

    // ── Aligned SPX series (display-only, same row spine as portfolio) ─────────
    // Benchmark: S&P 500 total return (SPXT) in GBP. It is read from the data rows, so it sits on exactly the same dates as the
    // portfolio point for that row.
    const visibleStartDate = hasData ? data[0].date : null;
    const visibleEndDate   = hasData ? data[data.length - 1].date : null;
    // The benchmark now comes straight from the data rows (canonical S&P-in-GBP series), so it is on exactly the same
    // dates and rebase as the portfolio line.
    const alignedSpx = hasData
        ? data.map(d => (d && d.benchmark != null && Number.isFinite(d.benchmark))
            ? { date: d.date, spxSourceDate: d.spxSourceDate || d.date, spxNative: d.spxNative, benchmark: d.benchmark, isStale: !!d.spxStale }
            : null)
        : [];
    // Benchmark values for y-domain — only non-null aligned values counted.
    const benchValues = mode === 'twr'
        ? alignedSpx.reduce(function(acc, p) {
            if (p && p.benchmark != null && Number.isFinite(p.benchmark)) acc.push(p.benchmark);
            return acc;
          }, [])
        : [];
    const allScaleValues = [...scaleValues, ...benchValues];

    const yMin = allScaleValues.length ? Math.min(...allScaleValues) : 0;
    const yMax = allScaleValues.length ? Math.max(...allScaleValues) : 1;
    const yPad = (yMax - yMin || yMax * 0.02 || 1) * 0.08;
    const yLo  = yMin - yPad;
    const yHi  = yMax + yPad;

    // Nice-numbers algorithm: finds clean tick intervals so y-axis labels are
    // rounded values (e.g. 0%, +5%, +10%) rather than raw interpolated decimals.
    function niceYTicks(lo, hi, maxTicks) {
        const range = hi - lo;
        if (range <= 0) return [lo, hi];
        const roughStep = range / (maxTicks || 4);
        const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
        const niceSteps = [1, 2, 2.5, 5, 10];
        let step = (niceSteps.find(s => s * mag >= roughStep) || niceSteps[niceSteps.length - 1]) * mag;
        const start = Math.ceil(lo / step) * step;
        const ticks = [];
        for (let v = start; v <= hi + step * 0.001; v += step) {
            ticks.push(parseFloat(v.toFixed(10)));
        }
        return ticks;
    }
    const yTicks = hasData ? niceYTicks(yLo, yHi, 4) : [];

    // X positions follow the DATE, not the row number. The history spine is weekly for older data and daily for the
    // last ~year, so index spacing squashed months of recent history against a few wide old weeks (an uneven
    // month axis and a misleading slope). Falls back to index spacing only if a row has no parseable date.
    const _tOf = d => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) ? Date.parse(d.slice(0, 10) + 'T12:00:00Z') : NaN;
    const _times = hasData ? data.map(d => _tOf(d.date)) : [];
    const dateScaled = hasData && _times.every(Number.isFinite) && _times[_times.length - 1] > _times[0];
    const t0 = dateScaled ? _times[0] : 0;
    const spanMs = dateScaled ? (_times[_times.length - 1] - _times[0]) : 1;
    const xsAll = hasData ? data.map((d, i) => dateScaled ? ((_times[i] - t0) / spanMs) * W
                                                            : (data.length <= 1 ? W / 2 : (i / (data.length - 1)) * W)) : [];
    const xP = i => xsAll[i];
    const yP = v => CH - ((v - yLo) / (yHi - yLo)) * CH;

    // Build SVG paths
    const pts = hasData
        ? data.reduce((acc, d, i) => {
            const v = lineV(i);
            if (v != null && isFinite(v)) acc.push([xP(i), yP(v), i]);
            return acc;
        }, [])
        : [];

    const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    // With more than one holding drawn there is no fill, so no line looks more important than the others.
    const areaPath = pts.length >= 2 && holdLines.length < 2
        ? `${linePath} L ${pts[pts.length-1][0].toFixed(1)} ${CH} L ${pts[0][0].toFixed(1)} ${CH} Z`
        : '';

    // S&P 500 benchmark path — uses xP(i) so every SPX point aligns exactly
    // with the portfolio point at the same row index. Null entries break the
    // path into segments (no false continuous bridge across gaps).
    const benchLinePath = (() => {
        if (!hasData || mode !== 'twr' || !alignedSpx.length) return '';
        var parts = [], seg = [];
        for (var _bi = 0; _bi < alignedSpx.length; _bi++) {
            var _ap = alignedSpx[_bi];
            var _bv = _ap ? _ap.benchmark : null;
            if (_bv != null && Number.isFinite(_bv)) {
                seg.push((seg.length === 0 ? 'M' : 'L') + ' ' +
                    xP(_bi).toFixed(1) + ' ' + yP(_bv).toFixed(1));
            } else {
                if (seg.length) { parts.push(seg.join(' ')); seg = []; }
            }
        }
        if (seg.length) parts.push(seg.join(' '));
        return parts.join(' ');
    })();

    // Keep the debug snapshot current (no-op in production).
    if (typeof window.__debugChartIntegrity_setSnapshot === 'function') {
        var _validAligned = alignedSpx.filter(function(p) { return p && p.benchmark != null; });
        var _staleAligned = alignedSpx.filter(function(p) { return p && p.isStale; });
        var _maxStale = _staleAligned.reduce(function(max, p) {
            var d = (new Date(p.date + 'T12:00:00Z') - new Date(p.spxSourceDate + 'T12:00:00Z')) / 86400000;
            return d > max ? d : max;
        }, 0);
        window.__debugChartIntegrity_setSnapshot({
            timeframe:               timeframe,
            visibleStartDate:        visibleStartDate,
            visibleEndDate:          visibleEndDate,
            portfolioPointCount:     hasData ? data.length : 0,
            alignedSpxPointCount:    _validAligned.length,
            firstPortfolioDate:      hasData ? data[0].date : null,
            lastPortfolioDate:       hasData ? data[data.length - 1].date : null,
            firstSpxDisplayDate:     _validAligned.length ? _validAligned[0].date : null,
            lastSpxDisplayDate:      _validAligned.length ? _validAligned[_validAligned.length - 1].date : null,
            firstSpxSourceDate:      _validAligned.length ? _validAligned[0].spxSourceDate : null,
            lastSpxSourceDate:       _validAligned.length ? _validAligned[_validAligned.length - 1].spxSourceDate : null,
            anySpxUsingDifferentXScale: false,  // guaranteed: all SPX points use xP(i)
            anyOffWindowSpxPoints:   false,     // guaranteed: aligned to portfolio row spine
            anyInvalidYValues:       allScaleValues.some(function(v) { return !isFinite(v) || v == null; }),
            staleSpxPointCount:      _staleAligned.length,
            maxSpxStalenessDays:     _maxStale,
            minY: yLo.toFixed(2),
            maxY: yHi.toFixed(2),
        });
    }


    const firstV = values[0];
    const lastV  = values[values.length - 1];
    // Line colour follows the portfolio's move, also while a holding is drawn, so the chips and table do not change colour.
    const periodDelta = portValues[0] > 0 ? (portValues[portValues.length - 1] - portValues[0]) / portValues[0] : null;
    const isUp = periodDelta == null || periodDelta >= 0;
    const lineCol = isUp ? C.amber : C.rose;
    const HOLD_COLS = ['#2dd4bf', '#e879f9', '#f97316'];
    // The portfolio, kept as a dashed grey line under the holdings while any are drawn.
    const portPath = showHold ? data.reduce((acc, d, i) => {
        const v = d[yKey];
        if (v != null && isFinite(v)) acc.push((acc.length ? 'L ' : 'M ') + xP(i).toFixed(1) + ' ' + yP(v).toFixed(1));
        return acc;
    }, []).join(' ') : '';
    const holdCol = slot => HOLD_COLS[slot] || lineCol;
    // The other drawn holdings (after the first), with their paths and colours.
    const extraLines = holdLines.slice(1).map(l => {
        const p = [];
        l.vals.forEach((v, i) => { if (v != null && isFinite(v)) p.push((p.length ? 'L ' : 'M ') + xP(i).toFixed(1) + ' ' + yP(v).toFixed(1)); });
        return { tk: l.tk, vals: l.vals, col: holdCol(l.slot), path: p.join(' ') };
    });
    const firstCol = showHold ? holdCol(holdLines[0].slot) : lineCol;
    const gradId = `pcg${timeframe.replace(/[^a-z0-9]/gi,'_')}${mode}`;

    // Scrub. The crosshair and pop-out follow the finger, then stay on the last pressed day (stickyIdx) after it lifts.
    const bubbleIdx = scrubIdx != null ? scrubIdx : (stickyIdx != null && stickyIdx < data.length ? stickyIdx : null);
    const scrubPt = bubbleIdx != null ? data[bubbleIdx] : null;
    const scrubV  = scrubPt ? lineV(bubbleIdx) : null;
    const scrubRaw = scrubPt ? scrubPt.rawValue : null;
    const scrubX  = bubbleIdx != null && data.length > 1 ? xP(bubbleIdx) : null;
    const scrubY  = scrubV != null ? yP(scrubV) : null;

    // Contributors table (% mode). Focus day = the live scrub point while a finger is down, otherwise the pinned day.
    // Two ranges: "Since start" (window start -> focus day; ties to the Port figure in the pop-out) or "vs last press"
    // (the previously pressed day <-> the focus day, ordered by date: press a peak, then the trough, to see what caused the
    // fall). Guarded: if the rows do not reconcile with the move the chart shows for that range, nothing is shown.
    const pinIdx = (pinDate && hasData) ? data.findIndex(d => d.date === pinDate) : -1;
    const focusIdx = scrubIdx != null ? scrubIdx : (pinIdx >= 1 ? pinIdx : null);
    const focusPt = (hasData && focusIdx != null) ? data[focusIdx] : null;
    const _cmpDate = scrubIdx != null ? pinDate : prevPinDate;       // while pressing, compare against the pinned day
    const _cmpIdx = (hasData && _cmpDate) ? data.findIndex(d => d.date === _cmpDate) : -1;
    const canCompare = focusIdx != null && _cmpIdx >= 0 && _cmpIdx !== focusIdx;
    const segActive = canCompare && cmpMode === 'prev';
    const loIdx = segActive ? Math.min(_cmpIdx, focusIdx) : 0;
    const hiIdx = segActive ? Math.max(_cmpIdx, focusIdx) : focusIdx;
    let tableContrib = null;
    const gbp = mode !== 'twr';
    if (tableOpen && gbp && typeof contribFn === 'function' && typeof contribFn.gains === 'function' && hasData && focusIdx != null
        && hiIdx > loIdx && data[loIdx] && data[hiIdx] && data[loIdx].date && data[hiIdx].date) {
        // £: the rows must add up to the move the chart shows between the two days (to the pound), else nothing is shown.
        const _vLo = data[loIdx][yKey], _vHi = data[hiIdx][yKey];
        try {
            const _res = contribFn.gains(data[loIdx].date, data[hiIdx].date);
            if (_res && Number.isFinite(_res.total) && _vLo != null && _vHi != null && Math.abs(_res.total - (_vHi - _vLo)) <= 1)
                tableContrib = _res;
        } catch (e) { tableContrib = null; }
    }
    if (tableOpen && !gbp && typeof contribFn === 'function' && hasData && focusIdx != null && hiIdx > loIdx
        && data[loIdx] && data[hiIdx] && data[loIdx].date && data[hiIdx].date) {
        const _vLo = data[loIdx][yKey], _vHi = data[hiIdx][yKey];
        const _den = loIdx === 0 ? 100 : _vLo;
        try {
            const _res = contribFn(data[loIdx].date, data[hiIdx].date);
            if (_res && Number.isFinite(_res.total) && _res.rows.length > 0 && _vHi != null && _den > 0
                && Math.abs(_res.total - (_vHi / _den - 1)) <= 0.0005) tableContrib = _res;
        } catch (e) { tableContrib = null; }
    }
    // S&P 500 in GBP over the same range (display only)
    // If the US has not traded yet on the latest day (the chart leaves that day's benchmark empty), the S&P figure uses the
    // previous session's close instead, and is flagged with a small grey "c" (closed).
    let spxRange = null, spxClosed = false;
    if (tableContrib && !gbp && alignedSpx[loIdx]) {
        const _bLo = alignedSpx[loIdx].benchmark;
        const _ok = i => alignedSpx[i] && Number.isFinite(alignedSpx[i].benchmark);
        let _hi = hiIdx;
        if (hiIdx === data.length - 1) while (_hi > loIdx && !_ok(_hi)) _hi--;
        if (_ok(_hi) && _hi > loIdx && Number.isFinite(_bLo) && _bLo > 0) {
            spxRange = alignedSpx[_hi].benchmark / _bLo - 1;
            spxClosed = _hi !== hiIdx;
        }
    }

    // Compute displayed delta (from period start or scrub vs period start)
    const displayV = scrubIdx != null ? scrubV : lastV;
    const displayDelta = firstV > 0 && displayV != null ? (displayV - firstV) / firstV : null;
    const displayAbs0  = displayV != null && firstV != null ? displayV - firstV : null;
    // While pressing in "vs last press", the chip (like the pop-out) shows the compared range's move, not the window's
    // (the holding's, when one is drawn).
    const segOf = vals => (segActive && vals[loIdx] > 0 && vals[hiIdx] > 0) ? vals[hiIdx] / vals[loIdx] - 1 : null;
    // In £ the table's total is pounds: the chip shows that move and its % of the value on the earlier day.
    const _segBase = gbp && tableContrib && data[loIdx] ? data[loIdx][yKey] : null;
    const segDelta = showHold ? segOf(holdVals)
        : !tableContrib ? null : !gbp ? tableContrib.total : (_segBase > 0 ? tableContrib.total / _segBase : null);
    const _segShown = scrubIdx != null && segActive && tableContrib && segDelta != null;
    const displayDeltaShown = _segShown ? segDelta : displayDelta;
    const displayAbs = _segShown && gbp ? tableContrib.total : displayAbs0;
    const shortTk = tk => (tk.length > 9 ? tk.slice(0, 8) + '\u2026' : tk);

    function hitTest(clientX, clientY) {
        if (!containerRef.current || !hasData) return;
        const rect = containerRef.current.getBoundingClientRect();
        const relX = clientX - rect.left - PAD.left;
        const _idx = nearestIndexByX(xsAll, relX);
        lastScrubRef.current = _idx;
        setScrubIdx(_idx);
    }
    // Lifting the finger (or clicking, on desktop) pins the last pressed day so the table stays readable.
    function pinLastScrub() {
        const li = lastScrubRef.current;
        lastScrubRef.current = null;
        if (!(tableOpen && hasData && li != null && li >= 1 && data[li])) return;
        const nd = data[li].date, cur = pinRef.current;
        if (cur && cur !== nd) setPrevPinDate(cur);
        setPinDate(nd);
    }
    const _MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fmtRangeDate(ds) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ds || '');
        return m ? (+m[3]) + ' ' + _MONTHS[+m[2] - 1] + ' ' + m[1].slice(2) : (ds || '');
    }
    // A length of time as "23d" / "9m" / "2.4y": calendar days under two months, rounded months under a year, years after.
    // Used by both the range header and the Held return rows, so a holding held for the whole window shows the same length.
    function fmtSpanDays(days) {
        days = Math.round(days);
        return days < 60 ? Math.max(1, days) + 'd' : days < 365 ? Math.round(days / 30.4375) + 'm' : (days / 365.25).toFixed(1) + 'y';
    }
    // Length of a selected range for the "(23d)" / "(9m)" tag after its dates.
    function fmtRangeSpan(a, b) {
        const ta = Date.parse(String(a || '').slice(0, 10) + 'T12:00:00Z'), tb = Date.parse(String(b || '').slice(0, 10) + 'T12:00:00Z');
        if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb < ta) return '';
        return fmtSpanDays((tb - ta) / 86400000);
    }

    function fmtXLabel(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr + 'T00:00:00Z');
        if (timeframe === '1D') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
        if (timeframe === '1W' || timeframe === '1M')
            return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    }
    function fmtTooltipDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr + 'T00:00:00Z');
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    function fmtChartVal(v) {
        if (v == null) return '—';
        if (mode === 'twr') return `${v >= 100 ? '+' : ''}${(v - 100).toFixed(1)}%`;
        return privacyMode ? '£ ••••' : '£' + Math.round(v).toLocaleString('en-GB');
    }
    function fmtDelta(abs, pct) {
        if (pct == null) return '—';
        const pctStr = `${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(1)}%`;
        if (mode === 'twr') return pctStr;
        if (abs == null) return pctStr;
        const absStr = privacyMode ? '••••' : `${abs >= 0 ? '+' : '\u2212'}£${Math.abs(Math.round(abs)).toLocaleString('en-GB')}`;
        return `${absStr}  ${pctStr}`;
    }

    // X ticks: real calendar positions (month starts / Mondays / weekdays), placed by date so they are evenly spaced in time.
    let xTicks = [];
    if (hasData && dateScaled) {
        xTicks = buildTimeTicks(t0, t0 + spanMs, W).map(k => ({ x: ((k.t - t0) / spanMs) * W, label: k.label }));
    } else if (hasData) {
        const maxTx = Math.max(2, Math.floor(W / 65));
        const step  = Math.max(1, Math.ceil(data.length / maxTx));
        for (let i = 0; i < data.length; i += step) xTicks.push({ x: xP(i), label: fmtXLabel(data[i].date) });
    }

    // ── Contributors table, under the chart (% mode) ──
    // Opens from a timeframe chip or Analyse; while open it follows presses on the chart (live while the finger moves),
    // stays pinned after lifting, and the x hides it. Three columns: Holding (dimmed + "sold" if no longer held on the end
    // day), Contrib = contribution in percentage points
    // to the range's move (rows + Other add up to it; the faint bar is its size relative to the largest), and Held return =
    // price return only over the stretches it was held ("/yr" when held a year or more, a plain total otherwise).
    // "Other (n)" expands to the smaller holdings plus a "Costs & other" remainder. When two days have been pressed, the
    // switch flips between "Since start" and "vs last press" (the earlier press <-> the later one).
    const contribTable = (() => {
        if (!tableContrib || !focusPt) return null;
        const T = tableContrib;
        const fmtPPn = v => { let n = Math.round(v * 10000) / 100; if (n === 0) n = 0; return (n >= 0 ? '+' : '') + n.toFixed(2); };
        // In £ the figures are pounds (hidden in privacy mode); in % they are percentage points.
        const fmtGbpN = v => { const n = Math.round(v); return privacyMode ? '••••' : (n >= 0 ? '+' : '\u2212') + '£' + Math.abs(n).toLocaleString('en-GB'); };
        const fmtC = gbp ? fmtGbpN : fmtPPn;
        const fmtPctN = (v, dp) => {
            if (v == null || !Number.isFinite(v)) return '\u2014';
            const f = Math.pow(10, dp);
            let n = Math.round(v * 100 * f) / f;
            if (n === 0) n = 0;
            return (n >= 0 ? '+' : '') + n.toFixed(dp) + '%';
        };
        const cols = 'minmax(0, 1.05fr) 0.85fr 1.8fr';
        const hdrCell = (txt, right) => React.createElement('span', { style: {
            fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase',
            letterSpacing: '0.08em', textAlign: right ? 'right' : 'left' } }, txt);
        const numCell = (txt, color, extra) => React.createElement('span', { style: Object.assign({
            fontFamily: mono, fontSize: 12, fontWeight: 700, textAlign: 'right',
            fontVariantNumeric: 'tabular-nums', color: color }, extra || {}) }, txt);
        // Both chips are always drawn while the table is up. "Custom" is dimmed until a second day has been pressed,
        // because until then there is nothing to compare against.
        const chip = (label, active, onClick, disabled) => React.createElement('button', {
            key: label, onClick: disabled ? undefined : onClick, disabled: !!disabled, 'aria-pressed': !!active, style: {
            fontFamily: sys, fontSize: 10, fontWeight: 600, lineHeight: '12px', padding: '6px 10px', borderRadius: 5,
            border: '1px solid ' + (active ? lineCol + '55' : C.border), background: active ? lineCol + '14' : 'transparent',
            color: active ? lineCol : C.zinc600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 } }, label);

        // Header block: one grid, so the two figures share a column and the x can never push one of them sideways.
        //   row 1:  dates (length)              Portfolio  +x.xx%    x
        //   row 2:  [From start] [Custom]   S&P £  +y.yy%    (x spans both rows)
        // The x is a 44x44 hit area (Apple's minimum); it reaches 14px into the card's padding so its glyph sits flush right.
        const spanTxt = fmtRangeSpan(T.startDate, T.endDate);
        const gcell = (key, col, row, style, txt) => React.createElement('span', { key: key, style: Object.assign({
            gridColumn: col, gridRow: row, whiteSpace: 'nowrap' }, style) }, txt);
        const hdrBlock = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto 30px',
            columnGap: 6, rowGap: 6, alignItems: 'center', marginBottom: 8 } },
            gcell('rng', 1, 1, { fontFamily: sys, fontSize: 11, fontWeight: 600, color: C.zinc500, whiteSpace: 'normal' },
                fmtRangeDate(T.startDate) + ' → ' + fmtRangeDate(T.endDate) + (spanTxt ? ' (' + spanTxt + ')' : '')),
            // Grey while a holding is drawn instead of the portfolio; tapping it brings the portfolio line back.
            gcell('pl', 2, 1, { fontFamily: mono, fontSize: 12, fontWeight: 700, color: showHold ? C.zinc600 : lineCol }, 'Portfolio'),
            gcell('pv', 3, 1, { fontFamily: mono, fontSize: 12, fontWeight: 700, color: showHold ? C.zinc600 : lineCol, textAlign: 'right',
                fontVariantNumeric: 'tabular-nums' }, gbp ? fmtGbpN(T.total) : fmtPctN(T.total, 2)),
            showHold ? React.createElement('button', { key: 'pback', onClick: () => setSel([]), 'aria-label': 'Show the portfolio line',
                style: { gridColumn: '2 / span 2', gridRow: 1, alignSelf: 'stretch', margin: '-8px -4px', padding: 0, border: 'none',
                         background: 'transparent', cursor: 'pointer' } }) : null,
            React.createElement('button', {
                key: 'x', onClick: hideTable, 'aria-label': 'Hide contributors',
                style: { gridColumn: 4, gridRow: '1 / span 2', alignSelf: 'start', width: 44, height: 44, margin: '-13px -14px 0 0',
                         padding: 0, border: 'none', background: 'transparent', color: C.zinc500, fontSize: 16, lineHeight: '44px',
                         cursor: 'pointer', position: 'relative', zIndex: 2 }
            }, '✕'),
            React.createElement('div', { key: 'chips', style: { gridColumn: 1, gridRow: 2, display: 'flex', alignItems: 'center', gap: 4, minHeight: 26 } },
                chip('From start', !segActive, () => setCmpMode('start'), false),
                chip('Custom', segActive, () => setCmpMode('prev'), !canCompare)),
            spxRange != null ? gcell('sl', 2, 2, { fontFamily: mono, fontSize: 11, fontWeight: 600, color: C.blue, opacity: 0.9 }, spxLabel() + ' £') : null,
            spxRange != null ? gcell('sv', 3, 2, { fontFamily: mono, fontSize: 11, fontWeight: 600, color: C.blue, opacity: 0.9,
                textAlign: 'right', fontVariantNumeric: 'tabular-nums', position: 'relative' },
                [fmtPctN(spxRange, 2),
                 // "c" = closed: US not open yet, so this is the previous session's close. Hangs in the gap so the figures stay aligned.
                 spxClosed ? React.createElement('span', { key: 'c', title: 'US market closed: previous close', style: { position: 'absolute', left: '100%',
                     marginLeft: 2, top: 1, fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, opacity: 1 } }, 'c') : null]) : null
        );
        const colHead = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: cols, columnGap: 6,
            paddingBottom: 4, borderBottom: '1px solid ' + C.border } },
            hdrCell('Holding'), hdrCell(gbp ? 'Gain' : 'Contrib', 1), hdrCell('Held return', 1));

        const maxAbs = Math.max.apply(null, T.rows.map(r => Math.abs(r.c)).concat([1e-9]));
        const retCell = r => {
            if (r.held == null) return numCell('\u2014', C.zinc700, { fontSize: 11, fontWeight: 600 });
            const dur = fmtSpanDays(r.heldDays);
            return r.pa != null
                ? numCell(fmtPctN(r.pa, 1) + '/yr \u00b7 ' + dur, C.zinc400, { fontSize: 11, fontWeight: 600 })
                : numCell(fmtPctN(r.held, 1) + ' \u00b7 ' + dur, C.zinc600, { fontSize: 11, fontWeight: 500 });
        };
        const mkRow = (r, i, indent) => {
            const pos = r.c >= 0;
            const barPct = Math.max(2, Math.min(100, Math.round(Math.abs(r.c) / maxAbs * 100)));
            const label = shortTk(r.tk);
            // Tap holdings (up to three) to draw their own lines instead of the portfolio's; tap one again to drop it, or tap
            // the grey Portfolio to go back. A drawn row is outlined in its line's colour and carries a swatch of it (the legend).
            // % only: in £ a holding's line would sit flat along the bottom next to the whole portfolio.
            const canPick = !gbp && r.held != null && typeof contribFn.holdingSeries === 'function';
            const pickedLine = holdLines.find(l => l.tk === r.tk);
            const picked = !!pickedLine;
            const pCol = picked ? holdCol(pickedLine.slot) : null;
            return React.createElement('div', { key: r.tk,
                onClick: canPick ? () => toggleSel(r.tk) : undefined,
                role: canPick ? 'button' : undefined, 'aria-pressed': canPick ? picked : undefined,
                style: { position: 'relative', borderTop: i === 0 ? 'none' : '1px solid ' + C.border, cursor: canPick ? 'pointer' : 'default',
                         borderRadius: 3, outline: picked ? '1px solid ' + pCol + '99' : 'none', outlineOffset: 0, zIndex: picked ? 1 : 'auto',
                         background: picked ? pCol + '12' : 'transparent' } },
                // faint bar: this row's size relative to the largest contributor shown
                React.createElement('div', { style: { position: 'absolute', left: 0, top: 1, bottom: 1, width: barPct + '%',
                    background: (pos ? C.emerald : C.rose) + '1c', borderRadius: 3, pointerEvents: 'none' } }),
                React.createElement('div', { style: { position: 'relative', display: 'grid', gridTemplateColumns: cols,
                    columnGap: 6, alignItems: 'center', padding: '7px 0' } },
                    React.createElement('span', { style: { display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0, paddingLeft: 3 + (indent || 0) } },
                        picked ? React.createElement('span', { 'aria-hidden': true, style: { alignSelf: 'center', flexShrink: 0, width: 10, height: 3,
                            borderRadius: 2, background: pCol } }) : null,
                        React.createElement('span', { style: { fontFamily: mono, fontSize: 12, fontWeight: 700, color: C.amber,
                            opacity: r.sold ? 0.55 : 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                        r.sold ? React.createElement('span', { style: { fontFamily: sys, fontSize: 9, fontStyle: 'italic', color: C.zinc700, flexShrink: 0 } },
                            / \(R\)$/.test(r.tk) ? 'vested' : 'sold') : null
                    ),
                    numCell(fmtC(r.c), pos ? C.emerald : C.rose),
                    retCell(r)
                )
            );
        };
        const rows = T.rows.map((r, i) => mkRow(r, i, 0));

        // Other (n): tap to expand into the smaller holdings + whatever no holding explains
        const canExpand = T.moreCount > 0;
        const otherInner = [
            React.createElement('span', { key: 'l', style: { fontFamily: mono, fontSize: 12, fontWeight: 500, color: C.zinc600, paddingLeft: 3 } },
                canExpand ? 'Other (' + T.moreCount + ') ' + (otherOpen ? '\u25be' : '\u25b8') : 'Other'),
            React.createElement('span', { key: 'p', style: { fontFamily: mono, fontSize: 12, fontWeight: 700, textAlign: 'right',
                fontVariantNumeric: 'tabular-nums', color: C.zinc500 } }, fmtC(T.other))
        ];
        const otherStyle = { display: 'grid', gridTemplateColumns: cols, columnGap: 6, alignItems: 'center', padding: '7px 0',
            borderTop: '1px solid ' + C.border, width: '100%', background: 'transparent', borderLeft: 'none', borderRight: 'none',
            borderBottom: 'none', textAlign: 'left', color: 'inherit', cursor: canExpand ? 'pointer' : 'default', font: 'inherit' };
        const otherRow = T.showOther
            ? React.createElement(canExpand ? 'button' : 'div', canExpand
                ? { key: '__other', onClick: () => setOtherOpen(o => !o), 'aria-expanded': otherOpen, style: otherStyle }
                : { key: '__other', style: otherStyle }, otherInner)
            : null;
        let openRows = null;
        if (canExpand && otherOpen) {
            const shownRest = T.rest.slice(0, 10), folded = T.rest.slice(10);
            let tailV = T.tail;
            for (const r of folded) tailV += r.c;
            openRows = shownRest.map((r, i) => mkRow(r, i + 1, 10));
            if (Math.abs(tailV) >= (gbp ? 0.5 : 5e-5) || folded.length > 0) {
                openRows.push(React.createElement('div', { key: '__tail', style: { display: 'grid', gridTemplateColumns: cols,
                    columnGap: 6, alignItems: 'center', padding: '7px 0', borderTop: '1px solid ' + C.border } },
                    React.createElement('span', { style: { fontFamily: mono, fontSize: 11, fontWeight: 500, color: C.zinc700, paddingLeft: 13 } },
                        folded.length > 0 ? 'Smaller & other (' + folded.length + ')' : 'Costs & other'),
                    numCell(fmtC(tailV), C.zinc600, { fontSize: 11 })
                ));
            }
        }
        // £ only: the money put in less taken out over the range, which moves the value without being a gain.
        const flowRow = gbp && Math.abs(T.flows) >= 0.5 ? React.createElement('div', { key: '__flows', style: { display: 'grid',
            gridTemplateColumns: cols, columnGap: 6, alignItems: 'center', padding: '7px 0', borderTop: '1px solid ' + C.border } },
            React.createElement('span', { style: { fontFamily: mono, fontSize: 12, fontWeight: 500, color: C.zinc600, paddingLeft: 3 } },
                T.flows >= 0 ? 'Net money in' : 'Net money out'),
            numCell(fmtGbpN(T.flows), C.zinc500)) : null;
        return React.createElement('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid ' + C.border } },
            hdrBlock, colHead, rows, otherRow, openRows, flowRow);
    })();

    return React.createElement('div', null,
        // ── One row: £ / % on the left, the range on the right, in the same segmented controls as the Estate chart
        // (Fergus asked). Tapping the range already shown opens the table, as the chips did.
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 } },
            React.createElement(SegmentedControl, { options: [{ id: 'value', label: '£' }, { id: 'twr', label: '%' }], value: mode, onChange: setMode }),
            React.createElement(SegmentedControl, { options: TF.map(tf => ({ id: tf, label: tf === 'ALL' ? 'All' : tf })), value: timeframe, fill: true,
                onChange: tf => (tf === timeframe ? openTable() : setTimeframe(tf)) })
        ),

        // ── Chart area ──
        React.createElement('div', {
            ref: containerRef,
            className: 'chart-noselect', 'data-no-swipe': '',
            style: { position: 'relative', height: SVG_H, cursor: 'crosshair', userSelect: 'none' },
            onTouchStart:  e => { e.preventDefault(); lastTouchRef.current = Date.now(); hitTest(e.touches[0].clientX, e.touches[0].clientY); },
            onTouchMove:   e => { e.preventDefault(); lastTouchRef.current = Date.now(); hitTest(e.touches[0].clientX, e.touches[0].clientY); },
            onTouchEnd:    () => { lastTouchRef.current = Date.now(); setStickyIdx(lastScrubRef.current); pinLastScrub(); setScrubIdx(null); },
            onTouchCancel: () => { lastTouchRef.current = Date.now(); lastScrubRef.current = null; setScrubIdx(null); },
            // Mouse handlers are for desktop only: emulated mouse events that follow a touch are ignored (see touchedRecently).
            onClick:       () => { if (!touchedRecently()) { setStickyIdx(lastScrubRef.current); pinLastScrub(); } },
            onMouseMove:   e => { if (!touchedRecently()) hitTest(e.clientX, e.clientY); },
            onMouseLeave:  () => { if (touchedRecently()) return; lastScrubRef.current = null; setScrubIdx(null); },
        },
            !hasData
                ? React.createElement('div', { style: { height: SVG_H, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 } },
                    React.createElement('div', { style: { color: C.zinc700, fontFamily: sys, fontSize: 13, fontStyle: 'italic' } }, 'No price history loaded'),
                    React.createElement('div', { style: { color: C.zinc600, fontFamily: sys, fontSize: 11 } }, 'Use "Fetch history" to load prices')
                  )
                : cw > 0 && React.createElement('svg', {
                    width: cw, height: SVG_H,
                    style: { position: 'absolute', top: 0, left: 0, overflow: 'visible' }
                  },
                    React.createElement('defs', null,
                        React.createElement('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' },
                            React.createElement('stop', { offset: '0%', stopColor: firstCol, stopOpacity: '0.25' }),
                            React.createElement('stop', { offset: '85%', stopColor: firstCol, stopOpacity: '0.02' })
                        ),
                        // Fade mask at left/right edges
                        React.createElement('linearGradient', { id: gradId + '_fade', x1: '0', y1: '0', x2: '1', y2: '0' },
                            React.createElement('stop', { offset: '0%', stopColor: C.bg, stopOpacity: '0' }),
                            React.createElement('stop', { offset: '100%', stopColor: C.bg, stopOpacity: '0' })
                        )
                    ),
                    React.createElement('g', { transform: `translate(${PAD.left}, ${PAD.top})` },
                        // Grid lines at nice rounded y-axis positions
                        yTicks.map((v, i) =>
                            React.createElement('line', {
                                key: 'g' + i, x1: 0, x2: W,
                                y1: yP(v).toFixed(1), y2: yP(v).toFixed(1),
                                stroke: C.border, strokeWidth: 1,
                            })
                        ),
                        // Y-axis labels at nice rounded positions
                        hasData && yTicks.map((v, i) => {
                            const py = yP(v);
                            if (py < -4 || py > CH + 4) return null;
                            return React.createElement('text', {
                                key: 'y_lbl_' + i,
                                x: 6, y: py + 3,
                                fill: C.zinc600, fontSize: 9, fontFamily: sys,
                                fontWeight: '600', textAnchor: 'start',
                            }, fmtChartVal(v));
                        }),
                        // Zero-baseline dashed line (for TWR mode — at y=100 / 0% return)
                        mode === 'twr' && React.createElement('line', {
                            x1: 0, x2: W,
                            y1: yP(100), y2: yP(100),
                            stroke: C.zinc700, strokeWidth: 1, strokeDasharray: '4 3',
                        }),
                        // Area fill
                        areaPath && React.createElement('path', {
                            d: areaPath, fill: `url(#${gradId})`, stroke: 'none',
                        }),
                        // The portfolio, dashed grey, under the holdings
                        portPath && React.createElement('path', {
                            d: portPath, fill: 'none', stroke: C.zinc600, strokeWidth: 1.4,
                            strokeDasharray: '5 3', strokeOpacity: 0.85, strokeLinejoin: 'round',
                        }),
                        // The other drawn holdings, under the first one
                        extraLines.map(l => l.path && React.createElement('path', {
                            key: 'hl_' + l.tk, d: l.path, fill: 'none',
                            stroke: l.col, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
                        })),
                        // Line stroke
                        linePath && React.createElement('path', {
                            d: linePath, fill: 'none',
                            stroke: firstCol, strokeWidth: 1.8,
                            strokeLinecap: 'round', strokeLinejoin: 'round',
                        }),
                        // S&P 500 benchmark comparison (dashed blue, TWR only)
                        benchLinePath && React.createElement('path', {
                            d: benchLinePath, fill: 'none',
                            stroke: C.blue, strokeWidth: 1.5,
                            strokeDasharray: '3 3', opacity: 0.75,
                        }),
                        // X axis: tick marks + labels at calendar positions
                        xTicks.map((tk, ti) => React.createElement('g', { key: 'xt' + ti },
                            React.createElement('line', { x1: tk.x, x2: tk.x, y1: CH, y2: CH + 3, stroke: C.zinc700, strokeWidth: 1 }),
                            React.createElement('text', {
                                x: tk.x, y: CH + 16,
                                textAnchor: tk.x < 18 ? 'start' : tk.x > W - 18 ? 'end' : 'middle',
                                fill: C.zinc600, fontSize: 9, fontFamily: sys, fontWeight: '500',
                            }, tk.label)
                        )),
                        // "vs last press": shade the compared range and mark the day it starts from
                        tableContrib && segActive && React.createElement('rect', {
                            x: xP(loIdx), y: 0, width: Math.max(1, xP(hiIdx) - xP(loIdx)), height: CH,
                            fill: lineCol, fillOpacity: 0.10,
                        }),
                        tableContrib && segActive && data[_cmpIdx] && lineV(_cmpIdx) != null && React.createElement('g', null,
                            React.createElement('line', {
                                x1: xP(_cmpIdx), x2: xP(_cmpIdx), y1: 0, y2: CH,
                                stroke: lineCol, strokeOpacity: 0.55, strokeWidth: 1, strokeDasharray: '3 3',
                            }),
                            React.createElement('circle', {
                                cx: xP(_cmpIdx), cy: yP(lineV(_cmpIdx)), r: 3.5,
                                fill: firstCol, stroke: C.bg, strokeWidth: 2,
                            })
                        ),
                        // Pinned day marker: shows which day the table below describes once the finger is lifted
                        scrubIdx == null && tableContrib && pinIdx >= 1 && lineV(pinIdx) != null && React.createElement('g', null,
                            React.createElement('line', {
                                x1: xP(pinIdx), x2: xP(pinIdx), y1: 0, y2: CH,
                                stroke: lineCol, strokeOpacity: 0.55, strokeWidth: 1, strokeDasharray: '3 3',
                            }),
                            React.createElement('circle', {
                                cx: xP(pinIdx), cy: yP(lineV(pinIdx)), r: 3.5,
                                fill: firstCol, stroke: C.bg, strokeWidth: 2,
                            }),
                            extraLines.map(l => l.vals[pinIdx] != null && React.createElement('circle', {
                                key: 'pd_' + l.tk, cx: xP(pinIdx), cy: yP(l.vals[pinIdx]), r: 3.5,
                                fill: l.col, stroke: C.bg, strokeWidth: 2,
                            }))
                        ),
                        // Scrub crosshair + bubble
                        scrubX != null && scrubY != null && React.createElement('g', null,
                            // Vertical hairline
                            React.createElement('line', {
                                x1: scrubX, x2: scrubX, y1: 0, y2: CH,
                                stroke: C.zinc500, strokeWidth: 1, strokeDasharray: '3 3',
                            }),
                            // Dot on line
                            React.createElement('circle', {
                                cx: scrubX, cy: scrubY, r: 4,
                                fill: firstCol, stroke: C.bg, strokeWidth: 2,
                            }),
                            extraLines.map(l => l.vals[bubbleIdx] != null && React.createElement('circle', {
                                key: 'sd_' + l.tk, cx: scrubX, cy: yP(l.vals[bubbleIdx]), r: 4,
                                fill: l.col, stroke: C.bg, strokeWidth: 2,
                            })),
                            // Value tooltip bubble — shows portfolio + SPX in TWR mode
                            (() => {
                                // SPX aligned point for this scrub index (TWR only)
                                const _scrubSpx  = mode === 'twr' && bubbleIdx != null && alignedSpx
                                    ? alignedSpx[bubbleIdx] : null;
                                const _spxBench  = _scrubSpx && Number.isFinite(_scrubSpx.benchmark)
                                    ? _scrubSpx.benchmark : null;
                                const _spxNative = _scrubSpx && Number.isFinite(_scrubSpx.spxNative)
                                    && _scrubSpx.spxNative > 0 ? _scrubSpx.spxNative : null;
                                const _showSpx   = mode === 'twr' && _spxBench != null && _spxNative != null;
                                const _isStale   = _showSpx && _scrubSpx.isStale && _scrubSpx.spxSourceDate;

                                // Local helpers
                                const _fmtPct = function(indexVal) {
                                    if (indexVal == null || !Number.isFinite(indexVal)) return '—';
                                    const d = Math.round((indexVal - 100) * 100) / 100;
                                    return (d >= 0 ? '+' : '') + (d === 0 ? 0 : d).toFixed(2) + '%';
                                };
                                const _fmtIdx = function(v) {
                                    if (!v || !Number.isFinite(v) || v <= 0) return '—';
                                    return Math.round(v).toLocaleString('en-US');
                                };

                                // % mode: the line is cumulative from the window start, so the date line says "start -> pressed day".
                                const _segOn = bubbleIdx != null && segActive && !!tableContrib;
                                const _dateStr  = scrubPt
                                    ? ((mode === 'twr' && (bubbleIdx >= 1 || _segOn) && data[0])
                                        ? fmtRangeDate(data[_segOn ? loIdx : 0].date) + ' \u2192 ' + fmtRangeDate(_segOn ? data[hiIdx].date : scrubPt.date)
                                        : fmtTooltipDate(scrubPt.date))
                                    : '';
                                const _portIdx = (_segOn && segDelta != null) ? 100 * (1 + segDelta) : scrubV;
                                // One row per drawn line: the portfolio, or each holding in its own colour.
                                const _rows = [{ lbl: showHold ? shortTk(holdLines[0].tk) : 'Port', col: firstCol, v: _portIdx }]
                                    .concat(extraLines.map(l => {
                                        const sd = _segOn ? segOf(l.vals) : null;
                                        return { lbl: shortTk(l.tk), col: l.col, v: _segOn ? (sd != null ? 100 * (1 + sd) : null) : l.vals[bubbleIdx] };
                                    }))
                                    .concat(showHold ? [{ lbl: 'Port', col: C.zinc600,
                                        v: (_segOn && tableContrib) ? 100 * (1 + tableContrib.total) : scrubPt[yKey] }] : []);
                                const _lblW = Math.max(...(_rows.map(r => r.lbl.length).concat([4])));
                                const _spxIdxShown = (_segOn && spxRange != null) ? 100 * (1 + spxRange) : _spxBench;
                                const _staleStr = _isStale
                                    ? 'as of ' + new Date(_scrubSpx.spxSourceDate + 'T00:00:00Z')
                                        .toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
                                    : null;

                                const bPad = 7;
                                const bW   = _showSpx ? 160 : (mode === 'twr' ? 112 : 94);
                                const _xRows = (_rows.length - 1) * 14;
                                const bH   = _showSpx ? (_staleStr ? 64 : 52) + _xRows : 34;
                                let bx = scrubX + 8;
                                if (bx + bW > W) bx = scrubX - bW - 8;
                                bx = Math.max(0, bx);
                                const by = Math.max(0, scrubY - bH - 4);

                                if (_showSpx) {
                                    // TWR + SPX layout: date / Port % / SPX % · level / [stale]
                                    return React.createElement('g', null,
                                        React.createElement('rect', {
                                            x: bx, y: by, width: bW, height: bH,
                                            rx: 7, fill: 'rgba(13,18,24,0.86)',
                                            stroke: C.blue + '50', strokeWidth: 1,
                                        }),
                                        React.createElement('text', {
                                            x: bx + bPad, y: by + 11,
                                            fill: C.zinc500, fontSize: 9, fontFamily: sys,
                                            fontWeight: '500', dominantBaseline: 'middle',
                                        }, _dateStr),
                                        _rows.map((r, k) => React.createElement('text', {
                                            key: 'r' + k, x: bx + bPad, y: by + 25 + k * 14,
                                            fill: r.col, fontSize: 10, fontFamily: mono,
                                            fontWeight: '700', dominantBaseline: 'middle', style: { whiteSpace: 'pre' },
                                        }, r.lbl.padEnd(_lblW) + '  ' + _fmtPct(r.v))),
                                        React.createElement('text', {
                                            x: bx + bPad, y: by + 39 + _xRows,
                                            fill: C.blue, fontSize: 10, fontFamily: mono,
                                            fontWeight: '600', dominantBaseline: 'middle', opacity: 0.9,
                                        }, spxLabel() + ' \u00a3 ' + _fmtPct(_spxIdxShown) + '  ·  ' + _fmtIdx(_spxNative)),
                                        _staleStr ? React.createElement('text', {
                                            x: bx + bPad, y: by + bH - 9,
                                            fill: C.zinc600, fontSize: 8, fontFamily: sys,
                                            fontWeight: '400', dominantBaseline: 'middle',
                                        }, _staleStr) : null
                                    );
                                }

                                // Original layout: value (top) + date (bottom)
                                const _valStr = fmtChartVal(scrubRaw != null && mode === 'value' ? scrubRaw : _portIdx);
                                return React.createElement('g', null,
                                    React.createElement('rect', {
                                        x: bx, y: by, width: bW, height: bH,
                                        rx: 7, fill: 'rgba(13,18,24,0.86)',
                                        stroke: lineCol + '40', strokeWidth: 1,
                                    }),
                                    React.createElement('text', {
                                        x: bx + bPad, y: by + 12,
                                        fill: lineCol, fontSize: 11, fontFamily: sys,
                                        fontWeight: '700', dominantBaseline: 'middle',
                                    }, _valStr),
                                    React.createElement('text', {
                                        x: bx + bPad, y: by + bH - 8,
                                        fill: C.zinc500, fontSize: 9, fontFamily: sys,
                                        fontWeight: '500', dominantBaseline: 'middle',
                                    }, _dateStr)
                                );
                            })()
                        )
                    )
                ),

            // Period return chip (top-right overlay). Left out while several holdings are drawn: one figure could not say
            // which line it belongs to (the table's Held return and the pop-out give each one's).
            hasData && extraLines.length === 0 && React.createElement('div', {
                style: {
                    position: 'absolute', top: 2, right: 0,
                    fontFamily: sys, fontSize: 13, fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
                    color: signColor(displayDeltaShown),
                    // No blur: in privacy mode fmtDelta already swaps the £ amount for ••••, and the % must stay readable.
                }
            }, fmtDelta(displayAbs, displayDeltaShown))
        ),
        // (The notes and money-weighted figures that used to sit here now live in Settings -> Performance Metrics.)
        // Row under the chart: Analyse on the left (opens the contributors table), S&P legend on the right.
        ((hasData && typeof contribFn === 'function' && !tableOpen) || (mode === 'twr' && benchLinePath)) && React.createElement('div', {
            style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 5 }
        },
            hasData && typeof contribFn === 'function' && !tableOpen && React.createElement('button', {
                onClick: openTable,
                style: {
                    fontFamily: mono, fontSize: 10, fontWeight: 600, lineHeight: '12px', flexShrink: 0,
                    padding: '4px 10px', borderRadius: 5, border: `1px solid ${C.border}`,
                    background: 'transparent', color: C.zinc600, cursor: 'pointer',
                }
            }, 'Analyse'),
            React.createElement('span', { style: { flex: 1 } }),
            // While holdings are drawn the portfolio is the dashed grey line, so it gets a key of its own beside the S&P's.
            portPath && React.createElement('svg', { width: 20, height: 6, style: { display: 'block', flexShrink: 0 } },
                React.createElement('line', { x1: '0', y1: '3', x2: '20', y2: '3',
                    stroke: C.zinc600, strokeWidth: '1.4', strokeDasharray: '5 3', strokeOpacity: '0.85' })
            ),
            portPath && React.createElement('span', {
                style: { fontFamily: sys, fontSize: 9, color: C.zinc600, letterSpacing: '0.04em', marginRight: 8, whiteSpace: 'nowrap' }
            }, 'Portfolio'),
            mode === 'twr' && benchLinePath && React.createElement('svg', { width: 20, height: 6, style: { display: 'block' } },
                React.createElement('line', { x1: '0', y1: '3', x2: '20', y2: '3',
                    stroke: C.blue, strokeWidth: '1.5', strokeDasharray: '3 2', opacity: '0.75' })
            ),
            mode === 'twr' && benchLinePath && React.createElement('span', {
                style: { fontFamily: sys, fontSize: 9, color: C.blue, opacity: 0.75, letterSpacing: '0.04em' }
            }, (() => {
                // Base label
                const _spxBase = spxLatestPrice != null && Number.isFinite(spxLatestPrice)
                    ? spxLabel() + ' in \u00a3  (index ' + spxLatestPrice.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ')'
                    : spxLabel() + ' in \u00a3';
                // Staleness suffix — shown when the SPX price is from a prior session
                // (US market closed / pre-market). Format: "· as of 5 Jun"
                const _today = fmtDate(new Date());
                const _stale = spxSessionDate && spxSessionDate !== _today;
                if (_stale) {
                    const _d = new Date(spxSessionDate + 'T12:00:00Z');
                    const _label = _d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
                    return _spxBase + ' · as of ' + _label;
                }
                return _spxBase;
            })())
        ),
        contribTable
    );
});

// ── Debug-only chart integrity probe ──────────────────────────────────────────
// Call window.__debugChartIntegrity() in the browser console to inspect the
// current chart state. Returns null if no chart data is present.
// Does not affect normal UI or performance.
window.__debugChartIntegrity = (function() {
    var _snapshot = null;
    window.__debugChartIntegrity_setSnapshot = function(s) { _snapshot = s; };
    return function() { return _snapshot; };
})();

const InsightsPanel = React.memo(function InsightsPanel({ data, privacyMode, lastSpotRefreshAt, moversGlow, onOpenMarkets }) {
    if (!data) return null;
    const { contributors, bestMover, worstMover, hasLiveData, liveCount, giltCount } = data;

    // Insights shows % moves to 2 decimals (display only; same sign/blank rules as fmtP).
    const fmtP2 = (n) => n == null || isNaN(n) ? '\u2014' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;

    // Sub-section header
    function SectionLabel({ label, right }) {
        return React.createElement('div', { style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
        } },
            React.createElement('span', { style: {
                fontFamily: sys, fontSize: 10, fontWeight: 600,
                color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.1em',
            } }, label),
            right && React.createElement('span', { style: {
                fontFamily: sys, fontSize: 10, color: C.zinc700,
            } }, right)
        );
    }

    // Divider between sections
    const divider = React.createElement('div', { style: {
        height: 1, background: C.border, margin: '14px 0',
    } });

    // ── Section 2: Cash Drivers (ΔP × U) ────────────────────────────────
    const section2 = React.createElement('div', null,
        React.createElement(SectionLabel, {
            label: 'Cash Drivers  ΔP × U',
            // Time of the last successful spot refresh, with seconds (24-hour, London display).
            right: lastSpotRefreshAt ? 'As of ' + lastSpotRefreshAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null,
        }),
        !hasLiveData
            ? React.createElement('div', { style: {
                fontFamily: sys, fontSize: 12, fontStyle: 'italic',
                color: C.zinc700, padding: '8px 0',
              } }, 'Fetch live prices to see today\'s contributors')
            : contributors.length === 0
                ? React.createElement('div', { style: {
                    fontFamily: sys, fontSize: 12, color: C.zinc700,
                  } }, '\u2014')
                : React.createElement('div', null,
                    // Mini column-header row
                    React.createElement('div', {
                        style: {
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1.25fr) 0.75fr 0.9fr 0.7fr',
                            columnGap: 8,
                            paddingBottom: 5,
                            marginBottom: 2,
                            borderBottom: `1px solid ${C.border}`,
                        }
                    },
                        React.createElement('span', { style: { fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em' } }, 'Asset'),
                        React.createElement('span', { style: { fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Spot'),
                        React.createElement('span', { style: { fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Day \u00a3'),
                        React.createElement('span', { style: { fontFamily: sys, fontSize: 9, fontWeight: 600, color: C.zinc600, textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: 'right' } }, 'Day %')
                    ),
                    contributors.map((h, i) => {
                        // A gilt shows its clean price per \u00a3100 nominal (the market quote), like the holdings rows do.
                        const spot = h.valuationMethod === 'gilt_market_dirty' ? formatGiltSpot(h) : formatInsightSpotPrice(h);
                        const isPos = (h.todayAbsChange || 0) >= 0;
                        const tickerLabel = h.ticker && h.ticker !== 'UNTICKERED'
                            ? h.ticker
                            : (h.name || '').split(' ').slice(0, 2).join(' ');
                        return React.createElement('div', {
                            key: (h.ticker && h.ticker !== 'UNTICKERED')
                                ? h.ticker
                                : `${h.name || ''}-${h.account || ''}`,
                            style: {
                                display: 'grid',
                                gridTemplateColumns: 'minmax(0, 1.25fr) 0.75fr 0.9fr 0.7fr',
                                alignItems: 'center',
                                columnGap: 8,
                                padding: '6px 0',
                                borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
                            }
                        },
                            // Col 1 — Asset: direction icon + ticker
                            React.createElement('div', {
                                style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }
                            },
                                React.createElement('div', {
                                    style: {
                                        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                                        background: isPos ? C.emerald + '22' : C.rose + '22',
                                        border: `1px solid ${isPos ? C.emerald : C.rose}44`,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    }
                                },
                                    React.createElement('span', {
                                        style: { fontSize: 8, fontWeight: 700, color: isPos ? C.emerald : C.rose, lineHeight: 1 }
                                    }, isPos ? '\u25b2' : '\u25bc')
                                ),
                                React.createElement('span', {
                                    style: {
                                        fontFamily: mono, fontSize: 11, fontWeight: 700, color: C.amber,
                                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                    }
                                }, tickerLabel)
                            ),
                            // Col 2 — Spot: clean numeral + optional c/d superscript
                            React.createElement('div', {
                                style: {
                                    display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end',
                                    gap: 2, minWidth: 0,
                                    filter: privacyMode ? 'blur(5px)' : 'none',
                                }
                            },
                                React.createElement('span', {
                                    style: {
                                        fontFamily: mono, fontSize: 11, fontWeight: 600,
                                        color: spot ? C.zinc400 : C.zinc700,
                                        fontVariantNumeric: 'tabular-nums',
                                    }
                                }, spot ? spot.text : '\u2014'),
                                spot && spot.badge && React.createElement('sup', {
                                    style: { fontFamily: mono, fontSize: 7, color: spot.badge === '!' ? '#fbbf24' : C.zinc600, marginLeft: 1 }
                                }, spot.badge)
                            ),
                            // Col 3 — Day £
                            React.createElement('span', {
                                style: {
                                    fontFamily: sys, fontSize: 12, fontWeight: 700,
                                    textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                    letterSpacing: '-0.02em',
                                    color: isPos ? C.emerald : C.rose,
                                    filter: privacyMode ? 'blur(6px)' : 'none',
                                }
                            }, h.todayAbsChange != null ? fmtA(h.todayAbsChange) : '\u2014'),
                            // Col 4 — Day %
                            React.createElement('span', {
                                style: {
                                    fontFamily: sys, fontSize: 12, fontWeight: 600,
                                    textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                    color: isPos ? C.emerald : C.rose, opacity: 0.78,
                                }
                            }, h.todayPctChange != null ? fmtP2(h.todayPctChange) : '\u2014')
                        );
                    })
                  )
    );

    // Session Velocity tile — presentation only (selection, % and colour logic unchanged).
    // The ticker is shown as its bare stock code (exchange suffix dropped: "SMGB.L" -> "SMGB"),
    // never more than 4 characters, so it never needs an ellipsis.
    // Row geometry: the ticker yields before the percentage ever does; the % is
    // flex-shrink:0 so its right edge sits at the same x in both tiles. With 2-decimal %
    // the figure is wide, so sizes are derived from the tile's real content width
    // (50vw − 72px = half the screen minus page/panel/tile padding and the 8px gap) and
    // capped at the design size, so they hold on an iPhone 17 (402pt) and shrink on narrower
    // phones instead of truncating the ticker. Double-digit moves ("+13.42%") step down one
    // tier — decided from the LONGER of the two so both tiles always share size and height.
    const velocityPctLen = Math.max(
        bestMover  ? fmtP2(bestMover.todayPctChange).length  : 0,
        worstMover ? fmtP2(worstMover.todayPctChange).length : 0);
    const wide = velocityPctLen > 6;
    // The % uses the SAME size as the ticker (one size per tile pair), so the tiles stay short.
    const velocityTickerSize = wide ? 'min(14px, calc((50vw - 72px) / 9.2))' : 'min(15px, calc((50vw - 72px) / 8.4))';
    // Bare stock code for the tile: drop the exchange suffix (everything from the first "."), then cap at 4 characters.
    const velocityCode = mover => String(mover.ticker || mover.name || '').trim().split('.')[0].slice(0, 4);
    const moverTile = (label, mover) => {
        const col = signColor(mover.todayPctChange);
        const pctText = fmtP2(mover.todayPctChange);
        const pctSize = velocityTickerSize;
        return React.createElement('div', { key: 'mv_' + label, style: {
            flex: 1, minWidth: 0, background: col + '0f',
            border: `1px solid ${col}30`,
            borderRadius: 10, padding: '8px 12px',
        } },
            React.createElement('div', { style: {
                fontFamily: sys, fontSize: 10, lineHeight: '12px', fontWeight: 600,
                color: col, opacity: 0.7,
                textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
            } }, label),
            React.createElement('div', { style: {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            } },
                React.createElement('div', { style: {
                    fontFamily: mono, fontSize: velocityTickerSize, color: col,
                    minWidth: 0, overflow: 'hidden', textOverflow: 'clip', whiteSpace: 'nowrap',
                } }, velocityCode(mover),
                    // A restricted position keeps its (R), set smaller so the tile still fits.
                    mover.isRestrictedPosition && React.createElement('span', { style: { fontSize: '0.7em', marginLeft: 2 } }, '(R)')),
                React.createElement('div', { style: {
                    fontFamily: sys, fontSize: pctSize, lineHeight: 1.2, fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
                    color: col, flexShrink: 0, whiteSpace: 'nowrap',
                } }, pctText)
            )
        );
    };

    // ── Section 3: Session Velocity (best + worst mover by %) ───────────
    const section3 = React.createElement('div', null,
        React.createElement(SectionLabel, { label: 'Session Velocity' }),
        !hasLiveData
            ? React.createElement('div', { style: {
                fontFamily: sys, fontSize: 12, fontStyle: 'italic',
                color: C.zinc700, padding: '8px 0',
              } }, 'No live data')
            : React.createElement('div', { style: { display: 'flex', gap: 8 } },
                // Best / Worst tiles share ONE builder so their internal geometry is identical:
                // label on top, then a single hero row — ticker left, % right-aligned and
                // vertically centred. Colour still follows the actual move direction.
                bestMover  && moverTile('Best',  bestMover),
                worstMover && moverTile('Worst', worstMover),
                // Single mover (when best = only live holding)
                !worstMover && bestMover && React.createElement('div', { style: {
                    flex: 1, background: C.surfaceHigh,
                    border: `1px solid ${C.border}`,
                    borderRadius: 12, padding: '10px 12px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                } },
                    React.createElement('span', { style: {
                        fontFamily: sys, fontSize: 11, color: C.zinc700, fontStyle: 'italic',
                    } }, `${liveCount} position live`)
                )
            )
    );

    // ── Card container ───────────────────────────────────────────────────
    return React.createElement('div', {
        style: {
            background: `linear-gradient(160deg, ${C.surfaceHigh} 0%, ${C.surface} 100%)`,
            border: `1px solid ${C.border}`,
            borderRadius: 20, padding: '18px 18px 16px',
            marginBottom: 12,
        }
    },
        // Panel header
        React.createElement('div', { style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16,
        } },
            // The title opens the Markets screen (Fergus moved Markets here from the tab bar); the chevron marks it as a link.
            // It glows once Markets data is fresh and ready: green when the hero's Today is up, red when down (moversGlow, from PortfolioApp).
            React.createElement('button', { onClick: onOpenMarkets, className: moversGlow ? 'markets-live-glow ' + moversGlow : undefined, style: {
                display: 'flex', alignItems: 'center', gap: 3, background: 'none', border: 'none', padding: '6px 6px 6px 0', margin: '-6px 0',
                fontFamily: sys, fontSize: 10, fontWeight: 700,
                color: moversGlow === 'up' ? '#4ade80' : moversGlow === 'down' ? '#f87171' : C.zinc500, transition: 'color 600ms ease', textTransform: 'uppercase', letterSpacing: '0.18em', WebkitTapHighlightColor: 'transparent',
            } }, 'Market Movers', React.createElement(ChevronRight, { style: { width: 12, height: 12, flexShrink: 0 }, strokeWidth: 2.5 })),
            hasLiveData && React.createElement('div', { style: {
                display: 'flex', alignItems: 'center', gap: 5,
            } },
                React.createElement('div', { style: {
                    width: 5, height: 5, borderRadius: '50%', background: C.emerald,
                }, className: 'pulse-dot' }),
                React.createElement('span', { style: {
                    fontFamily: sys, fontSize: 10, color: C.zinc600,
                } }, 'Live')
            )
        ),
        // Section 0 (live quote grid) removed — spot prices now inline on HoldingRow cards.
        section2,
        divider,
        section3
    );
});
