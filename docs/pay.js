// ─── Pay screen (salary, bonus, stock awards, redundancy) ────────────────────
// Pay year by year: base salary, the discretionary bonus (cash, or cash and stock), and any redundancy payment, with
// total compensation, year-on-year growth, bonus against base and a 3-year average, a stacked bar chart, and the stock
// part of each bonus vesting over the following years. Opened from the Pay tab in the app's top tab bar, drawn below
// that bar (its height comes from the --topbar-h CSS variable index.html publishes), like the Life Admin screen.
//
// Loaded by index.html as its own file: <script src="pay.js?v=N">. Bump N there whenever this file changes, so the Home
// Screen app never pairs a new index.html with a cached old copy of this file.
//
// Exposes:
//   window.PayScreen — the Pay view (props: onClose, privacyMode, ui)
//   window.PayStore  — backupSnapshot() / restore(obj) for the app's JSON backup, plus get/subscribe/deleteAll
//   window.PayIcon   — the tab's icon
//
// Data lives in its own IndexedDB database ('portfolio-pay') and goes into the app's backups (the cloud copy is
// encrypted on the phone before it is sent). No pay figure is ever written into this file: the repo is public.
(function () {
'use strict';
var E = React.createElement;

// ── Store (IndexedDB, own database) ──────────────────────────────────────────
// state = { v: 1, years: [Year], updatedAt }
//   Year = { id, year, title, base, bonus, redundancy, cash, shares, price, currency, stockName, vest, notes }
//          year:       the calendar year the pay is for (2021).
//          base:       base salary for the year, £.
//          bonus:      the discretionary bonus for this year's performance, £, cash and stock together at award value.
//                      null = not known yet (the year isn't over); 0 = no bonus.
//          redundancy: a redundancy payment received in the year, £; null = none.
//          cash:       the cash part of the bonus, £. null = the bonus was all cash. The rest (bonus − cash) was paid in stock.
//          shares:     how many shares the stock part bought, at `price` a share in `currency` (USD or GBP), named stockName ('Citi').
//          vest:       years the stock vests over, an equal part each year from a year after the award (4: 25% a year).
//          The bonus for a year is paid early the next year (the stock is awarded then), so cash, shares and price
//          belong to the year the bonus was for, not the year it was paid.
var DB_NAME = 'portfolio-pay';
var DB_STORE = 'kv';
var DB_KEY = 'state';
var DEFAULT_VEST = 4;
function emptyState() { return { v: 1, years: [], updatedAt: null }; }

function idbOpen() {
    return new Promise(function (resolve, reject) {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
            if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
    });
}
function idbRead() {
    return idbOpen().then(function (db) {
        return new Promise(function (resolve, reject) {
            var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(DB_KEY);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    });
}
function idbWrite(value) {
    return idbOpen().then(function (db) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(DB_STORE, 'readwrite');
            tx.objectStore(DB_STORE).put(value, DB_KEY);
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
        });
    });
}

function text(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 80) : ''; }
function money(v) { return typeof v === 'number' && isFinite(v) ? Math.round(Math.abs(v) * 100) / 100 : null; }
function positive(v) { return typeof v === 'number' && isFinite(v) && v > 0 ? v : null; }
// Returns a cleaned year, or null when it has no year.
function validYear(y) {
    if (!y || typeof y !== 'object') return null;
    var year = Math.round(Number(y.year));
    if (!(year >= 1950 && year <= 2100)) return null;
    var bonus = money(y.bonus), cash = money(y.cash);
    if (cash != null && bonus != null && cash > bonus) cash = bonus;
    return {
        id: text(y.id, 40) || newId(),
        year: year,
        title: text(y.title, 40),
        base: money(y.base),
        bonus: bonus,
        redundancy: positive(money(y.redundancy)),
        cash: cash,
        shares: positive(typeof y.shares === 'number' ? Math.round(y.shares * 10000) / 10000 : null),
        price: positive(typeof y.price === 'number' ? Math.round(y.price * 10000) / 10000 : null),
        currency: y.currency === 'GBP' ? 'GBP' : 'USD',
        stockName: text(y.stockName, 30),
        vest: [1, 2, 3, 4, 5].indexOf(y.vest) >= 0 ? y.vest : DEFAULT_VEST,
        notes: text(y.notes, 500),
    };
}
// Returns a cleaned copy of a stored or restored state (one entry per year, oldest first), or null when it is not a Pay state.
function validateState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.years)) return null;
    var byYear = {}, ids = {};
    s.years.forEach(function (y) {
        var c = validYear(y);
        if (!c) return;
        while (ids[c.id]) c.id = newId();
        ids[c.id] = true;
        byYear[c.year] = c;
    });
    var years = Object.keys(byYear).map(function (k) { return byYear[k]; }).sort(function (a, b) { return a.year - b.year; });
    return { v: 1, years: years, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null };
}
var _idn = 0;
function newId() { return 'p' + Date.now().toString(36) + (_idn++).toString(36) + Math.random().toString(36).slice(2, 6); }

var _state = emptyState();
var _ready = false;
var _loadError = null;
var _listeners = [];
function emit() { _listeners.slice().forEach(function (fn) { try { fn(); } catch (e) {} }); }

var _loaded = idbRead().then(function (s) {
    var clean = validateState(s);
    if (clean) _state = clean;
}).catch(function (e) {
    _loadError = e && e.message ? e.message : String(e);
}).then(function () { _ready = true; emit(); });

function saveState(next) {
    next = validateState(next) || emptyState();
    next.updatedAt = Date.now();
    _state = next;
    emit();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return idbWrite(next).catch(function (e) {
        _loadError = 'Could not save: ' + (e && e.message ? e.message : e);
        emit();
        throw e;
    });
}

var PayStore = {
    ready: function () { return _loaded; },
    get: function () { return _state; },
    subscribe: function (fn) {
        _listeners.push(fn);
        return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
    },
    // Synchronous: the JSON backup is built inside the tap that opens the iOS share sheet. null = nothing to back up.
    backupSnapshot: function () { return _state.years.length ? JSON.parse(JSON.stringify(_state)) : null; },
    // Replaces the years with the ones from a backup. Returns false (and changes nothing) when invalid or empty.
    restore: function (obj) {
        var clean = validateState(obj);
        if (!clean || !clean.years.length) return false;
        saveState(clean).catch(function () {});
        return true;
    },
    deleteAll: function () { return saveState(emptyState()); },
};

function useStoreState() {
    var st = React.useState(0);
    React.useEffect(function () { return PayStore.subscribe(function () { st[1](function (n) { return n + 1; }); }); }, []);
    return _state;
}

