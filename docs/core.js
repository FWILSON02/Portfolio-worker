// Core: chart primitives, IndexedDB storage, benchmarks, transaction categorising, CSV parsing, currency and date helpers, previous-close logic.
// Loaded by index.html before app.js, in the order core, providers, sync, widgets, components; shares their globals (no module system, no build step).

// ─── Lightweight SVG chart components (replaces Recharts) ──────────────────
// Self-contained, zero dependencies. Supports line, area, and bar charts.
function useDimensions(ref) {
    const [dims, setDims] = React.useState({ width: 0, height: 0 });
    React.useEffect(() => {
        if (!ref.current)
            return;
        const measure = () => {
            if (ref.current) {
                setDims({ width: ref.current.offsetWidth, height: ref.current.offsetHeight });
            }
        };
        const ro = new ResizeObserver(measure);
        ro.observe(ref.current);
        measure();
        return () => ro.disconnect();
    }, []);
    return dims;
}
// Responsive wrapper — measures its container in pixels and passes w/h to child
function SvgResponsive({ height: heightProp, children }) {
    const ref = React.useRef(null);
    const { width, height } = useDimensions(ref);
    // heightProp may be a px number, a string like "92%", or "100%"
    // We always let the div control height via CSS and read the actual pixel height
    return (React.createElement("div", { ref: ref, style: { width: '100%', height: heightProp, display: 'block' } }, width > 0 && height > 0 && React.cloneElement(children, { width, height })));
}
// ── Calendar-aware x-axis ticks (shared by every time-series chart) ──────────────────────────────────
// How far back stored price history is daily. Older history is weekly (Friday closes). A year plus two weeks, so the 1Y
// chart and its starting close are daily too. The daily fetch and the chart's date spine both use it.
const DAILY_HISTORY_DAYS = 380;
// The history rows are NOT evenly spaced in time (weekly before ~a year ago, daily since), so the charts
// place points by DATE, and ticks are placed at real calendar positions: weekdays / Mondays for short windows,
// month starts (every 1, 2, 3, 6 or 12 months, whichever fits) for longer ones. Returns [{ t, label }].
const _TICK_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function buildTimeTicks(t0, t1, widthPx) {
    const DAY = 86400000, span = t1 - t0;
    if (!(span > 0) || !(widthPx > 0)) return [];
    const days = span / DAY;
    const pxPerDay = widthPx / days;
    const dayStart = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
    const fmtDay = t => { const d = new Date(t); return d.getUTCDate() + ' ' + _TICK_MON[d.getUTCMonth()]; };
    const inRange = t => t >= t0 - 1 && t <= t1 + 1;
    const DAY_LABEL_PX = 44;   // room needed by a label such as "28 Sep"
    if (days <= 45) {
        const first = dayStart(t0) < t0 ? dayStart(t0) + DAY : dayStart(t0);
        const weekdays = [];
        for (let t = first; t <= t1 + 1; t += DAY) { const w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) weekdays.push(t); }
        if (pxPerDay >= DAY_LABEL_PX) return weekdays.map(t => ({ t, label: fmtDay(t) }));
        const mondays = weekdays.filter(t => new Date(t).getUTCDay() === 1);
        if (pxPerDay * 7 >= DAY_LABEL_PX) return mondays.map(t => ({ t, label: fmtDay(t) }));
        return mondays.filter((t, i) => i % 2 === 0).map(t => ({ t, label: fmtDay(t) }));
    }
    const a = new Date(t0);
    const months = [];
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); Date.UTC(y, m, 1) <= t1 + 1; m++) {
        if (m > 11) { m = 0; y++; }
        months.push({ y, m, t: Date.UTC(y, m, 1) });
    }
    const usable = months.filter(x => inRange(x.t));
    // Choose the finest month step whose labels fit: "Jan" needs ~32px, "Jan '26" ~48px, "2026" ~30px.
    let picked = usable, multiYear = false, yearsOnly = false;
    for (const step of [1, 2, 3, 6, 12]) {
        picked = usable.filter(x => x.m % step === 0);
        multiYear = new Set(picked.map(x => x.y)).size > 1;
        yearsOnly = picked.length >= 2 && multiYear && picked.every(x => x.m === 0);
        const need = yearsOnly ? 30 : multiYear ? 48 : 32;
        let minGap = Infinity;
        for (let i = 1; i < picked.length; i++) minGap = Math.min(minGap, (picked[i].t - picked[i - 1].t) / DAY * pxPerDay);
        if (minGap >= need) break;
    }
    if (picked.length === 0) picked = usable.slice(0, 1);
    return picked.map(x => ({ t: x.t, label: yearsOnly ? String(x.y)
        : (multiYear ? _TICK_MON[x.m] + " '" + String(x.y).slice(2) : _TICK_MON[x.m]) }));
}
// Index of the point whose x is closest to relX (xs must be ascending). Used for touch/hover scrubbing.
function nearestIndexByX(xs, relX) {
    if (!xs || !xs.length) return 0;
    let lo = 0, hi = xs.length - 1;
    if (relX <= xs[lo]) return lo;
    if (relX >= xs[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= relX) lo = mid; else hi = mid; }
    return (relX - xs[lo] <= xs[hi] - relX) ? lo : hi;
}
function SvgChart({ data, series, width, height, margin, xKey, xFormat, yFormat, yDomain, gridColor, axisColor, labelColor, tooltipFormat }) {
    gridColor = gridColor || '#1e2530';
    axisColor = axisColor || '#6b6b76';
    labelColor = labelColor || '#a1a1aa';
    const m = Object.assign({ top: 10, right: 12, bottom: 28, left: 38 }, margin || {});
    const W = Math.max(1, width - m.left - m.right);
    const H = Math.max(1, height - m.top - m.bottom);
    const [hover, setHover] = React.useState(null);
    if (!data || data.length === 0)
        return null;
    // Y domain
    const allY = [];
    for (let i = 0; i < data.length; i++) {
        for (let j = 0; j < series.length; j++) {
            const v = data[i][series[j].key];
            if (v != null && isFinite(v))
                allY.push(v);
        }
    }
    if (allY.length === 0)
        return null;
    let yMin = yDomain ? yDomain[0] : Math.min.apply(null, allY);
    let yMax = yDomain ? yDomain[1] : Math.max.apply(null, allY);
    const yPad = (yMax - yMin) * 0.05 || 1;
    if (!yDomain) {
        yMin -= yPad;
        yMax += yPad;
    }
    const xLen = data.length - 1;
    // Place points by DATE when the x values are ISO dates (the history is weekly for older data and daily recently, so
    // index spacing would stretch recent weeks and squash old ones). Otherwise fall back to even spacing by index.
    const _times = data.map(r => { const d = r && r[xKey]; return (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) ? Date.parse(d.slice(0, 10) + 'T12:00:00Z') : NaN; });
    const dateScaled = xKey && data.length > 1 && _times.every(Number.isFinite) && _times[xLen] > _times[0];
    const _t0 = dateScaled ? _times[0] : 0, _span = dateScaled ? _times[xLen] - _times[0] : 1;
    const xsAll = data.map((r, i) => dateScaled ? ((_times[i] - _t0) / _span) * W : (xLen === 0 ? W / 2 : (i / xLen) * W));
    const px = (i) => xsAll[i];
    const py = (v) => H - ((v - yMin) / (yMax - yMin)) * H;
    // Y ticks: "nice" steps (1, 2, 2.5, 5 x 10^n) for ANY magnitude, so a low-priced fund (0.7) or a large value (17,000)
    // always gets a labelled scale — the old fixed ladder gave sub-5 ranges no ticks at all.
    const yRange = yMax - yMin;
    const maxTicksAllowed = H < 100 ? 3 : 6; // Clean boundaries in tight viewports
    const _rough = yRange / Math.max(1, maxTicksAllowed - 1);
    const _mag = Math.pow(10, Math.floor(Math.log10(_rough > 0 ? _rough : 1)));
    const yStep = ([1, 2, 2.5, 5, 10].find(f => f * _mag >= _rough) || 10) * _mag;
    const _stepStr = String(parseFloat(yStep.toPrecision(6)));
    const yDecimals = _stepStr.indexOf('.') >= 0 ? Math.min(6, _stepStr.split('.')[1].length) : 0;
    const yTicks = [];
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + yStep * 1e-6 && yTicks.length < maxTicksAllowed; v += yStep) {
        yTicks.push(parseFloat(v.toFixed(10)));
    }
    // X ticks
    let xTickObjs = [];
    if (dateScaled) {
        xTickObjs = buildTimeTicks(_t0, _t0 + _span, W).map(k => ({ x: ((k.t - _t0) / _span) * W, label: k.label }));
    } else {
        const maxXTicks = Math.max(2, Math.floor(W / 55));
        const xStep = Math.max(1, Math.ceil(data.length / maxXTicks));
        for (let i = 0; i < data.length; i += xStep)
            xTickObjs.push({ x: px(i), label: xFormat && data[i] ? xFormat(data[i][xKey], i) : (data[i] ? String(data[i][xKey]) : '') });
    }
    // Build SVG path for a series
    function makePath(s) {
        let d = '';
        let inSeg = false;
        for (let i = 0; i < data.length; i++) {
            const v = data[i][s.key];
            if (v == null || !isFinite(v)) {
                inSeg = false;
                continue;
            }
            const x = px(i).toFixed(1), y = py(v).toFixed(1);
            d += inSeg ? ('L' + x + ',' + y) : ('M' + x + ',' + y);
            inSeg = true;
        }
        return d;
    }
    function makeArea(s) {
        const baseY = s.baseY != null ? s.baseY : yMin;
        let segs = [];
        let cur = null;
        for (let i = 0; i < data.length; i++) {
            const v = data[i][s.key];
            if (v == null || !isFinite(v)) {
                if (cur) {
                    segs.push(cur);
                    cur = null;
                }
                continue;
            }
            if (!cur)
                cur = [];
            cur.push({ x: px(i), y: py(v) });
        }
        if (cur)
            segs.push(cur);
        return segs.map(seg => {
            const top = seg.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join('L');
            const base = seg.slice().reverse().map(p => p.x.toFixed(1) + ',' + py(baseY).toFixed(1)).join('L');
            return 'M' + top + 'L' + base + 'Z';
        }).join(' ');
    }
    // Hover handling
    const svgRef = React.useRef(null);
    function onMove(e) {
        if (!svgRef.current || !data.length)
            return;
        const rect = svgRef.current.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const mouseX = clientX - rect.left - m.left;
        setHover(nearestIndexByX(xsAll, mouseX));
    }
    const hoverD = hover != null ? data[hover] : null;
    const tooltipX = hover != null ? Math.min(m.left + px(hover) + 12, width - 170) : 0;
    return (React.createElement("svg", { ref: svgRef, width: width, height: height, onMouseMove: onMove, onMouseLeave: () => setHover(null), onTouchMove: onMove, onTouchEnd: () => setHover(null), style: { display: 'block', userSelect: 'none', touchAction: 'none' } },
        React.createElement("defs", null, series.filter(s => s.area).map(s => (React.createElement("linearGradient", { key: s.key + '_g', id: s.key + '_g', x1: "0", y1: "0", x2: "0", y2: "1" },
            React.createElement("stop", { offset: "0%", stopColor: s.color, stopOpacity: s.areaOpacity != null ? s.areaOpacity : 0.2 }),
            React.createElement("stop", { offset: "100%", stopColor: s.color, stopOpacity: 0 }))))),
        React.createElement("g", { transform: 'translate(' + m.left + ',' + m.top + ')' },
            yTicks.map((v, i) => (React.createElement("line", { key: i, x1: 0, x2: W, y1: py(v).toFixed(1), y2: py(v).toFixed(1), stroke: gridColor, strokeWidth: 1, strokeDasharray: "4 6" }))),
            yMin < 0 && yMax > 0 && (React.createElement("line", { x1: 0, x2: W, y1: py(0).toFixed(1), y2: py(0).toFixed(1), stroke: axisColor, strokeWidth: 1, strokeDasharray: "2 4" })),
            series.filter(s => s.area).map(s => (React.createElement("path", { key: s.key + '_a', d: makeArea(s), fill: 'url(#' + s.key + '_g)' }))),
            series.map(s => {
                if (!s.width && s.width !== 0)
                    s = Object.assign({}, s, { width: 2 });
                if (s.width === 0)
                    return null;
                return (React.createElement("path", { key: s.key, d: makePath(s), stroke: s.color, strokeWidth: s.width, strokeDasharray: s.dash || 'none', strokeOpacity: s.opacity != null ? s.opacity : 1, fill: "none" }));
            }),
            hover != null && (React.createElement("line", { x1: px(hover).toFixed(1), x2: px(hover).toFixed(1), y1: 0, y2: H, stroke: "#888894", strokeWidth: 1, strokeDasharray: "3 4" })),
            hover != null && series.map(s => {
                if (!s.width)
                    return null;
                const v = hoverD && hoverD[s.key];
                if (v == null || !isFinite(v))
                    return null;
                return React.createElement("circle", { key: s.key + '_dot', cx: px(hover).toFixed(1), cy: py(v).toFixed(1), r: 4, fill: s.color, stroke: "#000", strokeWidth: 1.5 });
            }),
            React.createElement("line", { x1: 0, x2: 0, y1: 0, y2: H, stroke: axisColor, strokeWidth: 1 }),
            React.createElement("line", { x1: 0, x2: W, y1: H, y2: H, stroke: axisColor, strokeWidth: 1 }),
            yTicks.map((v, i) => (React.createElement("text", { key: i, x: -5, y: py(v).toFixed(1), textAnchor: "end", dominantBaseline: "middle", fill: labelColor, fontSize: 10, fontFamily: "JetBrains Mono" }, yFormat ? yFormat(v) : v.toFixed(yDecimals)))),
            xTickObjs.map((tk, ti) => (React.createElement("g", { key: 'xt' + ti },
                React.createElement("line", { x1: tk.x.toFixed(1), x2: tk.x.toFixed(1), y1: H, y2: H + 3, stroke: axisColor, strokeWidth: 1 }),
                React.createElement("text", { x: tk.x.toFixed(1), y: H + 14, textAnchor: tk.x < 16 ? "start" : tk.x > W - 16 ? "end" : "middle", fill: labelColor, fontSize: 10, fontFamily: "JetBrains Mono" }, tk.label)))),
            // ── Trade markers: buy (green) and sell (red) circles on price line ──
            // Rendered when data points carry buyPrice or sellPrice properties (ticker detail chart).
            data.map((d, i) => {
                const priceKey = series.length > 0 ? series[0].key : null;
                const yVal = priceKey ? d[priceKey] : null;
                if (yVal == null || !isFinite(yVal)) return null;
                const markers = [];
                if (d.buyPrice != null) markers.push(
                    React.createElement('g', { key: 'buy_' + i },
                        React.createElement('circle', { cx: px(i).toFixed(1), cy: py(yVal).toFixed(1), r: 6, fill: '#34d399', stroke: '#080c10', strokeWidth: 1.5, opacity: 0.9 }),
                        React.createElement('text', { x: px(i).toFixed(1), y: (py(yVal) - 9).toFixed(1), textAnchor: 'middle', fill: '#34d399', fontSize: 8, fontFamily: 'JetBrains Mono' }, 'B')
                    )
                );
                if (d.sellPrice != null) markers.push(
                    React.createElement('g', { key: 'sell_' + i },
                        React.createElement('circle', { cx: px(i).toFixed(1), cy: py(yVal).toFixed(1), r: 6, fill: '#f87171', stroke: '#080c10', strokeWidth: 1.5, opacity: 0.9 }),
                        React.createElement('text', { x: px(i).toFixed(1), y: (py(yVal) - 9).toFixed(1), textAnchor: 'middle', fill: '#f87171', fontSize: 8, fontFamily: 'JetBrains Mono' }, 'S')
                    )
                );
                return markers.length > 0 ? React.createElement(React.Fragment, { key: 'markers_' + i }, ...markers) : null;
            })),
        hover != null && hoverD && (React.createElement("foreignObject", { x: tooltipX, y: m.top + 4, width: 165, height: 180, style: { pointerEvents: 'none' } },
            React.createElement("div", { style: {
                    background: '#0d1218', border: '1px solid #27272a', borderRadius: 10,
                    fontFamily: 'JetBrains Mono', fontSize: 11, padding: '8px 12px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.7)', color: '#e4e4e7',
                } },
                React.createElement("div", { style: { color: '#a1a1aa', marginBottom: 6, fontSize: 10 } }, hoverD[xKey]),
                series.map(s => {
                    const v = hoverD[s.key];
                    if (v == null || !isFinite(v))
                        return null;
                    return (React.createElement("div", { key: s.key, style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 3 } },
                        React.createElement("span", { style: { color: s.color } }, s.label),
                        React.createElement("span", null, tooltipFormat ? tooltipFormat(v, s.key, hoverD) : v.toFixed(1))));
                }))))));
}
// ─── IndexedDB persistence ──────────────────────────────────────────────────
// Small async wrapper around IndexedDB. We store three things:
//   - kv['transactions']  → the full transactions array
//   - kv['prices']        → the full prices map {ticker: [{date, close}]}
//   - kv['meta']          → { savedAt, txCount, seriesCount, source }
// Single object store keyed by string — keeps the wrapper trivial and lets
// us atomically save/load without orchestrating multiple stores.
const IDB_NAME = 'portfolio-pf';
const IDB_STORE = 'kv';
const IDB_VERSION = 1;
function openIDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined')
            return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE))
                db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbGet(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbSet(key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function idbClearAll() {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function idbDelete(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
// Format a "saved at" timestamp into a relative phrase ("2h ago")
function relTime(ts) {
    if (!ts)
        return '';
    const diff = (Date.now() - ts) / 1000;
    if (diff < 60)
        return 'just now';
    if (diff < 3600)
        return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400)
        return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
}
// Benchmark catalog. Each entry tells us which price-series sheet to look for and how to convert
// it to GBP. fxTicker = null means it's already in GBP. SPX is always shown; NDX and URTH appear
// in the chip selector only if the corresponding xlsx sheet was uploaded.
// To add a new benchmark: add an entry here, add a matching sheet to the prices xlsx with
// `date` and `close` columns, and it'll be picked up automatically.
const BENCHMARKS = [
    { id: '^GSPC', label: 'S&P 500 total return', short: 'SPXT', color: '#60a5fa', fxTicker: 'GBPUSD=X' },
    { id: '^NDX', label: 'NASDAQ 100', short: 'NDX', color: '#a78bfa', fxTicker: 'GBPUSD=X' },
    { id: 'URTH', label: 'MSCI World', short: 'WORLD', color: '#34d399', fxTicker: 'GBPUSD=X' },
];
// The S&P benchmark is Yahoo's S&P 500 TOTAL RETURN index (dividends reinvested), fetched like ^GSPC (Fergus: call it SPXT).
// The plain index stays for the Markets screen and the legend's level; if the total-return history is missing the benchmark
// falls back to the price index and is called SPX until it arrives.
const BENCH_TR_TICKER = '^SP500TR';
let spxLabelNow = 'SPXT';
function spxLabel() { return spxLabelNow; }
const PROXIES = {
};

// ── Canonical market-series normalizer ────────────────────────────────────────
// Deduplicates by date (last entry wins), validates close prices, and rejects
// weekends. No interpolation is ever performed — only genuine traded closes are
// returned. Used exclusively by the SPX benchmark chart pipeline so the visible
// benchmark line contains only real index closes, never synthetic ones.
function normalizeMarketSeries(rawSeries, opts) {
    const _o = opts || {};
    const allowWeekends = _o.allowWeekends === true;
    const minDate = _o.minDate || '2000-01-01';
    const maxDate = _o.maxDate || '2100-01-01';
    const byDate = new Map();
    for (const row of (rawSeries || [])) {
        const date  = String(row.date  || '').slice(0, 10);
        const close = Number(row.close);
        if (!date || date < minDate || date > maxDate) continue;
        if (!Number.isFinite(close) || close <= 0)    continue;
        if (!allowWeekends) {
            const dow = new Date(date + 'T12:00:00Z').getUTCDay();
            if (dow === 0 || dow === 6) continue;
        }
        byDate.set(date, close);
    }
    return Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, close]) => ({ date, close }));
}

