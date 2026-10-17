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
    { id: 'pensions',    label: 'Pension', liquid: false },
    { id: 'property',    label: 'Assets',                    liquid: false },
    { id: 'other',       label: 'Other',                     liquid: true  },
];
var GROUP_BY_ID = {};
GROUPS.forEach(function (g) { GROUP_BY_ID[g.id] = g; });
function groupOf(id) { return GROUP_BY_ID[id] || GROUP_BY_ID.other; }
// Whether an account counts toward Liquid: its own flag when set (e.g. unvested shares under Investments), else its group's.
// Cards on the Estate screen. Current and Credit cards share one: the cards are paid off monthly from the current
// account, so only together do they show the everyday cash position (Fergus asked). Entry and storage keep the groups.
var CARDS = [{ id: 'cash', label: 'Current and Credit', short: 'Cash', liquid: true, groups: ['current', 'cards'] }].concat(
    GROUPS.filter(function (g) { return g.id !== 'current' && g.id !== 'cards'; })
          .map(function (g) { return { id: g.id, label: g.label, liquid: g.liquid, groups: [g.id] }; }));
var CARD_OF = {}, CARD_BY_ID = {};
CARDS.forEach(function (c) { CARD_BY_ID[c.id] = c; c.groups.forEach(function (gid) { CARD_OF[gid] = c.id; }); });
function cardId(a) { return CARD_OF[a.group] || 'other'; }
function cardLabel(id) { return (CARD_BY_ID[id] || CARD_BY_ID.other).label; }
function isLiquid(a) { return typeof a.liquid === 'boolean' ? a.liquid : !!groupOf(a.group).liquid; }

// ── Store (IndexedDB, own database) ──────────────────────────────────────────
// state = { v: 1, accounts: [Account], snapshots: [Snapshot], lastExportAt, updatedAt }
//   Account  = { id, name, group, debt, share, rate, closed, appLinks }
//              growth:   % a year the value grows (+) or falls (−) after its last valuation (house, car); null = none.
//              asset:    { bought, price, rate, valuations: [{ date, value }] } for a house or car: the purchase, then
//                        any later valuations. Between two points the value runs in a straight line; after the latest
//                        it rises (+) or falls (−) by `rate` % a year. Once bought and price are set, every month from
//                        the purchase is worked out from these points.
//              loan:     { rate (%/yr), start, end ('YYYY-MM-DD'), payment (£/month) } for a repayment mortgage; null = none.
//                        After each balance you enter, the amount owed is worked down month by month from these terms.
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

// The spreadsheet's rate column holds fractions (0.038 = 3.8%); loan rates are in %.
function pctFromSheet(r) { return r < 1 ? Math.round(r * 1e6) / 1e4 : r; }
function validLoan(l) {
    if (!l || typeof l !== 'object') return null;
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
    var pts = (Array.isArray(l.points) ? l.points : []).filter(function (p) {
        return p && ISO_DATE.test(p.date || '') && num(p.value) != null;
    }).map(function (p) { return { date: p.date, value: Math.abs(p.value) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var out = { rate: num(l.rate), payment: num(l.payment),
                start: ISO_DATE.test(l.start || '') ? l.start : null, end: ISO_DATE.test(l.end || '') ? l.end : null,
                balance: num(l.balance) == null ? null : Math.abs(l.balance),
                drawn: ISO_DATE.test(l.drawn || '') ? l.drawn : null, amount: num(l.amount) == null ? null : Math.abs(l.amount),
                points: pts };
    return out.rate == null && out.payment == null && !out.start && !out.end && out.balance == null && !out.drawn && out.amount == null && !pts.length ? null : out;
}
// Current deal's terms and its starting balance set: the amount owed is worked out entirely from the loan's points.
function loanFormula(l) { return loanReady(l) && l.balance != null; }
// Points the amount owed passes through, oldest first: the amount borrowed, each remortgage, the current deal's start.
function loanPoints(l) {
    var first = l.drawn && l.amount != null && l.drawn < l.start ? [{ date: l.drawn, value: l.amount }] : [];
    var mid = l.points.filter(function (p) { return p.date < l.start && (!first.length || p.date > l.drawn); });
    return first.concat(mid, [{ date: l.start, value: l.balance }]);
}
// Amount owed (positive) on date `d` (Fergus): a straight line between the points either side of it (earlier deals),
// then from the current deal's start worked down month by month at its rate and payment. null before the first point.
function loanOwed(l, d) {
    if (!loanFormula(l)) return null;
    var pts = loanPoints(l);
    if (d < pts[0].date) return null;
    if (d >= l.start) return payDown(l.balance, l, l.start, d);
    for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i], p1 = pts[i + 1];
        if (d >= p0.date && d < p1.date) {
            var t = (Date.parse(d) - Date.parse(p0.date)) / (Date.parse(p1.date) - Date.parse(p0.date));
            return Math.round((p0.value + (p1.value - p0.value) * t) * 100) / 100;
        }
    }
    return l.balance;
}

// legacyRate: the account's old single growth rate, used as the purchase rate for data saved before rates per point.
function validAsset(x, legacyRate) {
    if (!x || typeof x !== 'object') return null;
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
    var vals = (Array.isArray(x.valuations) ? x.valuations : []).filter(function (v) {
        return v && ISO_DATE.test(v.date || '') && num(v.value) != null;
    }).map(function (v) { return { date: v.date, value: v.value }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var out = { bought: ISO_DATE.test(x.bought || '') ? x.bought : null, price: num(x.price),
                rate: x.rate === undefined ? num(legacyRate) : num(x.rate), valuations: vals };
    return out.bought || out.price != null || vals.length ? out : null;
}
// Bought and price paid set: the value is worked out from the purchase and valuations.
function assetReady(x) { return !!(x && x.bought && x.price != null); }
// The purchase, then each valuation, in date order: { date, value }.
function assetPoints(x) {
    return [{ date: x.bought, value: x.price }].concat(x.valuations.filter(function (v) { return v.date > x.bought; }));
}
// Value on date `d` (Fergus): a straight line between the two points either side of it; after the latest point, that
// value moved on at the yearly rate. null before the purchase.
function assetValue(x, d) {
    if (!assetReady(x) || d < x.bought) return null;
    var pts = assetPoints(x), last = pts[pts.length - 1];
    if (d >= last.date) return grow(last.value, x.rate || 0, last.date, d);
    for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i], p1 = pts[i + 1];
        if (d >= p0.date && d < p1.date) {
            var t = (Date.parse(d) - Date.parse(p0.date)) / (Date.parse(p1.date) - Date.parse(p0.date));
            return Math.round((p0.value + (p1.value - p0.value) * t) * 100) / 100;
        }
    }
    return last.value;
}
// The yearly rate after the latest point, kept on the account as `growth`.
function assetRate(x) { return x.rate; }
// Loans saved before the fix took the sheet's fraction as a %: 0.038 meant 3.8%, not 0.038%.
function fixLoanRate(l, sheetRate) {
    return l && l.rate != null && typeof sheetRate === 'number' && sheetRate > 0 && sheetRate < 1 && l.rate === sheetRate
        ? Object.assign({}, l, { rate: pctFromSheet(sheetRate) }) : l;
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
            loan: fixLoanRate(validLoan(a.loan), a.rate),
            asset: validAsset(a.asset, a.growth),
            appLinks: linksOf(a),
        };
    }).map(function (a) { return assetReady(a.asset) ? Object.assign({}, a, { growth: assetRate(a.asset) }) : a; }).map(linkedToInvestments);
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

