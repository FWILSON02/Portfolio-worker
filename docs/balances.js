// ─── Estate screen (balances) ────────────────────────────────────────────────
// Month-by-month balances of current, savings, card, investment, pension and property accounts, with total
// wealth and liquid money on top. Opened from the Estate tab in the app's top tab bar, and drawn below that bar
// (its height comes from the --topbar-h CSS variable index.html publishes).
//
// Loaded by index.html as its own file: <script src="balances.js?v=N">. Bump N there whenever this file changes,
// so the Home Screen app never pairs a new index.html with a cached old copy of this file.
//
// Exposes:
//   window.BalancesScreen  — the Estate view (props: onClose, privacyMode, appValues, ui)
//   window.BalancesStore   — backupSnapshot() / restore(obj) for the app's JSON backup, plus load/subscribe
//
// Data lives in its own IndexedDB database ('portfolio-balances'), so Settings → Clear cache never touches it.
// No balances are ever written into this file or index.html: the repo is public.
(function () {
'use strict';
var E = React.createElement;

// ── Groups ───────────────────────────────────────────────────────────────────
// liquid: counts toward Liquid (and always toward Total wealth). debt: balances are stored as negative numbers.
var GROUPS = [
    { id: 'current',     label: 'Current',                   liquid: true  },
    { id: 'savings',     label: 'Savings',                   liquid: true  },
    { id: 'investments', label: 'Investments',               liquid: true  },
    { id: 'cards',       label: 'Credit cards',              liquid: true, debt: true },
    { id: 'pensions',    label: 'Pensions & employer stock', liquid: false },
    { id: 'property',    label: 'Property & car',            liquid: false },
    { id: 'other',       label: 'Other',                     liquid: true  },
];
var GROUP_BY_ID = {};
GROUPS.forEach(function (g) { GROUP_BY_ID[g.id] = g; });
function groupOf(id) { return GROUP_BY_ID[id] || GROUP_BY_ID.other; }
// Whether an account counts toward Liquid: its own flag when set (e.g. unvested shares under Investments), else its group's.
function isLiquid(a) { return typeof a.liquid === 'boolean' ? a.liquid : !!groupOf(a.group).liquid; }

// ── Store (IndexedDB, own database) ──────────────────────────────────────────
// state = { v: 1, accounts: [Account], snapshots: [Snapshot], lastExportAt, updatedAt }
//   Account  = { id, name, group, debt, share, rate, closed, appLinks }
//              growth:   % a year the value grows (+) or falls (−) after its last valuation (house, car); null = none.
//              liquid:   true/false to count (or not) toward Liquid; null = the group's default.
//              appLinks: keys of the Investments-tab values this account follows (their sum); [] = typed in by hand.
//              debt:  balance stored negative (cards, mortgage); the form takes the amount owed as a positive number.
//              share: fraction of the balance that is yours (e.g. 0.5 of a jointly owned house and its mortgage).
//   Snapshot = { date: 'YYYY-MM-DD', values: { [accountId]: number }, partial? }
//              Full (imported, or saved before partial updates existed): an account missing from values = £0 then.
//              partial: true — only the accounts in values were updated; every other account keeps its last value.
var DB_NAME = 'portfolio-balances';
var DB_STORE = 'kv';
var DB_KEY = 'state';

function emptyState() { return { v: 1, accounts: [], snapshots: [], lastExportAt: null, updatedAt: null }; }

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

var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Returns a cleaned copy of a stored or restored state, or null when it is not a balances state at all.
// Old spreadsheet names shown by the employer instead (Fergus asked for these). Applied on load and on import, so a
// re-import of the spreadsheet keeps the new names and the links made under them.
var RENAMES = { 'Equate Plus': 'HSBC', 'Citi Stock': 'Citi' };
function renamed(name) { return Object.prototype.hasOwnProperty.call(RENAMES, name) ? RENAMES[name] : name; }

// appLinks from a stored account: the array, or the single appLink saved before several links were allowed.
function linksOf(a) {
    if (Array.isArray(a.appLinks)) return a.appLinks.filter(function (k) { return typeof k === 'string' && k; });
    return typeof a.appLink === 'string' && a.appLink ? [a.appLink] : [];
}

// An open account that follows the Investments tab is shown under Investments, so that card adds up to the same
// total as the Investments tab (Fergus asked). Applied to its whole history, so the chart stays consistent.
function linkedToInvestments(a) {
    return !a.closed && a.appLinks.length && a.group !== 'investments' ? Object.assign({}, a, { group: 'investments', debt: false }) : a;
}

function validateState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.accounts) || !Array.isArray(s.snapshots)) return null;
    var ids = {};
    var accounts = s.accounts.filter(function (a) {
        return a && typeof a.id === 'string' && typeof a.name === 'string';
    }).map(function (a) {
        ids[a.id] = true;
        return {
            id: a.id, name: renamed(a.name), group: GROUP_BY_ID[a.group] ? a.group : 'other',
            debt: !!a.debt,
            share: (typeof a.share === 'number' && a.share > 0 && a.share <= 1) ? a.share : 1,
            rate: (typeof a.rate === 'number' && isFinite(a.rate)) ? a.rate : null,
            closed: !!a.closed,
            liquid: typeof a.liquid === 'boolean' ? a.liquid : null,
            growth: (typeof a.growth === 'number' && isFinite(a.growth)) ? a.growth : null,
            appLinks: linksOf(a),
        };
    }).map(linkedToInvestments);
    var snapshots = s.snapshots.filter(function (sn) {
        return sn && typeof sn.date === 'string' && ISO_DATE.test(sn.date) && sn.values && typeof sn.values === 'object';
    }).map(function (sn) {
        var values = {};
        Object.keys(sn.values).forEach(function (id) {
            var v = sn.values[id];
            if (ids[id] && typeof v === 'number' && isFinite(v)) values[id] = v;
        });
        return sn.partial ? { date: sn.date, values: values, partial: true } : { date: sn.date, values: values };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return {
        v: 1, accounts: accounts, snapshots: snapshots,
        lastExportAt: typeof s.lastExportAt === 'number' ? s.lastExportAt : null,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null,
    };
}

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

function saveState(next, opts) {
    next.updatedAt = Date.now();
    _state = next;
    emit();
    // Ask Safari to keep this site's storage; a no-op where it is already persistent (Home Screen apps).
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    return idbWrite(next).catch(function (e) {
        _loadError = 'Could not save: ' + (e && e.message ? e.message : e);
        emit();
        throw e;
    });
}

var BalancesStore = {
    ready: function () { return _loaded; },
    get: function () { return _state; },
    subscribe: function (fn) {
        _listeners.push(fn);
        return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
    },
    // Synchronous on purpose: the JSON backup is built inside the tap that opens the iOS share sheet.
    // Returns null when there is nothing to back up. Marks the time so the screen can show "last exported".
    backupSnapshot: function () {
        if (!_state.accounts.length) return null;
        var copy = JSON.parse(JSON.stringify(_state));
        var next = Object.assign({}, _state, { lastExportAt: Date.now() });
        saveState(next).catch(function () {});
        return copy;
    },
    // Writes the live values of accounts linked to the Investments tab into this month's entry (see applyLinked).
    // index.html calls it whenever those values change, so linked accounts stay current without being typed in.
    syncLinked: function (appValues) {
        return _loaded.then(function () {
            var next = applyLinked(_state, appValues, todayISO());
            if (next) return saveState(next);
        }).catch(function () {});
    },
    // Replaces the balances with the ones from a backup. Returns false (and changes nothing) when invalid.
    restore: function (obj) {
        var clean = validateState(obj);
        if (!clean || !clean.accounts.length) return false;
        saveState(clean).catch(function () {});
        return true;
    },
};

function useBalancesState() {
    var st = React.useState(0);
    React.useEffect(function () { return BalancesStore.subscribe(function () { st[1](function (n) { return n + 1; }); }); }, []);
    return _state;
}

// ── Calculations ─────────────────────────────────────────────────────────────
function monthKey(date) { return date.slice(0, 7); }
function monthIndex(mk) { return Number(mk.slice(0, 4)) * 12 + Number(mk.slice(5, 7)) - 1; }
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(mk) { return MONTHS[Number(mk.slice(5, 7)) - 1] + ' ' + mk.slice(0, 4); }
function dayLabel(date) { return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4); }

// Totals for one snapshot. Every figure is built from the accounts: summary rows are never copied.
function totalsFor(snapshot, accountsById) {
    var groups = {};
    GROUPS.forEach(function (g) { groups[g.id] = 0; });
    var liquid = 0, total = 0;
    Object.keys(snapshot.values).forEach(function (id) {
        var a = accountsById[id];
        if (!a) return;
        var v = snapshot.values[id] * (a.share || 1);
        groups[a.group] = (groups[a.group] || 0) + v;
        total += v;
        if (isLiquid(a)) liquid += v;
    });
    return { groups: groups, liquid: liquid, total: total };
}

function indexAccounts(accounts) {
    var m = {};
    accounts.forEach(function (a) { m[a.id] = a; });
    return m;
}

// Every account's balance after each snapshot, oldest first: a full snapshot sets all of them (missing = £0), a partial
// one changes only the accounts it holds. asOf = the date each account's balance was last set.
function resolveTimeline(snapshots) {
    var values = {}, asOf = {};
    return snapshots.map(function (s) {
        if (!s.partial) { values = {}; asOf = {}; }
        else { values = Object.assign({}, values); asOf = Object.assign({}, asOf); }
        Object.keys(s.values).forEach(function (id) { values[id] = s.values[id]; asOf[id] = s.date; });
        return { date: s.date, values: values, asOf: asOf };
    });
}
// The balances as they stand now (after the last snapshot).
function currentBalances(state) {
    var t = resolveTimeline(state.snapshots);
    return t.length ? t[t.length - 1] : { date: null, values: {}, asOf: {} };
}

// A value grown (or shrunk) at `growth` % a year from date `from` to date `to`.
function grow(v, growth, from, to) {
    var years = (Date.parse(to) - Date.parse(from)) / (864e5 * 365.25);
    return years > 0 ? Math.round(v * Math.pow(1 + growth / 100, years) * 100) / 100 : v;
}
// Balances at `r.date` with each growing account (house, car) moved on from its last valuation at its own rate.
// Only the gap after a valuation is estimated: a value you enter always replaces the estimate.
function withGrowth(r, accounts) {
    var out = null;
    accounts.forEach(function (a) {
        if (a.growth == null || r.values[a.id] == null || !r.asOf[a.id] || r.asOf[a.id] >= r.date) return;
        out = out || Object.assign({}, r.values);
        out[a.id] = grow(r.values[a.id], a.growth, r.asOf[a.id], r.date);
    });
    return out ? Object.assign({}, r, { values: out }) : r;
}