// ── Canonical S&P 500 benchmark: ONE series, read by the chart, the cards and the attribution ────────────────
// In GBP (the close divided by GBP/USD on the same date); the total-return index (^SP500TR) when stored, else the price index. Built from the stored
// history plus the live quote. Only rows that are provably invalid are dropped: weekends, NYSE-holiday rows in daily
// data, and exact carried-forward copies of the previous close. Genuine large moves are never removed (the old reversal guard
// deleted 23 real weekly closes, including the -9.1% week of 4 Apr 2025).
const BENCH_MAX_STALE_DAYS = 5;    // weekend + a holiday; older than this gives no benchmark point (a gap, not a stale carry)
const BENCH_CARRY_TOL = 3e-6;      // consecutive closes within this (~0.02 index points) are a carried-forward copy, not a market move
function _isoDayDiff(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
// true / false, or null when the holiday calendar does not cover that year.
function isNyseHoliday(dateStr) {
    const spec = EXCHANGE_CALENDARS && EXCHANGE_CALENDARS.NYSE;
    if (!spec || !spec.holidays) return null;
    if (!spec.years.includes(Number(String(dateStr).slice(0, 4)))) return null;
    return spec.holidays.has(String(dateStr).slice(0, 10));
}
function cleanSpxCloses(rawSeries) {
    const dropped = { holidays: [], carried: [] };
    const rows = normalizeMarketSeries(rawSeries || [], { allowWeekends: false });   // dedupe, validate, no weekends
    const out = [];
    for (const r of rows) {
        const prev = out[out.length - 1];
        const dailyHere = !!prev && _isoDayDiff(prev.date, r.date) <= 4;   // the series is daily around this row
        // A holiday-dated row in DAILY data is a phantom. In WEEKLY data a bar stamped on a holiday Friday (Good Friday,
        // Juneteenth) holds that week's last real close, so it is kept: dropping it would leave a two-week gap.
        if (dailyHere && isNyseHoliday(r.date) === true) { dropped.holidays.push(r.date); continue; }
        if (dailyHere && Math.abs(r.close / prev.close - 1) <= BENCH_CARRY_TOL) {
            dropped.carried.push(r.date); continue;   // keep the first appearance, drop the stale copy
        }
        out.push(r);
    }
    return { rows: out, dropped };
}
// Latest row on or before dateStr, or null if there is none within maxStaleDays. `sorted` is ascending by date.
function seriesValueOnOrBefore(sorted, dateStr, maxStaleDays) {
    let lo = 0, hi = sorted.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid].date <= dateStr) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found < 0) return null;
    const staleDays = _isoDayDiff(sorted[found].date, dateStr);
    if (staleDays < 0 || staleDays > maxStaleDays) return null;
    return { row: sorted[found], staleDays };
}
function buildSpxGbpSeries(opts) {
    const o = opts || {};
    const cleaned = cleanSpxCloses(o.spxRaw);
    let spx = cleaned.rows;
    const ls = o.liveSession, lp = Number(o.liveSpx);
    let liveUsed = false;
    if (ls && Number.isFinite(lp) && lp > 0) {
        const dow = new Date(ls + 'T12:00:00Z').getUTCDay();
        const last = spx.length ? spx[spx.length - 1].date : '';
        if (dow !== 0 && dow !== 6 && isNyseHoliday(ls) !== true && ls >= last) {
            spx = (ls === last ? spx.slice(0, -1) : spx).concat([{ date: ls, close: lp }]);
            liveUsed = true;
        }
    }
    const fx = normalizeMarketSeries(o.fxRaw || [], { allowWeekends: true });
    const rows = []; let rowsWithoutFx = 0;
    for (const r of spx) {
        const f = seriesValueOnOrBefore(fx, r.date, 7);
        if (!f) { rowsWithoutFx++; continue; }
        rows.push({ date: r.date, usd: r.close, fx: f.row.close, fxDate: f.row.date, gbp: r.close / f.row.close });
    }
    return { rows, dropped: cleaned.dropped, liveUsed, rowsWithoutFx };
}
// One row per calendar week (the last row of each week), plus the first row as the starting point. The history is
// weekly for older data and daily for the last ~year, so risk statistics are computed on this weekly sample:
// every step is then about one week, and annualising by steps-per-year is valid.
function sampleWeeklyRows(rows) {
    if (!rows || rows.length < 2) return rows ? rows.slice() : [];
    const mon = d => { const t = new Date(d + 'T12:00:00Z'); const w = t.getUTCDay(); t.setUTCDate(t.getUTCDate() + (w === 0 ? -6 : 1 - w)); return t.toISOString().slice(0, 10); };
    const firstWeek = mon(rows[0].date);
    const out = [rows[0]];
    let curKey = null, cur = null;
    for (let i = 1; i < rows.length; i++) {
        const k = mon(rows[i].date);
        if (k === firstWeek) continue;
        if (cur && k !== curKey) out.push(cur);
        curKey = k; cur = rows[i];
    }
    if (cur) out.push(cur);
    return out;
}