// ── Calculations ─────────────────────────────────────────────────────────────
// The stock part of a year's bonus at award value, £: what the bonus was beyond its cash part. 0 when all cash.
function stockValue(y) { return y.bonus != null && y.cash != null ? Math.max(0, Math.round((y.bonus - y.cash) * 100) / 100) : 0; }
function cashBonus(y) { return y.bonus == null ? null : Math.round((y.bonus - stockValue(y)) * 100) / 100; }
function pct(a, b) { return a == null || b == null || !(b > 0) ? null : a / b - 1; }
// Every year with its figures worked out, oldest first.
//   tc:       total compensation: base + bonus + redundancy (as the sheet adds it up). Without a known bonus it is base
//             (+ redundancy) and `complete` is false, so no growth is worked out from it.
//   earned:   base + bonus, without redundancy.
//   yoy:      tc against the year before; yoyEarned without redundancy (only differs when either year had one).
//   bonusYoy: the bonus against the year before's (none when that was £0).
//   bonusPct: the bonus as a share of base.
//   avg3:     the average tc of this year and the two before (the sheet's 3yr average), when all three are complete.
function computeYears(years) {
    var list = (years || []).slice().sort(function (a, b) { return a.year - b.year; });
    var by = {};
    var out = list.map(function (y) {
        var stock = stockValue(y), cash = cashBonus(y);
        var earned = (y.base || 0) + (y.bonus || 0);
        var r = Object.assign({}, y, {
            stock: stock, cashPart: cash, complete: y.bonus != null && y.base != null,
            earned: earned, tc: earned + (y.redundancy || 0),
            impliedFx: stock > 0 && y.shares && y.price && y.currency === 'USD' ? Math.round(y.shares * y.price / stock * 10000) / 10000 : null,
        });
        by[y.year] = r;
        return r;
    });
    out.forEach(function (r) {
        var p = by[r.year - 1];
        var both = p && p.complete && r.complete;
        r.yoy = both ? pct(r.tc, p.tc) : null;
        r.yoyEarned = both ? pct(r.earned, p.earned) : null;
        r.bonusYoy = p && p.bonus != null && r.bonus != null ? pct(r.bonus, p.bonus) : null;
        r.bonusPct = r.bonus != null && r.base > 0 ? r.bonus / r.base : null;
        var three = [by[r.year - 2], p, r];
        var ok = three.every(function (x) { return x && x.complete; });
        r.avg3 = ok ? three.reduce(function (s, x) { return s + x.tc; }, 0) / 3 : null;
        r.avg3Earned = ok ? three.reduce(function (s, x) { return s + x.earned; }, 0) / 3 : null;
    });
    return out;
}
// When a tranche of stock counts as vested: awards are made with the bonus early in the year, and each tranche vests
// on the award's anniversary. The month isn't kept, so a tranche counts as vested from March of its year.
var VEST_MONTH = 3;
function isVested(vestYear, today) {
    var y = +today.slice(0, 4), m = +today.slice(5, 7);
    return vestYear < y || (vestYear === y && m >= VEST_MONTH);
}
// The stock part of each bonus and when it vests: the bonus for `year` is awarded in year + 1, and vests in `vest`
// equal parts in the years after that (year + 2 … year + 1 + vest). Valued at award value: the app's Investments tab
// already follows what the shares are worth now.
function stockAwards(rows, today) {
    return rows.filter(function (r) { return r.stock > 0 || r.shares; }).map(function (r) {
        var n = r.vest || DEFAULT_VEST, tranches = [];
        for (var i = 1; i <= n; i++) {
            var vy = r.year + 1 + i;
            tranches.push({ year: vy, shares: r.shares ? r.shares / n : null, value: r.stock / n, vested: isVested(vy, today) });
        }
        var unvested = tranches.filter(function (t) { return !t.vested; });
        return { year: r.year, awarded: r.year + 1, shares: r.shares, price: r.price, currency: r.currency, stockName: r.stockName, value: r.stock,
                 impliedFx: r.impliedFx, tranches: tranches,
                 unvestedValue: unvested.reduce(function (s, t) { return s + t.value; }, 0),
                 unvestedShares: r.shares ? unvested.reduce(function (s, t) { return s + t.shares; }, 0) : null };
    });
}
// Pay by the year it arrived, not the year it was for: base in its year, a bonus's cash early the next year, its stock
// as each tranche vests (at award value), redundancy in its year. `due` is stock still to vest.
function receivedByYear(rows, today) {
    var by = {};
    function at(y) { return by[y] || (by[y] = { year: y, base: 0, cash: 0, stock: 0, due: 0, redundancy: 0 }); }
    rows.forEach(function (r) {
        if (r.base) at(r.year).base += r.base;
        if (r.redundancy) at(r.year).redundancy += r.redundancy;
        if (r.cashPart) at(r.year + 1).cash += r.cashPart;
    });
    stockAwards(rows, today).forEach(function (a) {
        a.tranches.forEach(function (t) { if (t.vested) at(t.year).stock += t.value; else at(t.year).due += t.value; });
    });
    var ys = Object.keys(by).map(Number).sort(function (a, b) { return a - b; });
    if (!ys.length) return [];
    var out = [];
    for (var y = ys[0]; y <= ys[ys.length - 1]; y++) {
        var b = at(y);
        b.total = b.base + b.cash + b.stock + b.due + b.redundancy;
        out.push(b);
    }
    return out;
}
// The top card: the latest year with its bonus known, the year under way after it, and growth since the first full year.
function summary(rows) {
    var done = rows.filter(function (r) { return r.complete; });
    var latest = done[done.length - 1] || null;
    var current = rows.filter(function (r) { return !r.complete && r.base != null && (!latest || r.year > latest.year); })[0] || null;
    var first = done[0] || null, cagr = null;
    if (first && latest && latest.year > first.year && first.earned > 0)
        cagr = Math.pow(latest.earned / first.earned, 1 / (latest.year - first.year)) - 1;
    return { latest: latest, current: current, first: first, cagr: cagr };
}