// One point per month: the balances as they stood after the month's last snapshot.
function buildSeries(state) {
    var byId = indexAccounts(state.accounts);
    var byMonth = {};
    resolveTimeline(state.snapshots).forEach(function (r) { byMonth[monthKey(r.date)] = r; });
    return Object.keys(byMonth).sort().map(function (mk) {
        var r = withGrowth(byMonth[mk], state.accounts);
        var t = totalsFor(r, byId);
        return { month: mk, date: r.date, values: r.values, asOf: r.asOf, groups: t.groups, liquid: t.liquid, total: t.total };
    });
}

// Adds a partial update (only the given balances) dated `date`, merged into a partial snapshot already on that date.
function withPartial(snapshots, date, values) {
    var same = snapshots.filter(function (s) { return s.date === date && s.partial; })[0];
    var rest = snapshots.filter(function (s) { return s !== same; });
    var merged = { date: date, partial: true, values: Object.assign({}, same ? same.values : {}, values) };
    return rest.concat([merged]).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

// Live values for open accounts linked to the app: { [accountId]: value }. An app value that is still loading
// (ready === false, e.g. a holding without a price yet) is skipped, so a half-priced total is never written.
// An account linked to several values takes their sum, and only once every one of them is there and ready.
function liveLinked(accounts, appValues) {
    var byKey = appIndex(appValues);
    var live = {};
    accounts.forEach(function (a) {
        if (a.closed || !a.appLinks.length) return;
        var sum = 0;
        for (var i = 0; i < a.appLinks.length; i++) {
            var o = byKey[a.appLinks[i]];
            if (!o || o.ready === false || !Number.isFinite(o.value)) return;
            sum += o.value;
        }
        live[a.id] = Math.round(sum * 100) / 100;
    });
    return live;
}

// App values by key. A value's legacyKey (the key it had before) also finds it, so links made earlier keep working.
function appIndex(appValues) {
    var byKey = {};
    (appValues || []).forEach(function (o) { if (o && o.key) byKey[o.key] = o; });
    (appValues || []).forEach(function (o) { if (o && o.legacyKey && !byKey[o.legacyKey]) byKey[o.legacyKey] = o; });
    return byKey;
}
// The linked values of an account that the app has right now, and their sum (null when none are there).
function linkedNow(a, byKey) {
    var found = a.appLinks.map(function (k) { return byKey[k]; }).filter(Boolean);
    if (!found.length) return null;
    return { items: found, value: found.reduce(function (t, o) { return t + (Number.isFinite(o.value) ? o.value : 0); }, 0) };
}

// Saves the live values of linked accounts that changed, as a partial update dated today: every other account keeps
// its last value. Returns the new state, or null when nothing changed (or an entry is dated after today).
function applyLinked(state, appValues, today) {
    var live = liveLinked(state.accounts, appValues);
    var last = state.snapshots.length ? state.snapshots[state.snapshots.length - 1] : null;
    if (last && last.date > today) return null;
    var now = currentBalances(state).values;
    var changed = {};
    Object.keys(live).forEach(function (id) { if (now[id] !== live[id]) changed[id] = live[id]; });
    if (!Object.keys(changed).length) return null;
    return Object.assign({}, state, { snapshots: withPartial(state.snapshots, today, changed) });
}

// The point to compare `latest` with for a "12 months" change: the latest one at least 12 months earlier.
function pointMonthsBack(series, latest, months) {
    var target = monthIndex(latest.month) - months;
    var found = null;
    series.forEach(function (p) { if (monthIndex(p.month) <= target) found = p; });
    return found;
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtGBP(n, dp) {
    if (n == null || !isFinite(n)) return '—';
    var d = dp == null ? 0 : dp;
    var s = Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (n < 0 ? '−£' : '£') + s;
}
function fmtSigned(n) {
    if (n == null || !isFinite(n)) return '—';
    if (Math.round(n) === 0) return '£0';
    return (n > 0 ? '+£' : '−£') + Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
function fmtPct(n) {
    if (n == null || !isFinite(n)) return '';
    return (n >= 0 ? '+' : '−') + Math.abs(n * 100).toFixed(1) + '%';
}
function pctChange(now, before) {
    if (before == null || !isFinite(before) || Math.abs(before) < 1) return null;
    return (now - before) / Math.abs(before);
}
function relTime(ts) {
    if (!ts) return 'never';
    var days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 60) return days + ' days ago';
    return Math.round(days / 30) + ' months ago';
}
function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// "12,345.67", "£12,345", "(1,234.00)", "−50" → number; blank → null.
function parseAmount(x) {
    if (x == null) return null;
    if (typeof x === 'number') return isFinite(x) ? x : null;
    var s = String(x).replace(/Â/g, '').replace(/[£$€\s ,]/g, '').replace(/−/g, '-');
    if (s === '') return null;
    if (s === '-') return 0;                      // accounting format writes zero as a dash
    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    var v = parseFloat(s);
    return neg ? -v : v;
}

// ── Import: spreadsheet → state ──────────────────────────────────────────────
// Wide layout (the original spreadsheet): row 1 = snapshot dates from the first date column on; one row per
// account (name, rate, type, then a value per date) down to a row named "Summary". Below it, the summary rows
// are read only to check the import, plus House value and the car (Property & car).
// Long layout (this screen's CSV export): date, account, group, share, balance.
function cellToISO(c) {
    if (c == null || c === '') return null;
    if (typeof c === 'number') {
        if (c < 20000 || c > 80000) return null;  // an Excel serial between 1954 and 2119
        var p = XLSX.SSF.parse_date_code(c);
        return p ? p.y + '-' + String(p.m).padStart(2, '0') + '-' + String(p.d).padStart(2, '0') : null;
    }
    if (c instanceof Date && !isNaN(c)) {
        return c.getFullYear() + '-' + String(c.getMonth() + 1).padStart(2, '0') + '-' + String(c.getDate()).padStart(2, '0');
    }
    var s = String(c).trim(), m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
        var y = m[3].length === 2 ? '20' + m[3] : m[3];
        return y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    }
    return null;
}

// Best guess at the group from the sheet's "Account Type", falling back to the account name.
function guessGroup(type, name) {
    var t = String(type || '').toLowerCase();
    var n = String(name || '').toLowerCase();
    if (/current/.test(t)) return 'current';
    if (/credit/.test(t)) return 'cards';
    if (/mortgage/.test(t)) return 'property';
    if (/pension|tower|watson|sip|share ?save|stocks and shares account|rsu|employer/.test(t)) return 'pensions';
    if (/cash isa|saving|money market|cash/.test(t)) return 'savings';
    if (/stocks|shares|isa|invest|gia|fund/.test(t)) return 'investments';
    if (/loan/.test(n)) return 'other';
    if (/mortgage/.test(n)) return 'property';
    if (/credit|card|amex/.test(n)) return 'cards';
    if (/pension/.test(n)) return 'pensions';
    if (/sav(e|ing)|cash|money market|isa/.test(n)) return 'savings';
    if (/stock|share|coinbase|crypto|gold|fund|invest/.test(n)) return 'investments';
    return 'other';
}
function isDebtRow(group, type, name) {
    return group === 'cards' || /mortgage/i.test(String(type || '')) || /mortgage/i.test(String(name || ''));
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24); }