// ── Internal transfers ────────────────────────────────────────────────────────────────────────────────────────
// A gift between two accounts in the same ledger (e.g. to a spouse's ISA) shows up as a Transfer Out on one account
// (value 0) and a Transfer In on the other (value = cost basis) for the same units. Counted separately, the In leg
// looked like new money and the Out leg like a loss. A matched pair is an internal move: no external cash flow, units
// and cost basis unchanged overall. Legs with no partner stay external.
function markInternalTransfers(rows) {
    const isVest = t => /^(AWARD VEST|STOCK AWARD VEST|RSU VEST)$/.test(String(t.reference || '').toUpperCase());
    const num = q => parseFloat(String(q || '').replace(/,/g, '')) || 0;
    const tkOf = t => t.instrument && t.instrument.ticker;
    const legs = rows.filter(t => (t.category === 'transfer_out' || t.category === 'transfer_in') && tkOf(t) && tkOf(t) !== 'UNTICKERED' && !isVest(t));
    const outs = legs.filter(t => t.category === 'transfer_out').sort((a, b) => a.parsedDate - b.parsedDate);
    const ins = legs.filter(t => t.category === 'transfer_in');
    const used = new Set(), pairs = [];
    for (const o of outs) {
        const q = num(o.quantity);
        if (!(q > 0)) continue;
        let best = null, bestGap = Infinity;
        for (const i of ins) {
            if (used.has(i) || tkOf(i) !== tkOf(o)) continue;
            if (Math.abs(num(i.quantity) - q) > Math.max(1e-6, q * 1e-6)) continue;
            const gap = Math.abs(i.parsedDate - o.parsedDate) / 86400000;
            if (gap <= 3 && gap < bestGap) { best = i; bestGap = gap; }
        }
        if (best) {
            used.add(best); o.internalTransfer = true; best.internalTransfer = true;
            pairs.push({ ticker: tkOf(o), qty: q, outDate: o.parsedDate.toISOString().slice(0, 10), inDate: best.parsedDate.toISOString().slice(0, 10),
                         outAccount: o.account || '', inAccount: best.account || '', value: Math.abs(Number(best.value) || 0) });
        }
    }
    const unmatched = legs.filter(t => !t.internalTransfer).map(t => ({ ticker: tkOf(t), category: t.category, qty: num(t.quantity),
        date: t.parsedDate.toISOString().slice(0, 10), account: t.account || '', value: Number(t.value) || 0 }));
    return { pairs, unmatched };
}
// Which instruments sit OUTSIDE the performance measurement. Gilts, cash-like funds (money-market funds, ultra-short
// income funds) and bond funds are not equity, so they are left out of performance, the S&P comparison, XIRR and risk.
// Classification is by ticker and by the descriptions on that ticker's ledger rows. Returns 'gilt' | 'cashlike' | 'bond' | null.
function performanceExclusionClass(ticker, descriptions) {
    const text = (descriptions || []).join(' | ');
    if ((typeof GILT_LADDER_REGISTRY !== 'undefined' && GILT_LADDER_REGISTRY && GILT_LADDER_REGISTRY[ticker]) || /\bgilt\b/i.test(text)) return 'gilt';
    if (/money[\s-]*market|ultra[\s-]*short|short[\s-]*term\s+money|liquidity\s+fund|overnight/i.test(text)) return 'cashlike';
    if (/\bbonds?\b/i.test(text)) return 'bond';
    return null;
}
// Today's figures for the chart with the excluded sleeve (gilts, cash-like and bond funds) taken out: value and change lose the gilts, and the % change is
// recomputed on the ex-gilt opening value.
function excludeGiltsFromToday(p, g) {
    if (!p || p.totalValue == null || !g || !(g.value > 0)) return p;
    const total = p.totalValue - g.value;
    const abs = p.abs != null ? p.abs - (g.abs || 0) : null;
    const prior = abs != null ? total - abs : null;
    return { abs, pct: (abs != null && prior > 0) ? abs / prior : p.pct, totalValue: total };
}
function finaliseEnriched(rows) {
    Object.defineProperty(rows, '__transfers', { value: markInternalTransfers(rows), enumerable: false });
    return rows;
}