// ── Paste from a spreadsheet ─────────────────────────────────────────────────
// Fergus's sheet: (year) Title Base Bonus(prorate) Redundancy TC YoY… 3Yr average, Cash Payment, '<Stock> Stock Awarded',
// Award Price. Worked-out columns (TC, YoY, averages) are ignored: the app works them out itself.
var HEADERS = {
    year:       /^(year|yr)$/,
    title:      /^(title|role|grade|position|rank|job|job title)$/,
    base:       /^(base|base salary|salary|base pay)\b/,
    bonus:      /^(bonus|discretionary bonus|total bonus)\b/,
    redundancy: /^(redundancy|redundancy payment|severance)\b/,
    cash:       /^(cash|cash payment|cash bonus|cash paid)\b/,
    shares:     /(stock awarded|shares awarded|shares|stock award|award shares|units)$/,
    price:      /^(award price|share price|price|grant price)\b/,
    notes:      /^(notes|note|comments|comment)$/,
};
var DEFAULT_ORDER = ['year', 'title', 'base', 'bonus', 'redundancy'];
function headerKey(cell) {
    var c = String(cell || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!c) return null;
    for (var k in HEADERS) if (HEADERS[k].test(c)) return k;
    return null;
}
// 'Citi (C UN Equity) Stock Awarded' → 'Citi'.
function stockNameOf(cell) {
    var m = /^\s*([A-Za-z][A-Za-z&.' -]*?)\s*(\(|stock\b|shares\b)/i.exec(String(cell || ''));
    var n = m ? m[1].trim() : '';
    return /^(stock|shares|award)$/i.test(n) ? '' : n;
}
function splitRows(textIn) {
    return String(textIn || '').replace(/\r\n?/g, '\n').split('\n').map(function (line) {
        var cells = line.indexOf('\t') >= 0 ? line.split('\t') : splitCsvLine(line);
        return cells.map(function (c) { return c.trim(); });
    }).filter(function (r) { return r.some(function (c) { return c; }); });
}
function splitCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}
function parseNum(v) {
    var t = String(v == null ? '' : v).replace(/[£$€,\s]|Â/g, '');
    if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Number(t);
}
function parseMoney(v) { var n = parseNum(v); return n == null ? null : Math.round(Math.abs(n) * 100) / 100; }
function yearOf(v) { var t = String(v == null ? '' : v).trim(); return /^(19[5-9]\d|20\d\d)$/.test(t) ? +t : null; }
// text → { rows: [Year], skipped, paidNextYear, stockName }
//   paidNextYear: the sheet puts a bonus's cash and shares on the row of the year they were paid (the year after the
//   bonus year). Worked out from the figures: a row whose cash is more than its own bonus, while every cash fits the
//   bonus of the year before. `shift` (true / false) overrides it.
function parsePaste(textIn, shift) {
    var rows = splitRows(textIn), out = { rows: [], skipped: 0, paidNextYear: false, detected: false, stockName: '' };
    if (!rows.length) return out;
    var hi = -1, cols = null;
    for (var i = 0; i < Math.min(rows.length, 5); i++) {
        var keys = rows[i].map(headerKey);
        if (keys.indexOf('base') >= 0 && (keys.indexOf('bonus') >= 0 || keys.indexOf('title') >= 0)) { hi = i; cols = keys; break; }
    }
    var head = hi >= 0 ? rows[hi] : null;
    if (head) head.forEach(function (c, j) { if (cols[j] === 'shares' && !out.stockName) out.stockName = stockNameOf(c); });
    var raw = [];
    rows.forEach(function (r, i) {
        if (i <= hi) return;
        var map = {};
        if (cols) {
            // The year's column usually has no header: the first cell that holds a year.
            var shiftBy = Math.max(0, r.length - cols.length);   // a header copied without its leading blank cells lines up on the right
            r.forEach(function (c, j) { var k = cols[j - shiftBy]; if (k && map[k] == null && c !== '') map[k] = c; });
            if (map.year == null) for (var j = 0; j < r.length; j++) if (yearOf(r[j])) { map.year = r[j]; break; }
        } else DEFAULT_ORDER.forEach(function (k, j) { if (r[j] != null && r[j] !== '') map[k] = r[j]; });
        var year = yearOf(map.year);
        var y = { year: year, title: map.title || '', base: parseMoney(map.base), bonus: parseMoney(map.bonus), redundancy: parseMoney(map.redundancy),
                  cash: parseMoney(map.cash), shares: parseNum(map.shares), price: parseNum(map.price), notes: map.notes || '' };
        if (!year || (y.base == null && y.bonus == null && y.redundancy == null && y.cash == null && y.shares == null)) { out.skipped++; return; }
        raw.push(y);
    });
    // A blank bonus before the last year with one was no bonus (£0); only the years after it are still to come.
    var lastBonus = raw.reduce(function (m, y) { return y.bonus != null && y.year > m ? y.year : m; }, 0);
    raw.forEach(function (y) { if (y.bonus == null && y.year < lastBonus) y.bonus = 0; });
    // Do the cash and shares belong to the row above?
    var by = {};
    raw.forEach(function (y) { by[y.year] = y; });
    var withCash = raw.filter(function (y) { return y.cash != null; });
    var tooBig = withCash.some(function (y) { return y.bonus != null && y.cash > y.bonus + 0.5; });
    var fitsBefore = withCash.length > 0 && withCash.every(function (y) { var p = by[y.year - 1]; return p && p.bonus != null && y.cash <= p.bonus + 0.5; });
    out.detected = tooBig && fitsBefore;
    out.paidNextYear = shift == null ? out.detected : !!shift;
    if (out.paidNextYear) {
        var moved = {};
        raw.forEach(function (y) { if (y.cash != null || y.shares != null || y.price != null) moved[y.year - 1] = { cash: y.cash, shares: y.shares, price: y.price }; });
        raw.forEach(function (y) { var m = moved[y.year] || {}; y.cash = m.cash == null ? null : m.cash; y.shares = m.shares == null ? null : m.shares; y.price = m.price == null ? null : m.price; });
        // A bonus paid in a year the sheet has no row for (the year before its first row) is dropped: it has no bonus to belong to.
    }
    raw.forEach(function (y) {
        if (y.shares) { y.stockName = out.stockName; y.currency = 'USD'; y.vest = DEFAULT_VEST; }
        var c = validYear(y);
        if (c) out.rows.push(c);
    });
    return out;
}
// Pasted years replace the same year already here (keeping its id, notes and vesting) and add the rest.
function mergeYears(existing, incoming) {
    var by = {}, added = 0, updated = 0;
    (existing || []).forEach(function (y) { by[y.year] = y; });
    incoming.forEach(function (y) {
        var old = by[y.year];
        if (old) {
            updated++;
            by[y.year] = Object.assign({}, y, { id: old.id, notes: y.notes || old.notes, vest: y.shares ? (old.vest || y.vest) : old.vest,
                                                stockName: y.stockName || old.stockName, currency: y.shares ? (old.shares ? old.currency : y.currency) : old.currency });
        } else { added++; by[y.year] = y; }
    });
    var years = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.year - b.year; });
    return { years: years, added: added, updated: updated };
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtGBP(n) {
    if (n == null || !isFinite(n)) return '—';
    return (n < 0 ? '−' : '') + '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');
}
function fmtPct(v, signed) {
    if (v == null || !isFinite(v)) return '—';
    var s = (Math.abs(v) * 100).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
    return signed ? (v > 0 ? '+' : v < 0 ? '−' : '') + s : (v < 0 ? '−' : '') + s;
}
function fmtShares(n) { return n == null ? '—' : n.toLocaleString('en-GB', { maximumFractionDigits: 2 }); }
function fmtPrice(n, cur) { return n == null ? '—' : (cur === 'GBP' ? '£' : '$') + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function axisText(v) { return v >= 1000 ? '£' + (v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + 'k' : '£' + Math.round(v); }

// ── UI ───────────────────────────────────────────────────────────────────────
var ORANGE = '#fb923c';
// Chart series (checked for colour-blind separation against the app's dark surface).
var SERIES = [
    { id: 'base',       label: 'Base',        color: '#3b82f6' },
    { id: 'cash',       label: 'Bonus',       color: '#ea580c' },
    { id: 'stock',      label: 'Bonus stock', color: '#0d9488' },
    { id: 'redundancy', label: 'Redundancy',  color: '#c026d3' },
];
var SERIES_BY_ID = {};
SERIES.forEach(function (s) { SERIES_BY_ID[s.id] = s; });
var DEFAULT_UI = {
    C: { bg: '#080c10', surface: '#0d1218', surfaceHigh: '#11161f', border: 'rgba(255,255,255,0.08)',
         amber: '#fbbf24', emerald: '#34d399', rose: '#f87171', blue: '#60a5fa', violet: '#a78bfa',
         zinc400: '#cbd5e1', zinc500: '#a1a1aa', zinc600: '#9da5b4', zinc700: '#888894', white: '#ffffff' },
    sys: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif',
};
var UICtx = React.createContext(DEFAULT_UI);
function useUI() { return React.useContext(UICtx); }

function icon(paths) { return typeof _li === 'function' ? _li(paths) : function () { return null; }; }
var PayIcon = icon([{ t: 'r', x: 2, y: 6, w: 20, h: 12, rx: 2 }, { t: 'c', cx: 12, cy: 12, r: 2.5 }, 'M6 12h.01', 'M18 12h.01']);
var BackIcon = icon(['M15 18l-6-6 6-6']);

function cardStyle(ui, extra) {
    return Object.assign({ background: 'linear-gradient(180deg, ' + ui.C.surfaceHigh + ' 0%, ' + ui.C.surface + ' 100%)',
                           border: '1px solid ' + ui.C.border, borderRadius: 20 }, extra || {});
}
function capsLabel(ui) { return { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc500, textTransform: 'uppercase', letterSpacing: '0.18em' }; }
function moneyStyle(ui, size, privacy, color, weight) {
    return { fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', fontSize: size, fontWeight: weight || 700, color: color || ui.C.white,
             whiteSpace: 'nowrap', filter: privacy ? 'blur(7px)' : 'none' };
}
function buttonStyle(ui, kind) {
    var primary = kind === 'primary', danger = kind === 'danger';
    return { minHeight: 44, borderRadius: 12, padding: '0 14px', fontFamily: ui.sys, fontSize: 14, fontWeight: 600, cursor: 'pointer',
             background: primary ? 'rgba(251,146,60,0.14)' : danger ? 'rgba(248,113,113,0.10)' : 'rgba(39,39,42,0.6)',
             border: '1px solid ' + (primary ? 'rgba(251,146,60,0.4)' : danger ? 'rgba(248,113,113,0.3)' : ui.C.border),
             color: primary ? ORANGE : danger ? ui.C.rose : ui.C.zinc400,
             display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
}
function inputStyle(ui, extra) {
    return Object.assign({ display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, background: 'rgba(0,0,0,0.35)',
                           border: '1px solid ' + ui.C.border, borderRadius: 10, color: ui.C.white, fontFamily: ui.sys, fontSize: 16,
                           padding: '0 10px', height: 40, outline: 'none', WebkitAppearance: 'none', appearance: 'none' }, extra || {});
}
function Segmented(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2 } },
        props.options.map(function (o) {
            var on = o.id === props.value;
            return E('button', { key: String(o.id), onClick: function () { props.onChange(o.id); },
                style: { border: 'none', borderRadius: 7, padding: '5px 10px', fontFamily: ui.sys, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? ui.C.white : ui.C.zinc600 } }, o.label);
        }));
}
function Header(props) {
    var ui = useUI();
    return E('div', { style: { padding: '6px 16px 6px 8px', background: 'rgba(13,18,24,0.98)', borderBottom: '1px solid ' + ui.C.border, flexShrink: 0,
                                display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, boxSizing: 'border-box' } },
        E('button', { onClick: props.onBack, 'aria-label': 'Back', style: { background: 'none', border: 'none', color: ORANGE, display: 'flex', alignItems: 'center', padding: '6px 4px', cursor: 'pointer', fontFamily: ui.sys, fontSize: 15 } },
            E(BackIcon, { style: { width: 18, height: 18 }, strokeWidth: 2 }), 'Back'),
        E('div', { style: { fontFamily: ui.sys, fontSize: 17, fontWeight: 700, flex: 1, minWidth: 0, color: ui.C.white } }, props.title));
}
function Field(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderBottom: props.last ? 'none' : '1px solid ' + ui.C.border, fontFamily: ui.sys, fontSize: 14 } },
        E('span', { style: { color: ui.C.zinc600, flexShrink: 0 } }, props.label),
        E('span', { style: { color: ui.C.white, textAlign: 'right', minWidth: 0, fontVariantNumeric: 'tabular-nums', filter: props.privacy ? 'blur(6px)' : 'none' } }, props.children));
}
function Swatch(props) {
    return E('span', { style: { width: 8, height: 8, borderRadius: 2, background: props.color, flexShrink: 0, display: 'inline-block' } });
}