function readSheetRows(arrayBuffer) {
    if (typeof XLSX === 'undefined') throw new Error('The spreadsheet reader did not load. Check your connection and try again.');
    var wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
    var ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('The file has no sheets.');
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

// Returns { dates, rows: [ImportRow], checks: [SummaryRow], format } for the preview.
//   ImportRow  = { key, name, type, group, debt, share, rate, include, closed, values: [number|null per date] }
//   SummaryRow = { label, kind, values: [number|null per date] }
function parseImport(arrayBuffer) {
    var rows = readSheetRows(arrayBuffer);
    if (!rows.length) throw new Error('The file is empty.');
    var head = (rows[0] || []).map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
    if (head.indexOf('date') >= 0 && head.indexOf('account') >= 0 && head.indexOf('balance') >= 0) return parseLong(rows, head);
    return parseWide(rows);
}

function finishRows(list, nDates) {
    // Duplicate names get a 1 / 2 suffix, in sheet order, so each stays its own account.
    var count = {}, seen = {};
    list.forEach(function (r) { count[r.name.toLowerCase()] = (count[r.name.toLowerCase()] || 0) + 1; });
    list.forEach(function (r, i) {
        var k = r.name.toLowerCase();
        if (count[k] > 1) { seen[k] = (seen[k] || 0) + 1; r.name = r.name + ' ' + seen[k]; }
        r.key = 'r' + i;
        var last = -1;
        r.values.forEach(function (v, j) { if (v != null) last = j; });
        r.closed = last !== nDates - 1;
        r.count = r.values.filter(function (v) { return v != null; }).length;
        r.lastIndex = last;
    });
    return list;
}

function parseWide(rows) {
    var header = rows[0] || [];
    var dateCols = [], dates = [];
    header.forEach(function (c, j) {
        if (j === 0) return;
        var iso = cellToISO(c);
        if (iso) { dateCols.push(j); dates.push(iso); }
    });
    if (dates.length === 0) throw new Error('No snapshot dates found in the first row.');
    var firstDate = dateCols[0];
    var headLower = header.map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
    var rateCol = headLower.slice(0, firstDate).findIndex(function (h) { return h === 'r' || h === 'rate'; });
    var typeCol = headLower.slice(0, firstDate).findIndex(function (h) { return /type/.test(h); });

    var accounts = [], checks = [];
    var inSummary = false;
    var CHECK_ROWS = [
        { re: /^current$/i,      kind: 'current',     label: 'Current' },
        { re: /^savings$/i,      kind: 'savings',     label: 'Savings' },
        { re: /^investments$/i,  kind: 'investments', label: 'Investments' },
        { re: /^debt$/i,         kind: 'debt',        label: 'Debt (cards)' },
        { re: /^total liquid$/i, kind: 'liquid',      label: 'Total Liquid' },
        { re: /^total wealth$/i, kind: 'total',       label: 'Total Wealth' },
    ];
    var checkSeen = {};
    for (var i = 1; i < rows.length; i++) {
        var r = rows[i] || [];
        var name = String(r[0] == null ? '' : r[0]).trim();
        if (!name) continue;
        if (/^summary$/i.test(name)) { inSummary = true; continue; }
        var values = dateCols.map(function (j) { return parseAmount(r[j]); });
        var hasAny = values.some(function (v) { return v != null; });
        if (!hasAny) continue;
        if (!inSummary) {
            var type = typeCol >= 0 ? r[typeCol] : null;
            var group = guessGroup(type, name);
            var rate = rateCol >= 0 ? parseAmount(r[rateCol]) : null;
            accounts.push({
                name: name, type: type ? String(type) : '', group: group,
                debt: isDebtRow(group, type, name), share: group === 'property' ? 0.5 : 1,
                rate: rate, include: true, values: values,
            });
            continue;
        }
        var chk = CHECK_ROWS.find(function (c) { return c.re.test(name); });
        if (chk && !checkSeen[chk.kind]) {
            checkSeen[chk.kind] = true;
            checks.push({ label: chk.label, kind: chk.kind, values: values });
            continue;
        }
        // The only summary-block rows that are balances: the house and the car.
        if (/house/i.test(name) && /value/i.test(name)) {
            accounts.push({ name: name, type: 'Property', group: 'property', debt: false, share: 0.5, rate: null, include: true, values: values });
        } else if (/\bcar\b|volvo|vehicle/i.test(name) && !/age|real estate|total|wealth|%|\+/i.test(name)) {
            accounts.push({ name: name, type: 'Car', group: 'property', debt: false, share: 1, rate: null, include: true, values: values });
        }
    }
    if (!accounts.length) throw new Error('No account rows found under the date row.');
    return { format: 'wide', dates: dates, rows: finishRows(accounts, dates.length), checks: checks };
}

function parseLong(rows, head) {
    var ci = { date: head.indexOf('date'), account: head.indexOf('account'), group: head.indexOf('group'),
               share: head.indexOf('share'), balance: head.indexOf('balance') };
    var dateSet = {}, byName = {}, order = [];
    for (var i = 1; i < rows.length; i++) {
        var r = rows[i] || [];
        var iso = cellToISO(r[ci.date]);
        var name = String(r[ci.account] == null ? '' : r[ci.account]).trim();
        var v = parseAmount(r[ci.balance]);
        if (!iso || !name || v == null) continue;
        dateSet[iso] = true;
        if (!byName[name]) {
            var g = ci.group >= 0 ? String(r[ci.group] || '').trim() : '';
            var group = GROUP_BY_ID[g] ? g : guessGroup('', name);
            var share = ci.share >= 0 ? parseAmount(r[ci.share]) : null;
            byName[name] = { name: name, type: '', group: group, debt: groupOf(group).debt || v < 0 && group === 'property',
                             share: share > 0 && share <= 1 ? share : 1, rate: null, include: true, byDate: {} };
            order.push(name);
        }
        byName[name].byDate[iso] = v;
    }
    var dates = Object.keys(dateSet).sort();
    if (!dates.length) throw new Error('No rows with a date, account and balance found.');
    var list = order.map(function (n) {
        var a = byName[n];
        a.values = dates.map(function (d) { return a.byDate[d] != null ? a.byDate[d] : null; });
        delete a.byDate;
        return a;
    });
    // Names are already unique in this format, so finishRows adds no suffixes.
    return { format: 'long', dates: dates, rows: finishRows(list, dates.length), checks: [] };
}

// Preview rows → a state ready to save.
function importToState(parsed, prev) {
    var included = parsed.rows.filter(function (r) { return r.include; });
    var accounts = included.map(function (r, i) {
        return {
            id: 'a' + i + '-' + slug(r.name), name: renamed(r.name), group: r.group, debt: !!r.debt,
            share: r.share, rate: r.rate, closed: r.closed, liquid: null, appLinks: [],
        };
    });
    // Keep app links from before a re-import, matched by name.
    var prevLinks = {};
    (prev && prev.accounts || []).forEach(function (a) { if (a.appLinks && a.appLinks.length) prevLinks[a.name] = a.appLinks.slice(); });
    accounts.forEach(function (a) { if (prevLinks[a.name]) a.appLinks = prevLinks[a.name]; });
    var snapshots = parsed.dates.map(function (d, j) {
        var values = {};
        included.forEach(function (r, i) {
            var v = r.values[j];
            if (v == null) return;
            values[accounts[i].id] = r.debt ? -Math.abs(v) : v;
        });
        return { date: d, values: values };
    }).filter(function (s) { return Object.keys(s.values).length > 0; });
    return { v: 1, accounts: accounts, snapshots: snapshots, lastExportAt: prev ? prev.lastExportAt : null, updatedAt: null };
}

// Compares the app's totals with the sheet's own summary rows, snapshot by snapshot.
function runChecks(parsed) {
    if (!parsed.checks.length) return [];
    var st = importToState(parsed, null);
    var byId = indexAccounts(st.accounts);
    var totalsByDate = {};
    st.snapshots.forEach(function (s) { totalsByDate[s.date] = totalsFor(s, byId); });
    return parsed.checks.map(function (c) {
        var mism = [], compared = 0;
        parsed.dates.forEach(function (d, j) {
            var sheet = c.values[j];
            if (sheet == null) return;
            var t = totalsByDate[d] || { groups: {}, liquid: 0, total: 0 };
            var app = c.kind === 'liquid' ? t.liquid
                    : c.kind === 'total' ? t.total
                    : c.kind === 'debt' ? -(t.groups.cards || 0)
                    : (t.groups[c.kind] || 0);
            compared++;
            if (Math.abs(app - sheet) > 1) mism.push({ date: d, diff: app - sheet });
        });
        return { label: c.label, compared: compared, mismatches: mism };
    });
}

// ── Export ───────────────────────────────────────────────────────────────────
function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv(state) {
    var lines = ['date,account,group,share,balance'];
    // Every account's balance as it stood on each date, so a partial update still reads as a full row set.
    resolveTimeline(state.snapshots).forEach(function (s) {
        state.accounts.forEach(function (a) {
            if (s.values[a.id] == null) return;
            lines.push([s.date, a.name, a.group, a.share, s.values[a.id]].map(csvCell).join(','));
        });
    });
    return lines.join('\n') + '\n';
}
// Everything the Estate screen holds — every account (closed ones included, with group, share, rate and app link)
// and every snapshot ever saved — in one file that Import can restore exactly.
var JSON_FORMAT = 'estate-balances';
function buildJson(state) {
    var dates = state.snapshots.map(function (s) { return s.date; });
    return JSON.stringify({
        format: JSON_FORMAT,
        format_version: 1,
        exportedAt: new Date().toISOString(),
        summary: {
            accounts: state.accounts.length,
            closedAccounts: state.accounts.filter(function (a) { return a.closed; }).length,
            snapshots: state.snapshots.length,
            firstDate: dates[0] || null,
            lastDate: dates[dates.length - 1] || null,
        },
        data: { v: state.v, accounts: state.accounts, snapshots: state.snapshots },
    }, null, 2);
}
// Accepts this screen's JSON export, or a full app backup (its payload.balances). Returns a clean state or throws.
function parseJsonBackup(text) {
    var obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('Not a valid JSON file.'); }
    var raw = obj && obj.format === JSON_FORMAT ? obj.data
            : obj && obj.payload && obj.payload.balances ? obj.payload.balances
            : obj && Array.isArray(obj.accounts) ? obj
            : null;
    var clean = validateState(raw);
    if (!clean || !clean.accounts.length) throw new Error('This file has no Estate balances in it.');
    return clean;
}

// iOS: the share sheet (Save to Files); elsewhere a download.
function deliverText(text, filename, mime) {
    var file = null;
    try { file = new File([text], filename, { type: mime }); } catch (e) {}
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file] });
    }
    var url = URL.createObjectURL(new Blob([text], { type: mime }));
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
    return Promise.resolve();
}

// ── UI ───────────────────────────────────────────────────────────────────────
var DEFAULT_UI = {
    C: { bg: '#080c10', surface: '#0d1218', surfaceHigh: '#11161f', border: 'rgba(255,255,255,0.08)',
         amber: '#fbbf24', emerald: '#34d399', rose: '#f87171', blue: '#60a5fa', violet: '#a78bfa',
         zinc400: '#cbd5e1', zinc500: '#a1a1aa', zinc600: '#9da5b4', zinc700: '#888894', white: '#ffffff' },
    sys: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, sans-serif',
};
var UICtx = React.createContext(DEFAULT_UI);
function useUI() { return React.useContext(UICtx); }
function signColor(ui, n) { return n == null || Math.round(n) === 0 ? ui.C.zinc500 : n > 0 ? ui.C.emerald : ui.C.rose; }

var WalletIcon = typeof _li === 'function'
    ? _li(['M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1', 'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4'])
    : function () { return null; };
var ChevronIcon = typeof _li === 'function' ? _li(['M9 18l6-6-6-6']) : function () { return null; };
var BackIcon = typeof _li === 'function' ? _li(['M15 18l-6-6 6-6']) : function () { return null; };

function cardStyle(ui, extra) {
    return Object.assign({
        background: 'linear-gradient(180deg, ' + ui.C.surfaceHigh + ' 0%, ' + ui.C.surface + ' 100%)',
        border: '1px solid ' + ui.C.border, borderRadius: 16, padding: '14px 16px',
    }, extra || {});
}
function moneyStyle(ui, size, privacy, color) {
    return {
        fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em',
        fontSize: size, fontWeight: 700, color: color || ui.C.white, lineHeight: 1.1, whiteSpace: 'nowrap',
        filter: privacy ? 'blur(8px)' : 'none',
    };
}
function capsLabel(ui) {
    return { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc500, textTransform: 'uppercase', letterSpacing: '0.18em' };
}
function buttonStyle(ui, kind) {
    var primary = kind === 'primary', danger = kind === 'danger';
    return {
        minHeight: 44, borderRadius: 12, padding: '0 14px', fontFamily: ui.sys, fontSize: 14, fontWeight: 600,
        background: primary ? 'rgba(96,165,250,0.14)' : danger ? 'rgba(248,113,113,0.10)' : 'rgba(39,39,42,0.6)',
        border: '1px solid ' + (primary ? 'rgba(96,165,250,0.35)' : danger ? 'rgba(248,113,113,0.3)' : ui.C.border),
        color: primary ? ui.C.blue : danger ? ui.C.rose : ui.C.zinc400,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer',
    };
}
function inputStyle(ui, extra) {
    return Object.assign({
        background: 'rgba(0,0,0,0.35)', border: '1px solid ' + ui.C.border, borderRadius: 10,
        color: ui.C.white, fontFamily: ui.rounded, fontSize: 16, padding: '8px 10px', minHeight: 40,
        fontVariantNumeric: 'tabular-nums', outline: 'none', boxSizing: 'border-box',
    }, extra || {});
}