var _pendingView = null;
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
    // Settings → Estate (index.html): export, delete, and open the Import view on the Estate tab.
    exportFile: function (kind) {
        var name = 'estate-' + todayISO() + (kind === 'csv' ? '.csv' : '.json');
        var text = kind === 'csv' ? buildCsv(_state) : buildJson(_state);
        return deliverText(text, name, kind === 'csv' ? 'text/csv' : 'application/json').then(function () {
            saveState(Object.assign({}, _state, { lastExportAt: Date.now() })).catch(function () {});
            return name;
        });
    },
    deleteAll: function () { return saveState(emptyState()); },
    relTime: function (ts) { return relTime(ts); },
    // Asks the Estate screen to open a view ('import'); picked up when it mounts or, if open, straight away.
    openView: function (v) { _pendingView = v; window.dispatchEvent(new Event('estate-open-view')); },
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
        // A card covering several groups also gets its own sum (e.g. cash = current + cards).
        var c = cardId(a);
        if (c !== a.group) groups[c] = (groups[c] || 0) + v;
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
// one changes only the accounts it holds. asOf = the date each account's balance was last set. since = the date it
// was first set to its current figure: a month that only repeats last month's figure (a spreadsheet carrying a
// mortgage forward) is not a new reading, so a formula keeps running from the real one.
function resolveTimeline(snapshots) {
    var values = {}, asOf = {}, since = {};
    return snapshots.map(function (s) {
        var before = values;
        if (!s.partial) { values = {}; asOf = {}; }
        else { values = Object.assign({}, values); asOf = Object.assign({}, asOf); }
        since = Object.assign({}, since);
        Object.keys(s.values).forEach(function (id) {
            if (before[id] !== s.values[id] || !since[id]) since[id] = s.date;
            values[id] = s.values[id]; asOf[id] = s.date;
        });
        Object.keys(since).forEach(function (id) { if (values[id] == null) delete since[id]; });
        return { date: s.date, values: values, asOf: asOf, since: since };
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
// Whether a loan has every term needed to work it down.
function loanReady(l) { return !!(l && l.rate != null && l.payment != null && l.start && l.end); }
// Amount owed on a repayment mortgage moved on from `from` to `to`: on each monthly payment day (the start date's day
// of the month) between the start and end dates, a month's interest is added and the payment taken off. Never below 0.
// `owed` is the stored balance (negative for a debt); the result keeps its sign.
function payDown(owed, loan, from, to) {
    var sign = owed < 0 ? -1 : 1, b = Math.abs(owed), i = loan.rate / 100 / 12;
    var day = Number(loan.start.slice(8, 10)), y = Number(loan.start.slice(0, 4)), m = Number(loan.start.slice(5, 7));
    for (var n = 0; n < 1200 && b > 0; n++) {
        var dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
        var d = y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(day, dim)).padStart(2, '0');
        if (d > to || d > loan.end) break;
        if (d > from) b = Math.max(0, b * (1 + i) - loan.payment);
        m++; if (m > 12) { m = 1; y++; }
    }
    return sign * Math.round(b * 100) / 100;
}
// Balances at `r.date` with each growing account (house, car) moved on from its last valuation at its own rate, and
// each mortgage with loan terms worked down from its last balance. Only the gap after a value you enter is
// estimated: an entered value always replaces the estimate.
function withGrowth(r, accounts) {
    var out = null;
    accounts.forEach(function (a) {
        // House or car with a purchase (and maybe later valuations): worked out from those points from the purchase on.
        if (assetReady(a.asset)) {
            if (r.date < a.asset.bought) return;
            out = out || Object.assign({}, r.values);
            out[a.id] = assetValue(a.asset, r.date);
            return;
        }
        // Mortgage with its current deal's starting balance: worked out from its points from the first one on.
        if (loanFormula(a.loan)) {
            var owed = loanOwed(a.loan, r.date);
            if (owed == null) return;
            out = out || Object.assign({}, r.values);
            out[a.id] = a.debt ? -owed : owed;
            return;
        }
        var loan = loanReady(a.loan) ? a.loan : null;
        var from = r.since && r.since[a.id] || r.asOf[a.id];
        if ((a.growth == null && !loan) || r.values[a.id] == null || !from || from >= r.date) return;
        out = out || Object.assign({}, r.values);
        out[a.id] = loan ? payDown(r.values[a.id], loan, from, r.date) : grow(r.values[a.id], a.growth, from, r.date);
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
// are read only to check the import, plus House value and the car (the Assets group).
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
// Everything the Estate screen holds — every account (closed ones included, with name, group, share, liquid flag,
// growth rate, mortgage terms and app links)
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
var CloseIcon = typeof _li === 'function' ? _li(['M18 6L6 18', 'M6 6l12 12']) : function () { return null; };

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

// The small boxes in the house, car and mortgage forms, two to a row. iOS gives a date box a native minimum width
// wider than half a phone screen, so without this it spills over the box beside it (Fergus saw them overlap).
var FIELD_CSS = '.estate-field{-webkit-appearance:none;appearance:none;display:block;width:100%;min-width:0;max-width:100%;margin:0}' +
    '.estate-field::-webkit-date-and-time-value{text-align:left;margin:0}' +
    '.estate-field::-webkit-datetime-edit{padding:0}' +
    '.estate-field::-webkit-calendar-picker-indicator{margin:0 0 0 4px;padding:0;opacity:0.5}';
function fieldInput(ui, value, onChange, extra) {
    if (!document.getElementById('estate-field-css')) {
        var tag = document.createElement('style');
        tag.id = 'estate-field-css';
        tag.textContent = FIELD_CSS;
        document.head.appendChild(tag);
    }
    var date = extra.type === 'date';
    return E('input', Object.assign({ value: value, className: 'estate-field', onChange: function (e) { onChange(e.target.value); },
        style: inputStyle(ui, { fontSize: 14, padding: '0 10px', height: 36, minHeight: 36, lineHeight: '36px', textAlign: date ? 'left' : 'right' }) }, extra));
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
    return E('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', columnGap: 14, rowGap: 4, alignItems: 'baseline', marginTop: 8,
                               fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
        rows.map(function (r) {
            var c = signColor(ui, r.d);
            return [
                E('div', { key: r.p.months + 'l', style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                    'vs ' + r.p.label, E('span', { style: { color: ui.C.zinc700, fontSize: 11 } }, ' · ' + monthLabel(r.base.month))),
                E('div', { key: r.p.months + 'd', style: { fontSize: 13, color: c, textAlign: 'right', whiteSpace: 'nowrap', filter: props.privacy ? 'blur(6px)' : 'none' } }, fmtSigned(r.d)),
                E('div', { key: r.p.months + 'p', style: { fontSize: 13, color: c, textAlign: 'right', whiteSpace: 'nowrap', minWidth: 54 } }, fmtPct(pctChange(latest[props.field], r.base[props.field])))
            ];
        })
    );
}

function Hero(props) {
    var ui = useUI();
    var s = props.series, latest = s[s.length - 1];
    return E('div', { style: cardStyle(ui, { borderRadius: 20, padding: '18px 20px', marginBottom: 12 }) },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            E('span', { style: capsLabel(ui) }, 'Total wealth'),
            E('span', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc600 } }, 'As at ' + dayLabel(latest.date))
        ),
        E('div', { style: moneyStyle(ui, 32, props.privacy) }, props.privacy ? '£ •••,•••' : fmtGBP(latest.total)),
        E(ChangeTable, { series: s, field: 'total', privacy: props.privacy }),
        E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 14, paddingTop: 12 } },
            // Same layout as Total wealth above (label, then the figure on the left), like the Investments hero.
            E('div', { style: Object.assign({}, capsLabel(ui), { display: 'block', marginBottom: 10 }) }, 'Liquid wealth'),
            E('div', { style: moneyStyle(ui, 26, props.privacy) }, props.privacy ? '£ ••,•••' : fmtGBP(latest.liquid)),
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
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? ui.C.white : ui.C.zinc600, cursor: 'pointer', whiteSpace: 'nowrap' }
            }, o.label);
        })
    );
}