function Hero(props) {
    var ui = useUI(), s = props.summary, p = props.privacy, l = s.latest;
    if (!l) return null;
    var hadRed = l.redundancy || (props.prev && props.prev.redundancy);
    var bits = [];
    if (l.yoy != null) bits.push(fmtPct(l.yoy, true) + ' on ' + (l.year - 1));
    if (hadRed && l.yoyEarned != null) bits.push(fmtPct(l.yoyEarned, true) + ' without redundancy');
    return E('div', { style: cardStyle(ui, { padding: '18px 20px' }) },
        E('div', { style: capsLabel(ui) }, 'Total comp ' + l.year + (l.title ? ' · ' + l.title : '')),
        E('div', { style: { marginTop: 8 } }, E('span', { style: moneyStyle(ui, 32, p) }, fmtGBP(l.tc))),
        bits.length > 0 && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, marginTop: 4 } }, bits.join(' · ')),
        E('div', { style: { display: 'flex', gap: 10, marginTop: 14 } },
            [['Base', l.base, null], ['Bonus', l.bonus, l.bonusPct != null ? fmtPct(l.bonusPct) + ' of base' : null]].concat(l.redundancy ? [['Redundancy', l.redundancy, null]] : [])
                .map(function (x) {
                    return E('div', { key: x[0], style: { flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.25)', borderRadius: 12, padding: '9px 11px' } },
                        E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600 } }, x[0]),
                        E('div', { style: Object.assign(moneyStyle(ui, 16, p, ui.C.white, 650), { marginTop: 2 }) }, fmtGBP(x[1])),
                        x[2] && E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 1 } }, x[2]));
                })),
        (s.current || s.cagr != null) && E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc600, marginTop: 12, lineHeight: 1.5 } },
            s.current && E('div', null, s.current.year + ': base ', E('span', { style: { filter: p ? 'blur(6px)' : 'none', color: ui.C.zinc400 } }, fmtGBP(s.current.base)),
                s.current.base && l.base ? ' (' + fmtPct(s.current.base / l.base - 1, true) + ')' : '', ', bonus not known yet'),
            s.cagr != null && E('div', null, 'Pay without redundancy has grown ' + fmtPct(s.cagr) + ' a year since ' + s.first.year)));
}

