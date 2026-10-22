// UI tokens, gilt ladder maths, banners and the employer-schemes widget.
// Loaded by index.html before app.js, in the order core, providers, sync, widgets, components; shares their globals (no module system, no build step).

// ─── Phase 0: UI design tokens ──────────────────────────────────────────────
// Single source of truth for every visual constant in the app.
// Later phases should add to this object rather than inventing new magic strings.
const UI = {
    // Surface colours — used in style={{}} where Tailwind can't reach
    colors: {
        surface: '#0d1218', // card background (card-dark gradient end)
        surfaceHigh: '#11161f', // elevated surface: sticky cols, hover states, card-dark gradient start
        border: 'rgba(255,255,255,0.06)',
        gridLine: '#1e2530', // recharts CartesianGrid stroke
        stickyBorder: '#27272a', // closed-table sticky column separator
    },
    // Typography scale — replaces arbitrary text-[10px]/[10px]/[11px] values
    // Always prefer these over bare Tailwind sizes so we can tune in one place.
    text: {
        micro: 'text-[10px]', // metadata, debug labels, sub-labels (was mix of 9px/10px)
        label: 'text-xs', // chip text, axis ticks, section sub-labels
        body: 'text-sm', // table rows, descriptions, card body copy
        stat: 'text-lg', // mobile stat card numbers
        hero: 'text-2xl', // desktop stat card numbers
    },
    // Card padding variants — replaces scattered px-4 py-3 / px-5 py-5 combos
    card: {
        sm: 'px-4 py-3', // compact: mobile chips, small stat rows
        md: 'px-5 py-4', // standard: most stat cards
        lg: 'px-5 py-5', // spacious: hero cards, onboarding
    },
    // Border radii — replaces rounded-xl/2xl/3xl scatter
    radius: {
        sm: 'rounded-xl', // chips, compact cards, table rows
        md: 'rounded-2xl', // standard cards, chart wrappers, upload zones
        lg: 'rounded-3xl', // modals, onboarding, bottom sheets
    },
    // Animation timings — matches the existing keyframes; centralised for consistency
    duration: {
        fast: '150ms', // button hover, chip toggle
        base: '220ms', // settings slide-in, upload fade
        slow: '320ms', // bottom sheet, ticker modal
    },
    spring: 'cubic-bezier(0.16, 1, 0.3, 1)',
    // Z-index layers — prevents future modal/overlay stacking conflicts
    z: {
        bottomNav: 40,
        sheet: 50,
        modal: 60,
        toast: 70,
    },
    // Touch target — applied to every interactive element (44×44 minimum per HIG)
    touch: 'min-h-[44px] min-w-[44px]',
};
// ─── Shared className helpers ────────────────────────────────────────────────
// Use these instead of repeating card-dark + radius + padding inline.
const CARD = `card-dark ${UI.radius.md} ${UI.card.md}`;

