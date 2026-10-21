// ─── Pay (salary, bonus, redundancy) ─────────────────────────────────────────
// Pay year by year: base salary, the discretionary bonus and any redundancy payment, with total compensation,
// year-on-year growth, bonus against base and a 3-year average, and a stacked bar chart. Each year also keeps what its
// row on Fergus's sheet holds besides: the cash bonus payment and shares awarded that year, and the sales credits (EV)
// generated. Everything stays on the year its row is for (Fergus asked): nothing moves between years.
// Pay is the Pay line on the Cash Flow tab (lifeadmin.js), not a tab of its own (Fergus asked): Cash Flow lists it,
// opens its page and owns the header, Back and scrolling; this file draws the page's content.
//
// Loaded by index.html as its own file, before lifeadmin.js: <script src="pay.js?v=N">. Bump N there whenever this file
// changes, so the Home Screen app never pairs a new index.html with a cached old copy of this file.
//
// Exposes:
//   window.PayView  — one Pay page (props: page 'main' | 'edit' | 'paste' | 'takehome', id, privacy, ui, onEdit(id), onPaste(),
//                     onTakeHome(), onDone())
//   window.PayStore — backupSnapshot() / restore(obj) for the app's JSON backup, headline() for the Cash Flow line, plus
//                     get/subscribe/deleteAll
//   window.PayIcon  — Pay's icon
//
// Data lives in its own IndexedDB database ('portfolio-pay', kept from when Pay was a tab: renaming it would strand saved
// pay) and goes into the app's backups (the cloud copy is encrypted on the phone before it is sent). No pay figure is
// ever written into this file: the repo is public.
(function () {
'use strict';
var E = React.createElement;

// ── Store (IndexedDB, own database) ──────────────────────────────────────────
// state = { v: 2, years: [Year], updatedAt }
//   Year = { id, year, title, base, bonus, redundancy, cash, shares, price, currency, stockName, ev, fx, notes }
//          year:       the calendar year the row is for (2021).
//          base:       base salary for the year, £.
//          bonus:      the discretionary bonus for this year's performance, £. null = not known yet (the year isn't
//                      over); 0 = no bonus.
//          redundancy: a redundancy payment received in the year, £; null = none.
//          cash:       the sheet's Cash Payment on this row: bonus cash paid in this year, £ (for the year before's bonus).
//          shares:     shares awarded in this year, at `price` a share in `currency` (USD or GBP), named stockName ('Citi').
//          ev:         sales credits generated in the year (EV), $; null = none recorded.
//          fx:         US$ per £1 for the year, to set pay against EV; null = the year's average from USD_PER_GBP.
//   takeHome (optional) = { pct, scheme, onBonus, payslip }: what's needed to work out take-home pay (see netPay).
//          pct:     pension contribution, a share of pay (0.05 = 5%).
//          scheme:  'sacrifice' (salary sacrifice: before tax and NI), 'netpay' (before tax, not NI) or 'ras' (relief at
//                   source: taken from pay after tax, the pension adds basic-rate relief).
//          onBonus: the contribution is taken from the bonus too.
//          payslip: the monthly take-home on the latest payslip, £; when set, Cash Flow uses it instead of the worked-out one.
//   v 1 kept cash, shares and price on the bonus year (the year before the one they were paid in); v 2 keeps them on
//   the year paid, as the sheet does. Loading a v 1 state moves them back once.
var DB_NAME = 'portfolio-pay';
var DB_STORE = 'kv';
var DB_KEY = 'state';
function emptyState() { return { v: 2, years: [], updatedAt: null }; }

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
        ev: positive(typeof y.ev === 'number' ? Math.round(y.ev) : null),
        fx: typeof y.fx === 'number' && y.fx > 0.5 && y.fx < 3 ? Math.round(y.fx * 10000) / 10000 : null,
        notes: text(y.notes, 500),
    };
}
// Returns a cleaned copy of a stored or restored state (one entry per year, oldest first), or null when it is not a Pay state.
function validateState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.years)) return null;
    var byYear = {}, ids = {};
    unshiftV1(s).forEach(function (y) {
        var c = validYear(y);
        if (!c) return;
        while (ids[c.id]) c.id = newId();
        ids[c.id] = true;
        byYear[c.year] = c;
    });
    var years = Object.keys(byYear).map(function (k) { return byYear[k]; }).sort(function (a, b) { return a.year - b.year; });
    var out = { v: 2, years: years, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null };
    var th = validTakeHome(s.takeHome);
    if (th) out.takeHome = th;
    return out;
}
var SCHEMES = [{ id: 'sacrifice', label: 'Salary sacrifice' }, { id: 'netpay', label: 'Net pay (before tax)' }, { id: 'ras', label: 'Relief at source' }];
function validTakeHome(t) {
    if (!t || typeof t !== 'object') return null;
    var pct = typeof t.pct === 'number' && t.pct >= 0 && t.pct <= 0.6 ? Math.round(t.pct * 10000) / 10000 : 0;
    return { pct: pct, scheme: SCHEMES.some(function (x) { return x.id === t.scheme; }) ? t.scheme : 'sacrifice', onBonus: t.onBonus === true,
             payslip: positive(money(t.payslip)) };
}
// A v 1 state's years with each cash payment, shares and price moved from the bonus year to the year after (when they
// were paid), where the sheet has them. A year that only gets them gains a row.
function unshiftV1(s) {
    if (s.v !== 1) return s.years;
    var by = {}, out = [];
    s.years.forEach(function (y) {
        if (!y || typeof y !== 'object') return;
        var c = Object.assign({}, y, { cash: null, shares: null, price: null }, y.shares ? { stockName: '' } : {});
        by[y.year] = c; out.push(c);
    });
    s.years.forEach(function (y) {
        if (!y || typeof y !== 'object' || (y.cash == null && y.shares == null && y.price == null)) return;
        var to = by[y.year + 1];
        if (!to) { to = { year: y.year + 1 }; by[to.year] = to; out.push(to); }
        to.cash = y.cash; to.shares = y.shares; to.price = y.price;
        if (y.shares) { to.currency = y.currency; to.stockName = y.stockName; }
    });
    return out;
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
    // The Cash Flow line: the latest year with its bonus known (with how it compares to the year before), the year under
    // way after it, and take-home pay (takeHomeOf). All null when there is no pay yet.
    headline: function () {
        var rows = computeYears(_state.years), s = summary(rows);
        return { latest: s.latest, current: s.current, count: _state.years.length, takeHome: takeHomeOf(_state, rows) };
    },
};