var RANGES = [{ id: '1Y', label: '1Y', months: 12 }, { id: '3Y', label: '3Y', months: 36 }, { id: 'ALL', label: 'All', months: null }];
var CMP_MODES = [{ id: 'prev', label: 'Month before' }, { id: 'start', label: 'From start' }, { id: 'custom', label: 'Custom' }];
var LINE_COLS = ['#60a5fa', '#f472b6', '#fbbf24'];

// Change between two points, split into building blocks: per group and, within each group, per account. Built from the
// accounts (share applied; for Liquid only liquid accounts), so the blocks always add up exactly to the change shown.
function breakdown(base, focus, accounts, metric) {
    var groups = {};
    accounts.forEach(function (a) {
        if (metric === 'liquid' && !isLiquid(a)) return;
        var v0 = (base.values[a.id] || 0) * (a.share || 1), v1 = (focus.values[a.id] || 0) * (a.share || 1);
        if (!v0 && !v1) return;
        var c = cardId(a);
        var g = groups[c] || (groups[c] = { id: c, d: 0, v: 0, accounts: [] });
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
// 'a:<id>' is a single account (e.g. just the mortgage), drawn on its own.
function groupValue(p, gid, accounts, metric) {
    var t = 0, one = gid.slice(0, 2) === 'a:' ? gid.slice(2) : null;
    accounts.forEach(function (a) {
        if ((one ? a.id !== one : cardId(a) !== gid) || (metric === 'liquid' && !isLiquid(a))) return;
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
    var rState = React.useState('3Y'), range = rState[0];
    var hState = React.useState(null), scrub = hState[0], setScrub = hState[1];          // month under the finger
    var pState = React.useState(null), pin = pState[0], setPin = pState[1];               // last month lifted on
    var ppState = React.useState(null), prevPin = ppState[0], setPrevPin = ppState[1];    // the one before (Two months)
    var cState = React.useState('prev'), cmp = cState[0], setCmp = cState[1];
    var sState = React.useState([]), sel = sState[0], setSel = sState[1];                // groups drawn as lines
    var oState = React.useState(null), openGroup = oState[0], setOpenGroup = oState[1];
    var aState = React.useState(false), analysing = aState[0], setAnalysing = aState[1];   // breakdown panel open (Analyse)
    var all = props.series;
    var last = all[all.length - 1];
    var r = RANGES.find(function (x) { return x.id === range; });
    var pts = r.months == null ? all : all.filter(function (p) { return monthIndex(p.month) >= monthIndex(last.month) - r.months; });
    var byMonth = {};
    all.forEach(function (p, i) { byMonth[p.month] = i; });
    function inRange(mk) { return mk && pts.some(function (p) { return p.month === mk; }); }

    // Focus = the month under the finger, else the pinned month, else the latest. Base depends on the compare mode.
    var focus = all[byMonth[scrub]] || (inRange(pin) ? all[byMonth[pin]] : null) || pts[pts.length - 1];
    // With the panel closed the reading is simply from the start of the window, as before Analyse existed.
    var mode = analysing ? cmp : 'start';
    var base = null, waiting = false;
    if (mode === 'start') base = pts[0];
    else if (mode === 'custom') {
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
    // The scale fits the data in range, so changes are visible (Fergus, PR #51: a £0 floor flattened the line). It
    // takes in £0 only when the data crosses it, and the headroom never pushes it past £0 on a one-sided chart.
    var dLo = Math.min.apply(null, vals), dHi = Math.max.apply(null, vals);
    var pad = Math.max((dHi - dLo) * 0.08, Math.abs(dHi) * 0.01, 1);
    var lo = dLo - pad, hi = dHi + pad;
    if (dLo >= 0 && lo < 0) lo = 0;
    if (dHi <= 0 && hi > 0) hi = 0;
    var crosses = lo < 0 && hi > 0;
    var t0 = monthIndex(pts[0].month), t1 = monthIndex(pts[pts.length - 1].month);
    var x = function (p) { return t1 === t0 ? plotW / 2 : ((monthIndex(p.month) - t0) / (t1 - t0)) * plotW; };
    var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB); };
    var pathFor = function (l) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + x(p).toFixed(1) + ' ' + y(l.val(p)).toFixed(1); }).join(' '); };
    var up = pts[pts.length - 1][metric] >= pts[0][metric];
    var color = up ? ui.C.emerald : ui.C.rose;
    lines.forEach(function (l) { if (!l.color) l.color = color; });
    var mainLine = pathFor(lines[0]);
    // The area fills down to £0 when it is on the chart, else to the bottom edge.
    var y0 = y(crosses ? 0 : lo).toFixed(1);
    var area = !sel.length && (mainLine + ' L' + x(pts[pts.length - 1]).toFixed(1) + ' ' + y0 + ' L' + x(pts[0]).toFixed(1) + ' ' + y0 + ' Z');
    // Grid: the top, middle and bottom of the data, and £0 when the data crosses it (a line too close to another is left out).
    var ticks = [], span = hi - lo;
    (crosses ? [0] : []).concat([dHi, dLo, (dHi + dLo) / 2]).forEach(function (v) {
        if (ticks.every(function (t) { return Math.abs(t - v) > span * 0.12; })) ticks.push(v);
    });
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
        if (!analysing) { setScrub(null); return; }   // closed: the reading follows the finger only
        if (scrub !== pin) { setPrevPin(pin); setPin(scrub); }
        setScrub(null);
    }
    function reset() { setScrub(null); setPin(null); setPrevPin(null); setOpenGroup(null); }
    function closePanel() { reset(); setSel([]); setCmp('prev'); setAnalysing(false); }
    function lineLabel(gid) {
        if (gid.slice(0, 2) === 'a:') { var a = accounts.filter(function (x) { return x.id === gid.slice(2); })[0]; return a ? a.name : ''; }
        return CARD_BY_ID[gid] && CARD_BY_ID[gid].short || cardLabel(gid).split(' ')[0];
    }
    function toggleSel(gid) {
        setSel(sel.indexOf(gid) >= 0 ? sel.filter(function (g) { return g !== gid; }) : sel.concat([gid]).slice(-3));
    }

    var change = to[metric] - (from ? from[metric] : to[metric]);
    var marked = focus !== pts[pts.length - 1] || scrub || pin;
    var blur = props.privacy ? 'blur(6px)' : 'none';
    var maxAbs = bd ? Math.max.apply(null, bd.rows.map(function (g) { return Math.abs(g.d); }).concat([1])) : 1;

    return E('div', { style: cardStyle(ui, { borderRadius: 20, padding: '16px 18px 12px', marginBottom: 12 }) },
        E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 } },
            E(Segmented, { options: [{ id: 'total', label: 'Total' }, { id: 'liquid', label: 'Liquid' }], value: metric, onChange: function (v) { mState[1](v); } }),
            E(Segmented, { options: RANGES, value: range, onChange: function (v) { rState[1](v); reset(); } })
        ),
        // Reading of the chart: the focus month's figure (or each drawn group's), and its change from the base.
        E('div', { style: { display: 'flex', alignItems: 'baseline', columnGap: 8, flexWrap: 'wrap', minHeight: 20, fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
            E('span', { style: { fontSize: 12, color: ui.C.zinc500 } }, !analysing && !scrub ? 'Since ' + monthLabel(pts[0].month) : monthLabel(focus.month)),
            sel.length
                ? lines.map(function (l) {
                    return E('span', { key: l.gid, style: { fontSize: 12, color: l.color, filter: blur } }, lineLabel(l.gid) + ' ' + fmtGBP(l.val(focus)));
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
                        E('line', { x1: 0, x2: plotW, y1: y(v), y2: y(v), stroke: v === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.06)', strokeWidth: 1 }),
                        E('text', { x: W - 2, y: y(v), textAnchor: 'end', dominantBaseline: 'middle', fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.rounded },
                            props.privacy ? '' : kLabel(v)));
                }),
                // The compared period, shaded.
                analysing && from && E('rect', { x: x(from), y: padT, width: Math.max(1, x(to) - x(from)), height: H - padT - padB, fill: 'rgba(255,255,255,0.05)' }),
                area && E('path', { d: area, fill: 'url(#bal-area)' }),
                lines.map(function (l) {
                    return E('path', { key: l.gid || 'main', d: pathFor(l), fill: 'none', stroke: l.color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' });
                }),
                E('text', { x: 0, y: H - 6, fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.sys }, firstYear),
                lastYear !== firstYear && E('text', { x: plotW, y: H - 6, textAnchor: 'end', fill: ui.C.zinc700, fontSize: 10, fontFamily: ui.sys }, lastYear),
                analysing && from && E('line', { x1: x(from), x2: x(from), y1: padT, y2: H - padB, stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1, strokeDasharray: '3 3' }),
                marked && E('g', null,
                    E('line', { x1: x(focus), x2: x(focus), y1: padT, y2: H - padB, stroke: 'rgba(255,255,255,0.35)', strokeWidth: 1 }),
                    lines.map(function (l) {
                        return E('circle', { key: l.gid || 'main', cx: x(focus), cy: y(l.val(focus)), r: 4, fill: l.color, stroke: ui.C.bg, strokeWidth: 2 });
                    }))
            )
        ),
        // Analyse opens the building blocks under the chart (like the Investments tab); the x closes them again.
        !analysing && E('div', { style: { display: 'flex', marginTop: 4, marginBottom: 2 } },
            E('button', { onClick: function () { setAnalysing(true); },
                style: { fontFamily: ui.sys, fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: '1px solid ' + ui.C.border,
                         background: 'transparent', color: ui.C.zinc400, cursor: 'pointer' } }, 'Analyse')),
        // Building blocks for the compared period.
        analysing && E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 6, paddingTop: 10 } },
            E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
                E(Segmented, { options: CMP_MODES, value: cmp, onChange: function (v) { setCmp(v); } }),
                E('span', { style: { flex: 1 } }),
                E('button', { onClick: closePanel, 'aria-label': 'Close analysis',
                    style: { width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 14,
                             border: '1px solid ' + ui.C.border, background: 'transparent', color: ui.C.zinc400, cursor: 'pointer', padding: 0 } },
                    E(CloseIcon, { style: { width: 14, height: 14 }, strokeWidth: 2 }))
            ),
            waiting && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, marginBottom: 6 } }, 'Tap another month on the chart to compare it with the one marked.'),
            from ? E('div', null,
                E('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4, fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
                    E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500 } }, monthLabel(from.month) + ' → ' + monthLabel(to.month),
                        (pin || sel.length) ? E('button', { onClick: function () { reset(); setSel([]); }, style: { background: 'none', border: 'none', color: ui.C.blue, fontFamily: ui.sys, fontSize: 12, padding: '0 0 0 10px', cursor: 'pointer' } }, 'Clear') : null),
                    E('span', { style: { fontSize: 13, color: signColor(ui, bd.total), filter: blur } }, fmtSigned(bd.total))),
                bd.rows.map(function (g, i) {
                    var on = sel.indexOf(g.id) >= 0, isOpen = openGroup === g.id;
                    var col = on ? LINE_COLS[sel.indexOf(g.id) % LINE_COLS.length] : null;
                    return E('div', { key: g.id, style: { borderTop: i ? '1px solid ' + ui.C.border : 'none' } },
                        E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0' } },
                            // Dot: draws (or removes) this group's own line on the chart.
                            E('button', { onClick: function () { toggleSel(g.id); }, 'aria-label': 'Draw ' + cardLabel(g.id),
                                style: { width: 22, height: 22, flexShrink: 0, borderRadius: 11, border: '1px solid ' + (col || ui.C.border), background: col || 'transparent', cursor: 'pointer', padding: 0 } }),
                            E('button', { onClick: function () { setOpenGroup(isOpen ? null : g.id); },
                                style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' } },
                                E('span', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, cardLabel(g.id)),
                                // Bar sized against the largest block.
                                E('span', { style: { width: 54, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.05)', position: 'relative', flexShrink: 0 } },
                                    E('span', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: 3, width: Math.round(Math.abs(g.d) / maxAbs * 100) + '%', background: signColor(ui, g.d), opacity: 0.7 } })),
                                E('span', { style: { fontFamily: ui.rounded, fontSize: 13, color: signColor(ui, g.d), fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'right', filter: blur } }, fmtSigned(g.d)),
                                E(ChevronIcon, { style: { width: 12, height: 12, color: ui.C.zinc700, flexShrink: 0, transform: isOpen ? 'rotate(90deg)' : 'none' }, strokeWidth: 2 }))),
                        isOpen && E('div', { style: { padding: '0 0 6px 4px' } },
                            g.accounts.map(function (r) {
                                // Each account has its own small dot too, to draw just that account (Fergus: just the mortgage, just the car).
                                var aid = 'a:' + r.a.id, aOn = sel.indexOf(aid) >= 0, aCol = aOn ? LINE_COLS[sel.indexOf(aid) % LINE_COLS.length] : null;
                                return E('div', { key: r.a.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' } },
                                    E('button', { onClick: function () { toggleSel(aid); }, 'aria-label': 'Draw ' + r.a.name,
                                        style: { width: 14, height: 14, flexShrink: 0, borderRadius: 7, border: '1px solid ' + (aCol || ui.C.border), background: aCol || 'transparent', cursor: 'pointer', padding: 0, marginRight: 4 } }),
                                    E('span', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.a.name),
                                    E('span', { style: { fontSize: 12, color: signColor(ui, r.d), filter: blur } }, fmtSigned(r.d)),
                                    E('span', { style: { fontSize: 12, color: ui.C.zinc400, minWidth: 70, textAlign: 'right', filter: blur } }, fmtGBP(r.v)));
                            })));
                })
            ) : E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600 } }, 'Nothing earlier to compare with.'),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.4 } },
                'Press and drag on the chart to read any month; lift to keep it. Tap a dot to draw that group’s or account’s own line.')
        )
    );
}