// ── Stacked bar chart ────────────────────────────────────────────────────────
var CW = 340, CH = 170, PAD_L = 36, PAD_B = 18, PAD_T = 8;
function niceStep(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function yOf(v, hi) { return PAD_T + (CH - PAD_T - PAD_B) * (1 - v / hi); }
// A bar segment with its top corners rounded (only the top segment of a bar is).
function segPath(x, y, w, h, r) {
    if (r <= 0 || h <= 0) return 'M' + x + ' ' + (y + h) + 'h' + w + 'v' + (-h) + 'h' + (-w) + 'z';
    r = Math.min(r, h, w / 2);
    return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'z';
}
var VIEWS = [{ id: 'awarded', label: 'Year earned' }, { id: 'received', label: 'Year paid' }];
var _view = 'awarded';
// bars: [{ year, parts: [{ id, value, faint }], label }]
function PayChart(props) {
    var ui = useUI(), p = props.privacy, bars = props.bars, sel = props.selected;
    if (!bars.length) return null;
    var max = Math.max.apply(null, bars.map(function (b) { return b.parts.reduce(function (s, x) { return s + x.value; }, 0); }).concat([1]));
    var step = niceStep(max / 4), hi = Math.ceil(max / step) * step;
    var n = bars.length, colW = (CW - PAD_L) / n, bw = Math.max(4, Math.min(22, colW * 0.66));
    var grid = [];
    for (var v = 0, i = 0; v <= hi + step / 1e6; v += step, i++) {
        var y = yOf(v, hi);
        grid.push(E('line', { key: 'g' + i, x1: PAD_L, x2: CW, y1: y, y2: y, stroke: i ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.18)' }));
        grid.push(E('text', { key: 't' + i, x: PAD_L - 5, y: y + 3, textAnchor: 'end', fontSize: 9, fill: '#888894', style: { filter: p && v ? 'blur(3px)' : 'none' } }, axisText(v)));
    }
    var every = colW >= 17 ? 1 : 2;
    var marks = [];
    bars.forEach(function (b, bi) {
        var x0 = PAD_L + colW * bi, x = x0 + (colW - bw) / 2, acc = 0, on = b.year === sel;
        if (on) marks.push(E('rect', { key: 'hl' + b.year, x: x0 + 1, y: PAD_T, width: colW - 2, height: CH - PAD_T - PAD_B, rx: 4, fill: 'rgba(255,255,255,0.06)' }));
        var shown = b.parts.filter(function (s) { return s.value > 0; });
        shown.forEach(function (s, si) {
            var top = yOf(acc + s.value, hi), bottom = yOf(acc, hi);
            acc += s.value;
            var gap = si > 0 ? 2 : 0, h = bottom - top - gap;
            if (h <= 0) return;
            marks.push(E('path', { key: b.year + s.id + (s.faint ? 'f' : ''), d: segPath(x, top, bw, h, si === shown.length - 1 ? 3 : 0),
                fill: SERIES_BY_ID[s.id].color, fillOpacity: s.faint ? 0.35 : 1, stroke: s.faint ? SERIES_BY_ID[s.id].color : 'none', strokeDasharray: s.faint ? '2 2' : null, strokeWidth: s.faint ? 1 : 0 }));
        });
        if (b.open) marks.push(E('text', { key: 'q' + b.year, x: x + bw / 2, y: yOf(acc, hi) - 4, textAnchor: 'middle', fontSize: 9, fill: '#888894' }, '?'));
        if (bi % every === (n - 1) % every) marks.push(E('text', { key: 'x' + b.year, x: x0 + colW / 2, y: CH - 5, textAnchor: 'middle', fontSize: 9, fill: on ? '#ffffff' : '#888894' }, '’' + String(b.year).slice(2)));
        // The whole column is the tap target, wider than the bar.
        marks.push(E('rect', { key: 'hit' + b.year, x: x0, y: 0, width: colW, height: CH, fill: 'transparent', style: { cursor: 'pointer' },
                               onClick: function () { props.onSelect(b.year); } }));
    });
    var used = SERIES.filter(function (s) { return bars.some(function (b) { return b.parts.some(function (x) { return x.id === s.id && x.value > 0; }); }); });
    var anyFaint = bars.some(function (b) { return b.parts.some(function (x) { return x.faint && x.value > 0; }); });
    return E('div', null,
        E('svg', { viewBox: '0 0 ' + CW + ' ' + CH, width: '100%', style: { display: 'block', touchAction: 'pan-y' }, role: 'img',
                   'aria-label': 'Pay by year, stacked: ' + used.map(function (s) { return s.label; }).join(', ') }, grid, marks),
        E('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8, fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600 } },
            used.map(function (s) { return E('span', { key: s.id, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, E(Swatch, { color: s.color }), s.id === 'stock' && props.view === 'received' ? 'Stock vesting' : s.label); }),
            anyFaint && E('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
                E('span', { style: { width: 8, height: 8, borderRadius: 2, border: '1px dashed ' + SERIES_BY_ID.stock.color, background: 'rgba(13,148,136,0.35)', boxSizing: 'border-box' } }), 'Still to vest')));
}
function barsFor(view, rows, received) {
    if (view === 'received') return received.map(function (r) {
        return { year: r.year, parts: [{ id: 'base', value: r.base }, { id: 'cash', value: r.cash }, { id: 'stock', value: r.stock }, { id: 'stock', value: r.due, faint: true }, { id: 'redundancy', value: r.redundancy }] };
    });
    return rows.map(function (r) {
        return { year: r.year, open: !r.complete, parts: [{ id: 'base', value: r.base || 0 }, { id: 'cash', value: r.cashPart || 0 }, { id: 'stock', value: r.stock }, { id: 'redundancy', value: r.redundancy || 0 }] };
    });
}
// The figures for the tapped bar, under the chart.
function Readout(props) {
    var ui = useUI(), p = props.privacy, b = props.bar, row = props.row;
    if (!b) return null;
    var parts = b.parts.filter(function (x) { return x.value > 0; });
    var total = parts.reduce(function (s, x) { return s + x.value; }, 0);
    var name = function (x) { return x.faint ? 'Stock still to vest' : x.id === 'stock' ? (props.view === 'received' ? 'Stock vesting' : 'Bonus in stock') : x.id === 'cash' ? (props.view === 'received' ? 'Bonus cash (for ' + (b.year - 1) + ')' : row && row.stock ? 'Bonus in cash' : 'Bonus') : SERIES_BY_ID[x.id].label; };
    return E('div', { style: { marginTop: 10, borderTop: '1px solid ' + ui.C.border, paddingTop: 8, fontFamily: ui.sys } },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13.5, color: ui.C.white, fontWeight: 600, padding: '2px 0 4px' } },
            E('span', null, b.year + (row && row.title && props.view !== 'received' ? ' · ' + row.title : '')),
            E('span', { style: moneyStyle(ui, 14, p, ui.C.white, 650) }, fmtGBP(total))),
        parts.map(function (x, i) {
            return E('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: ui.C.zinc400, padding: '2px 0' } },
                E(Swatch, { color: SERIES_BY_ID[x.id].color }), E('span', { style: { flex: 1 } }, name(x)),
                E('span', { style: moneyStyle(ui, 12.5, p, ui.C.zinc400, 500) }, fmtGBP(x.value)));
        }),
        b.open && E('div', { style: { fontSize: 12, color: ui.C.zinc700, paddingTop: 4 } }, 'Bonus not known yet.'));
}
function ChartCard(props) {
    var ui = useUI(), view = React.useState(_view), rows = props.rows;
    var received = React.useMemo(function () { return receivedByYear(rows, props.today); }, [rows, props.today]);
    var bars = barsFor(view[0], rows, received);
    var hasStock = rows.some(function (r) { return r.stock > 0; });
    var latest = props.summary.latest ? props.summary.latest.year : bars.length ? bars[bars.length - 1].year : null;
    var sel = React.useState(latest);
    var selected = bars.filter(function (b) { return b.year === sel[0]; })[0] ? sel[0] : latest;
    var bar = bars.filter(function (b) { return b.year === selected; })[0];
    return E('div', { style: cardStyle(ui, { padding: '14px 14px 12px', marginTop: 14 }) },
        E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 } },
            E('span', { style: capsLabel(ui) }, 'Pay by year'),
            hasStock && E(Segmented, { options: VIEWS, value: view[0], onChange: function (v) { _view = v; view[1](v); } })),
        E(PayChart, { bars: bars, view: view[0], selected: selected, privacy: props.privacy, onSelect: sel[1] }),
        E(Readout, { bar: bar, view: view[0], row: rows.filter(function (r) { return r.year === selected; })[0], privacy: props.privacy }),
        view[0] === 'received' && E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.45 } },
            'Each bonus paid early the next year; its stock vests in equal parts over the years after, shown at award value.'));
}