function useStoreState() {
    var st = React.useState(0);
    React.useEffect(function () { return PayStore.subscribe(function () { st[1](function (n) { return n + 1; }); }); }, []);
    return _state;
}

// ── Calculations ─────────────────────────────────────────────────────────────
function pct(a, b) { return a == null || b == null || !(b > 0) ? null : a / b - 1; }
// US$ per £1, each year's average (Bank of England annual averages, rounded; 2025 approximate). A year can set its own.
var USD_PER_GBP = { 2010: 1.546, 2011: 1.604, 2012: 1.585, 2013: 1.565, 2014: 1.648, 2015: 1.528, 2016: 1.355, 2017: 1.289,
                    2018: 1.335, 2019: 1.277, 2020: 1.284, 2021: 1.376, 2022: 1.237, 2023: 1.244, 2024: 1.278, 2025: 1.32 };
function fxFor(y) {
    if (y.fx) return { rate: y.fx, own: true };
    if (USD_PER_GBP[y.year]) return { rate: USD_PER_GBP[y.year], own: false };
    var ks = Object.keys(USD_PER_GBP).map(Number).sort(function (a, b) { return a - b; });
    return { rate: USD_PER_GBP[y.year < ks[0] ? ks[0] : ks[ks.length - 1]], own: false };
}
// Every year with its figures worked out, oldest first.
//   tc:       total compensation: base + bonus + redundancy (as the sheet adds it up). Without a known bonus it is base
//             (+ redundancy) and `complete` is false, so no growth is worked out from it.
//   earned:   base + bonus, without redundancy.
//   evPct:    pay (base + bonus, without redundancy) in $ at the year's rate, as a share of the year's EV (sales credits).
//   yoy:      tc against the year before; yoyEarned without redundancy (only differs when either year had one).
//   bonusYoy: the bonus against the year before's (none when that was £0).
//   bonusPct: the bonus as a share of base.
//   avg3:     the average tc of this year and the two before (the sheet's 3yr average), when all three are complete.
function computeYears(years) {
    var list = (years || []).slice().sort(function (a, b) { return a.year - b.year; });
    var by = {};
    var out = list.map(function (y) {
        var earned = (y.base || 0) + (y.bonus || 0), fx = fxFor(y);
        var r = Object.assign({}, y, {
            fxRate: fx.rate, fxOwn: fx.own,
            complete: y.bonus != null && y.base != null,
            earned: earned, tc: earned + (y.redundancy || 0),
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
        r.evPct = r.ev && r.complete ? r.earned * r.fxRate / r.ev : null;
        r.evYoy = r.ev && p && p.ev ? pct(r.ev, p.ev) : null;
        var three = [by[r.year - 2], p, r];
        var ok = three.every(function (x) { return x && x.complete; });
        r.avg3 = ok ? three.reduce(function (s, x) { return s + x.tc; }, 0) / 3 : null;
        r.avg3Earned = ok ? three.reduce(function (s, x) { return s + x.earned; }, 0) / 3 : null;
    });
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

// ── Take-home pay ────────────────────────────────────────────────────────────
// UK (outside Scotland) income tax and employee National Insurance for 2026/27. The thresholds are frozen, so these are
// the 2025/26 figures too. Worked out over the year, as PAYE evens out by the year's end; a bonus month's payslip will
// differ, the year won't. Relief at source includes the higher-rate relief claimed back through self assessment, so
// payslips show a little less. Not covered: student loan, Scottish rates, taxable benefits: the payslip figure is there
// for those.
var TAX = { allowance: 12570, taperFrom: 100000, basicBand: 37700, additionalFrom: 125140, basic: 0.2, higher: 0.4, additional: 0.45,
            niFrom: 12570, niUpper: 50270, niMain: 0.08, niUpperRate: 0.02 };
// Income tax on a year's taxable pay. ani: adjusted net income, which sets how much of the personal allowance is left;
// band: extra basic-rate band (relief at source widens it by the gross contribution).
function incomeTax(taxable, ani, band) {
    var pa = Math.max(0, TAX.allowance - Math.max(0, ani - TAX.taperFrom) / 2);
    var above = Math.max(0, taxable - pa);
    var basic = Math.min(above, TAX.basicBand + (band || 0));
    var additional = Math.max(0, taxable - TAX.additionalFrom);
    return basic * TAX.basic + Math.max(0, above - basic - additional) * TAX.higher + additional * TAX.additional;
}
function nationalInsurance(pay) {
    return Math.max(0, Math.min(pay, TAX.niUpper) - TAX.niFrom) * TAX.niMain + Math.max(0, pay - TAX.niUpper) * TAX.niUpperRate;
}
// A year's pay → { gross, pension, tax, ni, net }. pension: what comes out of pay for it (relief at source: 80% of the
// contribution, the pension adding the other 20%).
function netPay(base, bonus, th) {
    th = th || validTakeHome({});
    var gross = (base || 0) + (bonus || 0);
    var contrib = th.pct * ((base || 0) + (th.onBonus ? bonus || 0 : 0));
    var taxable = gross, niPay = gross, fromPay = contrib, ani = gross, band = 0;
    if (th.scheme === 'sacrifice') { taxable = gross - contrib; niPay = gross - contrib; ani = taxable; }
    else if (th.scheme === 'netpay') { taxable = gross - contrib; ani = taxable; }
    else { fromPay = contrib * 0.8; ani = gross - contrib; band = contrib; }
    var tax = incomeTax(taxable, ani, band), ni = nationalInsurance(niPay);
    return { gross: gross, pension: fromPay, tax: tax, ni: ni, net: gross - fromPay - tax - ni };
}
// Take-home for Cash Flow: the base salary of the year under way (else the latest year), a month at a time, and the
// latest known bonus after tax and pension on top of it (paid once, so kept out of the monthly figure).
function takeHomeOf(state, rows) {
    var s = summary(rows), y = s.current || s.latest;
    if (!y || !(y.base > 0)) return null;
    var th = state.takeHome || validTakeHome({}), year = netPay(y.base, 0, th);
    var lastBonus = rows.filter(function (r) { return r.bonus > 0; }).pop() || null;
    var bonus = lastBonus ? { year: lastBonus.year, gross: lastBonus.bonus, net: netPay(y.base, lastBonus.bonus, th).net - year.net } : null;
    var worked = year.net / 12;
    return { year: y.year, base: y.base, annual: year, worked: worked, payslip: th.payslip, monthly: th.payslip || worked,
             settings: th, set: !!state.takeHome, bonus: bonus };
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
    ev:         /^(ev|sales credits?|credits|production)\b/,
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
// EV in dollars; a small figure is in $mm (the sheet's header says $mm while its figures are whole dollars).
function evOf(v) { var n = parseMoney(v); return n == null || n <= 0 ? null : n < 10000 ? n * 1e6 : n; }
function yearOf(v) { var t = String(v == null ? '' : v).trim(); return /^(19[5-9]\d|20\d\d)$/.test(t) ? +t : null; }
// text → { rows: [Year], skipped, stockName }. Every figure stays on the row it is on in the sheet.
function parsePaste(textIn) {
    var rows = splitRows(textIn), out = { rows: [], skipped: 0, stockName: '' };
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
                  cash: parseMoney(map.cash), shares: parseNum(map.shares), price: parseNum(map.price), notes: map.notes || '', ev: evOf(map.ev) };
        if (!year || (y.base == null && y.bonus == null && y.redundancy == null && y.cash == null && y.shares == null && y.ev == null)) { out.skipped++; return; }
        raw.push(y);
    });
    // A blank bonus before the last year with one was no bonus (£0); only the years after it are still to come.
    var lastBonus = raw.reduce(function (m, y) { return y.bonus != null && y.year > m ? y.year : m; }, 0);
    raw.forEach(function (y) { if (y.bonus == null && y.year < lastBonus) y.bonus = 0; });
    raw.forEach(function (y) {
        if (y.shares) { y.stockName = out.stockName; y.currency = 'USD'; }
        var c = validYear(y);
        if (c) out.rows.push(c);
    });
    return out;
}
// Pasted years replace the same year already here (keeping its id, notes and own $ rate) and add the rest.
function mergeYears(existing, incoming) {
    var by = {}, added = 0, updated = 0;
    (existing || []).forEach(function (y) { by[y.year] = y; });
    incoming.forEach(function (y) {
        var old = by[y.year];
        if (old) {
            updated++;
            by[y.year] = Object.assign({}, y, { id: old.id, notes: y.notes || old.notes, fx: y.fx || old.fx,
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
function fmtUSDm(n) { return n == null ? '—' : '$' + (n / 1e6).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + 'm'; }
function fmtShares(n) { return n == null ? '—' : n.toLocaleString('en-GB', { maximumFractionDigits: 2 }); }
function fmtPrice(n, cur) { return n == null ? '—' : (cur === 'GBP' ? '£' : '$') + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
function axisText(v) { return v >= 1000 ? '£' + (v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + 'k' : '£' + Math.round(v); }

// ── UI ───────────────────────────────────────────────────────────────────────
// Chart series (checked for colour-blind separation against the app's dark surface).
var SERIES = [
    { id: 'base',       label: 'Base',       color: '#3b82f6' },
    { id: 'bonus',      label: 'Bonus',      color: '#ea580c' },
    { id: 'redundancy', label: 'Redundancy', color: '#c026d3' },
];
var SERIES_BY_ID = {};
SERIES.forEach(function (s) { SERIES_BY_ID[s.id] = s; });
var DEFAULT_UI = {
    C: { bg: '#080c10', surface: '#0d1218', surfaceHigh: '#11161f', border: 'rgba(255,255,255,0.08)',
         amber: '#fbbf24', emerald: '#34d399', rose: '#f87171', blue: '#60a5fa', violet: '#a78bfa',
         zinc400: '#cbd5e1', zinc500: '#a1a1aa', zinc600: '#9da5b4', zinc700: '#888894', white: '#ffffff' },
    sys: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif',
    accent: '#2dd4bf',   // the buttons' colour: Cash Flow's teal, which Cash Flow passes in
};
var UICtx = React.createContext(DEFAULT_UI);
function useUI() { return React.useContext(UICtx); }

function icon(paths) { return typeof _li === 'function' ? _li(paths) : function () { return null; }; }
var PayIcon = icon([{ t: 'r', x: 2, y: 6, w: 20, h: 12, rx: 2 }, { t: 'c', cx: 12, cy: 12, r: 2.5 }, 'M6 12h.01', 'M18 12h.01']);

function cardStyle(ui, extra) {
    return Object.assign({ background: 'linear-gradient(180deg, ' + ui.C.surfaceHigh + ' 0%, ' + ui.C.surface + ' 100%)',
                           border: '1px solid ' + ui.C.border, borderRadius: 20 }, extra || {});
}
function capsLabel(ui) { return { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc500, textTransform: 'uppercase', letterSpacing: '0.18em' }; }
function moneyStyle(ui, size, privacy, color, weight) {
    return { fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', fontSize: size, fontWeight: weight || 700, color: color || ui.C.white,
             whiteSpace: 'nowrap', filter: privacy ? 'blur(7px)' : 'none' };
}
// '#2dd4bf' at 40% → 'rgba(45,212,191,0.4)'.
function tint(hex, a) {
    var n = parseInt(String(hex).slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
}
function buttonStyle(ui, kind) {
    var primary = kind === 'primary', danger = kind === 'danger';
    return { minHeight: 44, borderRadius: 12, padding: '0 14px', fontFamily: ui.sys, fontSize: 14, fontWeight: 600, cursor: 'pointer',
             background: primary ? tint(ui.accent, 0.14) : danger ? 'rgba(248,113,113,0.10)' : 'rgba(39,39,42,0.6)',
             border: '1px solid ' + (primary ? tint(ui.accent, 0.4) : danger ? 'rgba(248,113,113,0.3)' : ui.C.border),
             color: primary ? ui.accent : danger ? ui.C.rose : ui.C.zinc400,
             display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
}
function inputStyle(ui, extra) {
    return Object.assign({ display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, background: 'rgba(0,0,0,0.35)',
                           border: '1px solid ' + ui.C.border, borderRadius: 10, color: ui.C.white, fontFamily: ui.sys, fontSize: 16,
                           padding: '0 10px', height: 40, outline: 'none', WebkitAppearance: 'none', appearance: 'none' }, extra || {});
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
var CW = 340, CH = 200, PAD_L = 36, PAD_B = 18, PAD_T = 8;
var Y_STEP = 50000;   // £50k gridlines (Fergus asked)
function yOf(v, hi) { return PAD_T + (CH - PAD_T - PAD_B) * (1 - v / hi); }
// A bar segment with its top corners rounded (only the top segment of a bar is).
function segPath(x, y, w, h, r) {
    if (r <= 0 || h <= 0) return 'M' + x + ' ' + (y + h) + 'h' + w + 'v' + (-h) + 'h' + (-w) + 'z';
    r = Math.min(r, h, w / 2);
    return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'z';
}
// bars: [{ year, parts: [{ id, value, faint }], label }]
function PayChart(props) {
    var ui = useUI(), p = props.privacy, bars = props.bars, sel = props.selected;
    if (!bars.length) return null;
    var max = Math.max.apply(null, bars.map(function (b) { return b.parts.reduce(function (s, x) { return s + x.value; }, 0); }).concat([1]));
    var step = Y_STEP, hi = Math.max(1, Math.ceil(max / step)) * step;
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
            marks.push(E('path', { key: b.year + s.id, d: segPath(x, top, bw, h, si === shown.length - 1 ? 3 : 0), fill: SERIES_BY_ID[s.id].color }));
        });
        if (b.open) marks.push(E('text', { key: 'q' + b.year, x: x + bw / 2, y: yOf(acc, hi) - 4, textAnchor: 'middle', fontSize: 9, fill: '#888894' }, '?'));
        if (bi % every === (n - 1) % every) marks.push(E('text', { key: 'x' + b.year, x: x0 + colW / 2, y: CH - 5, textAnchor: 'middle', fontSize: 9, fill: on ? '#ffffff' : '#888894' }, '’' + String(b.year).slice(2)));
        // The whole column is the tap target, wider than the bar.
        marks.push(E('rect', { key: 'hit' + b.year, x: x0, y: 0, width: colW, height: CH, fill: 'transparent', style: { cursor: 'pointer' },
                               onClick: function () { props.onSelect(b.year); } }));
    });
    var used = SERIES.filter(function (s) { return bars.some(function (b) { return b.parts.some(function (x) { return x.id === s.id && x.value > 0; }); }); });
    return E('div', null,
        E('svg', { viewBox: '0 0 ' + CW + ' ' + CH, width: '100%', style: { display: 'block', touchAction: 'pan-y' }, role: 'img',
                   'aria-label': 'Pay by year, stacked: ' + used.map(function (s) { return s.label; }).join(', ') }, grid, marks),
        E('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8, fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600 } },
            used.map(function (s) { return E('span', { key: s.id, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } }, E(Swatch, { color: s.color }), s.label); })));
}
function barsFor(rows) {
    return rows.map(function (r) {
        return { year: r.year, open: !r.complete, parts: [{ id: 'base', value: r.base || 0 }, { id: 'bonus', value: r.bonus || 0 }, { id: 'redundancy', value: r.redundancy || 0 }] };
    });
}
// The figures for the tapped bar, under the chart.
function Readout(props) {
    var ui = useUI(), p = props.privacy, b = props.bar, row = props.row;
    if (!b) return null;
    var parts = b.parts.filter(function (x) { return x.value > 0; });
    var total = parts.reduce(function (s, x) { return s + x.value; }, 0);
    return E('div', { style: { marginTop: 10, borderTop: '1px solid ' + ui.C.border, paddingTop: 8, fontFamily: ui.sys } },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13.5, color: ui.C.white, fontWeight: 600, padding: '2px 0 4px' } },
            E('span', null, b.year + (row && row.title ? ' · ' + row.title : '')),
            E('span', { style: moneyStyle(ui, 14, p, ui.C.white, 650) }, fmtGBP(total))),
        parts.map(function (x, i) {
            return E('div', { key: i, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: ui.C.zinc400, padding: '2px 0' } },
                E(Swatch, { color: SERIES_BY_ID[x.id].color }), E('span', { style: { flex: 1 } }, SERIES_BY_ID[x.id].label),
                E('span', { style: moneyStyle(ui, 12.5, p, ui.C.zinc400, 500) }, fmtGBP(x.value)));
        }),
        b.open && E('div', { style: { fontSize: 12, color: ui.C.zinc700, paddingTop: 4 } }, 'Bonus not known yet.'));
}
function ChartCard(props) {
    var ui = useUI(), rows = props.rows, bars = barsFor(rows);
    var latest = props.summary.latest ? props.summary.latest.year : bars.length ? bars[bars.length - 1].year : null;
    var sel = React.useState(latest);
    var selected = bars.filter(function (b) { return b.year === sel[0]; })[0] ? sel[0] : latest;
    var bar = bars.filter(function (b) { return b.year === selected; })[0];
    return E('div', { style: cardStyle(ui, { padding: '14px 14px 12px', marginTop: 14 }) },
        E('div', { style: Object.assign(capsLabel(ui), { marginBottom: 10 }) }, 'Pay by year'),
        E(PayChart, { bars: bars, selected: selected, privacy: props.privacy, onSelect: sel[1] }),
        E(Readout, { bar: bar, row: rows.filter(function (r) { return r.year === selected; })[0], privacy: props.privacy }));
}

// ── Year list ────────────────────────────────────────────────────────────────
function Details(props) {
    var ui = useUI(), r = props.row, p = props.privacy, f = [];
    var redPrev = props.prev && props.prev.redundancy;
    f.push(E(Field, { key: 'base', label: 'Base salary', privacy: p }, fmtGBP(r.base)));
    f.push(E(Field, { key: 'bonus', label: 'Bonus' + (r.year ? ' for ' + r.year : ''), privacy: p }, r.bonus == null ? 'Not known yet' : fmtGBP(r.bonus)));
    if (r.redundancy) f.push(E(Field, { key: 'red', label: 'Redundancy', privacy: p }, fmtGBP(r.redundancy)));
    f.push(E(Field, { key: 'tc', label: 'Total comp', privacy: p }, fmtGBP(r.tc)));
    if (r.yoy != null) f.push(E(Field, { key: 'yoy', label: 'Change on ' + (r.year - 1) }, fmtPct(r.yoy, true)));
    if ((r.redundancy || redPrev) && r.yoyEarned != null) f.push(E(Field, { key: 'yoyE', label: '· without redundancy' }, fmtPct(r.yoyEarned, true)));
    if (r.bonusYoy != null) f.push(E(Field, { key: 'byoy', label: 'Bonus change' }, fmtPct(r.bonusYoy, true)));
    if (r.bonusPct != null) f.push(E(Field, { key: 'bpct', label: 'Bonus / base' }, fmtPct(r.bonusPct)));
    if (r.avg3 != null) f.push(E(Field, { key: 'avg', label: '3-year average', privacy: p }, fmtGBP(r.avg3)));
    if (r.avg3 != null && Math.abs(r.avg3 - r.avg3Earned) > 0.5) f.push(E(Field, { key: 'avgE', label: '· without redundancy', privacy: p }, fmtGBP(r.avg3Earned)));
    if (r.cash != null) f.push(E(Field, { key: 'cash', label: 'Cash bonus paid in ' + r.year, privacy: p }, fmtGBP(r.cash)));
    if (r.shares) f.push(E(Field, { key: 'shares', label: 'Shares awarded in ' + r.year, privacy: p },
        fmtShares(r.shares) + (r.stockName ? ' ' + r.stockName : '') + (r.price ? ' at ' + fmtPrice(r.price, r.currency) : '')));
    if (r.ev) f.push(E(Field, { key: 'ev', label: 'Sales credits (EV)', privacy: p }, fmtUSDm(r.ev) + (r.evYoy != null ? ' (' + fmtPct(r.evYoy, true) + ')' : '')));
    if (r.evPct != null) f.push(E(Field, { key: 'evPct', label: 'Pay / EV' }, fmtPct(r.evPct)));
    if (r.evPct != null) f.push(E(Field, { key: 'fxr', label: '· pay in $ at' }, '$' + r.fxRate.toFixed(3) + ' to £1' + (r.fxOwn ? '' : ' (year average)')));
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

// Take-home: a month of the base salary after pension, income tax and NI, and the latest bonus after them.
function TakeHomeCard(props) {
    var ui = useUI(), t = props.takeHome, p = props.privacy;
    if (!t) return null;
    var a = t.annual, m = function (v) { return v / 12; };
    var line = function (label, v, minus, strong) {
        return E('div', { key: label, style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0', fontFamily: ui.sys, fontSize: strong ? 14 : 13,
                                               color: strong ? ui.C.white : ui.C.zinc400, fontWeight: strong ? 600 : 400, borderTop: strong ? '1px solid ' + ui.C.border : 'none', marginTop: strong ? 4 : 0, paddingTop: strong ? 8 : 4 } },
            E('span', null, label), E('span', { style: moneyStyle(ui, strong ? 14 : 13, p, strong ? ui.C.white : ui.C.zinc400, strong ? 650 : 500) }, (minus ? '−' : '') + fmtGBP(v)));
    };
    var sch = SCHEMES.filter(function (x) { return x.id === t.settings.scheme; })[0];
    var diff = t.payslip ? t.payslip - t.worked : null;
    return E('div', { style: cardStyle(ui, { padding: '16px 18px', marginTop: 14 }) },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            E('span', { style: capsLabel(ui) }, 'Take-home ' + t.year),
            E('button', { onClick: props.onEdit, style: { fontFamily: ui.sys, fontSize: 12, color: ui.accent, background: 'none', border: '1px solid ' + tint(ui.accent, 0.4), borderRadius: 999, padding: '3px 10px', cursor: 'pointer' } }, 'Edit')),
        E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 } },
            E('span', { style: moneyStyle(ui, 28, p) }, fmtGBP(t.monthly)),
            E('span', { style: { fontFamily: ui.sys, fontSize: 14, color: ui.C.zinc600 } }, t.payslip ? 'a month, from your payslip' : 'a month')),
        t.payslip && E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc600, marginTop: 2 } },
            'Worked out: ', E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(t.worked)), Math.abs(diff) >= 1 ? ' (payslip ' + (diff > 0 ? '+' : '−') : '',
            Math.abs(diff) >= 1 && E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(Math.abs(diff))), Math.abs(diff) >= 1 ? ')' : ''),
        E('div', { style: { marginTop: 10 } },
            line('Base salary', m(a.gross)),
            line('Pension' + (t.settings.pct ? ' ' + fmtPct(t.settings.pct) + ', ' + sch.label.toLowerCase() : ''), m(a.pension), a.pension > 0),
            line('Income tax', m(a.tax), true),
            line('National Insurance', m(a.ni), true),
            line('Take-home', m(a.net), false, true)),
        t.bonus && E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc600, marginTop: 8, lineHeight: 1.45 } },
            'Bonus: ', E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(t.bonus.gross)), ' (' + t.bonus.year + ') is about ',
            E('span', { style: { filter: p ? 'blur(6px)' : 'none', color: ui.C.zinc400 } }, fmtGBP(t.bonus.net)), ' after tax' + (t.settings.onBonus && t.settings.pct ? ' and pension' : '') + ', on top, when paid.'),
        !t.set && E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.amber, marginTop: 8, lineHeight: 1.45 } },
            'Pension not set yet, so none is taken off. Tap Edit to add it.'),
        E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.4 } },
            '2026/27 UK tax and NI on ' + t.year + '’s base, over the year. No student loan, Scottish rates or benefits: add your payslip figure if they apply.'));
}