// One "vs <month>  +£x  +y%" line.
// Change against 1, 6 and 12 months earlier, £ and %, one row each. A period with no entry far enough back is left out;
// when the nearest earlier entry is older than asked (a gap in the history), its month says which one was used.
var PERIODS = [{ months: 1, label: '1 month' }, { months: 6, label: '6 months' }, { months: 12, label: '12 months' }];
function ChangeTable(props) {
    var ui = useUI();
    var s = props.series, latest = s[s.length - 1];
    var rows = PERIODS.map(function (p) {
        var base = pointMonthsBack(s, latest, p.months);
        return base ? { p: p, base: base, d: latest[props.field] - base[props.field] } : null;
    }).filter(Boolean);
    if (!rows.length) return null;
    return E('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', columnGap: 14, rowGap: 4, alignItems: 'baseline', marginTop: 8,
                               fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
        rows.map(function (r) {
            var c = signColor(ui, r.d);
            return [
                E('div', { key: r.p.months + 'l', style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, whiteSpace: 'nowrap' } },
                    'vs ' + r.p.label, E('span', { style: { color: ui.C.zinc700, fontSize: 11 } }, ' · ' + monthLabel(r.base.month))),
                E('div', { key: r.p.months + 'd', style: { fontSize: 13, color: c, textAlign: 'right', filter: props.privacy ? 'blur(6px)' : 'none' } }, fmtSigned(r.d)),
                E('div', { key: r.p.months + 'p', style: { fontSize: 13, color: c, textAlign: 'right', minWidth: 54 } }, fmtPct(pctChange(latest[props.field], r.base[props.field])))
            ];
        })
    );
}

function Hero(props) {
    var ui = useUI();
    var s = props.series, latest = s[s.length - 1];
    return E('div', { style: cardStyle(ui, { borderRadius: 20, padding: '16px 18px', marginBottom: 12 }) },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            E('span', { style: capsLabel(ui) }, 'Total wealth'),
            E('span', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc600 } }, 'As at ' + dayLabel(latest.date))
        ),
        E('div', { style: moneyStyle(ui, 34, props.privacy) }, props.privacy ? '£ •••,•••' : fmtGBP(latest.total)),
        E(ChangeTable, { series: s, field: 'total', privacy: props.privacy }),
        E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 14, paddingTop: 12 } },
            E('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 } },
                E('span', { style: capsLabel(ui) }, 'Liquid wealth'),
                E('span', { style: moneyStyle(ui, 22, props.privacy) }, props.privacy ? '£ ••,•••' : fmtGBP(latest.liquid))
            ),
            E(ChangeTable, { series: s, field: 'liquid', privacy: props.privacy })
        )
    );
}

function useWidth(ref) {
    var st = React.useState(0);
    React.useEffect(function () {
        if (!ref.current) return;
        var measure = function () { if (ref.current) st[1](ref.current.offsetWidth); };
        var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        if (ro) ro.observe(ref.current);
        measure();
        return function () { if (ro) ro.disconnect(); };
    }, []);
    return st[0];
}

function kLabel(v) {
    var a = Math.abs(v);
    var s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a));
    return (v < 0 ? '−£' : '£') + s;
}

function Segmented(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2 } },
        props.options.map(function (o) {
            var on = o.id === props.value;
            return E('button', {
                key: o.id, onClick: function () { props.onChange(o.id); },
                style: { border: 'none', borderRadius: 7, padding: '5px 10px', fontFamily: ui.sys, fontSize: 12, fontWeight: 600,
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? ui.C.white : ui.C.zinc600, cursor: 'pointer' }
            }, o.label);
        })
    );
}

var RANGES = [{ id: '1Y', label: '1Y', months: 12 }, { id: '3Y', label: '3Y', months: 36 }, { id: 'ALL', label: 'All', months: null }];
var CMP_MODES = [{ id: 'prev', label: 'Month before' }, { id: 'start', label: 'From start' }, { id: 'custom', label: 'Two months' }];
var LINE_COLS = ['#60a5fa', '#f472b6', '#fbbf24'];

// Change between two points, split into building blocks: per group and, within each group, per account. Built from the
// accounts (share applied; for Liquid only liquid accounts), so the blocks always add up exactly to the change shown.
function breakdown(base, focus, accounts, metric) {
    var groups = {};
    accounts.forEach(function (a) {
        if (metric === 'liquid' && !isLiquid(a)) return;
        var v0 = (base.values[a.id] || 0) * (a.share || 1), v1 = (focus.values[a.id] || 0) * (a.share || 1);
        if (!v0 && !v1) return;
        var g = groups[a.group] || (groups[a.group] = { id: a.group, d: 0, v: 0, accounts: [] });
        g.d += v1 - v0; g.v += v1;
        g.accounts.push({ a: a, d: v1 - v0, v: v1 });
    });
    var rows = Object.keys(groups).map(function (k) {
        var g = groups[k];
        g.accounts.sort(function (x, y) { return Math.abs(y.d) - Math.abs(x.d); });
        return g;
    }).sort(function (x, y) { return Math.abs(y.d) - Math.abs(x.d); });
    return { rows: rows, total: rows.reduce(function (t, g) { return t + g.d; }, 0) };
}
// A group's figure at a point (share applied; for Liquid only liquid accounts): what a drawn group line plots.
function groupValue(p, gid, accounts, metric) {
    var t = 0;
    accounts.forEach(function (a) {
        if (a.group !== gid || (metric === 'liquid' && !isLiquid(a))) return;
        t += (p.values[a.id] || 0) * (a.share || 1);
    });
    return t;
}