// ── Stock awards ─────────────────────────────────────────────────────────────
function AwardsCard(props) {
    var ui = useUI(), p = props.privacy, awards = props.awards;
    if (!awards.length) return null;
    var unvested = awards.reduce(function (s, a) { return s + a.unvestedValue; }, 0);
    return E('div', null,
        E('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '22px 4px 8px' } },
            E('span', { style: capsLabel(ui) }, 'Stock awards'),
            unvested > 0 && E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600 } }, 'Unvested ', E('span', { style: moneyStyle(ui, 12, p, ui.C.zinc400, 600) }, fmtGBP(unvested)))),
        E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
            awards.slice().reverse().map(function (a, i) {
                return E('div', { key: a.year, style: { padding: '11px 14px', borderTop: i ? '1px solid ' + ui.C.border : 'none', fontFamily: ui.sys } },
                    E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
                        E('span', { style: { fontSize: 14.5, fontWeight: 600, color: ui.C.white, flex: 1, minWidth: 0 } }, a.year + ' bonus'),
                        E('span', { style: moneyStyle(ui, 14, p, ui.C.white, 600) }, fmtGBP(a.value))),
                    E('div', { style: { fontSize: 12, color: ui.C.zinc600, marginTop: 2, filter: p ? 'blur(5px)' : 'none' } },
                        [a.shares ? fmtShares(a.shares) + ' ' + (a.stockName ? a.stockName + ' ' : '') + 'shares' : null,
                         a.price ? 'at ' + fmtPrice(a.price, a.currency) : null,
                         'awarded ' + a.awarded].filter(Boolean).join(' · ')),
                    E('div', { style: { display: 'flex', gap: 4, marginTop: 8 } },
                        a.tranches.map(function (t) {
                            return E('div', { key: t.year, style: { flex: 1, minWidth: 0, textAlign: 'center', borderRadius: 7, padding: '4px 0',
                                                                    background: t.vested ? 'rgba(13,148,136,0.22)' : 'transparent',
                                                                    border: '1px ' + (t.vested ? 'solid rgba(13,148,136,0.5)' : 'dashed rgba(255,255,255,0.18)') } },
                                E('div', { style: { fontSize: 11.5, fontWeight: 600, color: t.vested ? ui.C.white : ui.C.zinc600 } }, t.year),
                                E('div', { style: { fontSize: 10.5, color: ui.C.zinc700, filter: p ? 'blur(4px)' : 'none' } }, t.shares != null ? fmtShares(t.shares) : fmtGBP(t.value)));
                        })));
            })),
        E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, lineHeight: 1.45, padding: '8px 4px 0' } },
            'Filled years have vested (counted from March). Values are at award: the bonus less its cash part.'));
}

// ── Year list ────────────────────────────────────────────────────────────────
function Details(props) {
    var ui = useUI(), r = props.row, p = props.privacy, f = [];
    var redPrev = props.prev && props.prev.redundancy;
    f.push(E(Field, { key: 'base', label: 'Base salary', privacy: p }, fmtGBP(r.base)));
    f.push(E(Field, { key: 'bonus', label: 'Bonus' + (r.year ? ' for ' + r.year : ''), privacy: p }, r.bonus == null ? 'Not known yet' : fmtGBP(r.bonus)));
    if (r.stock > 0) {
        f.push(E(Field, { key: 'cash', label: '· in cash', privacy: p }, fmtGBP(r.cashPart) + ' (' + fmtPct(r.cashPart / r.bonus) + ')'));
        f.push(E(Field, { key: 'stock', label: '· in stock', privacy: p }, fmtGBP(r.stock)));
    }
    if (r.shares) f.push(E(Field, { key: 'shares', label: 'Shares awarded ' + (r.year + 1), privacy: p },
        fmtShares(r.shares) + (r.stockName ? ' ' + r.stockName : '') + (r.price ? ' at ' + fmtPrice(r.price, r.currency) : '')));
    if (r.impliedFx) f.push(E(Field, { key: 'fx', label: 'Implied rate' }, '$' + r.impliedFx.toFixed(3) + ' to £1'));
    if (r.redundancy) f.push(E(Field, { key: 'red', label: 'Redundancy', privacy: p }, fmtGBP(r.redundancy)));
    f.push(E(Field, { key: 'tc', label: 'Total comp', privacy: p }, fmtGBP(r.tc)));
    if (r.yoy != null) f.push(E(Field, { key: 'yoy', label: 'Change on ' + (r.year - 1) }, fmtPct(r.yoy, true)));
    if ((r.redundancy || redPrev) && r.yoyEarned != null) f.push(E(Field, { key: 'yoyE', label: '· without redundancy' }, fmtPct(r.yoyEarned, true)));
    if (r.bonusYoy != null) f.push(E(Field, { key: 'byoy', label: 'Bonus change' }, fmtPct(r.bonusYoy, true)));
    if (r.bonusPct != null) f.push(E(Field, { key: 'bpct', label: 'Bonus / base' }, fmtPct(r.bonusPct)));
    if (r.avg3 != null) f.push(E(Field, { key: 'avg', label: '3-year average', privacy: p }, fmtGBP(r.avg3)));
    if (r.avg3 != null && Math.abs(r.avg3 - r.avg3Earned) > 0.5) f.push(E(Field, { key: 'avgE', label: '· without redundancy', privacy: p }, fmtGBP(r.avg3Earned)));
    return E('div', { style: { padding: '2px 14px 12px', borderTop: '1px solid ' + ui.C.border, background: ui.C.surfaceHigh } },
        f,
        r.notes && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, padding: '10px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.45 } }, r.notes),
        E('button', { onClick: props.onEdit, style: { display: 'block', width: '100%', background: 'none', border: 'none', color: ui.C.zinc600, fontFamily: ui.sys, fontSize: 13.5, marginTop: 8, padding: 6, cursor: 'pointer' } }, 'Edit'));
}
function YearRow(props) {
    var ui = useUI(), r = props.row, p = props.privacy;
    var sub = [];
    if (r.bonus == null) sub.push('bonus not known yet');
    else if (r.bonusPct != null) sub.push('bonus ' + fmtPct(r.bonusPct) + ' of base');
    if (r.stock > 0) sub.push('part stock');
    if (r.redundancy) sub.push('redundancy');
    return E('div', { style: { borderTop: props.first ? 'none' : '1px solid ' + ui.C.border } },
        E('button', { onClick: props.onToggle, 'aria-expanded': props.open,
            style: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '11px 14px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' } },
            E('div', { style: { flex: 1, minWidth: 0 } },
                E('div', { style: { fontFamily: ui.sys, fontSize: 15, fontWeight: 600, color: ui.C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    r.year, r.title && E('span', { style: { fontWeight: 500, color: ui.C.zinc600 } }, ' · ' + r.title)),
                E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } }, sub.join(' · '))),
            E('div', { style: { textAlign: 'right', flexShrink: 0 } },
                E('div', { style: moneyStyle(ui, 15, p, r.complete ? ui.C.white : ui.C.zinc600, 600) }, fmtGBP(r.tc)),
                E('div', { style: { fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', fontSize: 12.5, color: ui.C.zinc700, fontWeight: 500 } },
                    r.yoy != null ? fmtPct(r.yoy, true) : r.complete ? '' : 'base so far'))),
        props.open && E(Details, { row: r, prev: props.prev, privacy: p, onEdit: props.onEdit }));
}

var _openYear = null;
var _mainScrollTop = 0;
function MainView(props) {
    var ui = useUI(), rows = props.rows, today = props.today;
    var open = React.useState(_openYear);
    if (!rows.length) {
        return E('div', { style: { padding: '12px 16px' } },
            E('div', { style: cardStyle(ui, { padding: '22px 18px', textAlign: 'center' }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 16, color: ui.C.white, fontWeight: 600, marginBottom: 6 } }, 'No pay yet'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 16 } },
                    'Copy your pay table out of your spreadsheet (year, title, base, bonus, redundancy, and the cash and stock columns) and paste it in, or add years one at a time.'),
                E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    E('button', { style: buttonStyle(ui, 'primary'), onClick: props.onPaste }, 'Paste from spreadsheet'),
                    E('button', { style: buttonStyle(ui), onClick: function () { props.onEdit(null); } }, '+ Add year'))));
    }
    var s = summary(rows), awards = stockAwards(rows, today);
    var byYear = {};
    rows.forEach(function (r) { byYear[r.year] = r; });
    return E('div', { style: { padding: '12px 16px 0' } },
        E(Hero, { summary: s, prev: s.latest ? byYear[s.latest.year - 1] : null, privacy: props.privacy }),
        E(ChartCard, { rows: rows, summary: s, today: today, privacy: props.privacy }),
        E(AwardsCard, { awards: awards, privacy: props.privacy }),
        E('div', { style: { margin: '22px 4px 8px' } }, E('span', { style: capsLabel(ui) }, 'Years')),
        E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
            rows.slice().reverse().map(function (r, i) {
                return E(YearRow, { key: r.id, row: r, prev: byYear[r.year - 1], first: i === 0, privacy: props.privacy, open: open[0] === r.year,
                    onToggle: function () { var v = open[0] === r.year ? null : r.year; _openYear = v; open[1](v); },
                    onEdit: function () { props.onEdit(r.id); } });
            })),
        E('div', { style: { display: 'flex', gap: 10, marginTop: 14 } },
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { flex: 1 }), onClick: function () { props.onEdit(null); } }, '+ Add year'),
            E('button', { style: Object.assign(buttonStyle(ui), { flex: 1 }), onClick: props.onPaste }, 'Paste from sheet')),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc700, lineHeight: 1.45, padding: '14px 4px 0' } },
            'Each year’s bonus is the one for that year’s work, paid early the next year. Total comp includes redundancy, as your sheet does. Pay is kept on this phone and in your encrypted backups.'));
}