var _openYear = null;
function MainView(props) {
    var ui = useUI(), rows = props.rows;
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
    var s = summary(rows);
    var byYear = {};
    rows.forEach(function (r) { byYear[r.year] = r; });
    return E('div', { style: { padding: '12px 16px 0' } },
        E(Hero, { summary: s, prev: s.latest ? byYear[s.latest.year - 1] : null, privacy: props.privacy }),
        E(TakeHomeCard, { takeHome: props.takeHome, privacy: props.privacy, onEdit: props.onTakeHome }),
        E(ChartCard, { rows: rows, summary: s, privacy: props.privacy }),
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
            'Each year’s bonus is the one for that year’s work. Total comp includes redundancy, as your sheet does. Pay is kept on this phone and in your encrypted backups.'));
}

function Label(props) {
    var ui = useUI();
    return E('label', { style: { display: 'block', marginBottom: 12, minWidth: 0, flex: props.flex } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, marginBottom: 5 } }, props.text),
        props.children,
        props.hint && E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 4, lineHeight: 1.4 } }, props.hint));
}
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
                 ev: str(y.ev), fx: str(y.fx), notes: y.notes || '' };
    });
    var form = f[0], err = React.useState(null), del = React.useState(false);
    function set(k, v) { var n = Object.assign({}, form); n[k] = v; f[1](n); }
    function save() {
        var nums = {};
        var bad = ['base', 'bonus', 'redundancy', 'cash', 'shares', 'price', 'ev', 'fx'].filter(function (k) {
            if (form[k].trim() === '') { nums[k] = null; return false; }
            nums[k] = parseNum(form[k]);
            return nums[k] == null || nums[k] < 0;
        });
        if (bad.length) return err[1]('Amounts should be numbers (check ' + bad.join(', ') + ').');
        var yr = yearOf(form.year);
        if (!yr) return err[1]('Give the year as four digits, e.g. 2026.');
        if (props.state.years.some(function (y) { return y.year === yr && (!existing || y.id !== existing.id); })) return err[1](yr + ' is already here: open it from the list to change it.');
        var y = validYear({ id: existing ? existing.id : null, year: yr, title: form.title, base: nums.base, bonus: nums.bonus, redundancy: nums.redundancy,
                            cash: nums.cash, shares: nums.shares, price: nums.price, currency: form.currency, stockName: form.stockName,
                            ev: nums.ev, fx: nums.fx, notes: form.notes });
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
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Year', flex: 1 }, input('year', { inputMode: 'numeric', placeholder: '2026' })),
            E(Label, { text: 'Title', flex: 2 }, input('title', { placeholder: 'e.g. VP', autoCapitalize: 'words' }))),
        E(Label, { text: 'Base salary (£)' }, input('base', num)),
        E(Label, { text: 'Bonus for ' + (yr || 'the year') + ' (£)', hint: 'The whole bonus for this year’s work. Leave blank until it’s known; 0 for no bonus.' }, input('bonus', { inputMode: 'decimal', placeholder: 'Not known yet' })),
        E(Label, { text: 'Redundancy payment (£)' }, input('redundancy', num)),
        E('div', { style: Object.assign(capsLabel(ui), { margin: '18px 0 10px' }) }, 'Paid in ' + (yr || 'the year')),
        E(Label, { text: 'Cash bonus payment (£)' }, input('cash', { inputMode: 'decimal', placeholder: 'None' })),
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Shares awarded', flex: 1 }, input('shares', { inputMode: 'decimal', placeholder: '0' })),
            E(Label, { text: 'Award price', flex: 1 }, input('price', { inputMode: 'decimal', placeholder: '0.00' })),
            E(Label, { text: 'In', flex: 0.8 }, E('select', { value: form.currency, onChange: function (e) { set('currency', e.target.value); }, style: inputStyle(ui) },
                E('option', { value: 'USD' }, '$'), E('option', { value: 'GBP' }, '£')))),
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Stock', flex: 1 }, input('stockName', { placeholder: 'e.g. Citi', autoCapitalize: 'words' }))),
        E('div', { style: Object.assign(capsLabel(ui), { margin: '18px 0 10px' }) }, 'Sales credits'),
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'EV generated ($)', flex: 1.4 }, input('ev', { inputMode: 'decimal', placeholder: 'None' })),
            E(Label, { text: '$ to £1', flex: 1, hint: 'Blank: the year’s average' }, input('fx', { inputMode: 'decimal', placeholder: yr ? String(fxFor({ year: yr }).rate) : '' }))),
        E(Label, { text: 'Notes' }, E('textarea', { value: form.notes, rows: 3, onChange: function (e) { set('notes', e.target.value); },
                                                    style: inputStyle(ui, { height: 'auto', padding: '8px 10px', resize: 'vertical' }) })),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            E('button', { style: buttonStyle(ui, 'primary'), onClick: save }, existing ? 'Save' : 'Add year'),
            existing && E('button', { style: buttonStyle(ui, 'danger'), onClick: remove }, del[0] ? 'Tap again to delete' : 'Delete year')));
}