function GroupCard(props) {
    var ui = useUI();
    var g = props.group, latest = props.latest, prev = props.prev;
    var open = React.useState(false);
    var now = latest.groups[g.id] || 0;
    // Change against 1, 6 and 12 months earlier, in one row of three under the header (same periods as the hero).
    var changes = PERIODS.map(function (p) {
        var base = pointMonthsBack(props.series, latest, p.months);
        var b = base ? (base.groups[g.id] || 0) : null;
        return { p: p, base: base, d: b == null ? null : now - b, pct: b == null ? null : pctChange(now, b) };
    });
    var rows = props.accounts.filter(function (a) { return cardId(a) === g.id && (!a.closed || latest.values[a.id] != null); })
        .sort(function (x, y) { return g.groups.indexOf(x.group) - g.groups.indexOf(y.group); });   // current accounts, then cards
    var blur = props.privacy ? 'blur(6px)' : 'none';
    return E('div', { style: cardStyle(ui, { borderRadius: 20, padding: 0 }) },
        E('button', {
            onClick: function () { open[1](!open[0]); },
            style: { width: '100%', background: 'none', border: 'none', padding: '12px 14px 10px 16px', display: 'block', cursor: 'pointer', textAlign: 'left' }
        },
          E('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            E('div', { style: { flex: 1, minWidth: 0 } },
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, fontWeight: 600 } }, g.label),
                E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 1 } },
                    rows.length + (rows.length === 1 ? ' account' : ' accounts'))
            ),
            E('div', { style: moneyStyle(ui, 17, props.privacy, now < 0 ? ui.C.rose : ui.C.white) }, fmtGBP(now)),
            E(ChevronIcon, { style: { width: 14, height: 14, color: ui.C.zinc700, transform: open[0] ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }, strokeWidth: 2 })
          ),
          // One row: vs 1m / 6m / 1y, each with £ and %. A period with no entry that far back shows a dash.
          E('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 8, marginTop: 7, paddingTop: 7, borderTop: '1px solid ' + ui.C.border,
                               fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
              changes.map(function (c) {
                  var col = c.d == null ? ui.C.zinc700 : signColor(ui, c.d);
                  // Two short lines so the full figures fit on a narrow phone: the £ change, then "1m  +2.3%".
                  return E('div', { key: c.p.months, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: col } },
                      E('div', { style: { fontSize: 12, filter: blur, overflow: 'hidden', textOverflow: 'ellipsis' } }, c.d == null ? '—' : fmtSigned(c.d)),
                      E('div', { style: { fontSize: 10, marginTop: 1 } },
                          E('span', { style: { fontFamily: ui.sys, color: ui.C.zinc600, marginRight: 5 } }, 'vs ' + (c.p.months === 12 ? '1y' : c.p.months + 'm')),
                          c.d == null ? '' : fmtPct(c.pct)));
              }))
        ),
        open[0] && E('div', { style: { borderTop: '1px solid ' + ui.C.border, padding: '6px 16px 10px' } },
            prev && E('div', { style: { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc700, textAlign: 'right', paddingTop: 4, paddingRight: 84, letterSpacing: '0.04em' } },
                'vs ' + monthLabel(prev.month)),
            (function () {
            // Tags sit in their own column just before the change, so LIVE / FORMULA line up down the card (Fergus asked).
            function tagOf(a) { return a.closed ? null : a.appLinks.length ? 'LIVE' : (a.growth != null || loanReady(a.loan) || assetReady(a.asset)) ? 'FORMULA' : null; }
            var anyTag = rows.some(tagOf);
            return rows.map(function (a) {
                var v = latest.values[a.id] || 0, pv = prev ? (prev.values[a.id] || 0) : null;
                var shareNote = (isLiquid(a) !== !!g.liquid ? (isLiquid(a) ? ' · liquid' : ' · not liquid') : '');
                // Tag like LIVE: the value follows the Investments tab (LIVE) or is worked out from a rate or loan terms (FORMULA).
                var tag = tagOf(a);
                return E('div', { key: a.id, style: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 0' } },
                    E('div', { style: { flex: 1, minWidth: 0, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        a.name, E('span', { style: { color: ui.C.zinc700, fontSize: 11 } }, shareNote)),
                    anyTag && E('span', { style: { fontFamily: ui.sys, color: ui.C.blue, fontSize: 10, width: 48, flexShrink: 0, textAlign: 'left', letterSpacing: '0.02em' } }, tag || ''),
                    pv != null && E('span', { style: { fontFamily: ui.rounded, fontSize: 11, color: signColor(ui, v - pv), filter: blur, fontVariantNumeric: 'tabular-nums', minWidth: 58, flexShrink: 0, textAlign: 'right' } }, fmtSigned(v - pv)),
                    E('span', { style: { fontFamily: ui.rounded, fontSize: 13, color: v < 0 ? ui.C.rose : ui.C.white, filter: blur, fontVariantNumeric: 'tabular-nums', minWidth: 76, flexShrink: 0, textAlign: 'right' } }, fmtGBP(v))
                );
            });
            })()
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
    return E('div', { style: { padding: '12px 16px 0' } },
        latest ? E(Hero, { series: series, privacy: props.privacy })
               : E('div', { style: cardStyle(ui, { marginBottom: 12, fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 }) }, 'No balances entered yet. Tap Update balances to add this month’s.'),
        series.length > 1 && E(Chart, { series: series, accounts: state.accounts, privacy: props.privacy }),
        latest && E('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 14 } },
            CARDS.filter(function (g) {
                return state.accounts.some(function (a) { return cardId(a) === g.id && (!a.closed || latest.values[a.id] != null); });
            }).map(function (g) {
                return E(GroupCard, { key: g.id, group: g, series: series, latest: latest, prev: prev, accounts: state.accounts, privacy: props.privacy });
            })
        ),
        E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', fontSize: 15 }), onClick: props.onUpdate }, 'Update balances'),
        // Import, export, the backup reminder and Delete live in Settings → Estate (Fergus asked).
        stale && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, textAlign: 'center', marginTop: 10, lineHeight: 1.4 } },
            'Last exported ' + relTime(state.lastExportAt) + '. Export a backup from Settings → Estate.')
    );
}