function Label(props) {
    var ui = useUI();
    return E('label', { style: { display: 'block', marginBottom: 12, minWidth: 0, flex: props.flex } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, marginBottom: 5 } }, props.text),
        props.children,
        props.hint && E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 4, lineHeight: 1.4 } }, props.hint));
}
var VESTS = [1, 2, 3, 4, 5].map(function (n) { return { id: n, label: n === 1 ? '1 year' : n + ' years' + (n === 4 ? ' (25% a year)' : '') }; });
// Add or change one year.
function EditView(props) {
    var ui = useUI();
    var existing = props.id ? props.state.years.filter(function (y) { return y.id === props.id; })[0] : null;
    var last = props.state.years[props.state.years.length - 1];
    var f = React.useState(function () {
        var y = existing || { year: last ? last.year + 1 : new Date().getFullYear(), title: last ? last.title : '' };
        var str = function (v) { return v == null ? '' : String(v); };
        return { year: str(y.year), title: y.title || '', base: str(y.base), bonus: str(y.bonus), redundancy: str(y.redundancy), cash: str(y.cash),
                 shares: str(y.shares), price: str(y.price), currency: y.currency || 'USD', stockName: y.stockName || (last && last.stockName) || '',
                 vest: y.vest || DEFAULT_VEST, notes: y.notes || '' };
    });
    var form = f[0], err = React.useState(null), del = React.useState(false);
    function set(k, v) { var n = Object.assign({}, form); n[k] = v; f[1](n); }
    function save() {
        var nums = {};
        var bad = ['base', 'bonus', 'redundancy', 'cash', 'shares', 'price'].filter(function (k) {
            if (form[k].trim() === '') { nums[k] = null; return false; }
            nums[k] = parseNum(form[k]);
            return nums[k] == null || nums[k] < 0;
        });
        if (bad.length) return err[1]('Amounts should be numbers (check ' + bad.join(', ') + ').');
        var yr = yearOf(form.year);
        if (!yr) return err[1]('Give the year as four digits, e.g. 2026.');
        if (props.state.years.some(function (y) { return y.year === yr && (!existing || y.id !== existing.id); })) return err[1](yr + ' is already here: open it from the list to change it.');
        if (nums.cash != null && nums.bonus != null && nums.cash > nums.bonus) return err[1]('The cash part can’t be more than the whole bonus.');
        var y = validYear({ id: existing ? existing.id : null, year: yr, title: form.title, base: nums.base, bonus: nums.bonus, redundancy: nums.redundancy,
                            cash: nums.cash, shares: nums.shares, price: nums.price, currency: form.currency, stockName: form.stockName, vest: +form.vest, notes: form.notes });
        var years = existing ? props.state.years.map(function (x) { return x.id === y.id ? y : x; }) : props.state.years.concat([y]);
        saveState(Object.assign({}, props.state, { years: years })).catch(function () {});
        props.onDone();
    }
    function remove() {
        if (!del[0]) { del[1](true); setTimeout(function () { del[1](false); }, 4000); return; }
        saveState(Object.assign({}, props.state, { years: props.state.years.filter(function (y) { return y.id !== existing.id; }) })).catch(function () {});
        props.onDone();
    }
    var input = function (k, extra) {
        return E('input', Object.assign({ value: form[k], onChange: function (e) { set(k, e.target.value); }, style: inputStyle(ui) }, extra || {}));
    };
    var num = { inputMode: 'decimal', placeholder: '0' };
    var yr = yearOf(form.year);
    var bonusN = parseNum(form.bonus), cashN = parseNum(form.cash);
    var stockN = bonusN != null && cashN != null ? Math.max(0, bonusN - cashN) : null;
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Year', flex: 1 }, input('year', { inputMode: 'numeric', placeholder: '2026' })),
            E(Label, { text: 'Title', flex: 2 }, input('title', { placeholder: 'e.g. VP', autoCapitalize: 'words' }))),
        E(Label, { text: 'Base salary (£)' }, input('base', num)),
        E(Label, { text: 'Bonus for ' + (yr || 'the year') + ' (£)', hint: 'Cash and stock together. Leave blank until it’s known; 0 for no bonus.' }, input('bonus', { inputMode: 'decimal', placeholder: 'Not known yet' })),
        E(Label, { text: 'Redundancy payment (£)' }, input('redundancy', num)),
        E('div', { style: Object.assign(capsLabel(ui), { margin: '18px 0 10px' }) }, 'Bonus paid in stock'),
        E(Label, { text: 'Cash part of the bonus (£)', hint: stockN != null ? 'So ' + fmtGBP(stockN) + ' was paid in stock.' : 'Blank when the bonus was all cash.' }, input('cash', { inputMode: 'decimal', placeholder: 'All cash' })),
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Shares awarded', flex: 1 }, input('shares', { inputMode: 'decimal', placeholder: '0' })),
            E(Label, { text: 'Award price', flex: 1 }, input('price', { inputMode: 'decimal', placeholder: '0.00' })),
            E(Label, { text: 'In', flex: 0.8 }, E('select', { value: form.currency, onChange: function (e) { set('currency', e.target.value); }, style: inputStyle(ui) },
                E('option', { value: 'USD' }, '$'), E('option', { value: 'GBP' }, '£')))),
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Stock', flex: 1 }, input('stockName', { placeholder: 'e.g. Citi', autoCapitalize: 'words' })),
            E(Label, { text: 'Vests over', flex: 1.4 }, E('select', { value: form.vest, onChange: function (e) { set('vest', +e.target.value); }, style: inputStyle(ui) },
                VESTS.map(function (v) { return E('option', { key: v.id, value: v.id }, v.label); })))),
        E(Label, { text: 'Notes' }, E('textarea', { value: form.notes, rows: 3, onChange: function (e) { set('notes', e.target.value); },
                                                    style: inputStyle(ui, { height: 'auto', padding: '8px 10px', resize: 'vertical' }) })),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            E('button', { style: buttonStyle(ui, 'primary'), onClick: save }, existing ? 'Save' : 'Add year'),
            existing && E('button', { style: buttonStyle(ui, 'danger'), onClick: remove }, del[0] ? 'Tap again to delete' : 'Delete year')));
}