// ── Price-unit audit ──────────────────────────────────────────────────────────────────────────────────────────
// The currency label of a ticker comes from its latest quote (or the config file) and is applied to ALL its stored
// history, so a series stored in pounds but labelled pence is valued at 1% of its worth. The audit compares the price
// actually paid per unit in the ledger (GBP) with the stored price on the trade date: a ratio near 1 means the series is
// in pounds, near 100 in pence, near GBP/USD in dollars. A GBP<->pence disagreement is corrected automatically (the
// factor of 100 cannot be a dividend or timing effect) and not shown anywhere. Anything else
// is reported and left alone.
function auditPriceUnits(enriched, prices, currencyMap, quoteCurrencies) {
    const res = { perTicker: {}, corrections: {}, warnings: [] };
    if (!enriched || !prices) return res;
    const fx = normalizeMarketSeries(prices['GBPUSD=X'] || [], { allowWeekends: true });
    const med = a => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
    const byTk = {};
    for (const t of enriched) {
        if (t.category !== 'buy' && t.category !== 'sell') continue;
        const tk = t.instrument && t.instrument.ticker;
        if (!tk || tk === 'UNTICKERED') continue;
        const qty = parseFloat(String(t.quantity || '').replace(/,/g, '')) || 0, val = Math.abs(Number(t.value));
        if (!(qty > 0) || !(val > 0)) continue;
        const ser = prices[tk];
        if (!ser || !ser.length) continue;
        const ds = t.parsedDate.toISOString().slice(0, 10);
        const p = seriesValueOnOrBefore(ser.map(r => ({ date: String(r.date).slice(0, 10), close: Number(r.close) })), ds, 10);
        if (!p || !(p.row.close > 0)) continue;
        const f = seriesValueOnOrBefore(fx, ds, 10);
        (byTk[tk] = byTk[tk] || []).push({ ratio: p.row.close / (val / qty), fx: f ? f.row.close : 1.3 });
    }
    for (const [tk, arr] of Object.entries(byTk)) {
        const mRatio = med(arr.map(x => x.ratio)), mFx = med(arr.map(x => x.fx));
        const expect = { GBP: 1, GBX: 100, USD: mFx };
        let best = null, bd = Infinity;
        for (const h of ['GBP', 'GBX', 'USD']) { const d = Math.abs(Math.log(mRatio / expect[h])); if (d < bd) { bd = d; best = h; } }
        const labeled = resolveQuoteCurrency(tk, currencyMap);
        const confident = bd <= Math.log(1.4);
        const rec = { n: arr.length, ratio: mRatio, best, labeled, confident, corrected: false };
        res.perTicker[tk] = rec;
        if (!confident || !labeled || best === labeled) continue;
        const pair = (labeled === 'GBP' && best === 'GBX') || (labeled === 'GBX' && best === 'GBP');
        const hasQuote = !!quoteCurrencies && Object.keys(quoteCurrencies).some(k => k.toUpperCase() === tk.toUpperCase());
        if (pair && !hasQuote && (arr.length >= 2 || bd <= Math.log(1.25))) { res.corrections[tk] = best; rec.corrected = true; }
        else res.warnings.push({ ticker: tk, labeled, best, ratio: mRatio, n: arr.length, reason: pair ? (hasQuote ? 'quote' : 'few') : 'family' });
    }
    return res;
}