// The balances chart, modelled on the Investments chart: press and drag to read any month, lift to pin it; the panel
// underneath splits the change into building blocks (groups, then accounts). Compare with the month before, the start
// of the range, or a second pinned month; tap a group's dot to draw its own line.
function Chart(props) {
    var ui = useUI();
    var ref = React.useRef(null);
    var dragging = React.useRef(false);
    var width = useWidth(ref);
    var accounts = props.accounts;
    var mState = React.useState('total'), metric = mState[0];
    var rState = React.useState('ALL'), range = rState[0];
    var hState = React.useState(null), scrub = hState[0], setScrub = hState[1];          // month under the finger
    var pState = React.useState(null), pin = pState[0], setPin = pState[1];               // last month lifted on
    var ppState = React.useState(null), prevPin = ppState[0], setPrevPin = ppState[1];    // the one before (Two months)
    var cState = React.useState('prev'), cmp = cState[0], setCmp = cState[1];
    var sState = React.useState([]), sel = sState[0], setSel = sState[1];                // groups drawn as lines
    var oState = React.useState(null), openGroup = oState[0], setOpenGroup = oState[1];
    var all = props.series;
    var last = all[all.length - 1];
    var r = RANGES.find(function (x) { return x.id === range; });
    var pts = r.months == null ? all : all.filter(function (p) { return monthIndex(p.month) >= monthIndex(last.month) - r.months; });
    var byMonth = {};
    all.forEach(function (p, i) { byMonth[p.month] = i; });
    function inRange(mk) { return mk && pts.some(function (p) { return p.month === mk; }); }

    // Focus = the month under the finger, else the pinned month, else the latest. Base depends on the compare mode.
    var focus = all[byMonth[scrub]] || (inRange(pin) ? all[byMonth[pin]] : null) || pts[pts.length - 1];
    var base = null, waiting = false;
    if (cmp === 'start') base = pts[0];
    else if (cmp === 'custom') {
        var other = scrub ? pin : prevPin;
        if (inRange(other) && other !== focus.month) base = all[byMonth[other]];
        else waiting = true;
    }
    if (!base) base = byMonth[focus.month] > 0 ? all[byMonth[focus.month] - 1] : null;
    var from = base, to = focus;
    if (from && monthIndex(from.month) > monthIndex(to.month)) { from = focus; to = base; }
    var bd = from ? breakdown(from, to, accounts, metric) : null;

    // Lines: the total, or the drawn groups on their own scale (they'd be flat lines next to the total).
    var lines = sel.length
        ? sel.map(function (gid, i) { return { gid: gid, color: LINE_COLS[i % LINE_COLS.length], val: function (p) { return groupValue(p, gid, accounts, metric); } }; })
        : [{ gid: null, color: null, val: function (p) { return p[metric]; } }];
    var H = 170, padT = 10, padB = 22, padR = 44;
    var W = Math.max(width, 10), plotW = W - padR;
    var vals = [];
    lines.forEach(function (l) { pts.forEach(function (p) { vals.push(l.val(p)); }); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var t0 = monthIndex(pts[0].month), t1 = monthIndex(pts[pts.length - 1].month);
    var x = function (p) { return t1 === t0 ? plotW / 2 : ((monthIndex(p.month) - t0) / (t1 - t0)) * plotW; };
    var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB); };
    var pathFor = function (l) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p).toFixed(1) + ' ' + y(l.val(p)).toFixed(1); }).join(' '); };
    var up = pts[pts.length - 1][metric] >= pts[0][metric];
    var color = up ? ui.C.emerald : ui.C.rose;
    lines.forEach(function (l) { if (!l.color) l.color = color; });
    var mainLine = pathFor(lines[0]);
    var area = !sel.length && (mainLine + ' L' + x(pts[pts.length - 1]).toFixed(1) + ' ' + (H - padB) + ' L' + x(pts[0]).toFixed(1) + ' ' + (H - padB) + ' Z');
    var ticks = [hi - pad, (hi + lo) / 2, lo + pad];
    var firstYear = pts[0].month.slice(0, 4), lastYear = pts[pts.length - 1].month.slice(0, 4);

    function pick(clientX) {
        if (!ref.current || pts.length === 0) return;
        var rect = ref.current.getBoundingClientRect();
        var px = clientX - rect.left, best = null, bdist = Infinity;
        pts.forEach(function (p) { var d = Math.abs(x(p) - px); if (d < bdist) { bdist = d; best = p; } });
        if (best) setScrub(best.month);
    }
    function lift() {
        dragging.current = false;
        if (!scrub) return;
        if (scrub !== pin) { setPrevPin(pin); setPin(scrub); }
        setScrub(null);
    }
    function reset() { setScrub(null); setPin(null); setPrevPin(null); setOpenGroup(null); }
    function toggleSel(gid) {
        setSel(sel.indexOf(gid) >= 0 ? sel.filter(function (g) { return g !== gid; }) : sel.concat([gid]).slice(-3));
    }

    var change = to[metric] - (from ? from[metric] : to[metric]);
    var marked = focus !== pts[pts.length - 1] || scrub || pin;
    var blur = props.privacy ? 'blur(6px)' : 'none';
    var maxAbs = bd ? Math.max.apply(null, bd.rows.map(function (g) { return Math.abs(g.d); }).concat([1])) : 1;

    return E('div', { style: cardStyle(ui, { borderRadius: 20, padding: '14px 16px 10px', marginBottom: 12 }) },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 } },
            E(Segmented, { options: [{ id: 'total', label: 'Total' }, { id: 'liquid', label: 'Liquid' }], value: metric, onChange: function (v) { mState[1](v); } }),
            E(Segmented, { options: RANGES, value: range, onChange: function (v) { rState[1](v); reset(); } })
        ),
        // Reading of the chart: the focus month's figure (or each drawn group's), and its change from the base.
        E('div', { style: { display: 'flex', alignItems: 'baseline', columnGap: 8, flexWrap: 'wrap', minHeight: 20, fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
            E('span', { style: { fontSize: 12, color: ui.C.zinc500 } }, monthLabel(focus.month)),
            sel.length
                ? lines.map(function (l) {
                    return E('span', { key: l.gid, style: { fontSize: 12, color: l.color, filter: blur } }, groupOf(l.gid).label.split(' ')[0] + ' ' + fmtGBP(l.val(focus)));
                })
                : [E('span', { key: 'v', style: { fontSize: 14, fontWeight: 600, color: ui.C.white, filter: blur } }, fmtGBP(focus[metric])),
                   from && E('span', { key: 'd', style: { fontSize: 12, color: signColor(ui, change), filter: blur } }, fmtSigned(change)),
                   from && E('span', { key: 'p', style: { fontSize: 12, color: signColor(ui, change) } }, fmtPct(pctChange(to[metric], from[metric])))]
        ),
        E('div', {
            ref: ref,
            className: 'chart-noselect', style: { position: 'relative', height: H, touchAction: 'none', marginTop: 4, cursor: 'crosshair' },
            onPointerDown: function (e) { dragging.current = true; pick(e.clientX); },
            onPointerMove: function (e) { if (dragging.current || e.pointerType === 'mouse') pick(e.clientX); },
            onPointerUp: lift,
            onPointerCancel: function () { dragging.current = false; setScrub(null); },
            onPointerLeave: function (e) { if (e.pointerType === 'mouse' && !dragging.current) setScrub(null); },
        },
            width > 0 && E('svg', { width: W, height: H, style: { display: 'block', overflow: 'visible' } },
                E('defs', null,
                    E('linearGradient', { id: 'bal-area', x1: 0, y1: 0, x2: 0, y2: 1 },
                        E('stop', { offset: '0%', stopColor: color, stopOpacity: 0.22 }),
                        E('stop', { offset: '100%', stopColor: color, stopOpacity: 0 }))),
                ticks.map(function (v, i) {
                    return E('g', { key: i },
                        E('line', { x1: 0, x2: plotW, y1: y(v), y2: y(v), stroke: 'rgba(255,255,255,0.06)', strokeWidth: 1 }),
                        E('text', { x: W - 2, y: y(v), textAnchor: 'end', dominantBaseline: 'middle', fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.rounded },
                            props.privacy ? '' : kLabel(v)));
                }),
                // The compared period, shaded.
                from && E('rect', { x: x(from), y: padT, width: Math.max(1, x(to) - x(from)), height: H - padT - padB, fill: 'rgba(255,255,255,0.05)' }),
                area && E('path', { d: area, fill: 'url(#bal-area)' }),
                lines.map(function (l) {
                    return E('path', { key: l.gid || 'main', d: pathFor(l), fill: 'none', stroke: l.color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' });
                }),
                E('text', { x: 0, y: H - 6, fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.sys }, firstYear),
                lastYear !== firstYear && E('text', { x: plotW, y: H - 6, textAnchor: 'end', fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.sys }, lastYear),
                from && E('line', { x1: x(from), x2: x(from), y1: padT, y2: H - padB, stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1, strokeDasharray: '3 3' }),
                marked && E('g', null,
                    E('line', { x1: x(focus), x2: x(focus), y1: padT, y2: H - padB, stroke: 'rgba(255,255,255,0.35)', strokeWidth: 1 }),
                    lines.map(function (l) {
                        return E('circle', { key: l.gid || 'main', cx: x(focus), cy: y(l.val(focus)), r: 4, fill: l.color, stroke: ui.C.bg, strokeWidth: 2 });
                    }))
            )
        ),
        // Building blocks for the compared period.
        E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 6, paddingTop: 10 } },
            E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 } },
                E(Segmented, { options: CMP_MODES, value: cmp, onChange: function (v) { setCmp(v); } }),
                (pin || sel.length) ? E('button', { onClick: function () { reset(); setSel([]); }, style: { background: 'none', border: 'none', color: ui.C.blue, fontFamily: ui.sys, fontSize: 12, padding: 0, cursor: 'pointer' } }, 'Clear') : null
            ),
            waiting && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, marginBottom: 6 } }, 'Tap a second month on the chart to compare the two.'),
            from ? E('div', null,
                E('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4, fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
                    E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500 } }, monthLabel(from.month) + ' → ' + monthLabel(to.month)),
                    E('span', { style: { fontSize: 13, color: signColor(ui, bd.total), filter: blur } }, fmtSigned(bd.total))),
                bd.rows.map(function (g, i) {
                    var on = sel.indexOf(g.id) >= 0, isOpen = openGroup === g.id;
                    var col = on ? LINE_COLS[sel.indexOf(g.id) % LINE_COLS.length] : null;
                    return E('div', { key: g.id, style: { borderTop: i ? '1px solid ' + ui.C.border : 'none' } },
                        E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0' } },
                            // Dot: draws (or removes) this group's own line on the chart.
                            E('button', { onClick: function () { toggleSel(g.id); }, 'aria-label': 'Draw ' + groupOf(g.id).label,
                                style: { width: 22, height: 22, flexShrink: 0, borderRadius: 11, border: '1px solid ' + (col || ui.C.border), background: col || 'transparent', cursor: 'pointer', padding: 0 } }),
                            E('button', { onClick: function () { setOpenGroup(isOpen ? null : g.id); },
                                style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' } },
                                E('span', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, groupOf(g.id).label),
                                // Bar sized against the largest block.
                                E('span', { style: { width: 54, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.05)', position: 'relative', flexShrink: 0 } },
                                    E('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, width: Math.round(Math.abs(g.d) / maxAbs * 100) + '%', background: signColor(ui, g.d), opacity: 0.7 } })),
                                E('span', { style: { fontFamily: ui.rounded, fontSize: 13, color: signColor(ui, g.d), fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'right', filter: blur } }, fmtSigned(g.d)),
                                E(ChevronIcon, { style: { width: 12, height: 12, color: ui.C.zinc700, flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none' }, strokeWidth: 2 }))),
                        isOpen && E('div', { style: { padding: '0 0 6px 30px' } },
                            g.accounts.map(function (r) {
                                return E('div', { key: r.a.id, style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
                                    E('span', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.a.name),
                                    E('span', { style: { fontSize: 12, color: signColor(ui, r.d), filter: blur } }, fmtSigned(r.d)),
                                    E('span', { style: { fontSize: 12, color: ui.C.zinc400, minWidth: 70, textAlign: 'right', filter: blur } }, fmtGBP(r.v)));
                            })));
                })
            ) : E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600 } }, 'Nothing earlier to compare with.'),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.4 } },
                'Press and drag on the chart to read any month; lift to keep it. Tap a dot to draw that group’s own line.')
        )
    );
}

function GroupCard(props) {
    var ui = useUI();
    var g = props.group, latest = props.latest, prev = props.prev;
    var open = React.useState(false);
    var now = latest.groups[g.id] || 0;
    var before = prev ? (prev.groups[g.id] || 0) : null;
    var d = before == null ? null : now - before;
    var rows = props.accounts.filter(function (a) { return a.group === g.id && (!a.closed || latest.values[a.id] != null); });
    var blur = props.privacy ? 'blur(6px)' : 'none';
    return E('div', { style: cardStyle(ui, { padding: 0 }) },
        E('button', {
            onClick: function () { open[1](!open[0]); },
            style: { width: '100%', background: 'none', border: 'none', padding: '13px 14px 13px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', textAlign: 'left' }
        },
            E('div', { style: { flex: 1, minWidth: 0 } },
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, fontWeight: 600 } }, g.label),
                E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 1 } },
                    rows.length + (rows.length === 1 ? ' account' : ' accounts'))
            ),
            E('div', { style: { textAlign: 'right' } },
                E('div', { style: moneyStyle(ui, 17, props.privacy, now < 0 ? ui.C.rose : ui.C.white) }, fmtGBP(now)),
                d != null && E('div', { style: { fontFamily: ui.rounded, fontSize: 11, color: signColor(ui, d), fontVariantNumeric: 'tabular-nums', marginTop: 2 } },
                    // Always says what it compares with: the previous month on record.
                    E('span', { style: { fontFamily: ui.sys, color: ui.C.zinc600 } }, 'vs ' + (monthIndex(latest.month) - monthIndex(prev.month) === 1 ? MONTHS[Number(prev.month.slice(5, 7)) - 1] : monthLabel(prev.month)) + ' '),
                    E('span', { style: { filter: blur } }, fmtSigned(d)), ' ', fmtPct(pctChange(now, before)))
            ),
            E(ChevronIcon, { style: { width: 14, height: 14, color: ui.C.zinc700, transform: open[0] ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }, strokeWidth: 2 })
        ),
        open[0] && E('div', { style: { borderTop: '1px solid ' + ui.C.border, padding: '6px 16px 10px' } },
            prev && E('div', { style: { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc700, textAlign: 'right', paddingTop: 4, paddingRight: 84, letterSpacing: '0.04em' } },
                'vs ' + monthLabel(prev.month)),
            rows.map(function (a) {
                var v = latest.values[a.id] || 0, pv = prev ? (prev.values[a.id] || 0) : null;
                var shareNote = (a.share < 1 ? ' · your ' + Math.round(a.share * 100) + '%' : '') + (isLiquid(a) !== !!g.liquid ? (isLiquid(a) ? ' · liquid' : ' · not liquid') : '')
                    + (a.growth != null ? ' · ' + (a.growth > 0 ? '+' : '') + a.growth + '%/yr' : '');
                return E('div', { key: a.id, style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0' } },
                    E('div', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        a.name, E('span', { style: { color: ui.C.zinc700, fontSize: 11 } }, shareNote),
                        a.appLinks.length && !a.closed ? E('span', { style: { color: ui.C.blue, fontSize: 10, marginLeft: 6 } }, 'LIVE') : null),
                    pv != null && E('span', { style: { fontFamily: ui.rounded, fontSize: 11, color: signColor(ui, v - pv), filter: blur, fontVariantNumeric: 'tabular-nums' } }, fmtSigned(v - pv)),
                    E('span', { style: { fontFamily: ui.rounded, fontSize: 13, color: v < 0 ? ui.C.rose : ui.C.white, filter: blur, fontVariantNumeric: 'tabular-nums', minWidth: 76, textAlign: 'right' } }, fmtGBP(v))
                );
            })
        )
    );
}