// ── Update form ──────────────────────────────────────────────────────────────
function amountText(v) { return v == null ? '' : String(Math.round(Math.abs(v) * 100) / 100); }

// House or car: the purchase (date, price paid, yearly rise or fall) and any later valuations, each with the rate it
// rises or falls at until the next. Rises / Falls is a switch because the iPhone decimal keypad has no minus sign.
function AssetFields(props) {
    var ui = useUI();
    var a = props.a, x = a.asset || { valuations: [] };
    var rateDraft = function (r, dflt) { return { falls: r != null ? r < 0 : dflt, pct: r != null ? String(Math.abs(r)) : '' }; };
    var isCar = /car|vehicle/i.test(a.name);
    var st = React.useState(function () {
        return { bought: x.bought || '', price: x.price != null ? String(x.price) : '', rate: rateDraft(x.rate != null ? x.rate : a.growth, isCar),
                 vals: (x.valuations || []).map(function (v) { return { date: v.date, value: String(v.value) }; }) };
    });
    var f = st[0];
    var num = function (t) { var n = Number(String(t).replace(/[£,%\s]/g, '')); return t === '' || isNaN(n) ? null : n; };
    var rateOf = function (r) { var n = num(r.pct); return n == null ? null : (r.falls ? -Math.abs(n) : Math.abs(n)); };
    var toAsset = function (d) {
        return validAsset({ bought: d.bought, price: num(d.price), rate: rateOf(d.rate),
            valuations: d.vals.map(function (v) { return { date: v.date, value: num(v.value) }; }) });
    };
    function update(next) {
        st[1](next);
        var asset = toAsset(next);
        props.onChange({ asset: asset, growth: asset && assetReady(asset) ? assetRate(asset) : rateOf(next.rate) });
    }
    function setTop(k, v) { var n = Object.assign({}, f); n[k] = v; update(n); }
    function setVal(i, k, v) { var n = Object.assign({}, f, { vals: f.vals.slice() }); n.vals[i] = Object.assign({}, n.vals[i]); n.vals[i][k] = v; update(n); }
    function addVal() {
        var cur = toAsset(f), today = todayISO();
        var guess = cur && assetReady(cur) ? assetValue(cur, today) : null;
        update(Object.assign({}, f, { vals: f.vals.concat([{ date: today, value: guess != null ? String(Math.round(guess)) : '' }]) }));
    }
    function removeVal(i) { update(Object.assign({}, f, { vals: f.vals.filter(function (_, k) { return k !== i; }) })); }

    var lab = function (t) { return E('span', { style: { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc600, letterSpacing: '0.04em' } }, t); };
    var input = function (value, onChange, extra) { return fieldInput(ui, value, onChange, extra); };
    var cell = function (t, el) { return E('label', { style: { display: 'block', minWidth: 0 } }, lab(t), el); };
    var grid = function (kids) { return E('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: 10, rowGap: 8 } }, kids); };
    var rateCells = function (r, onChange, label) {
        return [
            cell(label, E('div', { key: 's', style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2 } },
                [['Rises', false], ['Falls', true]].map(function (o) {
                    var on = r.falls === o[1];
                    return E('button', { key: o[0], type: 'button', onClick: function () { onChange(Object.assign({}, r, { falls: o[1] })); },
                        style: { flex: 1, border: 'none', borderRadius: 7, padding: '6px 0', fontFamily: ui.sys, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                 background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? (o[1] ? ui.C.rose : ui.C.emerald) : ui.C.zinc600 } }, o[0]);
                }))),
            cell('By % a year', input(r.pct, function (v) { onChange(Object.assign({}, r, { pct: v })); }, { inputMode: 'decimal', placeholder: r.falls ? '13' : '1' }))
        ];
    };
    var asset = toAsset(f), ready = assetReady(asset);
    var nowV = ready ? assetValue(asset, todayISO()) : null, rNow = ready ? assetRate(asset) : null;
    var blur = props.privacy ? 'blur(6px)' : 'none';
    return E('div', { style: { marginTop: 6 } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ready ? ui.C.blue : ui.C.zinc700, marginBottom: 4 } },
            ready ? E('span', null, 'Today ', E('span', { style: { filter: blur } }, fmtGBP(nowV)),
                      rNow ? ', ' + (rNow < 0 ? 'falling ' : 'rising ') + Math.abs(rNow) + '% a year from the ' + (asset.valuations.some(function (v) { return v.date > asset.bought; }) ? 'latest valuation' : 'price paid') : '',
                      asset.valuations.length ? '; straight line between valuations' : '')
                  : 'Add when it was bought and the price paid to keep it up to date:'),
        grid([cell('Bought on', input(f.bought, function (v) { setTop('bought', v); }, { type: 'date' })),
              cell('Price paid £', input(f.price, function (v) { setTop('price', v); }, { inputMode: 'decimal', placeholder: '0' }))]),
        f.vals.map(function (v, i) {
            return E('div', { key: i, style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed ' + ui.C.border } },
                E('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
                    E('span', { style: { flex: 1, fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc400, fontWeight: 600 } }, 'Valuation ' + (i + 1)),
                    E('button', { type: 'button', onClick: function () { removeVal(i); }, style: { background: 'none', border: 'none', color: ui.C.rose, fontFamily: ui.sys, fontSize: 12, padding: 0, cursor: 'pointer' } }, 'Remove')),
                grid([cell('Valued on', input(v.date, function (d) { setVal(i, 'date', d); }, { type: 'date' })),
                      cell('Valued at £', input(v.value, function (d) { setVal(i, 'value', d); }, { inputMode: 'decimal', placeholder: '0' }))]));
        }),
        ready && E('button', { type: 'button', onClick: addVal,
            style: { marginTop: 8, background: 'none', border: '1px dashed ' + ui.C.border, borderRadius: 8, width: '100%', padding: '7px 0', color: ui.C.blue, fontFamily: ui.sys, fontSize: 12, cursor: 'pointer' } },
            '+ Add a valuation'),
        // One rate: it runs on from the latest valuation (or the price paid, before any).
        E('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed ' + ui.C.border } },
            grid(rateCells(f.rate, function (r) { setTop('rate', r); }, f.vals.length ? 'After the latest, each year it' : 'Each year it'))));
}