// ── Money-weighted view: external flows, XIRR, and "the same deposits in the S&P" ─────────────────────────────────
// External flows are exactly the ones the TWR engine treats as external (internal transfer pairs excluded).
// amount > 0 = money into the portfolio.
function externalFlowsFromLedger(enriched) {
    const out = [];
    for (const t of [...enriched].sort((a, b) => a.parsedDate - b.parsedDate)) {
        if (t.internalTransfer) continue;
        const ds = t.parsedDate.toISOString().slice(0, 10), v = Number(t.value) || 0;
        if (t.category === 'subscription' || t.category === 'transfer') out.push({ date: ds, amount: v });
        else if (t.category === 'transfer_out') { if (Math.abs(v) > 0.001) out.push({ date: ds, amount: -v }); }
        else if (t.category === 'transfer_in' && Math.abs(v) > 0.001) out.push({ date: ds, amount: Math.abs(v) });
    }
    return out;
}
// flows: [{ t (ms), amount }] from the INVESTOR's side (deposits negative, final value positive). Annualised, bisection.
function xirrAnnual(flows) {
    if (!flows || flows.length < 2 || !flows.some(f => f.amount < 0) || !flows.some(f => f.amount > 0)) return null;
    const t0 = Math.min(...flows.map(f => f.t)), YR = 365.25 * 86400000;
    const f = r => flows.reduce((a, x) => a + x.amount / Math.pow(1 + r, (x.t - t0) / YR), 0);
    let lo = -0.99, hi = 10;
    if (f(lo) * f(hi) > 0) return null;
    for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
    return (lo + hi) / 2;
}
// Same start value and same deposits/withdrawals on the same dates, but invested in the S&P 500 in GBP.
function sameDepositsInSpx(startDate, startValue, endDate, flows, spxRows) {
    const at = d => { const k = seriesValueOnOrBefore(spxRows, d, 7); return k ? k.row.gbp : null; };
    const p0 = at(startDate), p1 = at(endDate);
    if (!(p0 > 0) || !(p1 > 0)) return null;
    let units = startValue / p0;
    const inv = [{ t: Date.parse(startDate + 'T12:00:00Z'), amount: -startValue }];
    for (const f of flows) {
        const p = at(f.date);
        if (!(p > 0)) return null;
        units += f.amount / p;
        inv.push({ t: Date.parse(f.date + 'T12:00:00Z'), amount: -f.amount });
    }
    const value = units * p1;
    inv.push({ t: Date.parse(endDate + 'T12:00:00Z'), amount: value });
    return { value, flowsInvestor: inv };
}