// The pension and payslip figures take-home is worked out from.
function TakeHomeView(props) {
    var ui = useUI(), th = props.state.takeHome || validTakeHome({});
    var f = React.useState(function () {
        return { pct: th.pct ? String(Math.round(th.pct * 10000) / 100) : '', scheme: th.scheme, onBonus: th.onBonus ? 'yes' : 'no', payslip: th.payslip == null ? '' : String(th.payslip) };
    });
    var form = f[0], err = React.useState(null);
    function set(k, v) { var n = Object.assign({}, form); n[k] = v; f[1](n); }
    function save() {
        var pct = form.pct.trim() === '' ? 0 : parseNum(form.pct), slip = form.payslip.trim() === '' ? null : parseNum(form.payslip);
        if (pct == null || pct < 0 || pct > 60) return err[1]('The pension should be a percentage, e.g. 5.');
        if (form.payslip.trim() !== '' && !(slip > 0)) return err[1]('The payslip take-home should be an amount in pounds.');
        saveState(Object.assign({}, props.state, { takeHome: { pct: pct / 100, scheme: form.scheme, onBonus: form.onBonus === 'yes', payslip: slip } })).catch(function () {});
        props.onDone();
    }
    var select = function (k, options) {
        return E('select', { value: form[k], onChange: function (e) { set(k, e.target.value); }, style: inputStyle(ui) },
            options.map(function (o) { return E('option', { key: o.id, value: o.id }, o.label); }));
    };
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Your pension (%)', flex: 1 }, E('input', { value: form.pct, inputMode: 'decimal', placeholder: '0', onChange: function (e) { set('pct', e.target.value); }, style: inputStyle(ui) })),
            E(Label, { text: 'From bonus too', flex: 1 }, select('onBonus', [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }]))),
        E(Label, { text: 'How it’s taken', hint: 'Salary sacrifice comes off before tax and NI; net pay before tax only; relief at source after tax, with 20% added by the pension. Your payslip or pension portal says which.' }, select('scheme', SCHEMES)),
        E(Label, { text: 'Take-home on your latest payslip (£ a month)', hint: 'Optional. When set, Cash Flow uses it instead of the worked-out figure: use it if you have a student loan, benefits or a different tax code.' },
            E('input', { value: form.payslip, inputMode: 'decimal', placeholder: 'Worked out', onChange: function (e) { set('payslip', e.target.value); }, style: inputStyle(ui) })),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%' }), onClick: save }, 'Save'));
}