// Sub-view header (Update balances, Import): Back and a title. The main view needs none; the tab bar names it.
function Header(props) {
    var ui = useUI();
    return E('div', {
        style: { padding: '6px 16px 6px 8px', background: 'rgba(13,18,24,0.98)', borderBottom: '1px solid ' + ui.C.border, flexShrink: 0,
                 display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, boxSizing: 'border-box' }
    },
        E('button', { onClick: props.onBack, 'aria-label': 'Back', style: { background: 'none', border: 'none', color: ui.C.blue, display: 'flex', alignItems: 'center', padding: '6px 4px', cursor: 'pointer', fontFamily: ui.sys, fontSize: 15 } },
            E(BackIcon, { style: { width: 18, height: 18 }, strokeWidth: 2 }), 'Back'),
        E('div', { style: { fontFamily: ui.sys, fontSize: 17, fontWeight: 700, flex: 1, minWidth: 0, color: ui.C.white, letterSpacing: '-0.01em' } }, props.title)
    );
}

// ── Main view ────────────────────────────────────────────────────────────────
function MainView(props) {
    var ui = useUI();
    var state = props.state, series = props.series;
    var del = React.useState(false);
    var msg = React.useState(null);
    if (!state.accounts.length) {
        return E('div', { style: { padding: '24px 16px' } },
            E('div', { style: cardStyle(ui, { padding: '22px 18px', textAlign: 'center' }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 16, color: ui.C.white, fontWeight: 600, marginBottom: 6 } }, 'No balances yet'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 16 } },
                    'Import your balances spreadsheet to bring in your history, or add your accounts and enter this month’s balances.'),
                E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    E('button', { style: buttonStyle(ui, 'primary'), onClick: props.onImport }, 'Import spreadsheet'),
                    E('button', { style: buttonStyle(ui), onClick: props.onUpdate }, 'Add accounts by hand')
                )
            )
        );
    }
    var latest = series.length ? series[series.length - 1] : null;
    var prev = series.length > 1 ? series[series.length - 2] : null;
    var stale = !state.lastExportAt || (Date.now() - state.lastExportAt) > 35 * 86400000;
    function exportFile(kind) {
        var name = 'estate-' + todayISO() + (kind === 'csv' ? '.csv' : '.json');
        var text = kind === 'csv' ? buildCsv(state) : buildJson(state);
        deliverText(text, name, kind === 'csv' ? 'text/csv' : 'application/json').then(function () {
            saveState(Object.assign({}, state, { lastExportAt: Date.now() })).catch(function () {});
            msg[1]('Exported ' + name);
        }).catch(function (e) { if (!e || e.name !== 'AbortError') msg[1]('Export failed: ' + (e && e.message)); });
    }
    return E('div', { style: { padding: '12px 16px 0' } },
        latest ? E(Hero, { series: series, privacy: props.privacy })
               : E('div', { style: cardStyle(ui, { marginBottom: 12, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 }) }, 'No balances entered yet. Tap Update balances to add this month’s.'),
        series.length > 1 && E(Chart, { series: series, accounts: state.accounts, privacy: props.privacy }),
        latest && E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 } },
            GROUPS.filter(function (g) {
                return state.accounts.some(function (a) { return a.group === g.id && (!a.closed || latest.values[a.id] != null); });
            }).map(function (g) {
                return E(GroupCard, { key: g.id, group: g, latest: latest, prev: prev, accounts: state.accounts, privacy: props.privacy });
            })
        ),
        E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', fontSize: 15 }), onClick: props.onUpdate }, 'Update balances'),
        E('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            E('button', { style: Object.assign(buttonStyle(ui), { flex: 1 }), onClick: props.onImport }, 'Import'),
            E('button', { style: Object.assign(buttonStyle(ui), { flex: 1 }), onClick: function () { exportFile('json'); } }, 'Export JSON')
        ),
        E('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 4 } },
            E('button', { onClick: function () { exportFile('csv'); }, style: { background: 'none', border: 'none', color: ui.C.zinc600, fontFamily: ui.sys, fontSize: 12, padding: '8px', cursor: 'pointer', textDecoration: 'underline' } },
                'Export CSV for Excel')
        ),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: stale ? ui.C.amber : ui.C.zinc600, textAlign: 'center', marginTop: 10, lineHeight: 1.4 } },
            'Last exported ' + relTime(state.lastExportAt) + '. Your balances live only on this phone. Export JSON saves every account, closed ones included, and every update, and Import restores it.'),
        msg[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, textAlign: 'center', marginTop: 6 } }, msg[0]),
        E('div', { style: { display: 'flex', justifyContent: 'center', marginTop: 18 } },
            E('button', {
                style: Object.assign(buttonStyle(ui, del[0] ? 'danger' : null), { minHeight: 34, fontSize: 12, fontWeight: 500, background: 'transparent', border: del[0] ? undefined : 'none', color: del[0] ? ui.C.rose : ui.C.zinc700 }),
                onClick: function () {
                    if (!del[0]) { del[1](true); setTimeout(function () { del[1](false); }, 4000); return; }
                    saveState(emptyState()).catch(function () {});
                    del[1](false);
                }
            }, del[0] ? 'Tap again to delete all balances' : 'Delete all balances')
        )
    );
}

// ── Update form ──────────────────────────────────────────────────────────────
function amountText(v) { return v == null ? '' : String(Math.round(Math.abs(v) * 100) / 100); }