function categoriseTransaction(row) {
    const ref = (row.reference || '').toUpperCase();
    const desc = (row.description || '').toLowerCase();

    // Core structural check: does this row carry an active investment ticker?
    // parseCSV normalises blank tickers to 'n/a', so the toLowerCase check is safe.
    const hasTicker = row.yahooTicker && row.yahooTicker.toLowerCase() !== 'n/a';

    // Explicit corporate-award vest: shares that arrive in an account (e.g. CPWM) on the vest date, valued in
    // sterling at that day's rate (Value (\u00a3), sign ignored). Recognised by its Reference code, not by wording,
    // and given the in-specie transfer semantics the engine already has: units + cost basis added, no cash
    // movement, and an external capital injection for TWR (so the vest is not mistaken for investment return).
    if (hasTicker && (ref === 'AWARD VEST' || ref === 'STOCK AWARD VEST' || ref === 'RSU VEST'))
        return 'transfer_in';

    if (ref === 'INTEREST')
        return 'interest';
    // 'manage' alone is too broad — it matches "Managers" in fund names like
    // "Virgin Direct Unit Trust Managers", miscategorising ISA transfers as fees.
    // HL management fees always have ref='MANAGE FEE'; the desc fallback requires the full phrase.
    if (ref === 'MANAGE FEE' || desc.includes('manage fee'))
        return 'fee';
    // Product transfer from a non-ISA account (e.g. HL Fund & Share) INTO the ISA
    // counts as a new subscription against the £20k allowance.
    if (desc.includes('product transfer'))
        return 'subscription';

    // ─── CASE A: IN-SPECIE ASSET TRANSFERS (row has a live market ticker) ───────
    // Using hasTicker as a gate prevents cash-only rows whose descriptions happen
    // to contain "transfer out" or "transfer from" from being misrouted into the
    // stock-transfer paths (which carry no cash impact).
    if (hasTicker) {
        // Outbound: HL uses ref='Transfer Out' for gifted/in-specie transfers.
        // desc checks cover edge-cases where ref is non-standard.
        if (ref === 'TRANSFER OUT' || desc.includes('transfer out') || desc.includes('gifted transfer away')) {
            return 'transfer_out';
        }
        // Inbound: HL uses ref='Transfer In'. 'transfer from' catches "Gifted Transfer
        // from Husband…" without requiring a 'received' suffix that HL doesn't emit.
        if (desc.includes('transfer in') || desc.includes('transfer from') || desc.includes('gifted transfer received')) {
            return 'transfer_in';
        }
    }
    // ─── CASE B: PURE CASH MOVEMENTS (no ticker — cash in/out, savings moves) ──
    else {
        // "Transfer to Active Savings Account", "Dummy Transfer Out" and similar
        // cash-deduction rows must generate a cash impact ('transfer' is handled in
        // accountCashMap like a subscription). Without this gate they fall through to
        // 'other' and their cash value is silently discarded.
        // FPD = HL's "Payment to Client Bank Account" reference code — a portfolio
        // withdrawal. Adding both the ref guard and a description match prevents
        // future false positives if HL reuses FPD for other purposes.
        if (desc.includes('transfer out') || desc.includes('transfer to') || ref === 'TRANSFER'
            || ref === 'FPD' || desc.includes('payment to client bank')) {
            return 'transfer';
        }
    }

    // ISA-to-ISA transfers (old ISA money moving between providers) — do NOT count against allowance.
    // "Transfer Subscription HBOS/Virgin/Natwest" are incoming ISA transfers despite the word "subscription".
    if (desc.includes('transfer subscription') || desc.includes('transfer from'))
        return 'transfer';
    // New cash subscriptions: opening sub, HL receipt (FPC ref), or card payments
    if (desc.includes('opening subscription') || desc.includes('isa receipt') || ref === 'FPC' || ref.startsWith('CARD'))
        return 'subscription';
    if (ref.startsWith('B'))
        return 'buy';
    if (ref.startsWith('S'))
        return 'sell';
    return 'other';
}
// ─── Synthetic ticker guard ───────────────────────────────────────────────────
// A ticker is "synthetic" (internal cost-basis code, not a real market symbol)
// if it is absent, is the literal string "n/a", or contains no suffix characters
// that real exchange symbols always carry (dot, equals, caret).
// Examples: T26A, TN28, JPM_MM → synthetic.  FLRK.L, ^GSPC, GBPUSD=X → real.
// ─── Multi-alias schema dictionary ───────────────────────────────────────────
// Each key maps to a regex that matches all known column header variants for that
// field. Adding a new alias here is the only change needed to support a renamed
// column — no code elsewhere requires touching.
const SCHEMA_ALIASES = {
    tradeDate:   /^(trade date|date|transaction date|deal date)/i,
    settleDate:  /^(settle date|settlement date|value date)/i,
    reference:   /^(reference|ref|bargain reference|id)/i,
    description: /^(description|narrative|asset description|name)/i,
    unitCost:    /^(unit cost|price|deal price|cost per unit)/i,
    quantity:    /^(quantity|qty|units|volume)/i,
    value:       /^(value|amount|net amount|total value)/i,
    yahooTicker: /^(yahoo ticker|yahoo symbol|ticker|symbol|ticker_y)/i,
    stooqTicker: /^(stooq ticker|stooq symbol|stooq code|ticker_s)/i,
    currency:    /^(currency|ccy|currency code)/i,
    account:     /^(account|portfolio account|wrapper|sub-account)$/i,
    assetName:   /^(asset name|display name|fund name|instrument name)/i,
    sector:      /^(sector|asset class|category)/i,
    status:      /^(status|holding status|position status)/i,
    // Optional audit columns for an Award Vest row: price per share in the row's Currency, and the GBP/USD rate
    // used to state Value (\u00a3). Only used to cross-check that value; never to compute one.
    localPrice:  /^(vest price|award price|local price)/i,
    fxRate:      /^(fx\b|fx rate|gbp\/usd)/i,
};
function isSyntheticTicker(ticker) {
    if (!ticker || ticker.toLowerCase() === 'n/a') return true;
    if (ticker.startsWith('^') || ticker.includes('=') || ticker.includes('.')) return false;
    return true; // no exchange suffix — internal code
}
// A ticker is a real market listing if it carries an exchange suffix, OR the file states it is quoted in a
// foreign currency. isSyntheticTicker() alone treats a bare US symbol such as Citi "C" as an internal code
// (right for gilts and money-market codes, which are GBP); a USD line in the ledger is a real, priced security.
// Open, listed tickers with fewer than 2 stored history points: a ticker new to the ledger (e.g. the first USD line)
// has no history to chart, and waiting for the next London day's refresh would leave it flat at cost meanwhile.
function tickersMissingHistory(tickers, pricesMap, isOpen, isListed) {
    return (tickers || []).filter(tk => tk && isListed(tk) && isOpen(tk) && ((pricesMap && pricesMap[tk]) || []).length < 2);
}
function isListedTicker(ticker, currencyMap) {
    if (!ticker || String(ticker).toLowerCase() === 'n/a') return false;
    if (!isSyntheticTicker(ticker)) return true;
    const c = lookupCurrency(currencyMap, ticker);
    return !!c && c !== 'GBP' && c !== 'GBX';
}
// ── Keyword-driven sector classification ───────────────────────────────────
// Applied when the CSV sector column is absent or defaults to 'Other'.
// Reads asset description and ticker to infer a sector bucket.
function classifySectorByKeyword(name, ticker) {
    const n = (name || '').toLowerCase();
    const t = (ticker || '').toLowerCase();
    if (/gilt|treasury bond|gov.{0,4}bond|sovereign debt|fixed income|t-bill/i.test(n)) return 'Bonds/Gilts';
    if (/money market|cash fund|liquidity fund|short.?term cash/i.test(n)) return 'Cash/Liquidity';
    if (/semiconductor|chip|nvidia|amd|asml|tsmc|arm hold/i.test(n + ' ' + t)) return 'Technology';
    if (/nasdaq|tech etf|technology etf|software|cloud|digital|data center/i.test(n)) return 'Technology';
    if (/bank|financ|insurance|asset manag|capital markets/i.test(n)) return 'Financials';
    if (/health|pharma|biotech|medic|life science/i.test(n)) return 'Healthcare';
    if (/energy|oil|gas|renew|solar|wind power/i.test(n)) return 'Energy';
    if (/real estate|reit|property/i.test(n)) return 'Real Estate';
    if (/consumer|retail|food|beverage|household/i.test(n)) return 'Consumer';
    if (/industrial|aerospace|defence|defense|transport/i.test(n)) return 'Industrials';
    if (/material|mining|metals|chemical|commodit/i.test(n)) return 'Materials';
    if (/global|world|msci|s&p 500|all.world|ftse all|developed market/i.test(n)) return 'Global Equity';
    if (/emerging market|em equity/i.test(n)) return 'Emerging Markets';
    if (/us equity|american|s&p|dow jones|russell/i.test(n)) return 'US Equity';
    if (/uk equity|ftse|britain|british/i.test(n)) return 'UK Equity';
    if (/europe|eurozone|stoxx/i.test(n)) return 'European Equity';
    if (/asia|japan|china|pacific/i.test(n)) return 'Asia-Pacific';
    return 'Other';
}
function parseCSV(text) {
    const lines = text.split(/\r?\n/);
    // ── Locate the true header row (skips blank/metadata rows at top of file) ─
    let headerRowIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (lower.includes('trade date') && lower.includes('settle date')) {
            headerRowIndex = i;
            break;
        }
    }
    if (headerRowIndex === -1) return [];

    // ── Hand off to PapaParse for fully RFC 4180-compliant parsing ────────────
    const csvChunk = lines.slice(headerRowIndex).join('\n');
    const parsed = Papa.parse(csvChunk, {
        header:          true,
        skipEmptyLines:  true,
        dynamicTyping:   false,
        transformHeader: h => h.trim(),
    });
    if (!parsed.data || parsed.data.length === 0) return [];

    // extractField: resolves a cell value by matching the row's header keys against
    // a SCHEMA_ALIASES regex, coercing to a trimmed string. Alias-based matching
    // means column renames (e.g. "Qty" instead of "Quantity") are handled here
    // without any other code changes.
    const extractField = (row, aliasRegex) => {
        const key = Object.keys(row).find(k => aliasRegex.test(k.trim()));
        return key != null ? String(row[key] ?? '').trim() : '';
    };

    return parsed.data.map(row => {
        const rawYahoo    = extractField(row, SCHEMA_ALIASES.yahooTicker);
        const rawStooq    = extractField(row, SCHEMA_ALIASES.stooqTicker);
        const rawValue    = extractField(row, SCHEMA_ALIASES.value);
        const rawDesc     = extractField(row, SCHEMA_ALIASES.description);
        // assetName: prefer dedicated "Asset Name" column; fall back to first 50 chars of description.
        // This means all existing CSVs without the column continue to work unchanged.
        const rawAssetName = extractField(row, SCHEMA_ALIASES.assetName) || rawDesc.slice(0, 50).trim();
        return {
            tradeDate:   extractField(row, SCHEMA_ALIASES.tradeDate),
            settleDate:  extractField(row, SCHEMA_ALIASES.settleDate),
            reference:   extractField(row, SCHEMA_ALIASES.reference),
            description: rawDesc,
            unitCost:    extractField(row, SCHEMA_ALIASES.unitCost),
            quantity:    extractField(row, SCHEMA_ALIASES.quantity),
            value:       parseFloat(rawValue.replace(/,/g, '')) || 0,
            yahooTicker: (!rawYahoo || rawYahoo.toLowerCase() === 'n/a') ? 'n/a' : rawYahoo,
            stooqTicker: (!rawStooq || rawStooq.toLowerCase() === 'n/a') ? 'n/a' : rawStooq,
            currency:    extractField(row, SCHEMA_ALIASES.currency)  || 'GBP',
            account:     (extractField(row, SCHEMA_ALIASES.account) || '').trim().toUpperCase() || 'UNASSIGNED ACCOUNT',
            assetName:   rawAssetName,
            sector:      extractField(row, SCHEMA_ALIASES.sector)    || 'Other',
            status:      extractField(row, SCHEMA_ALIASES.status)    || 'active',
            localPrice:  parseFloat(extractField(row, SCHEMA_ALIASES.localPrice).replace(/,/g, '')) || null,
            fxRate:      parseFloat(extractField(row, SCHEMA_ALIASES.fxRate).replace(/,/g, ''))     || null,
        };
    });
}
// ─── Strict data contract: CSV-only instrument resolution ────────────────────
// resolveMetadata is the sole gatekeeper for instrument identification.
// It reads exclusively from the uploaded CSV row — never from TICKER_MAP.
// Returning null immediately routes the row to the Synthetic / Cash Engine,
// eliminating all "ghost" fallback paths where the source of a ticker is ambiguous.
function resolveMetadata(row) {
    const yahooTicker = (row.yahooTicker || '').trim();
    const stooqTicker = (row.stooqTicker || '').trim();
    const currency    = (row.currency    || 'GBP').trim();
    const account     = (row.account     || 'UNASSIGNED ACCOUNT').trim().toUpperCase();
    // Cash / synthetic rows: Yahoo Ticker column is absent or explicit "n/a"
    if (!yahooTicker || yahooTicker.toLowerCase() === 'n/a') return null;
    return { yahooTicker, stooqTicker, currency, account };
}
function parseDate(dmy) {
    const [d, m, y] = dmy.split('/').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}