// Paste rows copied out of a spreadsheet, check them, then add them.
function PasteView(props) {
    var ui = useUI(), p = props.privacy;
    var txt = React.useState(''), done = React.useState(null);
    var parsed = React.useMemo(function () { return parsePaste(txt[0]); }, [txt[0]]);
    function add() {
        var res = mergeYears(props.state.years, parsed.rows);
        saveState(Object.assign({}, props.state, { years: res.years })).catch(function () {});
        done[1]({ added: res.added, updated: res.updated });
        txt[1]('');
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
        preview.length > 0 && E('div', { style: { marginTop: 16 } },
            E('div', { style: Object.assign(capsLabel(ui), { margin: '0 4px 8px' }) }, preview.length + (preview.length === 1 ? ' year found' : ' years found') + (parsed.skipped ? ' · ' + parsed.skipped + (parsed.skipped === 1 ? ' row skipped' : ' rows skipped') : '')),
            E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
                preview.slice().reverse().map(function (r, i) {
                    var bits = ['base ' + fmtGBP(r.base), r.bonus == null ? 'bonus not known' : 'bonus ' + fmtGBP(r.bonus)];
                    if (r.cash != null) bits.push('cash paid ' + fmtGBP(r.cash));
                    if (r.shares) bits.push(fmtShares(r.shares) + ' shares');
                    if (r.redundancy) bits.push('redundancy ' + fmtGBP(r.redundancy));
                    if (r.ev) bits.push('EV ' + fmtUSDm(r.ev));
                    return E('div', { key: r.year, style: { padding: '10px 14px', borderTop: i ? '1px solid ' + ui.C.border : 'none', fontFamily: ui.sys } },
                        E('div', { style: { fontSize: 14, color: ui.C.white, fontWeight: 600 } }, r.year + (r.title ? ' · ' + r.title : '')),
                        E('div', { style: { fontSize: 12, color: ui.C.zinc600, marginTop: 2, filter: p ? 'blur(5px)' : 'none' } }, bits.join(' · ')));
                })),
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', marginTop: 12 }), onClick: add },
                'Add ' + preview.length + (preview.length === 1 ? ' year' : ' years'))),
        txt[0].trim() && !preview.length && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.amber, marginTop: 12 } },
            'No years found. Copy the rows straight from the spreadsheet so the columns stay separate, with the year in the first column.'));
}