// Mortgage (Fergus): the amount borrowed, the balance at each remortgage, then the current deal (its starting balance,
// rate, payment, start and end). Straight lines between the earlier points; the current deal works itself down.
function LoanFields(props) {
    var ui = useUI();
    var a = props.a, l = a.loan || {};
    var str = function (v) { return v != null ? String(v) : ''; };
    var st = React.useState(function () {
        return { rate: l.rate != null ? String(l.rate) : (a.rate != null ? String(pctFromSheet(a.rate)) : ''), payment: str(l.payment),
                 start: l.start || '', end: l.end || '', balance: str(l.balance), drawn: l.drawn || '', amount: str(l.amount),
                 pts: (l.points || []).map(function (p) { return { date: p.date, value: String(p.value) }; }) };
    });
    var f = st[0];
    var num = function (t) { var n = Number(String(t).replace(/[£,%\s]/g, '')); return t === '' || isNaN(n) ? null : n; };
    var toLoan = function (d) {
        return validLoan({ rate: num(d.rate), payment: num(d.payment), start: d.start, end: d.end, balance: num(d.balance),
            drawn: d.drawn, amount: num(d.amount), points: d.pts.map(function (p) { return { date: p.date, value: num(p.value) }; }) });
    };
    function update(next) { st[1](next); props.onChange(toLoan(next)); }
    function set(k, v) { var n = Object.assign({}, f); n[k] = v; update(n); }
    function setPt(i, k, v) { var n = Object.assign({}, f, { pts: f.pts.slice() }); n.pts[i] = Object.assign({}, n.pts[i]); n.pts[i][k] = v; update(n); }
    function addPt() { update(Object.assign({}, f, { pts: f.pts.concat([{ date: '', value: '' }]) })); }
    function removePt(i) { update(Object.assign({}, f, { pts: f.pts.filter(function (_, k) { return k !== i; }) })); }
    var loan = toLoan(f), ready = loanReady(loan), formula = loanFormula(loan);
    var lab = function (t) { return E('span', { style: { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc600, letterSpacing: '0.04em' } }, t); };
    var input = function (value, onChange, extra) { return fieldInput(ui, value, onChange, extra); };
    var cell = function (t, el) { return E('label', { style: { display: 'block', minWidth: 0 } }, lab(t), el); };
    var grid = function (kids) { return E('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', columnGap: 10, rowGap: 8 } }, kids); };
    var head = function (t, extra) {
        return E('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
            E('span', { style: { flex: 1, fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc400, fontWeight: 600 } }, t), extra || null);
    };
    var section = function (key, kids) { return E('div', { key: key, style: { marginTop: 8, paddingTop: 8, borderTop: '1px dashed ' + ui.C.border } }, kids); };
    var blur = props.privacy ? 'blur(6px)' : 'none';
    var nowOwed = formula ? loanOwed(loan, todayISO()) : null;
    return E('div', { style: { marginTop: 6 } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ready ? ui.C.blue : ui.C.zinc700, marginBottom: 4 } },
            formula ? E('span', null, 'Owed today ', E('span', { style: { filter: blur } }, fmtGBP(nowOwed)),
                        ', down £' + loan.payment.toLocaleString('en-GB') + ' a month at ' + loan.rate + '% until ' + monthLabel(loan.end.slice(0, 7)),
                        loanPoints(loan).length > 1 ? '; straight line before this deal' : '')
            : ready ? 'Add the balance when this deal started to work it out from these terms alone:'
            : 'Add the mortgage below to keep it up to date:'),
        head('When you bought'),
        grid([cell('Borrowed on', input(f.drawn, function (v) { set('drawn', v); }, { type: 'date' })),
              cell('Amount borrowed £', input(f.amount, function (v) { set('amount', v); }, { inputMode: 'decimal', placeholder: '0' }))]),
        f.pts.map(function (p, i) {
            return section(i, [
                head('Remortgage ' + (i + 1), E('button', { type: 'button', onClick: function () { removePt(i); }, style: { background: 'none', border: 'none', color: ui.C.rose, fontFamily: ui.sys, fontSize: 12, padding: 0, cursor: 'pointer' } }, 'Remove')),
                grid([cell('Started on', input(p.date, function (v) { setPt(i, 'date', v); }, { type: 'date' })),
                      cell('Balance then £', input(p.value, function (v) { setPt(i, 'value', v); }, { inputMode: 'decimal', placeholder: '0' }))])]);
        }),
        E('button', { type: 'button', onClick: addPt,
            style: { marginTop: 8, background: 'none', border: '1px dashed ' + ui.C.border, borderRadius: 8, width: '100%', padding: '7px 0', color: ui.C.blue, fontFamily: ui.sys, fontSize: 12, cursor: 'pointer' } },
            '+ Add an earlier remortgage'),
        section('deal', [
            head('Current deal'),
            grid([cell('Started on', input(f.start, function (v) { set('start', v); }, { type: 'date' })),
                  cell('Balance then £', input(f.balance, function (v) { set('balance', v); }, { inputMode: 'decimal', placeholder: '0' })),
                  cell('Interest rate %', input(f.rate, function (v) { set('rate', v); }, { inputMode: 'decimal', placeholder: '4.5' })),
                  cell('Monthly payment £', input(f.payment, function (v) { set('payment', v); }, { inputMode: 'decimal', placeholder: '1,200' })),
                  cell('Ends on', input(f.end, function (v) { set('end', v); }, { type: 'date' }))])]));
}

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
            if (assetReady(a.asset) || loanFormula(a.loan)) return;   // worked out from its purchase / loan points
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
                                        assetReady(a.asset) ? E('div', { style: { fontSize: 11, color: ui.C.zinc700, marginTop: 1 } }, 'From its purchase and valuations')
                                        : loanFormula(a.loan) ? E('div', { style: { fontSize: 11, color: ui.C.zinc700, marginTop: 1 } }, 'Worked out below')
                                        : current.asOf[a.id] && E('div', { style: { fontSize: 11, color: amounts[a.id] !== initial[a.id] ? ui.C.amber : ui.C.zinc700, marginTop: 1 } },
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
                                        assetReady(a.asset)
                                            // House or car with a purchase: worked out from its valuations below, so not typed in.
                                            ? E('div', { style: { width: 116, textAlign: 'right', fontFamily: ui.rounded, fontSize: 15, color: ui.C.blue, padding: '9px 0', fontVariantNumeric: 'tabular-nums', filter: props.privacy ? 'blur(6px)' : 'none' } }, Math.round(assetValue(a.asset, date) || 0).toLocaleString('en-GB'))
                                            : loanFormula(a.loan)
                                            // Mortgage with its current deal's balance: worked out from the loan details, so not typed in.
                                            ? E('div', { style: { width: 116, textAlign: 'right', fontFamily: ui.rounded, fontSize: 15, color: ui.C.blue, padding: '9px 0', fontVariantNumeric: 'tabular-nums', filter: props.privacy ? 'blur(6px)' : 'none' } }, Math.round(loanOwed(a.loan, date) || 0).toLocaleString('en-GB'))
                                            : linked
                                            // Linked: the value comes from the Investments tab and keeps updating, so it isn't typed in.
                                            ? E('div', { style: { width: 116, textAlign: 'right', fontFamily: ui.rounded, fontSize: 15, color: ui.C.blue, padding: '9px 0', fontVariantNumeric: 'tabular-nums', filter: props.privacy ? 'blur(6px)' : 'none' } }, Math.abs(linked.value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
                                            : E('input', {
                                            inputMode: 'decimal', value: amounts[a.id] || '', placeholder: '0',
                                            onChange: function (e) { var o = Object.assign({}, amounts); o[a.id] = e.target.value; setAmounts(o); },
                                            style: inputStyle(ui, { width: 116, textAlign: 'right', filter: props.privacy ? 'blur(6px)' : 'none' })
                                        }))
                            ),
                            // House and car: the purchase and any later valuations, each with its yearly rise or fall.
                            !manage[0] && g.id === 'property' && !a.debt && E(AssetFields, { a: a, privacy: props.privacy,
                                onChange: function (patch) { patchAccount(a.id, patch); } }),
                            // Mortgage: its terms, so the amount owed works itself down between the balances you enter.
                            !manage[0] && g.id === 'property' && a.debt && E(LoanFields, { a: a, privacy: props.privacy, onChange: function (loan) { patchAccount(a.id, { loan: loan }); } }),
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
    var vState = React.useState(function () { var v = _pendingView || 'main'; _pendingView = null; return v; }), view = vState[0], setView = vState[1];
    React.useEffect(function () {
        function onOpen() { if (_pendingView) { setView(_pendingView); _pendingView = null; } }
        window.addEventListener('estate-open-view', onOpen);
        return function () { window.removeEventListener('estate-open-view', onOpen); };
    }, []);
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
window.__balancesInternals = { applyLinked: applyLinked, parseJsonBackup: parseJsonBackup, buildJson: buildJson, parseImport: parseImport, importToState: importToState, runChecks: runChecks, buildSeries: buildSeries, parseAmount: parseAmount, buildCsv: buildCsv,
    resolveTimeline: resolveTimeline, totalsFor: totalsFor, indexAccounts: indexAccounts, withPartial: withPartial, liveLinked: liveLinked,
    grow: grow, payDown: payDown, loanOwed: loanOwed, assetValue: assetValue, validateState: validateState };
})();