// Paste rows copied out of a spreadsheet, check them, then add them.
var SHIFTS = [{ id: 'paid', label: 'Year paid' }, { id: 'same', label: 'Bonus year' }];
function PasteView(props) {
    var ui = useUI(), p = props.privacy;
    var txt = React.useState(''), done = React.useState(null), shift = React.useState(null);
    var parsed = React.useMemo(function () { return parsePaste(txt[0], shift[0] == null ? null : shift[0] === 'paid'); }, [txt[0], shift[0]]);
    var hasStockCols = parsed.rows.some(function (y) { return y.cash != null || y.shares != null; }) || parsed.paidNextYear;
    function add() {
        var res = mergeYears(props.state.years, parsed.rows);
        saveState(Object.assign({}, props.state, { years: res.years })).catch(function () {});
        done[1]({ added: res.added, updated: res.updated });
        txt[1]('');
        shift[1](null);
    }
    var preview = computeYears(parsed.rows);
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, lineHeight: 1.5, marginBottom: 12 } },
            'Select your pay table in Excel or Numbers, including the header row, copy it and paste it below. Worked-out columns (TC, YoY, averages) are skipped: the app works them out. A year already here is updated.'),
        E('textarea', { value: txt[0], rows: 6, placeholder: 'Paste here', onChange: function (e) { txt[1](e.target.value); done[1](null); },
                        autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false,
                        style: inputStyle(ui, { height: 'auto', padding: '10px', fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical', whiteSpace: 'pre', overflowX: 'auto' }) }),
        done[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.emerald, margin: '12px 0' } },
            'Added ' + done[0].added + (done[0].added === 1 ? ' year' : ' years') + (done[0].updated ? ', updated ' + done[0].updated : '') + '.'),
        preview.length > 0 && hasStockCols && E('div', { style: cardStyle(ui, { padding: '12px 14px', marginTop: 14 }) },
            E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
                E('span', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.white, fontWeight: 600 } }, 'Cash and shares are on the row of the'),
                E(Segmented, { options: SHIFTS, value: parsed.paidNextYear ? 'paid' : 'same', onChange: shift[1] })),
            E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, marginTop: 6, lineHeight: 1.45 } },
                parsed.paidNextYear ? 'Each row’s cash payment and shares go with the bonus of the year before.' + (parsed.detected ? ' Picked because some years paid out more cash than their own bonus.' : '')
                                    : 'Each row’s cash payment and shares go with that row’s own bonus.')),
        preview.length > 0 && E('div', { style: { marginTop: 16 } },
            E('div', { style: Object.assign(capsLabel(ui), { margin: '0 4px 8px' }) }, preview.length + (preview.length === 1 ? ' year found' : ' years found') + (parsed.skipped ? ' · ' + parsed.skipped + (parsed.skipped === 1 ? ' row skipped' : ' rows skipped') : '')),
            E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
                preview.slice().reverse().map(function (r, i) {
                    var bits = ['base ' + fmtGBP(r.base), r.bonus == null ? 'bonus not known' : 'bonus ' + fmtGBP(r.bonus)];
                    if (r.stock > 0) bits.push(fmtGBP(r.stock) + ' in stock' + (r.shares ? ' (' + fmtShares(r.shares) + ' shares)' : ''));
                    if (r.redundancy) bits.push('redundancy ' + fmtGBP(r.redundancy));
                    return E('div', { key: r.year, style: { padding: '10px 14px', borderTop: i ? '1px solid ' + ui.C.border : 'none', fontFamily: ui.sys } },
                        E('div', { style: { fontSize: 14, color: ui.C.white, fontWeight: 600 } }, r.year + (r.title ? ' · ' + r.title : '')),
                        E('div', { style: { fontSize: 12, color: ui.C.zinc600, marginTop: 2, filter: p ? 'blur(5px)' : 'none' } }, bits.join(' · ')));
                })),
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', marginTop: 12 }), onClick: add },
                'Add ' + preview.length + (preview.length === 1 ? ' year' : ' years'))),
        txt[0].trim() && !preview.length && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.amber, marginTop: 12 } },
            'No years found. Copy the rows straight from the spreadsheet so the columns stay separate, with the year in the first column.'));
}

function ScreenInner(props) {
    var ui = useUI();
    var state = useStoreState();
    var v = React.useState({ name: 'main' }), view = v[0], setView = v[1];
    var rows = React.useMemo(function () { return computeYears(state.years); }, [state]);
    var today = todayISO();
    var scrollRef = React.useRef(null);
    React.useLayoutEffect(function () {
        if (view.name === 'main' && _ready && scrollRef.current) scrollRef.current.scrollTo({ top: _mainScrollTop, behavior: 'instant' });
    }, [view.name, _ready]);
    var back = view.name === 'main' ? null : function () { setView({ name: 'main' }); };
    var body;
    if (!_ready) body = E('div', { style: { padding: 32, textAlign: 'center', fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 } }, 'Loading…');
    else if (view.name === 'edit') body = E(EditView, { id: view.id, state: state, onDone: back });
    else if (view.name === 'paste') body = E(PasteView, { state: state, privacy: props.privacyMode });
    else body = E(MainView, { rows: rows, today: today, privacy: props.privacyMode, onPaste: function () { setView({ name: 'paste' }); },
                              onEdit: function (id) { setView({ name: 'edit', id: id }); } });
    var title = view.name === 'paste' ? 'Paste pay' : view.id ? 'Edit year' : 'Add year';
    return E('div', {
        'data-swipe-tabs': view.name === 'main' ? '' : null, 'data-tab-screen': 'pay',
        style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: ui.C.bg, display: 'flex', flexDirection: 'column', WebkitTapHighlightColor: 'transparent' }
    },
        back && E(Header, { title: title, onBack: back }),
        _loadError && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.rose, padding: '8px 16px' } }, 'Storage problem: ' + _loadError),
        E('div', { key: view.name, ref: scrollRef, onScroll: view.name === 'main' ? function (e) { _mainScrollTop = e.currentTarget.scrollTop; } : null,
                   className: 'ios-scroll', style: { flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'max(env(safe-area-inset-bottom), 28px)' } },
            body));
}

// Keeps a bug in this screen from taking down the rest of the app.
class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error: error }; }
    componentDidCatch(error, info) { console.error('Pay screen error:', error, info); }
    render() {
        if (!this.state.error) return this.props.children;
        var ui = this.props.ui;
        return E('div', { style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: ui.C.bg, padding: '40px 20px', fontFamily: ui.sys } },
            E('div', { style: { color: ui.C.rose, fontSize: 16, fontWeight: 600, marginBottom: 8 } }, 'Pay hit a problem'),
            E('div', { style: { color: ui.C.zinc600, fontSize: 13, marginBottom: 20, lineHeight: 1.5 } },
                String(this.state.error && this.state.error.message || this.state.error) + '. Your saved pay is untouched.'),
            E('button', { onClick: this.props.onClose, style: buttonStyle(ui) }, 'Back to Investments'));
    }
}

function PayScreen(props) {
    var ui = Object.assign({}, DEFAULT_UI, props.ui || {});
    ui.C = Object.assign({}, DEFAULT_UI.C, (props.ui && props.ui.C) || {});
    return E(UICtx.Provider, { value: ui }, E(Boundary, { ui: ui, onClose: props.onClose }, E(ScreenInner, props)));
}

window.PayScreen = PayScreen;
window.PayStore = PayStore;
window.PayIcon = PayIcon;
window.PayColor = ORANGE;
// For tests only: the pure parts, no UI.
window.__payInternals = { validateState: validateState, validYear: validYear, parsePaste: parsePaste, mergeYears: mergeYears, computeYears: computeYears,
    stockAwards: stockAwards, receivedByYear: receivedByYear, summary: summary, isVested: isVested, headerKey: headerKey, stockNameOf: stockNameOf };
})();