// ── Global display constants ──────────────────────────────────────────────────
// Defined outside PortfolioApp so HoldingRow and BottomSheet can reference them
// as stable module-level values rather than per-render closures — preventing
// the full unmount/remount cycle that caused sort-tab glitches.
const formatGBP = (n, opts = {}) => {
    var _a, _b;
    if (n == null || isNaN(n)) return '—';
    const sign = n < 0 ? '−' : '';
    return `${sign}£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: (_a = opts.dp) !== null && _a !== void 0 ? _a : 2, maximumFractionDigits: (_b = opts.dp) !== null && _b !== void 0 ? _b : 2 })}`;
};
const C = {
    bg: '#080c10', surface: '#0d1218', surfaceHigh: '#11161f',
    border: 'rgba(255,255,255,0.08)', borderMid: 'rgba(255,255,255,0.12)',
    amber: '#fbbf24', emerald: '#34d399', rose: '#f87171', blue: '#60a5fa', violet: '#a78bfa',
    zinc400: '#cbd5e1', // Raised to light grey/slate
    zinc500: '#a1a1aa', // Shifted up (Old zinc400 level)
    zinc600: '#9da5b4', // Elevated for WCAG AA sub-label contrast (~7:1 on surface)
    zinc700: '#888894', // Raised floor — was zinc600; minimum readable metadata (~5.9:1)
    white: '#ffffff', text: '#f4f4f7', spotPrice: '#f4f4f5',
};
const sys  = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif';
const mono = 'JetBrains Mono, monospace';
const serif = sys;
// SF Pro Rounded (built into iOS, no download). Used for the money figures and their Today / Total / Cash labels; falls back to the
// normal system font anywhere ui-rounded is not supported.
const rounded = 'ui-rounded, "SF Pro Rounded", ' + sys;
const fmtV = (n, dp=0) => formatGBP(n, {dp});
const fmtP = (n) => n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;
const fmtA = (n) => n == null || isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${formatGBP(n, {dp:0})}`;
const signColor = (n) => n == null || isNaN(n) ? C.zinc500 : n >= 0 ? C.emerald : C.rose;

// ── Gilt Ladder Engine ────────────────────────────────────────────────────────
// A gilt is valued ONLY from a verified market dirty price (giltsyield.com). There is no model estimate: the straight
// line from purchase price to par and the IGLS.L proxy overlay that stood in before a price source existed are gone.
// With no verified price a gilt is left unpriced and the holdings pipeline carries it like any other unpriced holding.
// Display-only — zero impact on masterPortfolio, TWR, or any ledger calculation.

const GILT_LADDER_REGISTRY = {
    'T26A': {
        name: 'Treasury 0.375% 22/10/2026', isin: 'GB00BNNGP668',
        purchaseCleanPrice: 100,
        purchaseDate: '2000-01-01', maturityDate: '2026-10-22',
        couponRate: 0.00375, couponMonths: [4, 10], couponDays: [22, 22],
        nominalQuantityFallback: 0,
    },
    'TN28': {
        name: 'Treasury 0.125% 31/01/2028', isin: 'GB00BMBL1G81',
        purchaseCleanPrice: 100,
        purchaseDate: '2000-01-01', maturityDate: '2028-01-31',
        couponRate: 0.00125, couponMonths: [1, 7], couponDays: [31, 31],
        nominalQuantityFallback: 0,
    },
    'TG29': {
        name: 'Treasury 0.500% 31/01/2029', isin: 'GB00BLPK7227',
        purchaseCleanPrice: 100,
        purchaseDate: '2000-01-01', maturityDate: '2029-01-31',
        couponRate: 0.00500, couponMonths: [1, 7], couponDays: [31, 31],
        nominalQuantityFallback: 0,
    },
    'TG30': {
        name: 'Treasury 0.375% 22/10/2030', isin: 'GB00BL68HH02',
        purchaseCleanPrice: 100,
        purchaseDate: '2000-01-01', maturityDate: '2030-10-22',
        couponRate: 0.00375, couponMonths: [4, 10], couponDays: [22, 22],
        nominalQuantityFallback: 0,
    },
};

// Normalise any date to YYYY-MM-DD — eliminates TZ drift in all calendar comparisons
function toISODate(d) {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    return String(d).slice(0, 10);
}
// Precise epoch-day difference (no float rounding drift)
function giltDaysBetween(aISO, bISO) {
    return Math.round((new Date(bISO).getTime() - new Date(aISO).getTime()) / 86400000);
}

// All coupon ISO dates for a given calendar year for one registry entry
function giltCouponDatesForYear(reg, year) {
    return reg.couponMonths.map((m, i) =>
        `${year}-${String(m).padStart(2,'0')}-${String(reg.couponDays[i]).padStart(2,'0')}`
    );
}
// Most recent coupon date on or before valuationISO (falls back to purchaseDate)
function giltPrevCouponDate(reg, valuationISO) {
    const yr  = parseInt(valuationISO.slice(0, 4));
    const candidates = [
        ...giltCouponDatesForYear(reg, yr - 1),
        ...giltCouponDatesForYear(reg, yr),
        ...giltCouponDatesForYear(reg, yr + 1),
    ].filter(d => d <= valuationISO).sort();
    return candidates.length > 0 ? candidates[candidates.length - 1] : toISODate(reg.purchaseDate);
}
// Next coupon date strictly after valuationISO (bounded by maturity)
function giltNextCouponDate(reg, valuationISO) {
    const yr      = parseInt(valuationISO.slice(0, 4));
    const matISO  = toISODate(reg.maturityDate);
    const candidates = [
        ...giltCouponDatesForYear(reg, yr),
        ...giltCouponDatesForYear(reg, yr + 1),
    ].filter(d => d > valuationISO && d <= matISO).sort();
    return candidates.length > 0 ? candidates[0] : matISO;
}

// ── Gilt redemption yield (gross and net of income tax) ──────────────────────────────────────────────────────────
// Income-tax rate applied to coupons for the NET yield. Gilt price gains are exempt from CGT, so only coupons are taxed and
// the pull-to-par gain is kept whole — which is why a low-coupon gilt's net yield sits only a little below its gross yield.
// Rates come from Pay (PayStore.marginal): the next pound of coupon at Fergus's marginal income-tax rate. Until Pay has a year
// with a base, 45% (additional rate) stands in.
const GILT_DEFAULT_TAX_RATE = 0.45;
function marginalRates() {
    try { return window.PayStore ? window.PayStore.marginal() : null; } catch (e) { return null; }
}
function giltTaxRate() { const m = marginalRates(); return m ? m.saving : GILT_DEFAULT_TAX_RATE; }
// Tax on a share vest: the same marginal rate with NI, whatever a plan's own estimated_vesting_tax_rate says; a plan's own
// figure (else 0) only stands in until Pay has figures.
function vestingTaxRate(plan) {
    const m = marginalRates();
    if (m) return m.pay;
    return typeof plan.estimated_vesting_tax_rate === 'number' ? plan.estimated_vesting_tax_rate : 0;
}

// Add n business days (negative n goes back). Weekends are skipped; UK bank holidays are not modelled.
function giltAddBusinessDays(iso, n) {
    const d = new Date(iso + 'T12:00:00Z'), step = n < 0 ? -1 : 1;
    for (let left = Math.abs(n); left > 0;) {
        d.setUTCDate(d.getUTCDate() + step);
        const w = d.getUTCDay();
        if (w !== 0 && w !== 6) left--;
    }
    return d.toISOString().slice(0, 10);
}

// Gross and net yield to maturity from a DIRTY price per £100, semi-annual compounding (the DMO convention).
// Settlement is T+1 after the price's trading session, which is how giltsyield.com quotes its dirty price. Cash flows are the
// remaining coupons plus 100 at maturity. Tax follows the accrued income scheme: it falls only on interest accruing after
// settlement, so the first coupon is taxed on its post-settlement share; a gilt bought ex-dividend (the last 7 business days
// before a coupon) misses that coupon but is taxed on the rebate it was credited. The redemption gain is untaxed.
// Returns { gross, net } as fractions (0.0412 = 4.12%), or null when it cannot be solved honestly.
function giltYieldFromDirty(reg, dirty, tradeISO, taxRate) {
    if (!reg || !Number.isFinite(dirty) || dirty <= 0 || !tradeISO) return null;
    const tax = Number.isFinite(taxRate) ? taxRate : giltTaxRate();
    const settle = giltAddBusinessDays(tradeISO, 1);
    const matISO = toISODate(reg.maturityDate);
    if (!(settle < matISO)) return null;
    const dates = [];
    for (let y = parseInt(settle.slice(0, 4), 10); y <= parseInt(matISO.slice(0, 4), 10); y++) {
        for (const d of giltCouponDatesForYear(reg, y)) if (d > settle && d <= matISO) dates.push(d);
    }
    dates.sort();
    if (!dates.length || dates[dates.length - 1] !== matISO) dates.push(matISO);
    const days = giltDaysBetween(giltPrevCouponDate(reg, settle), dates[0]);
    if (!(days >= 150 && days <= 200)) return null;                 // not a normal half-year period: do not guess
    const w = giltDaysBetween(settle, dates[0]) / days;             // share of the current coupon period still to run
    const c = 100 * reg.couponRate / 2;                             // coupon per period per £100
    const exDiv = settle >= giltAddBusinessDays(dates[0], -7);
    const gross = [], net = [];
    dates.forEach((d, k) => {
        const cash    = (k === 0 && exDiv) ? 0 : c;
        const taxable = k === 0 ? c * w : c;
        const redeem  = d === matISO ? 100 : 0;
        gross.push(cash + redeem);
        net.push(cash - tax * taxable + redeem);
    });
    const solve = flows => {
        const f = r => flows.reduce((a, cf, k) => a + cf / Math.pow(1 + r / 2, w + k), 0) - dirty;
        let lo = -0.5, hi = 1.0;
        if (!(f(lo) > 0 && f(hi) < 0)) return null;
        for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
        return (lo + hi) / 2;
    };
    const g = solve(gross), n = solve(net);
    return (g == null || n == null) ? null : { gross: g, net: n };
}

/**
 * Gilt rung valuation at a specific date, from a verified MARKET dirty price only (per £100 nominal).
 *   - verified price, rung not matured → dirty value = nominal x price / 100; the clean value is what is left after the
 *     contractual accrued interest (Act/Act, semi-annual coupons from the registry).
 *   - matured rung → worth its nominal (the redemption) until the broker's redemption row is in the ledger.
 *   - anything else → null: the gilt is UNPRICED. Nothing is estimated.
 * Safe to call for both "today" and "yesterday" — no cross-day parameter leakage.
 */
function computeGiltRungAt(reg, nominal, valuationISO, ledgerHasRedemption, marketDirtyPer100) {
    const purchaseISO    = toISODate(reg.purchaseDate);
    const maturityISO    = toISODate(reg.maturityDate);
    const daysToMaturity = giltDaysBetween(valuationISO, maturityISO);
    const matured        = daysToMaturity <= 0;
    if (!matured && !Number.isFinite(marketDirtyPer100)) return null;

    // ── Accrued interest (Act/Act, semi-annual coupons) ───────────────────────
    // Interest accrues every calendar day; the coupon date resets accrued to 0 and books the cash so the dirty value is continuous.
    const couponPerPeriod = nominal * (reg.couponRate / 2);
    const prevCouponISO   = giltPrevCouponDate(reg, valuationISO);
    const nextCouponISO   = giltNextCouponDate(reg, valuationISO);
    const isCouponDay     = prevCouponISO === valuationISO && valuationISO > purchaseISO;

    let accruedInterest = 0;
    let couponCashToday = 0;
    if (isCouponDay) {
        accruedInterest = 0;
        couponCashToday = couponPerPeriod;
    } else if (prevCouponISO && nextCouponISO) {
        const daysSinceLast = Math.max(0, giltDaysBetween(prevCouponISO, valuationISO));
        const daysInPeriod  = Math.max(1, giltDaysBetween(prevCouponISO, nextCouponISO));
        accruedInterest = couponPerPeriod * daysSinceLast / daysInPeriod;
    }

    let cleanValue          = 0;
    let cleanPrice          = null;
    let redemptionCashToday = 0;
    let maturedCashValue    = 0;
    let priceSource         = 'market';
    if (matured) {
        // Redemption is contractual (par), not an estimate. Event-flow only on the exact date; the bridge value
        // holds until the broker's redemption row appears in the ledger.
        accruedInterest     = 0;
        redemptionCashToday = (valuationISO === maturityISO) ? nominal : 0;
        maturedCashValue    = (typeof ledgerHasRedemption === 'function' && ledgerHasRedemption(reg, valuationISO))
            ? 0
            : nominal;
        priceSource         = 'matured';
    } else {
        cleanValue = nominal * marketDirtyPer100 / 100 - accruedInterest;
        cleanPrice = (cleanValue / nominal) * 100;
    }

    return {
        cleanPrice, cleanValue,
        accruedInterest, dirtyValue: cleanValue + accruedInterest,
        couponCashToday, redemptionCashToday,
        cashEventToday: couponCashToday + redemptionCashToday,
        maturedCashValue,
        isCouponDay, daysToMaturity, nominal, priceSource,
    };
}

/**
 * The gilt ladder: one rung per gilt still held, valued from a verified market price (or the matured-redemption bridge).
 * A held gilt with no usable price lands in `unpriced` with the reason — it is never estimated.
 * A market price is used only when it is fresh (gyMarketFor), the right gilt (gyCheckAgainstRegistry: maturity, coupon and
 * ISIN agree with the ledger) and the rung has not matured. The daily change is measured against the previous session's FINAL
 * stored price only; with none stored it is unavailable (null) rather than invented.
 */
function buildGiltLadderState(enriched, today, giltMarket, nowMs) {
    const todayISO     = toISODate(today);
    const yesterdayISO = toISODate(new Date(today.getTime() - 86400000));

    // Ledger-derived nominal quantities: net buys minus sells per gilt ticker. Nominal comes from the live
    // ledger; the registry fallback applies only when no buy/sell rows exist for a ticker.
    const ledgerNominal = {};
    const ledgerHasRows = {};   // a gilt with ledger rows that nets to zero is SOLD, not "no rows"
    for (const ticker of Object.keys(GILT_LADDER_REGISTRY)) {
        let net = 0;
        for (const t of enriched) {
            if (t.instrument?.ticker !== ticker) continue;
            const qty = parseFloat((t.quantity || '').replace(/,/g, '')) || 0;
            if (t.category === 'buy' || t.category === 'transfer_in' || t.category === 'sell' || t.category === 'transfer_out') ledgerHasRows[ticker] = true;
            if (t.category === 'buy'   || t.category === 'transfer_in')  net += qty;
            if (t.category === 'sell'  || t.category === 'transfer_out') net -= qty;
        }
        ledgerNominal[ticker] = Math.max(0, net);
    }

    // Is there an actual broker redemption row in the ledger?
    function ledgerHasRedemption(reg, _valuationISO) {
        const ticker = Object.keys(GILT_LADDER_REGISTRY).find(k => GILT_LADDER_REGISTRY[k] === reg);
        if (!ticker) return false;
        const matISO = toISODate(reg.maturityDate);
        return enriched.some(t =>
            t.instrument?.ticker === ticker
            && (t.category === 'sell' || t.category === 'transfer_out')
            && toISODate(t.parsedDate) >= matISO
        );
    }

    const rungs = [];
    const unpriced = [];
    for (const [ticker, reg] of Object.entries(GILT_LADDER_REGISTRY)) {
        const nominal = ledgerNominal[ticker] > 0
            ? ledgerNominal[ticker]
            : (ledgerHasRows[ticker] ? 0 : reg.nominalQuantityFallback);
        if (nominal <= 0) continue;

        const daysToMaturity = giltDaysBetween(todayISO, toISODate(reg.maturityDate));
        let mk = gyMarketFor(giltMarket, ticker, nowMs);
        let marketIssue = null;
        if (mk && daysToMaturity > 0) {
            const idIssue = gyCheckAgainstRegistry(mk, reg);
            if (idIssue) { marketIssue = idIssue; mk = null; }
        } else mk = null;

        const todayResult = computeGiltRungAt(reg, nominal, todayISO, ledgerHasRedemption, mk ? mk.dirty : null);
        if (!todayResult) { unpriced.push({ ticker, name: reg.name, nominal, daysToMaturity, marketIssue }); continue; }

        // Yesterday — completely independent pass (no parameter leakage). Market: the previous session's FINAL stored
        // price, or none. Matured: the redemption bridge (unknown the very day it matures, when yesterday was still priced).
        let yestResult = null;
        if (mk) {
            if (mk.prevCloseDirty != null) yestResult = computeGiltRungAt(reg, nominal, yesterdayISO, ledgerHasRedemption, mk.prevCloseDirty);
        } else {
            yestResult = computeGiltRungAt(reg, nominal, yesterdayISO, ledgerHasRedemption, null);
        }

        // Daily PnL = dirty value + cash events today − yesterday's dirty value+cash bridge
        const rungTotalToday = todayResult.dirtyValue + todayResult.maturedCashValue;
        const rungTotalYest  = yestResult ? (yestResult.dirtyValue + yestResult.maturedCashValue) : null;
        const rungPnL        = rungTotalYest == null ? null : rungTotalToday + todayResult.cashEventToday - rungTotalYest;
        // Yield to maturity from the verified market dirty price only.
        const ytm = (mk && todayResult.daysToMaturity > 0) ? giltYieldFromDirty(reg, mk.dirty, mk.session) : null;

        rungs.push({
            ticker, name: reg.name, nominal,
            cleanPrice:        todayResult.cleanPrice,
            cleanValue:        todayResult.cleanValue,
            accruedInterest:   todayResult.accruedInterest,
            // dirtyValue is the DIRTY part only; the matured-redemption bridge is carried separately in maturedCashValue
            // (the holding's value is dirtyValue + maturedCashValue — adding it here too would count it twice).
            dirtyValue:        todayResult.dirtyValue,
            maturedCashValue:  todayResult.maturedCashValue,
            couponCashToday:   todayResult.couponCashToday,
            cashEventToday:    todayResult.cashEventToday,
            dailyPnL:          rungPnL,
            isCouponDay:       todayResult.isCouponDay,
            daysToMaturity:    todayResult.daysToMaturity,
            priceSource:       todayResult.priceSource,
            marketDirty:       mk ? mk.dirty : null,
            marketAsOf:        mk ? mk.t : null,
            marketPrevClose:   mk ? mk.prevCloseDirty : null,
            marketSession:     mk ? mk.session : null,
            marketFinal:       mk ? !!mk.final : null,
            ytmGross:          ytm ? ytm.gross : null,
            ytmNet:            ytm ? ytm.net : null,
        });
    }
    if (rungs.length === 0 && unpriced.length === 0) return null;
    return { rungs, unpriced };
}

// ── Stage 1.4: Corporate Equity Overlay Components ────────────────────────────
// Defined at global scope (alongside HeroCard, AccountCard) so they are stable
// references that never remount on PortfolioApp re-render.

// FeedBanner — the price-feed strip (see feedBanner): amber, or red after a day without prices. Top of Investments.
function FeedBanner({ strip, kind = 'feed' }) {
    if (!strip) return null;
    const red = strip.level === 'red', col = red ? C.rose : C.amber;
    return React.createElement('div', {
        role: 'status', ['data-' + kind + '-banner']: strip.level,
        style: {
            display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12, borderRadius: 12, padding: '12px 14px',
            background: red ? 'rgba(239,68,68,0.08)' : 'rgba(251,191,36,0.08)',
            border: '1px solid ' + (red ? 'rgba(239,68,68,0.20)' : 'rgba(251,191,36,0.22)'),
        }
    },
        React.createElement(AlertCircle, { style: { width: 16, height: 16, color: col, flexShrink: 0, marginTop: 1 }, strokeWidth: 1.75 }),
        React.createElement('div', { style: { fontFamily: sys, fontSize: 12, lineHeight: 1.5, color: col } }, strip.text));
}

// ActionAlertBanner — crimson warning strip for overdue vesting confirmations.
// Returns null when currentActiveAlerts is empty so it takes no space.
function ActionAlertBanner({ currentCompState }) {
    const alerts = (currentCompState && currentCompState.currentActiveAlerts) || [];
    if (alerts.length === 0) return null;
    return React.createElement('div', {
        style: {
            display: 'flex', alignItems: 'flex-start', gap: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.20)',
            borderRadius: 12, padding: '12px 14px', marginBottom: 12,
        }
    },
        React.createElement(AlertCircle, {
            style: { width: 16, height: 16, color: C.rose, flexShrink: 0, marginTop: 1 },
            strokeWidth: 1.75,
        }),
        React.createElement('div', null,
            React.createElement('div', {
                style: { fontFamily: sys, fontSize: 12, fontWeight: 600, color: C.rose, marginBottom: 3 }
            }, 'Action Required'),
            React.createElement('div', {
                style: { fontFamily: sys, fontSize: 11, color: '#fca5a5', lineHeight: 1.55 }
            },
                `Vesting confirmation overdue for: ${alerts.join(', ')}. Please update your tracking data rules file.`
            )
        )
    );
}

// ── finiteOrNull / sanitizeMarketOverviewRows ─────────────────────────────────
// Module-scope helpers used by JSON export/import for Market Overview rows.
// Must not be defined inside PortfolioApp to avoid TDZ issues with export hooks.
// null / undefined / '' / booleans are "no value", NOT zero: Number(null) is 0, which
// used to turn a blank 1M/YTD/12M into "+0.0" after a reload.
function finiteOrNull(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sanitizeMarketOverviewRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function(row) {
        if (!row || typeof row !== 'object' || !row.id) return null;
        return {
            id:                  String(row.id || ''),
            label:               String(row.label || ''),
            type:                String(row.type  || ''),
            section:             String(row.section     || ''),
            displayKind:         String(row.displayKind || 'pctReturn'),
            liveSymbol:          String(row.liveSymbol  || ''),
            returnSymbol:        String(row.returnSymbol || ''),
            nowDecimals:         row.nowDecimals != null ? Number(row.nowDecimals) : null,
            riskColorMode:       row.riskColorMode || null,
            excludeFromTopMovers: !!row.excludeFromTopMovers,
            dataQuality:         row.dataQuality  || null,
            now:                 finiteOrNull(row.now),
            day:                 finiteOrNull(row.day),
            daySource:           row.daySource || null,
            previousClose:       finiteOrNull(row.previousClose),
            previousCloseSource: row.previousCloseSource || null,
            previousCloseDate:   row.previousCloseDate || null,
            dayCheckStatus:      row.dayCheckStatus    || null,
            dayCheckReason:      row.dayCheckReason    || null,
            dayCheckExpected:    row.dayCheckExpected  || null,
            dayCheckYahoo:       finiteOrNull(row.dayCheckYahoo),
            dayCheckAlt:         finiteOrNull(row.dayCheckAlt),
            dayCheckCalendarCovered: row.dayCheckCalendarCovered != null ? !!row.dayCheckCalendarCovered : null,
            dayCheckProvider:    row.dayCheckProvider  || null,
            dayCheckError:       row.dayCheckError     || null,
            dayCheckPending:     !!row.dayCheckPending,
            quoteSessionDate:    row.quoteSessionDate  || null,
            marketState:         row.marketState        || null,
            quoteAgeMs:          finiteOrNull(row.quoteAgeMs),
            quoteStatusLabel:    row.quoteStatusLabel   || null,
            quoteStatusKind:     row.quoteStatusKind    || null,
            quoteStatusCompact:  row.quoteStatusCompact || null,
            feedLabel:           row.feedLabel          || null,
            m1:                  finiteOrNull(row.m1),
            ytd:                 finiteOrNull(row.ytd),
            y1:                  finiteOrNull(row.y1),
            returnAsOfDate:      row.returnAsOfDate     || null,
            returnLatestClose:   finiteOrNull(row.returnLatestClose),
            m1AnchorDate:        row.m1AnchorDate  || null,
            m1AnchorClose:       finiteOrNull(row.m1AnchorClose),
            ytdAnchorDate:       row.ytdAnchorDate || null,
            ytdAnchorClose:      finiteOrNull(row.ytdAnchorClose),
            y1AnchorDate:        row.y1AnchorDate  || null,
            y1AnchorClose:       finiteOrNull(row.y1AnchorClose),
            periodCurrentSource: row.periodCurrentSource || null,
            periodCurrentDate:   row.periodCurrentDate   || null,
            periodCurrentClose:  finiteOrNull(row.periodCurrentClose),
            periodDataQuality:   row.periodDataQuality   || null,
            periodSource:        row.periodSource || row.returnSymbol || null,
            historyFromCache:    !!row.historyFromCache,
            historyStale:        !!row.historyStale,
            historyCacheAgeMs:   finiteOrNull(row.historyCacheAgeMs),
            source:              row.source || row.liveSymbol || null,
            liveError:           row.liveError    || null,
            historyError:        row.historyError  || null,
            error:               row.error         || null,
            primarySource:        row.primarySource        || null,
            primaryNote:          row.primaryNote          || null,
            fetchedLiveSymbol:    row.fetchedLiveSymbol    || null,
            fetchedHistorySymbol: row.fetchedHistorySymbol || null,
            dayWitnessNote:       row.dayWitnessNote       || null,
            dayWitnessFrom:       row.dayWitnessFrom       || null,
            historyNote:          row.historyNote          || null,
            historySeriesCount:   finiteOrNull(row.historySeriesCount),
            historyFirstDate:     row.historyFirstDate     || null,
            periodNullReasons:    (row.periodNullReasons && typeof row.periodNullReasons === 'object') ? {
                m1: row.periodNullReasons.m1 || null, ytd: row.periodNullReasons.ytd || null, y1: row.periodNullReasons.y1 || null } : null,
        };
    }).filter(Boolean);
}

function validateMarketOverviewSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.rows)) return null;
    return {
        schemaVersion: Number(raw.schemaVersion) || 1,
        updatedAt:     finiteOrNull(raw.updatedAt),
        status:        String(raw.status || 'partial'),
        error:         raw.error || null,
        rows:          sanitizeMarketOverviewRows(raw.rows),
    };
}

// ── resolveRestrictedDailyPricePair ────────────────────────────────────────────
// Price pair (live, previous close) for restricted-scheme daily P&L, in native
// units and GBP. Uses the same rules as every other 1D figure:
//   live      — livePrices (already passed the live-quote gate at commit)
//   previous  — resolveVerifiedDailyPrevClose on liveDailyCloses
// USD lines convert the previous close at the previous session's GBP/USD.
// No other fallbacks: if there is no live quote, or the previous session's close
// is missing / disputed / implausible, returns { ok:false, reason } and the plan
// is left unpriced for Today ("—"), never paired with an older session.
// Never zero-fills. Does not affect portfolio valuation (display-only).
function resolveRestrictedDailyPricePair({ ticker, currency, dollarRate, livePrices, liveDailyCloses, todayStr }) {
    const KNOWN_CCY = { 'C': 'USD', 'HSBA.L': 'GBX' };
    const normTk = String(ticker || '').toUpperCase().trim();
    const notOk = (reason, prevSessionDate) => ({
        ok: false, liveRaw: null, prevRaw: null, liveGBP: null, prevGBP: null,
        quoteSessionDate: todayStr || null, prevSessionDate: prevSessionDate || null,
        source: 'verified-daily', reason,
    });
    if (!normTk) return notOk('no-ticker');
    const dRate = dollarRate ;
    const ccy   = normaliseQuoteCurrency(currency) || KNOWN_CCY[normTk] || 'GBX';

    let livePxRaw = null;
    if (livePrices) {
        if (livePrices[normTk] != null) livePxRaw = livePrices[normTk];
        else {
            const k = Object.keys(livePrices).find(kk => String(kk).toUpperCase().trim() === normTk);
            if (k) livePxRaw = livePrices[k];
        }
    }
    const lN = Number(livePxRaw);
    if (livePxRaw == null || !Number.isFinite(lN) || lN <= 0) return notOk('no-live-price');

    const refDate = todayStr || getCurrentPnlSessionDateStr();
    const vr = resolveVerifiedDailyPrevClose({
        ticker: normTk, sessionDate: refDate, livePx: lN, dailyCloses: liveDailyCloses || {},
    });
    if (!vr.ok) return notOk(vr.reason, vr.expectedDate);

    const pN   = Number(vr.value);
    // USD lines: previous close at the previous session's GBP/USD, so the GBP move
    // includes the FX move. Falls back to the current rate (FX move omitted) only
    // when no GBP/USD close is available; fxPrevSource records which was used.
    const isUsd  = normaliseQuoteCurrency(ccy) === 'USD';
    const fxPrev = isUsd ? fxCloseOnOrBefore(liveDailyCloses, 'GBPUSD=X', vr.date, 5) : null;
    const lGBP = pxToGBPWithCurrency(lN, ccy, dRate);
    const pGBP = pxToGBPWithCurrency(pN, ccy, fxPrev ? fxPrev.rate : dRate);
    if (!lGBP || !pGBP || pGBP <= 0) return notOk('currency-conversion-failed', vr.date);
    const source = 'live+verified-prev(' + vr.status + ')';
    return { ok: true, liveRaw: lN, prevRaw: pN, liveGBP: lGBP, prevGBP: pGBP,
             quoteSessionDate: todayStr || null, prevSessionDate: vr.date || null,
             fxLive: isUsd ? dRate : null, fxPrev: fxPrev ? fxPrev.rate : null,
             fxPrevSource: !isUsd ? null : (fxPrev ? 'GBPUSD=X close ' + fxPrev.date : 'current-rate-fallback'),
             source, reason: source };
}

// ── restrictedDailyPass — pass 1 of computeRestrictedDisplayRows ─────────────
// Today's move per restricted plan, accumulated three ways: by institution (RSU/SIP group rows), by option plan
// (Sharesave rows), and by underlying share (byUnderlying: the HSBC (R) / Citi (R) positions). Same rules as the
// RestrictedSchemesWidget hero (see its PARITY CONTRACT); the option moves here are raw (no £0.50 display floor).
function restrictedDailyPass({ plans, livePrices, tickerCurrencyMap, dollarRate, liveAt, liveDailyCloses,
                               liveQuoteSessionDates, latestSession }) {
    const KNOWN_RESTRICTED_CCY = { 'C': 'USD', 'HSBA.L': 'GBX' };
    function rTicker(plan) {
        return (plan.yahooTicker || plan.yahoo_ticker || plan.ticker ||
                plan.instrumentTicker || plan.underlyingTicker || '')
            .toString().toUpperCase().trim();
    }
    // Session dates — same fallback chain as the hero (global eff || candidate).
    const _candidate = getCurrentPnlSessionDateStr();
    const _globalEff = getEffectivePnlSessionDateStr(liveAt, _candidate);
    const todayStr   = _globalEff || _candidate;

    // Daily-delta accumulation — mirror of the hero's plan loop.
    const instDailyPnL    = {};   // institution → daily P&L
    const instPricedPrev  = {};   // institution → prev-day value (denominator)
    const instPricedCount = {};   // institution → priced-plan count
    const optPlanDailyPnL = {};   // option planKey → daily P&L
    const optPlanPrevVal  = {};   // option planKey → prev intrinsic value
    const optPlanPrevTotal = {};  // option planKey → prev TOTAL value (cash + bonus + intrinsic): the % base
    const byUnderlying    = {};   // ticker → { abs, prev, count, liveRaw, liveGBP }: every plan on that share, options included

    function addU(tk, pair, abs, prev) {
        const u = byUnderlying[tk] || (byUnderlying[tk] = { abs: 0, prev: 0, count: 0, liveRaw: pair.liveRaw, liveGBP: pair.liveGBP });
        u.abs += abs; u.prev += prev; u.count += 1;
    }
    for (const plan of plans) {
        const units = Number(
            plan.current_units != null ? plan.current_units :
            plan.currentUnits  != null ? plan.currentUnits  :
            plan.units         != null ? plan.units         :
            plan.totalTargetUnits
        ) || 0;
        const normTk = rTicker(plan);
        if (!normTk || normTk === 'UNTICKERED') continue;
        const category = String(plan.category || plan.restricted_category || '').toUpperCase().trim();
        const planTodayStr = getEffectiveDateForTicker(normTk, liveQuoteSessionDates, _candidate, _globalEff) || todayStr;

        // ── Canonical price-pair resolver (liveDailyCloses takes priority) ─────
        // Market-price currency: today's quote currency first, then the plan's.
        const planCcy = lookupCurrency(tickerCurrencyMap, normTk) || normaliseQuoteCurrency(plan.currency) ||
            KNOWN_RESTRICTED_CCY[normTk] || 'GBX';
        const pair = resolveRestrictedDailyPricePair({
            ticker: normTk, currency: planCcy, dollarRate,
            livePrices, liveDailyCloses, todayStr: planTodayStr,
        });
        if (!pair.ok) continue;  // skip silently — never zero-fill
        // Latest-session rule (same as the hero / holdings): a plan whose market has not yet reached the latest session
        // (Citi RSUs on a London morning) contributes no Today, rather than a previous session's move shown as today's.
        if (isHeldBackBySession(planTodayStr, latestSession)) continue;
        const livePxGBP = pair.liveGBP;
        const prevPxGBP = pair.prevGBP;

        if (category === 'RSU' || category === 'SIP') {
            const ik = String(plan.institution || '—');
            instDailyPnL[ik]    = (instDailyPnL[ik]    || 0) + units * (livePxGBP - prevPxGBP);
            instPricedPrev[ik]  = (instPricedPrev[ik]  || 0) + units * prevPxGBP;
            instPricedCount[ik] = (instPricedCount[ik] || 0) + 1;
            addU(normTk, pair, units * (livePxGBP - prevPxGBP), units * prevPxGBP);
        } else if (category === 'OPTION') {
            const strike   = Number(plan.strikePrice ?? plan.strike_price ?? 0);
            const prevSprd = Math.max(0, prevPxGBP - strike);
            const liveSprd = Math.max(0, livePxGBP - strike);
            const tcm      = Number(plan.totalContractMonths ?? plan.total_contract_months ?? 1);
            const em       = Number(plan.elapsedMonths ?? 0);
            const pu       = tcm > 0 ? (em / tcm) * units : 0;
            const optPk    = plan.planId || plan.plan_id || plan.trancheId || String(plan.planName || '');
            optPlanDailyPnL[optPk] = (optPlanDailyPnL[optPk] || 0) + pu * (liveSprd - prevSprd);
            optPlanPrevVal[optPk]  = (optPlanPrevVal[optPk]  || 0) + pu * prevSprd;
            // Saved cash and accrued bonus do not move with the share price, but they are part of the value
            // shown on the line, so they belong in the base of its daily %.
            optPlanPrevTotal[optPk] = (optPlanPrevTotal[optPk] || 0)
                + Number(plan.accruedCash ?? 0) + Number(plan.accruedBonus ?? 0) + pu * prevSprd;
            addU(normTk, pair, pu * (liveSprd - prevSprd),
                Number(plan.accruedCash ?? 0) + Number(plan.accruedBonus ?? 0) + pu * prevSprd);
        }
    }
    return { instDailyPnL, instPricedPrev, instPricedCount, optPlanDailyPnL, optPlanPrevVal, optPlanPrevTotal, byUnderlying };
}

// All Holdings title for a restricted row: the institution, as a short ticker-style label ("HSBC", "CITI").
function restrictedInstTicker(inst) {
    return String(inst || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 5) || 'REST';
}

// ── computeRestrictedDisplayRows — CANONICAL restricted P&L row normalizer ────
// Single source of truth for the per-row numbers shown in BOTH:
//   a) RestrictedSchemesWidget hero (group rows / option rows), and
//   b) the All Holdings bottom-sheet "Restricted Corporate Schemes" section.
// Every formula below mirrors RestrictedSchemesWidget line-for-line:
//   - daily P&L: resolveRestrictedDailyPricePair (gated live px +
//     resolveVerifiedDailyPrevClose) with per-ticker effective session dates
//     via getEffectiveDateForTicker;
//   - RSU/SIP group total P&L: grant-price GBP basis vs current valueGBP;
//   - OPTION (Sharesave) total P&L: optionValue + accruedBonus vs accruedCash;
//   - OPTION daily display: suppressed when |move| < £0.50 (hero rule);
//     pct denominator = the line's own PREVIOUS value (saved cash + accrued
//     bonus + prev intrinsic value), so it is comparable with the share's own %.
// GUARDRAIL: output rows are display-only (isRestrictedDisplayOnly: true) and
// must NEVER be fed into masterPortfolio, account totals or TWR. (The hero total,
// Market Movers and the chart take restricted capital from their own paths:
// computeRestrictedPositions and restrictedChartPoint, never from these rows.)
// ⚠️ PARITY CONTRACT: see the matching comment above RestrictedSchemesWidget.
// If a formula changes in either place, change both. Per output row, the
// fields that must stay numerically aligned with the hero are:
//   marketValue / value, todayAbsChange, todayPctChange,
//   unrealisedPL, restrictedTotalPnl, restrictedTotalPnlPct, totalCost.
function computeRestrictedDisplayRows({
    currentCompState, livePrices, tickerCurrencyMap, gbpusdRate,
    prices, liveStatus, liveAt, liveDailyCloses, liveQuoteSessionDates,
    latestSession,
}) {
    const plans = (currentCompState && currentCompState.currentRestrictedPlans) || [];
    if (plans.length === 0) return [];

    const dollarRate = gbpusdRate ;

    // ── Pass 1: daily-delta accumulation (shared with the restricted positions) ─
    const { instDailyPnL, instPricedPrev, instPricedCount, optPlanDailyPnL, optPlanPrevVal, optPlanPrevTotal } =
        restrictedDailyPass({ plans, livePrices, tickerCurrencyMap, dollarRate, liveAt, liveDailyCloses,
                              liveQuoteSessionDates, latestSession });

    // ── Pass 2: build HoldingRow-compatible display rows ─────────────────────
    const byInst = new Map();
    const opts   = [];
    for (const p of plans) {
        const cat = String(p.category || p.restricted_category || '').toUpperCase().trim();
        if (cat === 'OPTION') { opts.push(p); continue; }
        const inst = p.institution || '—';
        if (!byInst.has(inst)) byInst.set(inst, []);
        byInst.get(inst).push(p);
    }

    const rows = [];

    // RSU/SIP institution groups — same numbers as the hero's renderRSUGroupRow.
    for (const [inst, grp] of byInst) {
        const totalVal   = grp.reduce((s, p) => s + Number(p.valueGBP ?? 0), 0);
        const totalUnits = grp.reduce((s, p) => s + Number(p.units   ?? 0), 0);
        const subtitle   = `${totalUnits.toLocaleString('en-GB', { maximumFractionDigits: 0 })} units · ${grp.length} grant${grp.length !== 1 ? 's' : ''}`;

        // Daily — exactly the hero's grpDailyAbs / grpDailyPct.
        const dAbs = (instPricedCount[inst] || 0) > 0 ? (instDailyPnL[inst] ?? null) : null;
        const dPct = (dAbs != null && (instPricedPrev[inst] || 0) > 0) ? dAbs / instPricedPrev[inst] : null;

        // Total — exactly the hero's grant-price-basis grpTotalPnl / grpTotalPct.
        let totalBasis = 0, activePlans = 0, basisFailed = false;
        for (const p of grp) {
            const planUnits = Number(p.units ?? p.current_units ?? 0);
            if (!(planUnits > 0)) continue;            // skip vested/empty tranches — don't fail the group
            if (!(p.grantPrice > 0)) { basisFailed = true; break; }
            const gpGBP = pxToGBPWithCurrency(p.grantPrice, String(p.currency || 'GBX').toUpperCase(), dollarRate);
            if (gpGBP == null) { basisFailed = true; break; }
            totalBasis += planUnits * gpGBP;
            activePlans++;
        }
        const grpTotalPnl = (!basisFailed && activePlans > 0 && totalBasis > 0) ? totalVal - totalBasis : null;
        const grpTotalPct = (grpTotalPnl != null && totalBasis > 0) ? grpTotalPnl / totalBasis : null;
        const grpBasis    = grpTotalPnl != null ? totalBasis : 0;

        const instTicker = restrictedInstTicker(inst);
        // Subheading names the scheme, not the institution again: RSUs are "Unvested", SIP is "Share incentive plan".
        const cats = new Set(grp.map(p => String(p.category || p.restricted_category || '').toUpperCase().trim()));
        const schemeName = [cats.has('RSU') ? 'Unvested' : null, cats.has('SIP') ? 'Share incentive plan' : null]
            .filter(Boolean).join(' · ') || inst;
        rows.push({
            // HoldingRow-compatible shape
            ticker: instTicker, name: schemeName, account: 'Restricted Asset',
            marketValue: totalVal, value: totalVal,
            todayAbsChange: dAbs,
            todayPctChange: dPct,
            unrealisedPL: grpTotalPnl,
            totalCost: grpBasis, totalProceeds: 0,
            restrictedTotalPnl: grpTotalPnl,
            restrictedTotalPnlPct: grpTotalPct,
            units: totalUnits,
            isRestrictedDisplayOnly: true,
            section: 'Restricted Corporate Schemes',
            _subtitle: subtitle,
        });
    }

    // OPTION (Sharesave) rows — same numbers as the hero's renderOptionRow.
    for (const p of opts) {
        const acc  = Number(p.accruedCash ?? 0);
        const ov   = Number(p.optionValue ?? 0);
        const vGBP = Number(p.valueGBP ?? 0);
        const em   = Number(p.elapsedMonths ?? 0);
        const tcm  = Number(p.totalContractMonths ?? p.total_contract_months ?? 0);
        const u    = Number(p.units ?? p.totalTargetUnits ?? 0);
        const subtitle = [
            u > 0 ? `${u.toLocaleString('en-GB')} options` : null,
            `${em}/${tcm || '?'} months`,
            acc > 0 ? `saved ${fmtV(acc, 0)}` : null,
        ].filter(Boolean).join(' · ');

        // Daily — hero rule: null unless priced; suppress |move| < £0.50;
        // pct denominator = the line's previous total value (cash + bonus + prev intrinsic value).
        const optPk    = p.planId || p.plan_id || p.trancheId || String(p.planName || '');
        const dAbsRaw  = (optPlanPrevVal[optPk] != null) ? (optPlanDailyPnL[optPk] ?? null) : null;
        const dAbs     = (dAbsRaw != null && Math.abs(dAbsRaw) >= 0.50) ? dAbsRaw : null;
        const pctBase  = optPlanPrevTotal[optPk] || 0;
        const dPct     = (dAbs != null && pctBase > 0) ? dAbs / pctBase : null;

        // Total — hero rule: gain vs saved = optionValue + accruedBonus.
        const aBonus      = Number(p.accruedBonus ?? 0);
        const totalPnl    = ov + aBonus;             // always defined, may be 0
        const totalPnlPct = acc > 0 ? totalPnl / acc : null;

        rows.push({
            ticker: p.institution ? restrictedInstTicker(p.institution) : 'SAYE', name: p.planName || p.planId || 'Sharesave',
            account: 'Restricted Asset',
            marketValue: vGBP, value: vGBP,
            todayAbsChange: dAbs,
            todayPctChange: dPct,
            unrealisedPL: totalPnl,    // gain vs saved cash
            totalCost: acc,            // contributions-to-date as cost basis
            totalProceeds: 0,
            restrictedTotalPnl: totalPnl,
            restrictedTotalPnlPct: totalPnlPct,
            units: u,
            isRestrictedDisplayOnly: true,
            section: 'Restricted Corporate Schemes',
            _subtitle: subtitle,
        });
    }
    return rows;
}

// ── Restricted positions: HSBC (R) and Citi (R) ──────────────────────────────
// Every restricted plan (RSU, SIP and Sharesave alike) is grouped by the share it is on, and each share is one
// position labelled with an "(R)", so the hero, Market Movers and the chart can show the restricted moves next to
// the ordinary holdings without mistaking them for shares that can be sold.
function restrictedPositionLabel(ticker, institution) {
    const tk = String(ticker || '').toUpperCase().trim();
    if (tk === 'HSBA.L' || tk === 'HSBA') return 'HSBC (R)';
    if (tk === 'C') return 'Citi (R)';
    return String(institution || tk || 'Restricted').trim() + ' (R)';
}
function restrictedPlanTicker(plan) {
    return (plan.yahooTicker || plan.yahoo_ticker || plan.ticker || plan.instrumentTicker || plan.underlyingTicker || '')
        .toString().toUpperCase().trim();
}
// One row per underlying share: value = the restricted value of every plan on it (what the restricted card shows);
// Today = the summed move of the plans that are priced on the latest session (null when none is), % against their
// previous value. currentPriceRaw / currentPriceGBP feed the Spot column in Market Movers.
function computeRestrictedPositions({
    currentCompState, livePrices, tickerCurrencyMap, gbpusdRate,
    liveAt, liveDailyCloses, liveQuoteSessionDates, latestSession,
}) {
    const plans = (currentCompState && currentCompState.currentRestrictedPlans) || [];
    if (plans.length === 0) return [];
    const { byUnderlying } = restrictedDailyPass({ plans, livePrices, tickerCurrencyMap, dollarRate: gbpusdRate, liveAt,
        liveDailyCloses, liveQuoteSessionDates, latestSession });
    const groups = new Map();
    for (const p of plans) {
        const tk = restrictedPlanTicker(p);
        if (!tk || tk === 'UNTICKERED') continue;
        if (!groups.has(tk)) groups.set(tk, { tk, institution: p.institution, value: 0, plans: 0 });
        const g = groups.get(tk);
        g.value += Number(p.valueGBP || 0);
        g.plans += 1;
    }
    const out = [];
    for (const g of groups.values()) {
        const d = byUnderlying[g.tk];
        const abs = d && d.count > 0 ? d.abs : null;
        out.push({
            ticker: restrictedPositionLabel(g.tk, g.institution), name: restrictedPositionLabel(g.tk, g.institution),
            underlyingTicker: g.tk, account: 'Restricted Asset',
            marketValue: g.value, units: g.plans,
            todayAbsChange: abs,
            todayPctChange: abs != null && d.prev > 0 ? abs / d.prev : null,
            todayPrevValue: abs != null ? d.prev : null,
            currentPriceRaw: d ? d.liveRaw : null, currentPriceGBP: d ? d.liveGBP : null,
            isRestrictedPosition: true,
        });
    }
    return out.sort((a, b) => b.marketValue - a.marketValue);
}

// Restricted capital on one chart date, from that date's planDetails (buildRestrictedTimeline): value per position
// (by), the share price in GBP per position (px, for the Held return column), and each plan's exposure (exp: q units
// whose value moves with price p) so a week's change can be split into market move and flows (restrictedChartFlows).
// An RSU counts from its grant date; before that it was not yet held.
//   RSU  q = units,                        p = value / units
//   SIP  q = units,                        p = share price (saved cash is a flow)
//   SAYE q = units saved for so far,       p = intrinsic spread (saved cash and bonus are flows)
function restrictedChartPoint(planDetails, dateStr) {
    const by = {}, px = {}, exp = {};
    let total = 0;
    for (const [key, p] of Object.entries(planDetails || {})) {
        if (!p || p.phase !== 'RESTRICTED') continue;
        if (p.grantDate && dateStr < p.grantDate) continue;
        const v = Number(p.valueGBP);
        if (!Number.isFinite(v)) continue;
        const tk = restrictedPlanTicker(p);
        const label = restrictedPositionLabel(tk, p.institution);
        by[label] = (by[label] || 0) + v;
        total += v;
        const cat = String(p.category || '').toUpperCase();
        const units = Number(p.units) || 0;
        let q = 0, pr = null, share = null;
        if (cat === 'RSU') { if (units > 0) { q = units; pr = v / units; share = pr; } }
        else if (cat === 'SIP') { q = units; pr = Number(p.priceGBP); share = pr; }
        else if (cat === 'OPTION') {
            const tcm = Number(p.totalContractMonths) || 0;
            q = tcm > 0 ? (Number(p.elapsedMonths) || 0) / tcm * units : 0;
            pr = Number(p.spread); share = Number(p.priceGBP);
        }
        if (Number.isFinite(share) && share > 0 && px[label] == null) px[label] = share;
        exp[key] = { label, q, p: Number.isFinite(pr) ? pr : null };
    }
    return { by, px, exp, total };
}
// Flows between two restricted chart points, per position: the change in value that the price move does not
// explain (a grant arriving, a tranche vesting out, Sharesave contributions). Market move = q (previous) × change in p,
// for plans held at both dates.
function restrictedChartFlows(prev, curr) {
    const flow = {};
    let total = 0;
    const labels = new Set([...Object.keys(prev.by), ...Object.keys(curr.by)]);
    for (const label of labels) {
        let gain = 0;
        for (const key of Object.keys(curr.exp)) {
            const c = curr.exp[key], p = prev.exp[key];
            if (!p || c.label !== label || p.p == null || c.p == null) continue;
            gain += p.q * (c.p - p.p);
        }
        const f = (curr.by[label] || 0) - (prev.by[label] || 0) - gain;
        if (Math.abs(f) > 1e-9) { flow[label] = f; total += f; }
    }
    return { flow, total };
}

// RestrictedSchemesWidget — Interactive account hero card with live delta and grouped RSU tranches.
// Global scope — stable reference alongside HeroCard, AccountCard, ActionAlertBanner.
// Returns null when no RESTRICTED-phase plans are present (safe zero-render guard).
//
// ⚠️ PARITY CONTRACT with computeRestrictedDisplayRows (All Holdings sheet):
// This widget keeps its own rendering path, but every P&L formula below is
// mirrored formula-for-formula in computeRestrictedDisplayRows (defined above).
// If you change any of the following HERE, change the helper identically —
// and vice versa — or the hero and the All Holdings restricted rows will drift:
//   1. Daily price-pair resolution: resolveRestrictedDailyPricePair (gated
//      live px + resolveVerifiedDailyPrevClose, no other fallbacks); per-ticker
//      session dates via getEffectiveDateForTicker with the
//      (_globalEff || _candidate) todayStr fallback chain.
//   2. Units priority: current_units → currentUnits → units → totalTargetUnits.
//   3. Currency chain (market prices): today's quote currency (tickerCurrencyMap, CI) → plan.currency →
//      KNOWN_RESTRICTED_CCY → 'GBX'; conversion via pxToGBPWithCurrency.
//   4. RSU/SIP group daily: instDailyPnL / instPricedPrev / instPricedCount
//      (null when zero plans priced — never zero-filled).
//   5. RSU/SIP group total: grant-price GBP basis vs Σ valueGBP; zero-unit
//      tranches skipped; missing grantPrice / failed FX ⇒ null total.
//   6. OPTION daily: prorated intrinsic-spread delta (elapsed/total months);
//      display suppressed when |move| < £0.50; pct denominator = the line's
//      previous value (accruedCash + accruedBonus + prev intrinsic value). The
//      hero header % uses the same previous value in its denominator.
//   7. OPTION total: optionValue + accruedBonus; pct vs accruedCash (>0).
//   8. Latest-session rule: a plan whose session (planTodayStr) is behind latestSession contributes no Today
//      (isHeldBackBySession, placed right after the pair.ok check).
function RestrictedSchemesWidget({
    currentCompState,
    privacyMode,
    livePrices,
    tickerCurrencyMap,
    gbpusdRate,
    prices,
    liveStatus,
    liveAt,
    liveDailyCloses,
    liveQuoteSessionDates,
    liveQuoteChecks,
    latestSession,
}) {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [expandedGroups, setExpandedGroups] = React.useState({});

    const plans = (currentCompState && currentCompState.currentRestrictedPlans) || [];
    if (plans.length === 0) return null;

    // Runtime formatting safety alias — resolves whichever formatter is in global scope
    const safeFormatGBP = (val, opts) => {
        if (typeof formatGBP === 'function') return formatGBP(val, opts);
        if (typeof fmtV === 'function') return fmtV(val);
        return '\u00a3' + Number(val).toLocaleString('en-GB', { maximumFractionDigits: opts?.dp ?? 0 });
    };

    // ── 1. Value source of truth via nullish coalescing ──────────────────────
    const fallbackTotal = plans.reduce((s, p) => s + Number(p.valueGBP || 0), 0);
    const totalValue    = Number(currentCompState?.currentRestrictedComp ?? fallbackTotal);

    // ── 2. Intraday session change matrix (display only) ─────────────────────
    // Partial accumulation: valid ticker rows contribute their daily delta;
    // tickers without a live/prevClose pair are silently skipped — never treated
    // as £0. Today line is null only when zero restricted rows are priced.
    // - If C priced, HSBA.L missing → shows Citi daily P&L only.
    // - If HSBA.L priced, C missing → shows HSBC daily P&L only.
    // - If both priced → shows combined daily P&L.
    // - If neither priced → Today —.
    // ── Case-insensitive map lookup — handles ticker capitalisation mismatches ──
    function getMapValueCI(map, ticker) {
        const norm = String(ticker || '').toUpperCase().trim();
        if (!map || !norm) return null;
        if (map[norm] != null) return map[norm];
        const key = Object.keys(map).find(k => String(k).toUpperCase().trim() === norm);
        return key ? map[key] : null;
    }

    // ── Debug gate — set true locally to log per-plan diagnostics ───────────
    const DEBUG_RESTRICTED_DAILY = false;

    // ── Ticker resolver: walks all known field naming conventions ────────────
    // Intentionally tolerates planDetails that use snake_case, camelCase, or
    // either of the Yahoo-ticker synonyms used across the app's schema versions.
    function getRestrictedTicker(plan) {
        return (
            plan.yahooTicker       ||
            plan.yahoo_ticker      ||
            plan.ticker            ||
            plan.instrumentTicker  ||
            plan.underlyingTicker  ||
            ''
        ).toString().toUpperCase().trim();
    }

    // ── Known-currency hardened fallbacks (tickers not in HL tickerCurrencyMap) ─
    // C is a USD-quoted NYSE ticker; HSBA.L is a GBX-quoted LSE ticker.
    // These override the generic 'GBX' default when the plan lacks an explicit
    // currency field and the ticker isn't found in tickerCurrencyMap.
    const KNOWN_RESTRICTED_CCY = { 'C': 'USD', 'HSBA.L': 'GBX' };

    let todayAbsChange    = 0;
    let pricedPrevValue   = 0;  // sum of (prevPxGBP × effective units) for priced rows only
    let pricedTickerCount = 0;  // count of rows that had a valid live + prevClose pair
    const instDailyPnL    = {};   // institution → accumulated daily P&L
    const instPricedPrev  = {};   // institution → accumulated prev-day value (denominator)
    const instPricedCount = {};   // institution → priced-plan count
    const optPlanDailyPnL = {};   // planId → daily P&L for OPTION plans
    const optPlanPrevVal  = {};   // planId → prev-day intrinsic value
    const optPlanPrevTotal = {};  // planId → prev-day TOTAL value (cash + bonus + intrinsic): the % denominator
    // Diagnostic store — display-only, never feeds valuation.
    // Keyed by normTk. Populated whether pair.ok or not so the UI can show
    // either a price chip or a meaningful failure reason.
    const restrictedPriceDiagnostics = {};  // { [ticker]: { ok, source, reason, quoteSessionDate, prevSessionDate, liveRaw, prevRaw } }

    // Format a trade-session date as a compact human label (e.g. "Closed Fri").
    function formatSessionDateLabel(dateStr) {
        if (!dateStr) return null;
        try {
            var d      = new Date(dateStr + 'T12:00:00Z');
            var today  = new Date(); today.setUTCHours(12, 0, 0, 0);
            var ageDays = Math.floor((today.getTime() - d.getTime()) / 86400000);
            var days   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            if (ageDays < 1) return 'Today';
            if (ageDays < 2) return 'Yesterday';
            return 'Closed ' + days[d.getUTCDay()];
        } catch(e) { return null; }
    }

    const _widgetCandidate   = getCurrentPnlSessionDateStr();
    const _widgetGlobalEff   = getEffectivePnlSessionDateStr(liveAt, _widgetCandidate);
    // Per-plan todayStr is resolved inside the plan loop using getEffectiveDateForTicker.
    // This global is the fallback for plans whose ticker lacks liveDailyCloses data.
    const todayStr = _widgetGlobalEff || _widgetCandidate;

    for (const plan of plans) {
        // ── Units: check current_units / currentUnits before the generic 'units' field ──
        // Priority: current_units (RSU/SIP CSV field) → currentUnits (camelCase alias)
        //           → units (planDetails storage key) → totalTargetUnits (OPTION fallback)
        const units = Number(
            plan.current_units   != null ? plan.current_units   :
            plan.currentUnits    != null ? plan.currentUnits    :
            plan.units           != null ? plan.units           :
            plan.totalTargetUnits
        ) || 0;

        // ── Ticker resolution via schema-safe helper ──────────────────────────
        const normTk = getRestrictedTicker(plan);
        if (!normTk || normTk === 'UNTICKERED') continue;

        // ── Category normalisation ────────────────────────────────────────────
        const category = String(plan.category || plan.restricted_category || '').toUpperCase().trim();

        // ── Canonical price-pair resolver (liveDailyCloses first) ─────────────
        const planEffDate  = getEffectiveDateForTicker(normTk, liveQuoteSessionDates, _widgetCandidate, _widgetGlobalEff);
        const planTodayStr = planEffDate || todayStr;
        // Market-price currency: today's quote currency first, then the plan's.
        const planCcy = lookupCurrency(tickerCurrencyMap, normTk) || normaliseQuoteCurrency(plan.currency) ||
            KNOWN_RESTRICTED_CCY[normTk] || 'GBX';
        const pair = resolveRestrictedDailyPricePair({
            ticker: normTk, currency: planCcy, dollarRate: gbpusdRate ,
            livePrices, liveDailyCloses, todayStr: planTodayStr,
        });

        // Always record diagnostics — whether pair.ok or not — for chip/debug display.
        if (!restrictedPriceDiagnostics[normTk]) {
            restrictedPriceDiagnostics[normTk] = {
                ok: pair.ok, source: pair.source, reason: pair.reason,
                quoteSessionDate: pair.quoteSessionDate, prevSessionDate: pair.prevSessionDate,
                liveRaw: pair.liveRaw, prevRaw: pair.prevRaw,
            };
        }

        if (!pair.ok) continue;  // skip silently — never zero-fill
        // Latest-session rule — mirrored in computeRestrictedDisplayRows (parity item 8). Placed before the plan is
        // counted as priced, so a held-back plan adds nothing to Today or to its denominator.
        if (isHeldBackBySession(planTodayStr, latestSession)) continue;
        const livePxGBP = pair.liveGBP;
        const prevPxGBP = pair.prevGBP;

        pricedTickerCount++;

        let dailyPnL = 0;
        const deltaGBP = livePxGBP - prevPxGBP;

        if (category === 'RSU' || category === 'SIP') {
            dailyPnL         = units * deltaGBP;
            todayAbsChange  += dailyPnL;
            pricedPrevValue += units * prevPxGBP;
            const _ik = String(plan.institution || '—');
            instDailyPnL[_ik]    = (instDailyPnL[_ik]    || 0) + dailyPnL;
            instPricedPrev[_ik]  = (instPricedPrev[_ik]  || 0) + units * prevPxGBP;
            instPricedCount[_ik] = (instPricedCount[_ik] || 0) + 1;
        } else if (category === 'OPTION') {
            // Intrinsic-value change for proration of accrued option units.
            // Uses totalContractMonths + elapsedMonths from planDetails (stored by buildRestrictedTimeline).
            const strike              = Number(plan.strikePrice ?? plan.strike_price ?? 0);
            const prevSpread          = Math.max(0, prevPxGBP - strike);
            const liveSpread          = Math.max(0, livePxGBP - strike);
            const totalContractMonths = Number(plan.totalContractMonths ?? plan.total_contract_months ?? 1);
            const elapsedMonths       = Number(plan.elapsedMonths ?? 0);
            const proratedUnits       = totalContractMonths > 0
                ? (elapsedMonths / totalContractMonths) * units : 0;
            dailyPnL         = proratedUnits * (liveSpread - prevSpread);
            todayAbsChange  += dailyPnL;
            // Previous value of the whole option line: saved cash + accrued bonus + prev intrinsic value. Cash and
            // bonus do not move with the share price but are part of the value shown (and of the card total), so the
            // daily % is measured against all of it - the same way the RSU and SIP rows are.
            const _optPrevTotal = Number(plan.accruedCash ?? 0) + Number(plan.accruedBonus ?? 0) + proratedUnits * prevSpread;
            pricedPrevValue += _optPrevTotal;
            // Per-plan tracking for TODAY display in renderOptionRow
            const _optPk = plan.planId || plan.plan_id || plan.trancheId || String(plan.planName || '');
            optPlanDailyPnL[_optPk] = (optPlanDailyPnL[_optPk] || 0) + dailyPnL;
            optPlanPrevVal[_optPk]  = (optPlanPrevVal[_optPk]  || 0) + proratedUnits * prevSpread;
            optPlanPrevTotal[_optPk] = (optPlanPrevTotal[_optPk] || 0) + _optPrevTotal;
        }

        if (DEBUG_RESTRICTED_DAILY) console.table([{
            planId:          plan.planId || plan.plan_id || plan.name,
            label:           plan.label  || plan.planName || plan.grantName || plan.awardName,
            ticker:          normTk,
            category:        plan.restricted_category || plan.category,
            currency:        planCcy,
            units,
            livePxRaw:       pair.liveRaw,
            prevPxRaw:       pair.prevRaw,
            livePxGBP:       pair.liveGBP,
            prevPxGBP:       pair.prevGBP,
            pairSource:      pair.source,
            quoteSessionDate: pair.quoteSessionDate,
            prevSessionDate: pair.prevSessionDate,
            deltaGBP,
            dailyPnL,
            reasonSkipped:   null,
        }]);
        // Missing live or prevClose: silently skip — never zero-fill, never invalidate other rows
    }

    // Percentage uses pricedPrevValue (priced portion only) as denominator,
    // so unpriced tickers neither inflate nor suppress the rate.
    const finalTodayAbs = pricedTickerCount > 0 ? todayAbsChange : null;
    const finalTodayPct = (pricedTickerCount > 0 && pricedPrevValue > 0)
        ? todayAbsChange / pricedPrevValue : null;

    // ── 3. Row render helpers ─────────────────────────────────────────────────
    function renderRSURow(plan, i) {
        const taxRateVal  = Number(plan.marginal_tax_rate ?? 0);
        const taxLabelNode = (taxRateVal > 0 && taxRateVal < 1)
            ? React.createElement('span', {
                style: { color: C.zinc600, fontFamily: sys, fontSize: 10, marginLeft: 4 }
              }, `(Tax: ${(taxRateVal * 100).toFixed(0)}%)`)
            : null;

        return React.createElement('div', {
            key: plan.planId || i,
            style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                     padding: '10px 0 0', borderTop: `1px solid ${C.border}`, gap: 12, minHeight: 44 }
        },
            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                React.createElement('div', {
                    style: { fontFamily: sys, fontSize: 12, fontWeight: 600, color: C.text,
                             marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                }, plan.planName || plan.planId || '\u2014'),
                React.createElement('div', {
                    style: { fontFamily: sys, fontSize: 10, color: C.zinc500, marginBottom: 4 }
                }, plan.institution || '\u2014'),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    React.createElement('span', { style: { fontFamily: mono, fontSize: 10, color: C.zinc600 } },
                        `${(plan.units || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 })} units`),
                    plan.vestingDate && React.createElement('span', {
                        style: { fontFamily: sys, fontSize: 10, color: C.amber }
                    }, `Vests ${plan.vestingDate}`),
                    taxLabelNode
                )
            ),
            React.createElement('div', { style: { textAlign: 'right', flexShrink: 0 } },
                React.createElement('div', {
                    style: { fontFamily: sys, fontSize: 14, fontWeight: 600, color: C.violet,
                             fontVariantNumeric: 'tabular-nums', filter: privacyMode ? 'blur(6px)' : 'none' }
                }, safeFormatGBP(plan.valueGBP || 0, { dp: 0 })),
                React.createElement('div', {
                    style: { fontFamily: sys, fontSize: 10, color: C.zinc600, marginTop: 2 }
                }, 'est. GBP')
            )
        );
    }

    function renderOptionRow(plan, i, planDailyAbs, planDailyPct) {
        const valueGBP            = Number(plan.valueGBP            ?? 0);
        const accruedCash         = Number(plan.accruedCash         ?? 0);
        const optionValue         = Number(plan.optionValue         ?? 0);
        const elapsedMonths       = Number(plan.elapsedMonths       ?? 0);
        const totalContractMonths = Number(plan.totalContractMonths ?? 0);
        const targetUnits         = Number(plan.totalTargetUnits    ?? plan.units ?? 0);

        const progressPct  = totalContractMonths > 0
            ? Math.max(0, Math.min(100, (elapsedMonths / totalContractMonths) * 100)) : 0;
        const privacyClass = privacyMode ? 'privacy-blur' : '';

        const taxRateVal   = Number(plan.marginal_tax_rate ?? 0);
        const taxLabelNode = (taxRateVal > 0 && taxRateVal < 1)
            ? React.createElement('span', {
                style: { color: C.zinc600, fontFamily: sys, fontSize: 10, marginLeft: 4 }
              }, `(Tax: ${(taxRateVal * 100).toFixed(0)}%)`)
            : null;

        // Gain vs saved cash (Sharesave semantics per brief Change 4)
        // gain = optionValue + accruedBonus = valueGBP - accruedCash
        // Always defined (may be 0 when both are 0); never negative because of saved cash
        const accruedBonus   = Number(plan.accruedBonus ?? 0);
        const optTotalPnl    = optionValue + accruedBonus;
        const optTotalPnlPct = accruedCash > 0 ? optTotalPnl / accruedCash : null;

        // Compact subtitle: institution · N options · saved £X · elapsed/total months · session date
        const _optTk = String((plan.ticker || plan.yahooTicker || plan.yahoo_ticker || '').trim()).toUpperCase();
        const _optDiag = _optTk ? restrictedPriceDiagnostics[_optTk] : null;
        const _optSessionLabel = (_optDiag && _optDiag.ok) ? formatSessionDateLabel(_optDiag.quoteSessionDate) : null;
        const optSubtitle = [
            plan.institution || 'Employer',
            `${targetUnits.toLocaleString('en-GB')} options`,
            accruedCash > 0 ? `saved ${safeFormatGBP(accruedCash, { dp: 0 })}` : null,
            `${elapsedMonths}/${totalContractMonths || '?'} months`,
            _optSessionLabel || null,
        ].filter(Boolean).join(' · ');

        return React.createElement('div', {
            key: plan.planId || i,
            style: { padding: '10px 0 0', borderTop: `1px solid ${C.border}` }
        },
            // ── Top row: plan name left, current value right ── matches RSU group row
            React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 } },
                React.createElement('div', { style: { minWidth: 0, flex: 1 } },
                    React.createElement('div', {
                        style: { fontFamily: mono, fontSize: 12, color: C.amber, marginBottom: 1,
                                 letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                    }, plan.planName || 'Sharesave Option'),
                    React.createElement('div', {
                        style: { fontFamily: sys, fontSize: 11, color: C.zinc500, overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                    },
                        privacyMode
                            ? [plan.institution || 'Employer', `${targetUnits.toLocaleString('en-GB')} options`, `${elapsedMonths}/${totalContractMonths || '?'} months`].filter(Boolean).join(' · ')
                            : optSubtitle
                    )
                ),
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingLeft: 10 } },
                    React.createElement('div', {
                        className: privacyClass,
                        style: { fontFamily: rounded, fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                 letterSpacing: '-0.02em', color: C.text }
                    }, safeFormatGBP(valueGBP, { dp: 0 }))
                )
            ),
            // ── Progress bar ──
            React.createElement('div', {
                style: { height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999,
                         overflow: 'hidden', margin: '4px 0 7px' }
            },
                React.createElement('div', {
                    style: { width: `${progressPct}%`, height: '100%', background: C.violet,
                             borderRadius: 9999, transition: 'width 400ms ease' }
                })
            ),
            // ── TODAY / TOTAL metric row — same grammar as RSU group row ──
            React.createElement('div', { style: { display: 'flex', gap: 14, alignItems: 'center' } },
                React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'baseline' } },
                    React.createElement('span', {
                        style: { fontFamily: rounded, fontSize: 11, fontWeight: 400, color: C.zinc500, letterSpacing: 0 }
                    }, 'Today'),
                    React.createElement('span', {
                        className: planDailyAbs != null && privacyMode ? 'privacy-blur' : '',
                        style: { fontFamily: rounded, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                 letterSpacing: '-0.01em', color: planDailyAbs != null ? signColor(planDailyAbs) : C.zinc600 }
                    }, planDailyAbs != null ? fmtA(planDailyAbs) : '—'),
                    planDailyPct != null
                        ? React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 11, fontWeight: 500, color: signColor(planDailyPct) }
                          }, `(${fmtP(planDailyPct)})`)
                        : null
                ),
                React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'baseline' } },
                    React.createElement('span', {
                        style: { fontFamily: rounded, fontSize: 11, fontWeight: 400, color: C.zinc500, letterSpacing: 0 }
                    }, 'Total'),
                    React.createElement('span', {
                        className: privacyClass,
                        style: { fontFamily: rounded, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                 letterSpacing: '-0.01em', color: signColor(optTotalPnl) }
                    }, fmtA(optTotalPnl)),
                    optTotalPnlPct != null
                        ? React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 11, fontWeight: 500, color: signColor(optTotalPnlPct) }
                          }, `(${fmtP(optTotalPnlPct)})`)
                        : null
                ),
                taxLabelNode
            )
        );
    }

    function renderRSUGroupRow(groupPlans, i) {
        const totalGrpVal  = groupPlans.reduce((s, p) => s + Number(p.valueGBP ?? 0), 0);
        const totalUnits   = groupPlans.reduce((s, p) => s + Number(p.units    ?? 0), 0);
        const institution  = groupPlans[0].institution    || '—';
        const custody      = groupPlans[0].custodyPlatform || null;
        const grpKey       = institution;
        const isGrpExpanded = !!expandedGroups[grpKey];

        const grpDailyAbs = (instPricedCount[institution] || 0) > 0 ? (instDailyPnL[institution] ?? null) : null;
        const grpDailyPct = (grpDailyAbs != null && (instPricedPrev[institution] || 0) > 0)
            ? grpDailyAbs / instPricedPrev[institution] : null;

        // Total P&L: grant price (native currency) × units → GBP basis vs current value.
        // Uses current gbpusdRate for USD→GBP conversion (slight approximation vs grant-date FX).
        // Zero-unit tranches (fully vested or pending settlement) are skipped, not failed.
        // If computation is impossible, grpTotalNullReason captures why for explicit UI display.
        let grpTotalNullReason = null;
        const { grpTotalPnl, grpTotalBasis } = (() => {
            const dollarRate = gbpusdRate ;
            let totalBasis = 0;
            let activePlans = 0;
            for (const p of groupPlans) {
                const planUnits = Number(p.units ?? p.current_units ?? 0);
                if (!(planUnits > 0)) continue;         // skip zero-unit tranches (vested/empty) — don't fail the group
                if (!(p.grantPrice > 0)) {
                    grpTotalNullReason = 'no grant price on record';
                    return { grpTotalPnl: null, grpTotalBasis: 0 };
                }
                const ccy = String(p.currency || 'GBX').toUpperCase();
                const gpGBP = pxToGBPWithCurrency(p.grantPrice, ccy, dollarRate);
                if (gpGBP == null) {
                    grpTotalNullReason = 'FX rate unavailable';
                    return { grpTotalPnl: null, grpTotalBasis: 0 };
                }
                totalBasis += planUnits * gpGBP;
                activePlans++;
            }
            if (activePlans === 0) {
                grpTotalNullReason = 'no active units';
                return { grpTotalPnl: null, grpTotalBasis: 0 };
            }
            const pnl = totalBasis > 0 ? totalGrpVal - totalBasis : null;
            return { grpTotalPnl: pnl, grpTotalBasis: totalBasis };
        })();
        const grpTotalPct = (grpTotalPnl != null && grpTotalBasis > 0) ? grpTotalPnl / grpTotalBasis : null;

        // Hoisted ticker/currency/diagnostic — used by both the spot-price chip
        // and the session-date label so neither IIFE has to redeclare grpTk.
        const grpTk = String(
            groupPlans[0].ticker || groupPlans[0].yahooTicker ||
            groupPlans[0].yahoo_ticker || groupPlans[0].underlyingTicker || ''
        ).trim().toUpperCase();
        const grpCcy = lookupCurrency(tickerCurrencyMap, grpTk) || normaliseQuoteCurrency(groupPlans[0].currency)
            || KNOWN_RESTRICTED_CCY[grpTk] || 'GBX';
        const grpDiag = grpTk ? restrictedPriceDiagnostics[grpTk] : null;

        return React.createElement('div', {
            key: `grp-${institution}-${i}`,
            style: { padding: '10px 0 0', borderTop: `1px solid ${C.border}` }
        },
            React.createElement('button', {
                onClick: () => setExpandedGroups(prev => ({ ...prev, [grpKey]: !prev[grpKey] })),
                style: {
                    width: '100%', textAlign: 'left', background: 'none', border: 'none',
                    padding: 0, cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                    display: 'block', minHeight: 44,
                }
            },
                // Top row: title + chevron left, value right — matches HoldingRow top row
                React.createElement('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 5 } },
                    React.createElement('div', { style: { minWidth: 0, flex: 1 } },
                        React.createElement('div', {
                            style: { fontFamily: mono, fontSize: 12, color: C.amber, marginBottom: 1,
                                     letterSpacing: '0.02em', display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }
                        },
                            React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, institution),
                            // ── Spot price chip — uses hoisted grpTk/grpCcy ─────────────────
                            (() => {
                                if (!grpTk) return null;
                                const spotResult = resolveDisplaySpotPrice({
                                    ticker: grpTk,
                                    livePrices,
                                    prices,
                                    liveStatus,
                                    liveAt,
                                    gbpusdRate,
                                    tickerCurrencyMap: Object.assign({}, tickerCurrencyMap, { [grpTk]: grpCcy }),
                                    liveQuoteChecks,
                                });
                                const sp = formatSpotPrice(spotResult);
                                if (!sp) return null;
                                return React.createElement('span', {
                                    style: { color: C.zinc500, fontWeight: 400, whiteSpace: 'nowrap',
                                             display: 'inline-flex', alignItems: 'baseline', gap: 0, flexShrink: 0 }
                                },
                                    '· ' + sp.text,
                                    sp.badge && React.createElement('sup', {
                                        style: { fontFamily: mono, fontSize: 7, color: sp.badge === '!' ? '#fbbf24' : C.zinc600, marginLeft: 1 }
                                    }, sp.badge)
                                );
                            })(),
                            // ── Session date label — uses hoisted grpDiag ────────────────────
                            (() => {
                                if (!grpDiag || !grpDiag.ok) return null;
                                const sl = formatSessionDateLabel(grpDiag.quoteSessionDate);
                                if (!sl) return null;
                                return React.createElement('span', {
                                    style: { color: C.zinc700, fontWeight: 400, fontSize: 10,
                                             whiteSpace: 'nowrap', flexShrink: 0 }
                                }, '· ' + sl);
                            })(),
                            React.createElement('span', {
                                style: { color: C.zinc600, fontSize: 10, lineHeight: 1, display: 'inline-block',
                                         transition: 'transform 150ms ease', flexShrink: 0,
                                         transform: isGrpExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }
                            }, '▾')
                        ),
                        React.createElement('div', {
                            style: { fontFamily: sys, fontSize: 11, color: C.zinc500, overflow: 'hidden',
                                     textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                        }, [custody, `${totalUnits.toLocaleString('en-GB', { maximumFractionDigits: 0 })} units · ${groupPlans.length} grant${groupPlans.length !== 1 ? 's' : ''}`].filter(Boolean).join(' · '))
                    ),
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingLeft: 10 } },
                        React.createElement('div', {
                            style: { fontFamily: rounded, fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                     letterSpacing: '-0.02em', color: C.text,
                                     filter: privacyMode ? 'blur(6px)' : 'none' }
                        }, safeFormatGBP(totalGrpVal, { dp: 0 }))
                    )
                ),
                // Bottom row: Today + Total — matches HoldingRow metric row
                React.createElement('div', { style: { display: 'flex', gap: 14, alignItems: 'center' } },
                    React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'baseline' } },
                        React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 11, fontWeight: 400, color: C.zinc500, letterSpacing: 0 }
                        }, 'Today'),
                        React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                     letterSpacing: '-0.01em', color: signColor(grpDailyAbs),
                                     filter: privacyMode ? 'blur(5px)' : 'none' }
                        }, grpDailyAbs == null ? '—' : fmtA(grpDailyAbs)),
                        React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 11, fontWeight: 500, color: signColor(grpDailyPct) }
                        }, grpDailyPct != null ? `(${fmtP(grpDailyPct)})` : '')
                    ),
                    React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'baseline', opacity: grpTotalPnl != null ? 1 : 0.65 } },
                        React.createElement('span', {
                            style: { fontFamily: rounded, fontSize: 11, fontWeight: 400, color: C.zinc500, letterSpacing: 0 }
                        }, 'Total'),
                        React.createElement('span', {
                            className: privacyMode ? 'privacy-blur' : '',
                            style: { fontFamily: rounded, fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                     letterSpacing: '-0.01em', color: grpTotalPnl != null ? signColor(grpTotalPnl) : C.zinc600 }
                        }, grpTotalPnl != null ? fmtA(grpTotalPnl) : '—'),
                        grpTotalPct != null
                            ? React.createElement('span', {
                                style: { fontFamily: rounded, fontSize: 11, fontWeight: 500, color: signColor(grpTotalPct) }
                              }, `(${fmtP(grpTotalPct)})`)
                            : grpTotalNullReason
                                ? React.createElement('span', {
                                    style: { fontFamily: rounded, fontSize: 10, fontStyle: 'italic', color: C.zinc600 }
                                  }, grpTotalNullReason)
                                : null
                    )
                )
            ),
            isGrpExpanded && React.createElement('div', {
                style: { marginTop: 6, paddingTop: 4, borderTop: `1px dashed ${C.border}` }
            },
                ...groupPlans.map((plan, ti) =>
                    React.createElement('div', {
                        key: plan.planId || ti,
                        style: {
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: 8, padding: '5px 0',
                            borderTop: ti > 0 ? `1px solid rgba(255,255,255,0.04)` : 'none',
                        }
                    },
                        React.createElement('span', {
                            style: { fontFamily: sys, fontSize: 10, color: C.zinc500,
                                     flex: 1, minWidth: 0, overflow: 'hidden',
                                     textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
                        }, plan.planName || plan.planId || '—'),
                        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
                            React.createElement('span', {
                                style: { fontFamily: mono, fontSize: 10, color: C.zinc600 }
                            }, `${Number(plan.units ?? 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })}u`),
                            plan.vestingDate && plan.vestingDate !== 'Rolling' && React.createElement('span', {
                                style: { fontFamily: sys, fontSize: 10, color: C.amber }
                            }, plan.vestingDate),
                            React.createElement('span', {
                                style: { fontFamily: mono, fontSize: 10, color: C.violet,
                                         fontVariantNumeric: 'tabular-nums',
                                         filter: privacyMode ? 'blur(5px)' : 'none' }
                            }, safeFormatGBP(plan.valueGBP ?? 0, { dp: 0 }))
                        )
                    )
                )
            )
        );
    }
    // ── 4. Institution grouping: RSU and SIP collapse by institution; OPTION renders individually ─
    // OPTION plans keep their specialised layout (progress bar, strike/spread metadata).
    // RSU and SIP plans from the same institution are consolidated into a single grouped card.
    const byInstitution = new Map();
    const renderItems   = [];
    for (const plan of plans) {
        if (plan.category === 'OPTION') {
            renderItems.push({ grouped: false, plan });
            continue;
        }
        const key = plan.institution || '\u2014';
        if (!byInstitution.has(key)) {
            byInstitution.set(key, []);
            renderItems.push({ grouped: true, key });
        }
        byInstitution.get(key).push(plan);
    }
    const finalItems = renderItems.map(item => {
        if (!item.grouped) return item;
        const members = byInstitution.get(item.key) || [];
        if (members.length === 1) return { grouped: false, plan: members[0] };
        return { grouped: true, key: item.key, plans: members };
    });

    // ── 5. Structural layout ──────────────────────────────────────────────────
    return React.createElement('div', {
        style: {
            background: `linear-gradient(180deg, ${C.surfaceHigh} 0%, ${C.surface} 100%)`,
            border: `1px solid ${isExpanded ? C.violet + '55' : C.border}`,
            borderRadius: 20, padding: '14px 16px',
            marginTop: 8, marginBottom: 8,
            transition: 'border-color 150ms ease',
        }
    },
        // Tappable header: label + MetricBlock + plan count + chevron
        React.createElement('button', {
            onClick: () => setIsExpanded(e => !e),
            style: { width: '100%', textAlign: 'left', background: 'none', border: 'none',
                     padding: 0, cursor: 'pointer', WebkitTapHighlightColor: 'transparent', display: 'block' }
        },
            React.createElement('div', null,
                // Header — label yields (ellipsis) before any financial figure does
                React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
                    React.createElement('div', {
                        style: { width: 10, height: 10, borderRadius: '50%', background: C.violet, flexShrink: 0 }
                    }),
                    React.createElement('div', {
                        style: { flex: 1, minWidth: 0, fontFamily: sys, fontSize: 10, lineHeight: '14px', color: C.zinc500,
                                 textTransform: 'uppercase', letterSpacing: '0.18em',
                                 whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                    }, 'Restricted Corporate Schemes'),
                    React.createElement('div', {
                        style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }
                    },
                        React.createElement('span', {
                            style: { fontFamily: sys, fontSize: 11, lineHeight: '14px', color: C.zinc600, whiteSpace: 'nowrap' }
                        }, `${plans.length} plan${plans.length !== 1 ? 's' : ''}`),
                        React.createElement('span', {
                            style: { fontSize: 11, color: C.zinc600, lineHeight: 1,
                                     transition: 'transform 150ms ease',
                                     transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                     display: 'inline-block' }
                        }, '\u25be')
                    )
                ),
                // Content row — values and calculations exactly as before, only the layout changed
                (() => {
                    const rText = safeFormatGBP(totalValue, { dp: 0 });
                    const rSize = compactFitSize(26, rText.length, 16);
                    return React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                        React.createElement('div', { style: compactValueStyle(rSize, privacyMode) },
                            privacyMode ? '\u00a3 \u2022\u2022\u2022,\u2022\u2022\u2022' : rText),
                        React.createElement(CompactMetricGrid, {
                            todayAbs: finalTodayAbs,
                            todayPct: finalTodayPct,
                            totalAbs: currentCompState?.currentRestrictedPerformancePnL ?? null,
                            totalPct: (currentCompState?.currentRestrictedPerformanceBasis > 0
                                       && currentCompState?.currentRestrictedPerformancePnL != null)
                                ? (currentCompState.currentRestrictedPerformancePnL
                                   / currentCompState.currentRestrictedPerformanceBasis)
                                : null,
                            privacyMode,
                        })
                    );
                })()
            )
        ),
        // Expandable breakdown panel
        isExpanded && React.createElement('div', {
            style: {
                margin: '8px -16px -14px', padding: '6px 16px 14px',
                background: 'rgba(0,0,0,0.22)',
                borderTop: `1px solid ${C.border}`,
            }
        },
            ...finalItems.map((item, i) => {
                if (item.grouped)              return renderRSUGroupRow(item.plans, i);
                if (item.plan.category === 'OPTION') {
                    const _optPk = item.plan.planId || item.plan.plan_id || item.plan.trancheId || String(item.plan.planName || '');
                    const _dAbsRaw = (optPlanPrevVal[_optPk] != null) ? (optPlanDailyPnL[_optPk] ?? null) : null;
                    // Suppress display when daily move rounds to £0 (< £0.50) — avoids misleading "-£0" for flat days.
                    const _dAbs = (_dAbsRaw != null && Math.abs(_dAbsRaw) >= 0.50) ? _dAbsRaw : null;
                    // Pct denominator: the line's previous total value (saved cash + accrued bonus + prev intrinsic value),
                    // i.e. what the line was worth before today's move. Dividing by saved cash alone nearly doubled the %
                    // (the saved cash is only about half of what the line is worth), so it looked twice the share's own move.
                    const _optPctBase = optPlanPrevTotal[_optPk] || 0;
                    const _dPct = (_dAbs != null && _optPctBase > 0) ? _dAbs / _optPctBase : null;
                    return renderOptionRow(item.plan, i, _dAbs, _dPct);
                }
                return renderRSURow(item.plan, i);
            })
        )
    );
}