function UpdateView(props) {
    var ui = useUI();
    var state = props.state;
    var appValues = props.appValues || [];
    var appByKey = appIndex(appValues);
    var current = currentBalances(state);
    var shownNow = withGrowth(Object.assign({}, current, { date: todayISO() }), state.accounts);   // growing values moved on to today

    // Working copies: accounts (for manage mode) and the typed amounts (positive = amount owed for debts).
    var accState = React.useState(function () { return state.accounts.map(function (a) { return Object.assign({}, a); }); });
    var accounts = accState[0], setAccounts = accState[1];
    var amtState = React.useState(function () {
        var m = {};
        state.accounts.forEach(function (a) {
            m[a.id] = amountText(shownNow.values[a.id]);
        });
        return m;
    });
    var amounts = amtState[0], setAmounts = amtState[1];
    var initial = React.useState(amounts)[0];   // what each box showed on opening: unchanged boxes aren't saved
    var dateState = React.useState(todayISO()), date = dateState[0];
    var manage = React.useState(state.accounts.length === 0);
    var newName = React.useState(''), newGroup = React.useState('current');
    var err = React.useState(null);

    var open = accounts.filter(function (a) { return !a.closed; });
    var closed = accounts.filter(function (a) { return a.closed; });

    function patchAccount(id, patch) {
        setAccounts(accounts.map(function (a) { return a.id === id ? Object.assign({}, a, patch) : a; }));
    }
    var chooser = React.useState(null);   // id of the account whose link list is open
    function toggleLink(a, key) {
        var has = a.appLinks.indexOf(key) >= 0;
        patchAccount(a.id, { appLinks: has ? a.appLinks.filter(function (k) { return k !== key; }) : a.appLinks.concat([key]) });
    }
    function addAccount() {
        var name = newName[0].trim();
        if (!name) return;
        if (accounts.some(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })) { err[1]('There is already an account called ' + name + '.'); return; }
        var g = newGroup[0];
        var id = 'm' + Date.now().toString(36) + '-' + slug(name);
        setAccounts(accounts.concat([{ id: id, name: name, group: g, debt: !!groupOf(g).debt, share: 1, rate: null, closed: false, liquid: null, appLinks: [] }]));
        newName[1]('');
        err[1](null);
    }
    // Saves only the balances that changed, as a partial update: every other account keeps its last value and date,
    // so month-on-month changes aren't flattened by re-saving untouched balances.
    function save() {
        if (!ISO_DATE.test(date || '')) { err[1]('Pick a date.'); return; }
        var values = {}, bad = null;
        open.forEach(function (a) {
            var linked = linkedNow(a, appByKey);
            if (linked) {
                var lv = Math.round(linked.value * 100) / 100;
                if (current.values[a.id] !== lv) values[a.id] = lv;
                return;
            }
            var t = amounts[a.id];
            if (t === initial[a.id]) return;                    // left as it was
            if (t == null || String(t).trim() === '') { values[a.id] = 0; return; }
            var v = parseAmount(t);
            if (v == null) { bad = a.name; return; }
            values[a.id] = a.debt ? -Math.abs(v) : v;
        });
        // An account closed here stops counting from this date.
        accounts.forEach(function (a) {
            var before = state.accounts.filter(function (x) { return x.id === a.id; })[0];
            if (a.closed && before && !before.closed && current.values[a.id]) values[a.id] = 0;
        });
        if (bad) { err[1]('Check the amount for ' + bad + '.'); return; }
        var snaps = Object.keys(values).length ? withPartial(state.snapshots, date, values) : state.snapshots;
        saveState(Object.assign({}, state, { accounts: accounts.map(linkedToInvestments), snapshots: snaps })).then(props.onDone, function (e) { err[1]('Could not save: ' + (e && e.message)); });
    }

    // Accounts the Investments tab can hold: savings (e.g. a money market fund), investments, pensions and other.
    var linkable = function (a) { return appValues.length > 0 && !a.debt && /^(savings|investments|pensions|other)$/.test(a.group); };
    return E('div', { style: { padding: '12px 16px 0' } },
        E('div', { style: cardStyle(ui, { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }) },
            E('div', { style: { flex: 1, fontFamily: ui.sys, fontSize: 14, color: ui.C.zinc400 } }, 'Balances as at'),
            E('input', { type: 'date', value: date, onChange: function (e) { dateState[1](e.target.value); }, style: inputStyle(ui, { fontFamily: ui.sys, fontSize: 15 }) })
        ),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, margin: '-4px 4px 12px', lineHeight: 1.4 } },
            'Change only the balances you have new figures for. The others keep their last value and date.'),
        GROUPS.map(function (g) {
            var list = open.filter(function (a) { return a.group === g.id; });
            if (!list.length) return null;
            return E('div', { key: g.id, style: { marginBottom: 14 } },
                E('div', { style: Object.assign(capsLabel(ui), { margin: '0 4px 6px' }) }, g.label + (g.debt ? ' · amount owed' : '')),
                E('div', { style: cardStyle(ui, { padding: '4px 14px' }) },
                    list.map(function (a, i) {
                        var linked = linkedNow(a, appByKey);
                        var choosing = chooser[0] === a.id;
                        return E('div', { key: a.id, style: { padding: '8px 0', borderTop: i ? '1px solid ' + ui.C.border : 'none' } },
                            E('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                                manage[0]
                                    ? E('input', { value: a.name, onChange: function (e) { patchAccount(a.id, { name: e.target.value }); }, style: inputStyle(ui, { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 14 }) })
                                    : E('div', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 14, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                        a.name, a.debt && g.id === 'property' ? E('span', { style: { color: ui.C.zinc700, fontSize: 11 } }, ' · owed') : null,
                                        current.asOf[a.id] && E('div', { style: { fontSize: 11, color: amounts[a.id] !== initial[a.id] ? ui.C.amber : ui.C.zinc700, marginTop: 1 } },
                                            amounts[a.id] !== initial[a.id] ? 'Will update' : 'Updated ' + dayLabel(current.asOf[a.id]))),
                                manage[0]
                                    ? E('div', { style: { display: 'flex', gap: 6 } },
                                        // Investments are liquid by default; switch off for money you can't get at (unvested shares).
                                        g.id === 'investments' && E('button', {
                                            onClick: function () { patchAccount(a.id, { liquid: !isLiquid(a) }); },
                                            style: Object.assign(buttonStyle(ui), { minHeight: 36, fontSize: 12, color: isLiquid(a) ? ui.C.emerald : ui.C.zinc600 })
                                        }, isLiquid(a) ? 'Liquid: yes' : 'Liquid: no'),
                                        E('button', { onClick: function () { patchAccount(a.id, { closed: true }); }, style: Object.assign(buttonStyle(ui), { minHeight: 36, fontSize: 12 }) }, 'Close'))
                                    : E('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                                        E('span', { style: { fontFamily: ui.rounded, color: ui.C.zinc600, fontSize: 15 } }, '£'),
                                        linked
                                            // Linked: the value comes from the Investments tab and keeps updating, so it isn't typed in.
                                            ? E('div', { style: { width: 116, textAlign: 'right', fontFamily: ui.rounded, fontSize: 15, color: ui.C.blue, padding: '9px 0', fontVariantNumeric: 'tabular-nums', filter: props.privacy ? 'blur(6px)' : 'none' } }, Math.abs(linked.value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
                                            : E('input', {
                                            inputMode: 'decimal', value: amounts[a.id] || '', placeholder: '0',
                                            onChange: function (e) { var o = Object.assign({}, amounts); o[a.id] = e.target.value; setAmounts(o); },
                                            style: inputStyle(ui, { width: 116, textAlign: 'right', filter: props.privacy ? 'blur(6px)' : 'none' })
                                        }))
                            ),
                            // House and car: a yearly % the value is moved on by after each valuation you enter.
                            !manage[0] && g.id === 'property' && !a.debt && E('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 } },
                                E('span', { style: { flex: 1, fontFamily: ui.sys, fontSize: 11, color: a.growth != null ? ui.C.blue : ui.C.zinc700 } },
                                    a.growth != null ? 'Moves on by ' + (a.growth > 0 ? '+' : '') + a.growth + '% a year after each valuation' : 'Yearly growth (− for depreciation):'),
                                E('input', {
                                    inputMode: 'decimal', placeholder: '%', defaultValue: a.growth == null ? '' : String(a.growth),
                                    onChange: function (e) { var t = e.target.value.trim(); var n = t === '' ? null : Number(t.replace('%', '').replace('−', '-')); patchAccount(a.id, { growth: n == null || isNaN(n) ? null : n }); },
                                    style: inputStyle(ui, { width: 64, textAlign: 'right', fontSize: 13, padding: '6px 8px' })
                                }),
                                E('span', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc600 } }, '%/yr')),
                            !manage[0] && linkable(a) && E('button', {
                                onClick: function () { chooser[1](choosing ? null : a.id); },
                                style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }
                            },
                                E('span', { style: { fontFamily: ui.sys, fontSize: 11, color: linked ? ui.C.blue : ui.C.zinc700, flexShrink: 0 } }, linked ? 'Live from Investments:' : 'Link to Investments:'),
                                E('span', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 12, color: linked ? ui.C.blue : ui.C.zinc600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                    a.appLinks.length ? a.appLinks.map(function (k) { return appByKey[k] ? appByKey[k].label : 'not in Investments now'; }).join(' + ') : 'Not linked'),
                                E(ChevronIcon, { style: { width: 12, height: 12, color: ui.C.zinc700, flexShrink: 0, transform: choosing ? 'rotate(90deg)' : 'none' }, strokeWidth: 2 })),
                            // Tick every Investments value this account should add up (e.g. a share plan's account and its unvested shares).
                            !manage[0] && linkable(a) && choosing && E('div', { style: { marginTop: 4, paddingLeft: 2 } },
                                appValues.map(function (o) {
                                    // An old link counts for the one value its key resolves to, not every value sharing that old key.
                                    var viaLegacy = !!o.legacyKey && appByKey[o.legacyKey] === o && a.appLinks.indexOf(o.legacyKey) >= 0;
                                    var on = a.appLinks.indexOf(o.key) >= 0 || viaLegacy;
                                    return E('label', { key: o.key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontFamily: ui.sys, fontSize: 13, color: on ? ui.C.white : ui.C.zinc400 } },
                                        E('input', { type: 'checkbox', checked: on, onChange: function () { toggleLink(a, viaLegacy ? o.legacyKey : o.key); }, style: { width: 18, height: 18, accentColor: ui.C.blue, margin: 0 } }),
                                        E('span', { style: { flex: 1, minWidth: 0 } }, o.label),
                                        !props.privacy && E('span', { style: { fontFamily: ui.rounded, fontSize: 12, color: ui.C.zinc600, fontVariantNumeric: 'tabular-nums' } }, fmtGBP(o.value)));
                                }),
                                a.group !== 'investments' && E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, padding: '4px 0 2px' } }, 'Once linked and saved, this account moves under Investments.'))
                        );
                    })
                )
            );
        }),
        manage[0] && E('div', { style: cardStyle(ui, { marginBottom: 14 }) },
            E('div', { style: Object.assign(capsLabel(ui), { marginBottom: 8 }) }, 'Add an account'),
            E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                E('input', { value: newName[0], placeholder: 'Account name', onChange: function (e) { newName[1](e.target.value); }, style: inputStyle(ui, { fontFamily: ui.sys }) }),
                E('div', { style: { display: 'flex', gap: 8 } },
                    E('select', { value: newGroup[0], onChange: function (e) { newGroup[1](e.target.value); }, style: inputStyle(ui, { flex: 1, fontFamily: ui.sys, fontSize: 14 }) },
                        GROUPS.map(function (g) { return E('option', { key: g.id, value: g.id }, g.label); })),
                    E('button', { onClick: addAccount, style: buttonStyle(ui, 'primary') }, 'Add'))
            ),
            closed.length > 0 && E('div', { style: { marginTop: 14 } },
                E('div', { style: Object.assign(capsLabel(ui), { marginBottom: 6 }) }, 'Closed accounts'),
                closed.map(function (a) {
                    return E('div', { key: a.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } },
                        E('div', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, a.name),
                        E('button', { onClick: function () { patchAccount(a.id, { closed: false }); }, style: Object.assign(buttonStyle(ui), { minHeight: 32, fontSize: 12 }) }, 'Reopen'));
                })
            )
        ),
        E('button', {
            onClick: function () { manage[1](!manage[0]); err[1](null); },
            style: Object.assign(buttonStyle(ui), { width: '100%', marginBottom: 10, background: 'transparent' })
        }, manage[0] ? 'Done managing accounts' : 'Add, rename or close accounts'),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, margin: '0 4px 10px' } }, err[0]),
        E('div', { style: { display: 'flex', gap: 8 } },
            E('button', { onClick: props.onDone, style: Object.assign(buttonStyle(ui), { flex: 1 }) }, 'Cancel'),
            E('button', { onClick: save, disabled: manage[0] || open.length === 0, style: Object.assign(buttonStyle(ui, 'primary'), { flex: 2, opacity: manage[0] || open.length === 0 ? 0.45 : 1 }) }, 'Save balances')
        )
    );
}