// One Pay page, drawn inside the Cash Flow screen (which gives it the header, Back and the scrolling).
//   page 'main':  the summary, take-home, chart and years; 'edit': add (id null) or change one year; 'paste': paste from
//   the sheet; 'takehome': the pension and payslip figures take-home is worked out from.
function PayPage(props) {
    var ui = useUI();
    var state = useStoreState();
    var rows = React.useMemo(function () { return computeYears(state.years); }, [state]);
    var body;
    if (!_ready) body = E('div', { style: { padding: 32, textAlign: 'center', fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 } }, 'Loading…');
    else if (props.page === 'edit') body = E(EditView, { id: props.id, state: state, onDone: props.onDone });
    else if (props.page === 'paste') body = E(PasteView, { state: state, privacy: props.privacy });
    else if (props.page === 'takehome') body = E(TakeHomeView, { state: state, onDone: props.onDone });
    else body = E(MainView, { rows: rows, takeHome: takeHomeOf(state, rows), privacy: props.privacy, onPaste: props.onPaste, onEdit: props.onEdit, onTakeHome: props.onTakeHome });
    return E(React.Fragment, null,
        _loadError && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.rose, padding: '8px 16px' } }, 'Pay storage problem: ' + _loadError),
        body);
}

function PayView(props) {
    var ui = Object.assign({}, DEFAULT_UI, props.ui || {});
    ui.C = Object.assign({}, DEFAULT_UI.C, (props.ui && props.ui.C) || {});
    return E(UICtx.Provider, { value: ui }, E(PayPage, props));
}

window.PayView = PayView;
window.PayStore = PayStore;
window.PayIcon = PayIcon;
// For tests only: the pure parts, no UI.
window.__payInternals = { netPay: netPay, incomeTax: incomeTax, nationalInsurance: nationalInsurance, takeHomeOf: takeHomeOf, validTakeHome: validTakeHome,
    validateState: validateState, validYear: validYear, parsePaste: parsePaste, mergeYears: mergeYears, computeYears: computeYears,
    summary: summary, fxFor: fxFor, headerKey: headerKey, stockNameOf: stockNameOf };
})();