// pxToGBP: converts a raw native-currency price to GBP.
// currencyMap is a { [yahooTicker]: 'GBP'|'GBX'|'USD' } object built from the
// uploaded CSV, replacing the old static TICKER_CURRENCY constant.
//
// Currency comes from resolveQuoteCurrency: the file's currency for the ticker
// (case-insensitive), else GBX for an LSE line (.L), else unknown → null. An
// unknown currency is refused rather than guessed: the old blanket GBX default
// would have divided a USD price by 100.
// Case-insensitive currency lookup, normalised ('GBp' → 'GBX'); no defaults.
function lookupCurrency(currencyMap, ticker) {
    if (!currencyMap || !ticker) return null;
    const tk = String(ticker).toUpperCase().trim();
    let v = currencyMap[ticker] ?? currencyMap[tk];
    if (v == null) {
        const k = Object.keys(currencyMap).find(kk => String(kk).toUpperCase().trim() === tk);
        if (k) v = currencyMap[k];
    }
    return normaliseQuoteCurrency(v);
}
// Effective currency map used for every market-price conversion: the currency
// Yahoo reported with the ticker's latest accepted quote ("today's currency")
// wins; the file / config currency is used only for tickers Yahoo hasn't
// reported yet. A disagreement is still listed in Settings → Daily close check.
function buildEffectiveCurrencyMap(configCurrencyMap, quoteCurrencies) {
    const out = {};
    Object.entries(configCurrencyMap || {}).forEach(([k, v]) => { const n = normaliseQuoteCurrency(v); if (n) out[_dcUp(k)] = n; });
    Object.entries(quoteCurrencies  || {}).forEach(([k, v]) => { const n = normaliseQuoteCurrency(v); if (n) out[_dcUp(k)] = n; });
    return out;
}
const QUOTE_CURRENCY_KEY = 'quote_currencies_v1';   // Yahoo's latest currency per ticker (localStorage)
function resolveQuoteCurrency(ticker, currencyMap) {
    const n = lookupCurrency(currencyMap, ticker);
    if (n) return n;
    const tk = String(ticker || '').toUpperCase().trim();
    if (tk.endsWith('.L')) return 'GBX';   // LSE line with no quote yet and nothing in the file: pence
    return null;
}
function pxToGBP(ticker, rawPx, gbpusd, currencyMap) {
    const ccy = resolveQuoteCurrency(ticker, currencyMap);
    if (!ccy) return null;   // unknown currency: refuse (pxToGBPWithCurrency would assume GBP)
    return pxToGBPWithCurrency(rawPx, ccy, gbpusd);
}
// Last live price seen for each external-custody ticker, kept across app opens. Live quotes are not
// stored between sessions, and a custody ticker (e.g. Citi "C") has no ledger history to fall back on,
// so without this the card has no price at all until the first live fetch of every launch completes.
// Used only as a LABELLED fallback ("last price <date>"), never in place of a live quote.
const CUSTODY_LAST_PRICE_KEY = 'custody_last_price_v1';
function loadCustodyLastPrices() {
    try { const o = JSON.parse(localStorage.getItem(CUSTODY_LAST_PRICE_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
    catch { return {}; }
}
function saveCustodyLastPrices(o) { try { localStorage.setItem(CUSTODY_LAST_PRICE_KEY, JSON.stringify(o || {})); } catch {} }
// ── External custody: acquisition (vest) details ─────────────────────────────
// An RSU/stock award's cost is its value on the vest date: shares x vest price, in sterling at the GBP/USD
// rate ON that date. That is what makes a Total gain/loss possible for a position with no trade ledger.
// Dates: DD/MM/YYYY (UK; also D/M/YYYY, DD-MM-YYYY, DD.MM.YYYY) or YYYY-MM-DD. Returns 'YYYY-MM-DD' or null.
function parseCustodyDate(v) {
    const t = String(v == null ? '' : v).trim();
    let y, m, d, mt;
    if ((mt = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;   // e.g. 31/02
    return dt.toISOString().slice(0, 10);
}
// Latest rate on or before a date, but only if it is within maxGapDays of it (a weekend or holiday is fine;
// a series that simply doesn't reach back that far is not silently replaced by today's rate).
function rateOnOrBefore(series, iso, maxGapDays) {
    if (!Array.isArray(series) || !iso) return null;
    let hit = null;
    for (const p of series) { if (p.date <= iso) hit = p; else break; }
    if (!hit || !Number.isFinite(Number(hit.close)) || Number(hit.close) <= 0) return null;
    const gap = (Date.parse(iso + 'T00:00:00Z') - Date.parse(hit.date + 'T00:00:00Z')) / 86400000;
    return gap <= (maxGapDays == null ? 7 : maxGapDays) ? { rate: Number(hit.close), date: hit.date } : null;
}
// Fix 1: Explicit currency converter for compensation and external custody rows.
// Uses the 'currency' column from the CSV directly — avoids the tickerCurrencyMap
// GBX default which would misvalue USD tickers (e.g. Citi 'C') not in HL ledger.
// Confirmed: HSBA.L (HSBC on LSE via Yahoo Finance) returns pence → use GBX in the CSV.
function pxToGBPWithCurrency(rawPx, currency, gbpusd) {
    if (rawPx == null || !isFinite(rawPx)) return null;
    // 'GBp' (Yahoo's spelling of pence) must not upper-case into 'GBP' (pounds).
    const ccy = normaliseQuoteCurrency(currency) || 'GBP';
    if (ccy === 'USD') return gbpusd > 0 ? rawPx / gbpusd : null;
    if (ccy === 'GBP') return rawPx;
    if (ccy === 'GBX') return rawPx / 100; // pence → pounds
    return null; // unknown currency — refuse to guess
}
// ── Market-data validity helpers ──────────────────────────────────────────────
// Used by activeHoldingsWithDelta and the JSON restore path to validate live
// previous-close against completed history, preventing stale backups from
// producing incorrect Today insight metrics (e.g. SEMI.L showing wrong direction).

// True when value falls on the same calendar date as right now.
// Accepts Date objects, ISO strings, or restored JSON date strings.
function isSameCalendarDay(value) {
    if (!value) return false;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return false;
    const now = new Date();
    return (
        d.getFullYear() === now.getFullYear() &&
        d.getMonth()    === now.getMonth()    &&
        d.getDate()     === now.getDate()
    );
}

// ── Shared P&L session date helpers ─────────────────────────────────────────
// All market-priced Today P&L paths share these three functions so that
// "today" means the same thing everywhere: the latest completed (or live)
// trading session, not the wall-clock calendar date.


// The current P&L session date string (YYYY-MM-DD).
//   Weekday  → today's UTC date (current or just-closed session).
//   Weekend  → most recent Friday's UTC date (last completed session).
//   Market holidays are not explicitly modelled here; stale/missing closes remain
//   handled by the existing previous-close and completed-daily-move resolvers.
function getCurrentPnlSessionDateStr() {
    const d = new Date();
    const dow = d.getUTCDay();                          // 0=Sun … 6=Sat
    if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);   // Sat → Fri
    if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);   // Sun → Fri
    return d.toISOString().slice(0, 10);
}


// Returns the UTC date string for the trading session immediately before dateStr.
// Mon (dow=1) → 3 days back to Fri.  Any other weekday → 1 day back.
// Input is expected to be a weekday; getCurrentPnlSessionDateStr always maps weekends to Fri.
function previousTradingDayStr(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    const dow = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - (dow === 1 ? 3 : 1));
    return d.toISOString().slice(0, 10);
}

// Maps a live-fetch timestamp to the trading session it actually represents.
// Returns the effective session date string, or null if liveAt is absent/stale.
//
// Two cases are accepted:
//   1. liveAt matches the candidate session date  — normal same-day live quote.
//   2. liveAt matches the previous trading day    — Monday pre-market scenario:
//      Friday liveAt is valid for Friday P&L until the first Monday fetch arrives.
//      On Tuesday, a Friday liveAt correctly returns null (prevSession = Monday ≠ Friday).
//
// Using the effective date as the session date for the previous close ensures that when
// liveAt = Friday and candidate = Monday, prevClose resolves to Thursday (not Friday),
// so the delta = Friday − Thursday — not the false-zero Friday − Friday.
function getEffectivePnlSessionDateStr(liveAt, candidateSessionDateStr) {
    if (!liveAt || !candidateSessionDateStr) return null;
    // Normalise liveAt to its trading-session date before comparing.
    // A fetch on Saturday at 19:01 returns Friday's market close; treating liveAt
    // as Saturday would break the comparison with the Friday candidate session.
    // Weekend liveAt → roll back to the preceding Friday (same logic as getCurrentPnlSessionDateStr).
    const d = liveAt instanceof Date ? new Date(liveAt.getTime()) : new Date(liveAt);
    if (isNaN(d.getTime())) return null;
    const dow = d.getUTCDay();
    if (dow === 6) d.setUTCDate(d.getUTCDate() - 1); // Sat → Fri
    if (dow === 0) d.setUTCDate(d.getUTCDate() - 2); // Sun → Fri
    const liveSessionDate = d.toISOString().slice(0, 10);
    if (liveSessionDate === candidateSessionDateStr) return candidateSessionDateStr;
    if (liveSessionDate === previousTradingDayStr(candidateSessionDateStr)) return liveSessionDate;
    return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Returns the effective P&L session date for a specific ticker.
// Uses per-ticker quote session metadata (last date in liveDailyCloses[ticker]) when
// available — this is the actual market-session date, not the fetch timestamp.
//
// STALE-REJECT rule: if ticker metadata exists but is older than the previous session,
// return null. Do NOT fall through to the global fallback — per-ticker evidence is
// stronger and if it says stale, we must not substitute a more recent global date.
//
// NO-DATA rule: if ticker has no metadata, fall back to globalFallbackDate (legacy
// liveAt-based behaviour). This keeps non-liveDailyCloses tickers working.
function getEffectiveDateForTicker(ticker, liveQuoteSessionDates, candidateSessionDateStr, globalFallbackDate) {
    const normTk = String(ticker || '').toUpperCase().trim();
    const tickerSessionDate = liveQuoteSessionDates && liveQuoteSessionDates[normTk];
    if (tickerSessionDate) {
        // Per-ticker metadata present: strict check — current or one-prior session only
        if (tickerSessionDate === candidateSessionDateStr) return tickerSessionDate;
        if (tickerSessionDate === previousTradingDayStr(candidateSessionDateStr)) return tickerSessionDate;
        return null; // Stale: reject. Do not fall back to global.
    }
    // No per-ticker metadata: use global legacy fallback
    return globalFallbackDate || null;
}

// ── Live tail of a stored price series ────────────────────────────────────────
// Stored history holds completed sessions up to its last refresh; the live layer owns everything after that. That is
// today's live quote AND any completed session the stored history does not have yet. History is refreshed once a day
// and a refresh can fail for some tickers, but liveDailyCloses (the live pass's own daily closes, the ones Today's
// previous close is taken from) already has those sessions. Appending the live quote straight after an older close made
// the chart's last segment measure a different move from Today: on 21 Oct 2026 every LSE line priced 20 Oct at its
// 19 Oct close, so the 1W chart showed the portfolio -0.24% on a +0.3% day.
// Raw daily closes meet adjusted history cleanly for the same reason the live quote does (adjusted = raw after the latest
// ex-date). Bridged rows are strictly after the series' last date and before liveDate; rows the sources disagree on, and
// weekend stubs on exchanges that don't trade weekends, are skipped. A liveDate before the series' last date is ignored.
function withLiveTail(series, ticker, liveDate, livePx, dailyCloses) {
    const rows = (series || []).slice();
    if (!liveDate || !(Number(livePx) > 0)) return rows;
    if (rows.length && liveDate < String(rows[rows.length - 1].date).slice(0, 10)) return rows;
    // A point already on liveDate (a series restored from a backup carries the live quote it was exported with) is
    // replaced, and the bridge is measured from the stored close before it.
    const kept = rows.filter(r => String(r.date).slice(0, 10) < liveDate);
    const last = kept.length ? String(kept[kept.length - 1].date).slice(0, 10) : '';
    const tk = _dcUp(ticker);
    const daily = dailyCloses && (dailyCloses[tk] ?? Object.entries(dailyCloses).find(([k]) => _dcUp(k) === tk)?.[1]);
    const prof = dailyCheckProfileFor(tk);
    const spec = prof.calendar ? EXCHANGE_CALENDARS[prof.calendar] : null;
    const isWeekend = ds => { const g = new Date(ds + 'T12:00:00Z').getUTCDay(); return g === 0 || g === 6; };
    const bridge = (Array.isArray(daily) ? daily : [])
        .filter(r => r && r.date && Number(r.close) > 0 && r.status !== 'conflict')
        .map(r => ({ date: String(r.date).slice(0, 10), close: Number(r.close) }))
        .filter(r => r.date > last && r.date < liveDate && !(spec && !spec.everyDay && isWeekend(r.date)))
        .sort((a, b) => a.date.localeCompare(b.date))
        .filter((r, i, a) => i === 0 || a[i - 1].date !== r.date);
    return kept.concat(bridge, [{ date: liveDate, close: Number(livePx) }]);
}

// ── Latest-session rule for Today figures ─────────────────────────────────────
// Each holding's Today move is tagged with the trading session it was measured on (todaySessionDate). Moves from
// different sessions must never be blended: on a Monday morning in London the LSE holdings carry Monday's move while
// Citi (not yet open) still carries Friday's. The "latest session" is the most recent session any holding has reached;
// a holding on an earlier session has its Today held back (withLatestSessionToday, applied once in activeHoldingsWithDelta,
// and mirrored for the restricted schemes), so the hero, account cards, All Holdings and Insights never blend sessions and a
// market that has not yet opened is held back until it does. When every holding is on the same session (a weekend, or before
// any market opens) all of them count. A holding with no session date cannot be shown to disagree, so it is kept.
function latestTodaySession(holdings) {
    let latest = null;
    for (const h of holdings || []) {
        if (h.todayAbsChange == null) continue;
        const s = h.todaySessionDate;
        if (s && (!latest || s > latest)) latest = s;
    }
    return latest;
}
// True when a move measured on `session` is behind the latest session (so it must not be shown as "Today").
// Unknown on either side → not held back (cannot show a disagreement).
function isHeldBackBySession(session, latestSession) {
    return !!session && !!latestSession && session !== latestSession;
}
function isInLatestTodaySession(h, latestSession) {
    return !isHeldBackBySession(h.todaySessionDate, latestSession);
}
// THE one place a holding's Today is held back. A holding on an earlier session than the latest has its Today blanked
// (null → shown as "—" everywhere: hero total, account cards, All Holdings rows, Insights). Its session tag is kept.
function withLatestSessionToday(h, latestSession) {
    if (h.todayAbsChange == null || isInLatestTodaySession(h, latestSession)) return h;
    return { ...h, todayAbsChange: null, todayPctChange: null, todayHeldBack: true };
}

// Selects the immediately prior completed session close from a raw Yahoo chart series.
// Builds {ts, close} pairs from the parallel timestamp / close arrays, sorts ascending by
// timestamp, converts each bar's timestamp to a UTC calendar date, then returns the most
// recent bar whose date is strictly before the current session date.
//
// This correctly handles all cases where today's bar may be present in the series but has
// a null or partial (live) close — it is excluded by the strict-before-date comparison.
// It never selects the oldest bar when newer completed sessions exist.
//
// Parameters:
//   timestamps      — result.timestamp array from Yahoo v8 chart response (Unix seconds)
//   closes          — result.indicators.quote[0].close parallel array
//   currentQuoteTs  — meta.regularMarketTime (Unix seconds); identifies the current session
//
// Returns { value, date, allCandidates } or null when no prior session is determinable.
function getPreviousCompletedCloseFromSeries(timestamps, closes, currentQuoteTs) {
    if (!Array.isArray(timestamps) || !Array.isArray(closes) || timestamps.length === 0) return null;
    const tsToDate = ts => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
    // Build valid pairs; sort ascending so allCandidates is chronological
    const pairs = timestamps
        .map((ts, i) => ({ ts: Number(ts), close: Number(closes[i]) }))
        .filter(x => Number.isFinite(x.ts) && Number.isFinite(x.close) && x.close > 0)
        .sort((a, b) => a.ts - b.ts);
    if (pairs.length === 0) return null;
    if (Number.isFinite(currentQuoteTs) && currentQuoteTs > 0) {
        const currentDate = tsToDate(currentQuoteTs);
        // All bars belonging to a session strictly before today's session date
        const prior = pairs.filter(p => tsToDate(p.ts) < currentDate);
        if (prior.length === 0) return null;
        const sel = prior[prior.length - 1]; // most recent completed prior session
        return {
            value:         sel.close,
            date:          tsToDate(sel.ts),
            allCandidates: prior.map(p => ({ date: tsToDate(p.ts), close: p.close })),
        };
    }
    // currentQuoteTs unavailable: conservatively assume last bar is the current (possibly
    // incomplete) session and return the second-to-last bar as the prior completed session.
    if (pairs.length < 2) return null;
    const sel = pairs[pairs.length - 2];
    return {
        value:         sel.close,
        date:          tsToDate(sel.ts),
        allCandidates: pairs.slice(0, -1).map(p => ({ date: tsToDate(p.ts), close: p.close })),
    };
}




// Maximum plausible single-session daily move for a liquid equity.
// livePrevClose values implying a larger move vs the current live price are
// considered stale or from the wrong source, and are discarded.
// Callers that do not pass livePrices skip this check (tentative trust).
const MAX_SANE_DAILY_MOVE = 0.15; // 15 %