// ── Import view ──────────────────────────────────────────────────────────────
function ImportView(props) {
    var ui = useUI();
    var state = props.state;
    var pState = React.useState(null), parsed = pState[0], setParsed = pState[1];
    var rState = React.useState(null), restoreState = rState[0];   // a JSON export (or app backup) to restore
    var err = React.useState(null);
    var busy = React.useState(false);
    var fileRef = React.useRef(null);

    function onFile(e) {
        var f = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!f) return;
        err[1](null); busy[1](true);
        var isJson = /\.json$/i.test(f.name) || /json/.test(f.type);
        (isJson
            ? f.text().then(function (text) { setParsed(null); rState[1](parseJsonBackup(text)); })
            : f.arrayBuffer().then(function (buf) { rState[1](null); setParsed(parseImport(buf)); })
        ).catch(function (x) { err[1](x && x.message ? x.message : String(x)); }).then(function () { busy[1](false); });
    }
    function patchRow(key, patch) {
        setParsed(Object.assign({}, parsed, { rows: parsed.rows.map(function (r) {
            if (r.key !== key) return r;
            var n = Object.assign({}, r, patch);
            if (patch.group) n.debt = isDebtRow(patch.group, r.type, r.name);
            return n;
        }) }));
    }
    function confirm() {
        var next = importToState(parsed, state);
        if (!next.accounts.length) { err[1]('Tick at least one account.'); return; }
        saveState(next).then(props.onDone, function (x) { err[1]('Could not save: ' + (x && x.message)); });
    }

    var checks = parsed ? runChecks(parsed) : [];
    var picker = E('input', { ref: fileRef, type: 'file', accept: '.xlsx,.xls,.csv,.json,text/csv,application/json', onChange: onFile, style: { display: 'none' } });

    if (restoreState) {
        var rs = restoreState, rDates = rs.snapshots.map(function (x) { return x.date; });
        var rClosed = rs.accounts.filter(function (a) { return a.closed; }).length;
        return E('div', { style: { padding: '12px 16px 0' } }, picker,
            E('div', { style: cardStyle(ui, { marginBottom: 12 }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 15, color: ui.C.white, fontWeight: 600 } }, 'Restore from JSON'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, marginTop: 6, lineHeight: 1.5 } },
                    rs.accounts.length + ' accounts (' + rClosed + ' closed) and ' + rs.snapshots.length + ' snapshots' +
                    (rDates.length ? ', ' + dayLabel(rDates[0]) + ' to ' + dayLabel(rDates[rDates.length - 1]) : '') + '.'),
                state.accounts.length > 0 && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, marginTop: 8, lineHeight: 1.45 } },
                    'Restoring replaces everything on this screen now (' + state.accounts.length + ' accounts, ' + state.snapshots.length + ' snapshots).')
            ),
            err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, margin: '0 4px 10px' } }, err[0]),
            E('div', { style: { display: 'flex', gap: 8 } },
                E('button', { onClick: function () { rState[1](null); }, style: Object.assign(buttonStyle(ui), { flex: 1, whiteSpace: 'nowrap' }) }, 'Choose another'),
                E('button', { onClick: function () {
                    var next = Object.assign({}, rs, { lastExportAt: state.lastExportAt });
                    saveState(next).then(props.onDone, function (x) { err[1]('Could not save: ' + (x && x.message)); });
                }, style: Object.assign(buttonStyle(ui, 'primary'), { flex: 2 }) }, 'Restore')
            )
        );
    }

    if (!parsed) {
        return E('div', { style: { padding: '16px' } }, picker,
            E('div', { style: cardStyle(ui, { padding: '18px' }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 14, color: ui.C.zinc400, lineHeight: 1.5, marginBottom: 14 } },
                    'Choose your balances spreadsheet (.xlsx or .csv) with one column per date and one row per account, or a JSON or CSV file exported from this screen. You’ll see a preview before anything is saved.'),
                E('button', { onClick: function () { fileRef.current && fileRef.current.click(); }, disabled: busy[0], style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%' }) },
                    busy[0] ? 'Reading…' : 'Choose file'),
                err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginTop: 12 } }, err[0])
            )
        );
    }

    var inc = parsed.rows.filter(function (r) { return r.include; });
    return E('div', { style: { padding: '12px 16px 0' } }, picker,
        E('div', { style: cardStyle(ui, { marginBottom: 12 }) },
            E('div', { style: { fontFamily: ui.sys, fontSize: 15, color: ui.C.white, fontWeight: 600 } },
                parsed.dates.length + ' snapshots, ' + dayLabel(parsed.dates[0]) + ' to ' + dayLabel(parsed.dates[parsed.dates.length - 1])),
            E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, marginTop: 4, lineHeight: 1.45 } },
                inc.length + ' of ' + parsed.rows.length + ' accounts ticked. Check each account’s group, and untick anything that shouldn’t count.'),
            state.snapshots.length > 0 && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, marginTop: 8, lineHeight: 1.45 } },
                'Importing replaces the ' + state.snapshots.length + ' snapshots already here, including any you entered by hand.')
        ),
        checks.length > 0 && E('div', { style: cardStyle(ui, { marginBottom: 12 }) },
            E('div', { style: Object.assign(capsLabel(ui), { marginBottom: 8 }) }, 'Check against your summary rows'),
            checks.map(function (c) {
                var ok = c.mismatches.length === 0;
                return E('div', { key: c.label, style: { padding: '5px 0' } },
                    E('div', { style: { display: 'flex', gap: 8, fontFamily: ui.sys, fontSize: 13 } },
                        E('span', { style: { flex: 1, color: ui.C.zinc400 } }, c.label),
                        E('span', { style: { color: ok ? ui.C.emerald : ui.C.amber } },
                            ok ? 'Matches all ' + c.compared : (c.compared - c.mismatches.length) + ' of ' + c.compared + ' match')),
                    !ok && E('div', { style: { fontFamily: ui.rounded, fontSize: 11, color: ui.C.zinc600, marginTop: 2, lineHeight: 1.5 } },
                        c.mismatches.slice(0, 6).map(function (m) { return dayLabel(m.date) + ' '; }).join('· ').trim(),
                        c.mismatches.length > 6 ? ' and ' + (c.mismatches.length - 6) + ' more' : '',
                        E('span', { style: { filter: props.privacy ? 'blur(5px)' : 'none' } },
                            ' (app ' + fmtSigned(c.mismatches[0].diff) + ' on the first)'))
                );
            }),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 6, lineHeight: 1.45 } },
                'The app always adds up the accounts, so a mismatch usually means a summary row in the sheet left an account out.')
        ),
        GROUPS.map(function (g) {
            var list = parsed.rows.filter(function (r) { return r.group === g.id; });
            if (!list.length) return null;
            return E('div', { key: g.id, style: { marginBottom: 12 } },
                E('div', { style: Object.assign(capsLabel(ui), { margin: '0 4px 6px' }) }, g.label),
                E('div', { style: cardStyle(ui, { padding: '2px 12px' }) },
                    list.map(function (r, i) {
                        return E('div', { key: r.key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: i ? '1px solid ' + ui.C.border : 'none', opacity: r.include ? 1 : 0.5 } },
                            E('input', { type: 'checkbox', checked: r.include, onChange: function (e) { patchRow(r.key, { include: e.target.checked }); }, style: { width: 18, height: 18, flexShrink: 0 } }),
                            E('div', { style: { flex: 1, minWidth: 0 } },
                                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.name),
                                E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700 } },
                                    r.count + (r.count === 1 ? ' value' : ' values') + (r.closed ? ' · closed ' + monthLabel(monthKey(parsed.dates[r.lastIndex])) : ' · open') + (r.debt ? ' · owed' : ''))),
                            g.id === 'property' && E('div', { style: { display: 'flex', alignItems: 'center', gap: 2 } },
                                E('input', { inputMode: 'numeric', value: String(Math.round(r.share * 100)),
                                    onChange: function (e) { var p = parseAmount(e.target.value); if (p != null && p > 0 && p <= 100) patchRow(r.key, { share: p / 100 }); },
                                    style: inputStyle(ui, { width: 46, minHeight: 32, padding: '4px 6px', fontSize: 13, textAlign: 'right' }) }),
                                E('span', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700 } }, '%')),
                            E('select', { value: r.group, onChange: function (e) { patchRow(r.key, { group: e.target.value }); },
                                style: { maxWidth: 104, background: 'transparent', border: 'none', color: ui.C.blue, fontFamily: ui.sys, fontSize: 12 } },
                                GROUPS.map(function (gg) { return E('option', { key: gg.id, value: gg.id }, gg.label); }))
                        );
                    })
                )
            );
        }),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, margin: '0 4px 10px' } }, err[0]),
        E('div', { style: { display: 'flex', gap: 8 } },
            E('button', { onClick: function () { setParsed(null); }, style: Object.assign(buttonStyle(ui), { flex: 1, whiteSpace: 'nowrap' }) }, 'Choose another'),
            E('button', { onClick: confirm, style: Object.assign(buttonStyle(ui, 'primary'), { flex: 2 }) }, 'Import ' + inc.length + ' accounts')
        )
    );
}

// ── Screen ───────────────────────────────────────────────────────────────────
function BalancesScreenInner(props) {
    var ui = useUI();
    var state = useBalancesState();
    var vState = React.useState('main'), view = vState[0], setView = vState[1];
    var series = React.useMemo(function () { return buildSeries(state); }, [state]);
    var title = view === 'update' ? 'Update balances' : 'Import';
    var back = view === 'main' ? null : function () { setView('main'); };
    var body;
    if (!_ready) {
        body = E('div', { style: { padding: 32, textAlign: 'center', fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 } }, 'Loading…');
    } else if (view === 'update') {
        body = E(UpdateView, { state: state, appValues: props.appValues, privacy: props.privacyMode, onDone: back });
    } else if (view === 'import') {
        body = E(ImportView, { state: state, privacy: props.privacyMode, onDone: back });
    } else {
        body = E(MainView, { state: state, series: series, privacy: props.privacyMode,
                             onUpdate: function () { setView('update'); }, onImport: function () { setView('import'); } });
    }
    return E('div', {
        style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: ui.C.bg, display: 'flex', flexDirection: 'column', WebkitTapHighlightColor: 'transparent' }
    },
        back && E(Header, { title: title, onBack: back }),
        _loadError && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.rose, padding: '8px 16px' } }, 'Storage problem: ' + _loadError),
        // Keyed by view so each view opens scrolled to the top.
        E('div', { key: view, className: 'ios-scroll', style: { flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'max(env(safe-area-inset-bottom), 28px)' } },
            body)
    );
}

// Keeps a bug in this screen from taking down the rest of the app.
class BalancesBoundary extends React.Component {
    constructor(p) { super(p); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error: error }; }
    componentDidCatch(error, info) { console.error('Balances screen error:', error, info); }
    render() {
        if (!this.state.error) return this.props.children;
        var ui = this.props.ui;
        return E('div', { style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: ui.C.bg, padding: '40px 20px', fontFamily: ui.sys } },
            E('div', { style: { color: ui.C.rose, fontSize: 16, fontWeight: 600, marginBottom: 8 } }, 'Estate hit a problem'),
            E('div', { style: { color: ui.C.zinc600, fontSize: 13, marginBottom: 20, lineHeight: 1.5 } },
                String(this.state.error && this.state.error.message || this.state.error) + '. Your saved balances are untouched.'),
            E('button', { onClick: this.props.onClose, style: buttonStyle(ui) }, 'Back to Investments'));
    }
}

function BalancesScreen(props) {
    var ui = Object.assign({}, DEFAULT_UI, props.ui || {});
    ui.C = Object.assign({}, DEFAULT_UI.C, (props.ui && props.ui.C) || {});
    return E(UICtx.Provider, { value: ui },
        E(BalancesBoundary, { ui: ui, onClose: props.onClose }, E(BalancesScreenInner, props)));
}

window.BalancesScreen = BalancesScreen;
window.BalancesStore = BalancesStore;
window.BalancesIcon = WalletIcon;
// For tests only: the pure parts, no UI.
window.__balancesInternals = { applyLinked: applyLinked, parseJsonBackup: parseJsonBackup, buildJson: buildJson, parseImport: parseImport, importToState: importToState, runChecks: runChecks, buildSeries: buildSeries, parseAmount: parseAmount, buildCsv: buildCsv };
})();
