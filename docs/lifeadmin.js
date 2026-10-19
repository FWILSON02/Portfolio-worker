// ─── Life Admin screen (bills) ───────────────────────────────────────────────
// Monthly bills and outgoings: what each one is, who it's with, the account or policy number, the login, the website,
// when the contract ends and what it costs. Opened from the Life Admin tab in the app's top tab bar, drawn below that
// bar (its height comes from the --topbar-h CSS variable index.html publishes), like the Estate screen.
//
// Loaded by index.html as its own file after balances.js: <script src="lifeadmin.js?v=N">. Bump N there whenever this
// file changes, so the Home Screen app never pairs a new index.html with a cached old copy of this file.
//
// Exposes:
//   window.LifeAdminScreen — the Life Admin view (props: onClose, privacyMode, ui)
//   window.LifeAdminStore  — backupSnapshot() / restore(obj) for the app's JSON backup, plus get/subscribe/deleteAll
//   window.LifeAdminIcon   — the tab's icon
//
// Data lives in its own IndexedDB database ('portfolio-lifeadmin'). It goes into the app's backups (the cloud copy is
// encrypted on the phone before it is sent). Password hints never do: they come from the secrets file and stay in
// this browser (estate_login_hints, shared with the Estate tab). No bill is ever written into this file: the repo is public.
(function () {
'use strict';
var E = React.createElement;

// ── Categories and how often a bill is paid ──────────────────────────────────
var CATEGORIES = [
    { id: 'home',      label: 'Home',      color: '#2dd4bf' },
    { id: 'utilities', label: 'Utilities', color: '#60a5fa' },
    { id: 'insurance', label: 'Insurance', color: '#a78bfa' },
    { id: 'services',  label: 'Services',  color: '#fb923c' },
    { id: 'other',     label: 'Other',     color: '#9da5b4' },
];
var CATEGORY_BY_ID = {};
CATEGORIES.forEach(function (c) { CATEGORY_BY_ID[c.id] = c; });
function categoryOf(id) { return CATEGORY_BY_ID[id] || CATEGORY_BY_ID.other; }
// A pasted bill's category from its name.
function guessCategory(name) {
    var n = String(name || '').toLowerCase();
    if (/insur|cover|warranty|protect/.test(n)) return 'insurance';
    if (/mortgage|rent|council|service charge|ground rent/.test(n)) return 'home';
    if (/energy|gas|electric|water|internet|broadband|wifi|fibre|tv|licen[cs]e|phone|mobile|sim/.test(n)) return 'utilities';
    if (/clean|gardener|gym|subscription|netflix|spotify|nanny|childcare|window/.test(n)) return 'services';
    return 'other';
}

var EVERY = [
    { id: 'week',    label: 'Weekly',        per: 52, unit: 'a week' },
    { id: '2weeks',  label: 'Every 2 weeks', per: 26, unit: 'every 2 weeks' },
    { id: '4weeks',  label: 'Every 4 weeks', per: 13, unit: 'every 4 weeks' },
    { id: 'month',   label: 'Monthly',       per: 12, unit: 'a month' },
    { id: 'quarter', label: 'Quarterly',     per: 4,  unit: 'a quarter' },
    { id: 'year',    label: 'Yearly',        per: 1,  unit: 'a year' },
];
var EVERY_BY_ID = {};
EVERY.forEach(function (f) { EVERY_BY_ID[f.id] = f; });

// ── Store (IndexedDB, own database) ──────────────────────────────────────────
// state = { v: 1, bills: [Bill], updatedAt }
//   Bill = { id, name, provider, category, amount, every, account, username, link, end, notes, estate }
//          name:     what the bill is ('Energy', 'Council Tax').
//          amount:   £ paid each `every` (see EVERY); the monthly and yearly figures are worked out from it.
//          account:  account, customer or policy number.
//          username: the login name, or a reminder such as 'email'. The password hint is never stored here.
//          link:     the provider's website (https://) or an app address (scheme://); null = none.
//          end:      'YYYY-MM-DD' when the contract or policy ends or renews; null = rolling.
//          estate:   id of an Estate mortgage this bill follows: its monthly payment and deal end come from the Estate
//                    tab (Fergus asked), so the two can't disagree. amount, every and end are then ignored.
var DB_NAME = 'portfolio-lifeadmin';
var DB_STORE = 'kv';
var DB_KEY = 'state';
function emptyState() { return { v: 1, bills: [], updatedAt: null }; }

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
function text(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 120) : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
// A website or an app address. Script and data addresses are never kept, nor plain http. A bare 'example.co.uk' gets https://.
function validLink(v) {
    if (typeof v !== 'string') return null;
    var t = v.trim();
    if (!t) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(t) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) t = 'https://' + t;
    var m = /^([a-z][a-z0-9+.-]*):\/\/\S+$/i.exec(t);
    if (!m || t.length > 500 || /^(javascript|data|vbscript|file|blob|http)$/i.test(m[1])) return null;
    return t;
}
// Returns a cleaned bill, or null when it has no name.
function validBill(b) {
    if (!b || typeof b !== 'object') return null;
    var name = text(b.name, 80);
    if (!name) return null;
    var amount = typeof b.amount === 'number' && isFinite(b.amount) ? Math.round(Math.abs(b.amount) * 100) / 100 : null;
    return {
        id: text(b.id, 40) || newId(),
        name: name,
        provider: text(b.provider, 80),
        category: CATEGORY_BY_ID[b.category] ? b.category : guessCategory(name),
        amount: amount,
        every: EVERY_BY_ID[b.every] ? b.every : 'month',
        account: text(b.account, 80),
        username: text(b.username, 120),
        link: validLink(b.link),
        end: ISO_DATE.test(b.end || '') ? b.end : null,
        notes: text(b.notes, 500),
        estate: text(b.estate, 60) || null,
    };
}
// Returns a cleaned copy of a stored or restored state, or null when it is not a Life Admin state at all.
function validateState(s) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.bills)) return null;
    var seen = {}, bills = [];
    s.bills.forEach(function (b) {
        var c = validBill(b);
        if (!c) return;
        while (seen[c.id]) c.id = newId();
        seen[c.id] = true;
        bills.push(c);
    });
    return { v: 1, bills: bills, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : null };
}
var _idn = 0;
function newId() { return 'b' + Date.now().toString(36) + (_idn++).toString(36) + Math.random().toString(36).slice(2, 6); }

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

var LifeAdminStore = {
    ready: function () { return _loaded; },
    get: function () { return _state; },
    subscribe: function (fn) {
        _listeners.push(fn);
        return function () { _listeners = _listeners.filter(function (f) { return f !== fn; }); };
    },
    // Synchronous: the JSON backup is built inside the tap that opens the iOS share sheet. null = nothing to back up.
    backupSnapshot: function () { return _state.bills.length ? JSON.parse(JSON.stringify(_state)) : null; },
    // Replaces the bills with the ones from a backup. Returns false (and changes nothing) when invalid or empty.
    restore: function (obj) {
        var clean = validateState(obj);
        if (!clean || !clean.bills.length) return false;
        saveState(clean).catch(function () {});
        return true;
    },
    deleteAll: function () { return saveState(emptyState()); },
};

function useStoreState() {
    var st = React.useState(0);
    React.useEffect(function () { return LifeAdminStore.subscribe(function () { st[1](function (n) { return n + 1; }); }); }, []);
    return _state;
}
// The Estate state, re-read whenever it changes (the mortgage bill follows it).
function useEstateState() {
    var st = React.useState(0), store = window.BalancesStore;
    React.useEffect(function () { return store && store.subscribe ? store.subscribe(function () { st[1](function (n) { return n + 1; }); }) : undefined; }, [store]);
    return store && store.get ? store.get() : null;
}

// ── Calculations ─────────────────────────────────────────────────────────────
// Estate mortgages a bill can follow: open debts with a monthly payment.
function estateMortgages(estate) {
    return ((estate && estate.accounts) || []).filter(function (a) { return a && !a.closed && a.debt && a.loan && typeof a.loan.payment === 'number'; });
}
// A bill as shown: its yearly and monthly cost, with an Estate mortgage's payment and deal end in place of its own.
// fromEstate: the Estate account followed; missing: it follows one that is no longer there (or has no payment).
function resolveBill(b, estate) {
    var out = Object.assign({}, b, { fromEstate: null, missing: false });
    if (b.estate) {
        var a = estateMortgages(estate).filter(function (x) { return x.id === b.estate; })[0];
        if (a) {
            out.fromEstate = a;
            out.amount = Math.abs(a.loan.payment);
            out.every = 'month';
            out.end = a.loan.end || null;
            if (!out.provider) out.provider = a.name;
            if (!out.link && a.link) out.link = a.link;
        } else out.missing = true;
    }
    var per = (EVERY_BY_ID[out.every] || EVERY_BY_ID.month).per;
    out.annual = out.amount == null ? null : Math.round(out.amount * per * 100) / 100;
    out.monthly = out.annual == null ? null : out.annual / 12;
    return out;
}
function resolveAll(state, estate) { return ((state && state.bills) || []).map(function (b) { return resolveBill(b, estate); }); }
// Totals for the top card: per month and per year, and per category (biggest first).
function totals(bills) {
    var monthly = 0, annual = 0, by = {};
    bills.forEach(function (b) {
        if (b.annual == null) return;
        annual += b.annual; monthly += b.monthly;
        by[b.category] = (by[b.category] || 0) + b.monthly;
    });
    var cats = CATEGORIES.filter(function (c) { return by[c.id] > 0; })
        .map(function (c) { return { id: c.id, label: c.label, color: c.color, monthly: by[c.id], share: monthly ? by[c.id] / monthly : 0 }; })
        .sort(function (x, y) { return y.monthly - x.monthly; });
    return { monthly: monthly, annual: annual, count: bills.length, categories: cats };
}
var SORTS = [{ id: 'cost', label: 'Biggest' }, { id: 'renews', label: 'Renews' }, { id: 'name', label: 'A–Z' }];
function sortBills(bills, how) {
    var list = bills.slice();
    var byName = function (a, b) { return a.name.localeCompare(b.name); };
    if (how === 'name') return list.sort(byName);
    if (how === 'renews') return list.sort(function (a, b) {
        if (a.end && b.end) return a.end < b.end ? -1 : a.end > b.end ? 1 : byName(a, b);
        return a.end ? -1 : b.end ? 1 : byName(a, b);
    });
    return list.sort(function (a, b) { return (b.annual || 0) - (a.annual || 0) || byName(a, b); });
}

// Renewal alerts (the maturity banner from balances.js, kind 'renewal'): each bill's contract end. A bill that follows
// an Estate mortgage is left out: the Estate tab already alerts its deal end.
function renewalAlerts(bills, today, windows) {
    var ma = window.MaturityAlerts;
    if (!ma || !ma.make) return [];
    return ma.sort(bills.map(function (b) {
        if (!b.end || b.fromEstate || b.estate) return null;
        return ma.make({ kind: 'renewal', key: b.id, date: b.end,
            title: function (w, past) { return b.name + (past ? ' contract ended ' : ' contract ends ') + w; },
            parts: (b.provider ? [b.provider] : []).concat(b.annual != null ? [(b.provider ? ' · ' : ''), { gbp: b.annual }, ' a year'] : []) }, today, windows);
    }));
}

// ── Password hints (the secrets file; never stored with the bills) ───────────
var LOGIN_HINTS_KEY = 'estate_login_hints';
function hintName(n) { return String(n == null ? '' : n).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function loginHints() {
    try { var o = JSON.parse(localStorage.getItem(LOGIN_HINTS_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
// A bill's hint: by its provider ('hint: Brightwell'), else by its name ('hint: Energy').
function hintFor(hints, b) { return (b.provider && hints[hintName(b.provider)]) || hints[hintName(b.name)] || null; }
// Saves hints pasted with the bills, in the same place the secrets file puts them. A blank hint changes nothing.
function saveHints(list) {
    if (!list.length) return 0;
    var map = loginHints(), n = 0;
    list.forEach(function (h) { if (h.key && h.hint) { map[h.key] = h.hint.slice(0, 300); n++; } });
    try { localStorage.setItem(LOGIN_HINTS_KEY, JSON.stringify(map)); } catch (e) { return 0; }
    return n;
}

// ── Paste from a spreadsheet ─────────────────────────────────────────────────
// Rows copied out of Excel or Numbers arrive tab-separated. A header row names the columns; the first two unnamed ones
// are the bill and the provider (Fergus's Bills sheet has no heading over them). With no header, his sheet's order:
// bill, provider, account number, user name, contract end date, annual cost, monthly cost.
var HEADERS = {
    name:     /^(bill|bill type|type|item|what|outgoing|expense)$/,
    provider: /^(provider|company|supplier|who|with|lender|insurer)$/,
    account:  /^(account|account number|account no|acc no|policy|policy number|policy no|reference|ref|customer number|number)$/,
    username: /^(user name|username|user|login|log in|email)$/,
    hint:     /^(password hint|hint|password|login hint)$/,
    link:     /^(website|web site|link|url|site|web)$/,
    end:      /^(contract end date|contract end|end date|ends|end|renewal|renewal date|renews|expiry|expires)$/,
    annual:   /^(annual cost|annual|annual bill|yearly|per year|cost per year|year|yearly cost)$/,
    monthly:  /^(monthly cost|monthly|per month|month|monthly bill|cost)$/,
    notes:    /^(notes|note|comments|comment)$/,
};
var DEFAULT_ORDER = ['name', 'provider', 'account', 'username', 'end', 'annual', 'monthly'];
function headerKey(cell) {
    var c = String(cell || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    for (var k in HEADERS) if (HEADERS[k].test(c)) return k;
    return null;
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
function parseMoney(v) {
    var t = String(v == null ? '' : v).replace(/[£$€,\s]|Â/g, '');
    if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Math.round(Math.abs(Number(t)) * 100) / 100;
}
var MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function isoOf(y, m, d) {
    if (y < 100) y += 2000;
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? y + '-' + pad2(m) + '-' + pad2(d) : null;
}
// '31 December 2029', '31 Dec 2029', '31/12/2029' (UK order), '2029-12-31'. null when it isn't a date.
function parseDate(v) {
    var t = String(v == null ? '' : v).trim().toLowerCase();
    var m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) return isoOf(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(t))) return isoOf(+m[3], +m[2], +m[1]);
    if ((m = /^(?:[a-z]+,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})\.?,?\s+(\d{4})$/.exec(t))) {
        var mi = MONTH_NAMES.indexOf(m[2].slice(0, 3));
        return mi >= 0 ? isoOf(+m[3], mi + 1, +m[1]) : null;
    }
    return null;
}
// The amount and how often from the sheet's annual and monthly columns. When both are given, their ratio says how
// often it is really paid: the cleaner's £70 'monthly' against £1,820 a year is every 2 weeks.
function costFrom(annual, monthly) {
    if (monthly != null && annual != null && monthly > 0) {
        var r = annual / monthly;
        var match = EVERY.filter(function (f) { return Math.abs(r - f.per) <= f.per * 0.02; })[0];
        return match ? { amount: monthly, every: match.id } : { amount: annual, every: 'year' };
    }
    if (monthly != null) return { amount: monthly, every: 'month' };
    if (annual != null) return { amount: annual, every: 'year' };
    return { amount: null, every: 'month' };
}
// text → { rows: [{ bill, hint, estateName }], skipped } — skipped counts totals and other rows with no bill name.
function parsePaste(textIn, estate) {
    var rows = splitRows(textIn), out = { rows: [], skipped: 0 };
    if (!rows.length) return out;
    var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var cols = null, start = 0;
    var keys = rows[0].map(headerKey), named = keys.filter(Boolean).length;
    if (named >= 2) {
        start = 1;
        // A header copied without its blank leading cells is shorter than the rows: line it up on the right.
        var shift = Math.max(0, width - rows[0].length);
        cols = {};
        keys.forEach(function (k, i) { if (k && cols[k] == null) cols[k] = i + shift; });
        var free = [];
        for (var i = 0; i < width; i++) if (!keys.some(function (k, j) { return k && j + shift === i; })) free.push(i);
        ['name', 'provider'].forEach(function (k) { if (cols[k] == null && free.length && free[0] < (cols.account != null ? cols.account : width)) cols[k] = free.shift(); });
    } else {
        cols = {};
        DEFAULT_ORDER.forEach(function (k, i) { cols[k] = i; });
    }
    var mortgages = estateMortgages(estate);
    for (var r = start; r < rows.length; r++) {
        var row = rows[r];
        var get = function (k) { return cols[k] == null ? '' : row[cols[k]] || ''; };
        var name = get('name');
        if (!name || /^(total|totals|sum|subtotal)$/i.test(name) || row.some(function (c) { return /^total$/i.test(c); })) { out.skipped++; continue; }
        var cost = costFrom(parseMoney(get('annual')), parseMoney(get('monthly')));
        var user = get('username');
        if (/^-?\d+(\.\d+)?\s*%$/.test(user)) user = '';   // a rate in the wrong column is not a login
        var bill = validBill({ name: name, provider: get('provider'), account: get('account'), username: user, link: get('link'),
                               end: parseDate(get('end')), notes: get('notes'), amount: cost.amount, every: cost.every });
        if (!bill) { out.skipped++; continue; }
        var estateName = null;
        if (/mortgage/i.test(name) && mortgages.length) {
            var pick = mortgages.filter(function (a) { return bill.provider && hintName(a.name).indexOf(hintName(bill.provider)) >= 0; })[0] || mortgages[0];
            bill.estate = pick.id; estateName = pick.name;
        }
        var hint = get('hint');
        out.rows.push({ bill: bill, estateName: estateName, hint: hint ? { key: hintName(bill.provider || bill.name), hint: hint } : null });
    }
    return out;
}
// Adds pasted bills. One with the same name and provider as a saved bill updates it (blank cells keep what was there).
function mergeBills(existing, incoming) {
    var key = function (b) { return hintName(b.name) + '|' + hintName(b.provider); };
    var list = existing.slice(), at = {};
    list.forEach(function (b, i) { at[key(b)] = i; });
    var added = 0, updated = 0;
    incoming.forEach(function (b) {
        var i = at[key(b)];
        if (i == null) { at[key(b)] = list.length; list.push(b); added++; return; }
        var old = list[i], next = Object.assign({}, old);
        ['account', 'username', 'link', 'end', 'notes', 'amount', 'estate'].forEach(function (f) { if (b[f] != null && b[f] !== '') next[f] = b[f]; });
        if (b.amount != null) next.every = b.every;
        list[i] = next; updated++;
    });
    return { bills: list, added: added, updated: updated };
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtGBP(n, dp) {
    if (n == null || !isFinite(n)) return '—';
    var d = dp == null ? 0 : dp;
    return '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
}
// £ with pence only when there are any: £70, £12.50.
function fmtExact(n) { return n == null ? '—' : fmtGBP(n, Math.round(n * 100) % 100 ? 2 : 0); }
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(d) { return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4); }
function longDay(d) { return WEEKDAYS[new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + dayLabel(d); }
function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function daysUntil(d, today) { return Math.round((Date.parse(d + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000); }
// The grey line under a bill's name: provider, then when it ends (amber within 30 days, or once passed).
function subLine(b, today) {
    var parts = [];
    if (b.provider) parts.push(b.provider);
    var soon = false;
    if (b.end) {
        var n = daysUntil(b.end, today);
        soon = n <= 30;
        var what = b.fromEstate ? 'deal ends' : 'ends';
        parts.push(n < 0 ? (b.fromEstate ? 'deal ended ' : 'ended ') + dayLabel(b.end) : n === 0 ? what + ' today' : n <= 30 ? what + ' in ' + n + (n === 1 ? ' day' : ' days') : what + ' ' + dayLabel(b.end));
    } else if (b.every !== 'month' && b.every !== 'year' && b.amount != null) parts.push(fmtExact(b.amount) + ' ' + EVERY_BY_ID[b.every].unit);
    else if (!b.provider) parts.push('no end date');
    return { text: parts.join(' · '), soon: soon };
}

// ── UI ───────────────────────────────────────────────────────────────────────
var TEAL = '#2dd4bf';
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
var ListIcon = icon([{ t: 'r', x: 5, y: 3, w: 14, h: 18, rx: 2 }, 'M9 8h6', 'M9 12h6', 'M9 16h4']);
var BackIcon = icon(['M15 18l-6-6 6-6']);
var OpenIcon = icon(['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']);
var BILL_ICONS = {
    home: icon(['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z']),
    council: icon(['M3 21h18', 'M5 21V10', 'M19 21V10', 'M9 21V10', 'M15 21V10', 'M2 10l10-7 10 7z']),
    energy: icon(['M13 2 4 14h7l-1 8 9-12h-7z']),
    water: icon(['M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z']),
    internet: icon(['M5 12.5a10 10 0 0 1 14 0', 'M8.5 16a5 5 0 0 1 7 0', 'M2 9a15 15 0 0 1 20 0', { t: 'c', cx: 12, cy: 19.5, r: 0.8 }]),
    tv: icon([{ t: 'r', x: 2, y: 7, w: 20, h: 14, rx: 2 }, 'M17 2l-5 5-5-5']),
    phone: icon([{ t: 'r', x: 7, y: 2, w: 10, h: 20, rx: 2 }, 'M11 18h2']),
    insurance: icon(['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z']),
    car: icon(['M5 17h14', 'M3 17v-4l2-5h14l2 5v4', { t: 'c', cx: 7.5, cy: 17, r: 1.8 }, { t: 'c', cx: 16.5, cy: 17, r: 1.8 }]),
    services: icon(['M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z', 'M19 15l.8 1.7 1.7.8-1.7.8L19 20l-.8-1.7-1.7-.8 1.7-.8z']),
    other: icon([{ t: 'r', x: 4, y: 3, w: 16, h: 18, rx: 2 }, 'M8 8h8', 'M8 12h8', 'M8 16h5']),
};
function billIcon(b) {
    var n = (b.name || '').toLowerCase();
    if (/council/.test(n)) return BILL_ICONS.council;
    if (/energy|gas|electric/.test(n)) return BILL_ICONS.energy;
    if (/water/.test(n)) return BILL_ICONS.water;
    if (/internet|broadband|wifi|fibre/.test(n)) return BILL_ICONS.internet;
    if (/\btv\b|television/.test(n)) return BILL_ICONS.tv;
    if (/phone|mobile|sim/.test(n)) return BILL_ICONS.phone;
    if (/car|motor/.test(n) && b.category === 'insurance') return BILL_ICONS.car;
    return BILL_ICONS[b.category] || BILL_ICONS.other;
}

function cardStyle(ui, extra) {
    return Object.assign({ background: 'linear-gradient(180deg, ' + ui.C.surfaceHigh + ' 0%, ' + ui.C.surface + ' 100%)',
                           border: '1px solid ' + ui.C.border, borderRadius: 20 }, extra || {});
}
function capsLabel(ui) { return { fontFamily: ui.sys, fontSize: 10, color: ui.C.zinc500, textTransform: 'uppercase', letterSpacing: '0.18em' }; }
function money(ui, size, privacy, color, weight) {
    return { fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums', fontSize: size, fontWeight: weight || 700, color: color || ui.C.white,
             whiteSpace: 'nowrap', filter: privacy ? 'blur(7px)' : 'none' };
}
function buttonStyle(ui, kind) {
    var primary = kind === 'primary', danger = kind === 'danger';
    return { minHeight: 44, borderRadius: 12, padding: '0 14px', fontFamily: ui.sys, fontSize: 14, fontWeight: 600, cursor: 'pointer',
             background: primary ? 'rgba(45,212,191,0.14)' : danger ? 'rgba(248,113,113,0.10)' : 'rgba(39,39,42,0.6)',
             border: '1px solid ' + (primary ? 'rgba(45,212,191,0.4)' : danger ? 'rgba(248,113,113,0.3)' : ui.C.border),
             color: primary ? TEAL : danger ? ui.C.rose : ui.C.zinc400,
             display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
}
function inputStyle(ui, extra) {
    return Object.assign({ display: 'block', width: '100%', boxSizing: 'border-box', minWidth: 0, background: 'rgba(0,0,0,0.35)',
                           border: '1px solid ' + ui.C.border, borderRadius: 10, color: ui.C.white, fontFamily: ui.sys, fontSize: 16,
                           padding: '0 10px', height: 40, outline: 'none', WebkitAppearance: 'none', appearance: 'none' }, extra || {});
}

function Header(props) {
    var ui = useUI();
    return E('div', { style: { padding: '6px 16px 6px 8px', background: 'rgba(13,18,24,0.98)', borderBottom: '1px solid ' + ui.C.border, flexShrink: 0,
                                display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, boxSizing: 'border-box' } },
        E('button', { onClick: props.onBack, 'aria-label': 'Back', style: { background: 'none', border: 'none', color: TEAL, display: 'flex', alignItems: 'center', padding: '6px 4px', cursor: 'pointer', fontFamily: ui.sys, fontSize: 15 } },
            E(BackIcon, { style: { width: 18, height: 18 }, strokeWidth: 2 }), 'Back'),
        E('div', { style: { fontFamily: ui.sys, fontSize: 17, fontWeight: 700, flex: 1, minWidth: 0, color: ui.C.white } }, props.title));
}

function Hero(props) {
    var ui = useUI(), t = props.totals, p = props.privacy;
    return E('div', { style: cardStyle(ui, { padding: '18px 20px' }) },
        E('div', { style: capsLabel(ui) }, 'Monthly outgoings'),
        E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 } },
            E('span', { style: money(ui, 32, p) }, fmtGBP(t.monthly)),
            E('span', { style: { fontFamily: ui.sys, fontSize: 15, color: ui.C.zinc600 } }, 'a month')),
        E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, marginTop: 4 } },
            E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(t.annual)), ' a year · ' + t.count + (t.count === 1 ? ' bill' : ' bills')),
        t.categories.length > 0 && E('div', { style: { display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2, margin: '16px 0 10px' } },
            t.categories.map(function (c) { return E('div', { key: c.id, style: { flex: Math.max(c.share, 0.01), background: c.color } }); })),
        t.categories.map(function (c) {
            return E('div', { key: c.id, style: { display: 'flex', alignItems: 'center', fontFamily: ui.sys, fontSize: 13.5, color: ui.C.zinc400, padding: '4px 0' } },
                E('span', { style: { width: 8, height: 8, borderRadius: 2, background: c.color, marginRight: 8, flexShrink: 0 } }),
                E('span', { style: { flex: 1 } }, c.label),
                E('span', { style: money(ui, 13.5, p, ui.C.zinc400, 500) }, fmtGBP(c.monthly)),
                E('span', { style: { width: 40, textAlign: 'right', color: ui.C.zinc700, fontVariantNumeric: 'tabular-nums' } }, Math.round(c.share * 100) + '%'));
        }));
}

function SortPicker(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2 } },
        SORTS.map(function (s) {
            var on = s.id === props.value;
            return E('button', { key: s.id, onClick: function () { props.onChange(s.id); },
                style: { border: 'none', borderRadius: 7, padding: '5px 10px', fontFamily: ui.sys, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? ui.C.white : ui.C.zinc600 } }, s.label);
        }));
}

function copyText(v) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(v).then(function () { return true; }, function () { return false; }); } catch (e) {}
    return Promise.resolve(false);
}
function Chip(props) {
    var ui = useUI();
    return E('button', { onClick: props.onClick, style: { fontFamily: ui.sys, fontSize: 12, color: TEAL, background: 'none', border: '1px solid rgba(45,212,191,0.4)',
                                                          borderRadius: 999, padding: '3px 10px', cursor: 'pointer', flexShrink: 0 } }, props.children);
}
function Field(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: props.last ? 'none' : '1px solid ' + ui.C.border, fontFamily: ui.sys, fontSize: 14 } },
        E('span', { style: { color: ui.C.zinc600, flexShrink: 0 } }, props.label),
        E('span', { style: { color: ui.C.white, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, textAlign: 'right' } }, props.children));
}

// A bill opened from the list: its numbers and login, with copy buttons, and its website.
function Details(props) {
    var ui = useUI(), b = props.bill, p = props.privacy;
    var copied = React.useState(null), show = React.useState(false);
    var hint = hintFor(props.hints, b);
    function copy(what, v) { copyText(v).then(function (ok) { copied[1](ok ? what : null); if (ok) setTimeout(function () { copied[1](null); }, 1500); }); }
    var rows = [];
    if (b.account) rows.push(E(Field, { key: 'acc', label: 'Account number' },
        E('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', filter: p ? 'blur(6px)' : 'none' } }, b.account),
        E(Chip, { onClick: function () { copy('acc', b.account); } }, copied[0] === 'acc' ? 'Copied' : 'Copy')));
    if (b.username) rows.push(E(Field, { key: 'user', label: 'Username' },
        E('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, b.username),
        E(Chip, { onClick: function () { copy('user', b.username); } }, copied[0] === 'user' ? 'Copied' : 'Copy')));
    if (hint) rows.push(E(Field, { key: 'hint', label: 'Password hint' },
        show[0] ? E('span', { style: { whiteSpace: 'normal' } }, hint) : E('span', { style: { letterSpacing: '0.15em', color: ui.C.zinc600 } }, '••••••'),
        E(Chip, { onClick: function () { show[1](!show[0]); } }, show[0] ? 'Hide' : 'Show')));
    rows.push(E(Field, { key: 'cost', label: 'Cost' },
        E('span', { style: money(ui, 14, p, ui.C.white, 500) }, b.amount == null ? 'Not set' : fmtExact(b.amount) + ' ' + EVERY_BY_ID[b.every].unit)));
    if (b.end) rows.push(E(Field, { key: 'end', label: b.fromEstate ? 'Deal ends' : 'Contract ends' }, longDay(b.end)));
    rows.push(E(Field, { key: 'cat', label: 'Category' }, categoryOf(b.category).label));
    if (b.notes) rows.push(E('div', { key: 'notes', style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, padding: '10px 0', borderBottom: '1px solid ' + ui.C.border, whiteSpace: 'pre-wrap', lineHeight: 1.45 } }, b.notes));
    return E('div', { style: { padding: '2px 14px 14px', borderTop: '1px solid ' + ui.C.border, background: ui.C.surfaceHigh } },
        rows,
        b.fromEstate && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, padding: '10px 0 0', lineHeight: 1.4 } },
            'Payment and deal end come from ' + b.fromEstate.name + ' in Estate.'),
        b.missing && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.amber, padding: '10px 0 0', lineHeight: 1.4 } },
            'The Estate mortgage this bill followed is gone. Edit the bill to pick another or enter its cost.'),
        b.link && E('a', { href: b.link, target: '_blank', rel: 'noopener noreferrer',
            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12, background: 'rgba(45,212,191,0.12)', color: TEAL,
                     borderRadius: 12, padding: '11px', fontFamily: ui.sys, fontSize: 14, fontWeight: 600, textDecoration: 'none' } },
            E(OpenIcon, { style: { width: 15, height: 15 }, strokeWidth: 2 }), 'Open ' + (b.provider || b.name)),
        E('button', { onClick: props.onEdit, style: { display: 'block', width: '100%', background: 'none', border: 'none', color: ui.C.zinc600, fontFamily: ui.sys, fontSize: 13.5, marginTop: 10, padding: 6, cursor: 'pointer' } }, 'Edit'));
}

function BillRow(props) {
    var ui = useUI(), b = props.bill, c = categoryOf(b.category), Icon = billIcon(b), sub = subLine(b, props.today), p = props.privacy;
    return E('div', { style: { borderTop: props.first ? 'none' : '1px solid ' + ui.C.border } },
        E('button', { onClick: props.onToggle, 'aria-expanded': props.open,
            style: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 14px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', WebkitTapHighlightColor: 'transparent' } },
            E('div', { style: { width: 36, height: 36, borderRadius: 10, background: c.color + '24', color: c.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } },
                E(Icon, { style: { width: 18, height: 18 }, strokeWidth: 1.8 })),
            E('div', { style: { flex: 1, minWidth: 0 } },
                E('div', { style: { fontFamily: ui.sys, fontSize: 15, fontWeight: 600, color: ui.C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, b.name),
                E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: sub.soon ? ui.C.amber : ui.C.zinc600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } }, sub.text)),
            E('div', { style: { textAlign: 'right', flexShrink: 0 } },
                E('div', { style: money(ui, 15, p, ui.C.white, 600) }, b.monthly == null ? '—' : fmtGBP(b.monthly)),
                E('div', { style: money(ui, 12.5, p, ui.C.zinc700, 500) }, b.annual == null ? 'no cost' : fmtGBP(b.annual) + '/yr'))),
        props.open && E(Details, { bill: b, hints: props.hints, privacy: p, onEdit: props.onEdit }));
}

var _sort = 'cost';
var _openId = null;
var _mainScrollTop = 0;
function MainView(props) {
    var ui = useUI();
    var sort = React.useState(_sort), open = React.useState(_openId);
    var hints = React.useState(loginHints)[0];
    var bills = props.bills, today = todayISO();
    var t = React.useMemo(function () { return totals(bills); }, [bills]);
    var Banner = window.MaturityAlerts && window.MaturityAlerts.Banner;
    if (!bills.length) {
        return E('div', { style: { padding: '12px 16px' } },
            E('div', { style: cardStyle(ui, { padding: '22px 18px', textAlign: 'center' }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 16, color: ui.C.white, fontWeight: 600, marginBottom: 6 } }, 'No bills yet'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 16 } },
                    'Copy your bills table out of your spreadsheet and paste it in, or add them one at a time.'),
                E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    E('button', { style: buttonStyle(ui, 'primary'), onClick: props.onPaste }, 'Paste from spreadsheet'),
                    E('button', { style: buttonStyle(ui), onClick: function () { props.onEdit(null); } }, '+ Add bill'))));
    }
    var list = sortBills(bills, sort[0]);
    return E('div', { style: { padding: '12px 16px 0' } },
        Banner && E(Banner, { source: function (w) { return renewalAlerts(bills, today, w); }, privacy: props.privacy }),
        E(Hero, { totals: t, privacy: props.privacy }),
        E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '22px 4px 8px' } },
            E('span', { style: capsLabel(ui) }, 'Bills'),
            E(SortPicker, { value: sort[0], onChange: function (v) { _sort = v; sort[1](v); } })),
        E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
            list.map(function (b, i) {
                return E(BillRow, { key: b.id, bill: b, first: i === 0, today: today, hints: hints, privacy: props.privacy, open: open[0] === b.id,
                    onToggle: function () { var v = open[0] === b.id ? null : b.id; _openId = v; open[1](v); },
                    onEdit: function () { props.onEdit(b.id); } });
            })),
        E('div', { style: { display: 'flex', gap: 10, marginTop: 14 } },
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { flex: 1 }), onClick: function () { props.onEdit(null); } }, '+ Add bill'),
            E('button', { style: Object.assign(buttonStyle(ui), { flex: 1 }), onClick: props.onPaste }, 'Paste from sheet')),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc700, lineHeight: 1.45, padding: '14px 4px 0' } },
            'Bills are kept on this phone and in your encrypted backups. Password hints come from the secrets file (rows ‘hint: <provider>’) and never leave this phone.'));
}

function Label(props) {
    var ui = useUI();
    return E('label', { style: { display: 'block', marginBottom: 12, minWidth: 0, flex: props.flex } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc500, marginBottom: 5 } }, props.text),
        props.children);
}

// Add or change one bill.
function EditView(props) {
    var ui = useUI();
    var existing = props.id ? props.state.bills.filter(function (b) { return b.id === props.id; })[0] : null;
    var mortgages = estateMortgages(props.estate);
    var f = React.useState(function () {
        var b = existing || {};
        return { name: b.name || '', provider: b.provider || '', category: b.category || '', amount: b.amount == null ? '' : String(b.amount),
                 every: b.every || 'month', account: b.account || '', username: b.username || '', link: b.link || '', end: b.end || '',
                 notes: b.notes || '', estate: b.estate || '' };
    });
    var form = f[0], err = React.useState(null), del = React.useState(false);
    function set(k, v) { var n = Object.assign({}, form); n[k] = v; f[1](n); }
    function save() {
        var amount = form.amount === '' ? null : parseMoney(form.amount);
        if (form.amount !== '' && amount == null) return err[1]('The cost should be a number of pounds.');
        if (form.link.trim() && !validLink(form.link)) return err[1]('The website should start with https:// (or be an app address).');
        var bill = validBill({ id: existing ? existing.id : null, name: form.name, provider: form.provider, category: form.category || guessCategory(form.name),
                               amount: amount, every: form.every, account: form.account, username: form.username, link: form.link, end: form.end,
                               notes: form.notes, estate: form.estate || null });
        if (!bill) return err[1]('Give the bill a name.');
        var bills = existing ? props.state.bills.map(function (b) { return b.id === bill.id ? bill : b; }) : props.state.bills.concat([bill]);
        saveState(Object.assign({}, props.state, { bills: bills })).catch(function () {});
        props.onDone();
    }
    function remove() {
        if (!del[0]) { del[1](true); setTimeout(function () { del[1](false); }, 4000); return; }
        saveState(Object.assign({}, props.state, { bills: props.state.bills.filter(function (b) { return b.id !== existing.id; }) })).catch(function () {});
        props.onDone();
    }
    var input = function (k, extra) {
        return E('input', Object.assign({ value: form[k], onChange: function (e) { set(k, e.target.value); }, style: inputStyle(ui) }, extra || {}));
    };
    var select = function (k, options) {
        return E('select', { value: form[k], onChange: function (e) { set(k, e.target.value); }, style: inputStyle(ui) },
            options.map(function (o) { return E('option', { key: o.id, value: o.id }, o.label); }));
    };
    var fromEstate = !!form.estate;
    return E('div', { style: { padding: '16px 16px 0' } },
        E(Label, { text: 'Bill' }, input('name', { placeholder: 'Energy', autoCapitalize: 'words' })),
        E(Label, { text: 'Provider' }, input('provider', { placeholder: 'Who it’s with', autoCapitalize: 'words' })),
        E(Label, { text: 'Category' }, select('category', [{ id: '', label: 'Pick from the name' }].concat(CATEGORIES))),
        mortgages.length > 0 && E(Label, { text: 'Cost and end date' },
            select('estate', [{ id: '', label: 'Entered here' }].concat(mortgages.map(function (a) { return { id: a.id, label: 'From Estate: ' + a.name }; })))),
        !fromEstate && E('div', { style: { display: 'flex', gap: 10 } },
            E(Label, { text: 'Cost (£)', flex: 1 }, input('amount', { inputMode: 'decimal', placeholder: '0' })),
            E(Label, { text: 'How often', flex: 1 }, select('every', EVERY))),
        !fromEstate && E(Label, { text: 'Contract ends or renews' }, input('end', { type: 'date' })),
        E(Label, { text: 'Account or policy number' }, input('account', { autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false })),
        E(Label, { text: 'Username' }, input('username', { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, placeholder: 'e.g. email' })),
        E(Label, { text: 'Website' }, input('link', { type: 'url', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, placeholder: 'https://' })),
        E(Label, { text: 'Notes' }, E('textarea', { value: form.notes, rows: 3, onChange: function (e) { set('notes', e.target.value); },
                                                    style: inputStyle(ui, { height: 'auto', padding: '8px 10px', resize: 'vertical' }) })),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 14 } },
            'Don’t put passwords or hints here: these go into your backups. Add a hint to the secrets file as ‘hint: ' + (form.provider || form.name || 'Provider') + '’ instead.'),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            E('button', { style: buttonStyle(ui, 'primary'), onClick: save }, existing ? 'Save' : 'Add bill'),
            existing && E('button', { style: buttonStyle(ui, 'danger'), onClick: remove }, del[0] ? 'Tap again to delete' : 'Delete bill')));
}

// Paste rows copied out of a spreadsheet, check them, then add them.
function PasteView(props) {
    var ui = useUI();
    var txt = React.useState(''), done = React.useState(null);
    var parsed = React.useMemo(function () { return parsePaste(txt[0], props.estate); }, [txt[0], props.estate]);
    function add() {
        var res = mergeBills(props.state.bills, parsed.rows.map(function (r) { return r.bill; }));
        var hints = saveHints(parsed.rows.map(function (r) { return r.hint; }).filter(Boolean));
        saveState(Object.assign({}, props.state, { bills: res.bills })).catch(function () {});
        done[1]({ added: res.added, updated: res.updated, hints: hints });
        txt[1]('');
    }
    var preview = parsed.rows.map(function (r) { return resolveBill(r.bill, props.estate); });
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, lineHeight: 1.5, marginBottom: 12 } },
            'Select your bills table in Excel or Numbers, including the header row, copy it and paste it below. Totals are skipped. A bill already here with the same name and provider is updated.'),
        E('textarea', { value: txt[0], rows: 6, placeholder: 'Paste here', onChange: function (e) { txt[1](e.target.value); done[1](null); },
                        autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false,
                        style: inputStyle(ui, { height: 'auto', padding: '10px', fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical', whiteSpace: 'pre', overflowX: 'auto' }) }),
        done[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.emerald, margin: '12px 0' } },
            'Added ' + done[0].added + (done[0].added === 1 ? ' bill' : ' bills') + (done[0].updated ? ', updated ' + done[0].updated : '') +
            (done[0].hints ? ', saved ' + done[0].hints + (done[0].hints === 1 ? ' hint' : ' hints') + ' on this phone only' : '') + '.'),
        preview.length > 0 && E('div', { style: { marginTop: 16 } },
            E('div', { style: Object.assign(capsLabel(ui), { margin: '0 4px 8px' }) }, preview.length + (preview.length === 1 ? ' bill found' : ' bills found') + (parsed.skipped ? ' · ' + parsed.skipped + (parsed.skipped === 1 ? ' row skipped' : ' rows skipped') : '')),
            E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
                preview.map(function (b, i) {
                    var r = parsed.rows[i];
                    var bits = [categoryOf(b.category).label];
                    if (r.estateName) bits.push('cost from Estate: ' + r.estateName);
                    else if (b.amount != null) bits.push(fmtExact(b.amount) + ' ' + EVERY_BY_ID[b.every].unit);
                    else bits.push('no cost');
                    if (b.end && !r.estateName) bits.push('ends ' + dayLabel(b.end));
                    if (r.hint) bits.push('hint kept on this phone');
                    return E('div', { key: i, style: { padding: '10px 14px', borderTop: i ? '1px solid ' + ui.C.border : 'none', fontFamily: ui.sys } },
                        E('div', { style: { fontSize: 14, color: ui.C.white, fontWeight: 600 } }, b.name + (b.provider ? ' · ' + b.provider : '')),
                        E('div', { style: { fontSize: 12, color: ui.C.zinc600, marginTop: 2, filter: props.privacy ? 'blur(5px)' : 'none' } }, bits.join(' · ')));
                })),
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', marginTop: 12 }), onClick: add },
                'Add ' + preview.length + (preview.length === 1 ? ' bill' : ' bills'))),
        txt[0].trim() && !preview.length && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.amber, marginTop: 12 } },
            'No bills found. Copy the rows straight from the spreadsheet so the columns stay separate.'));
}

function ScreenInner(props) {
    var ui = useUI();
    var state = useStoreState(), estate = useEstateState();
    var v = React.useState({ name: 'main' }), view = v[0], setView = v[1];
    var bills = React.useMemo(function () { return resolveAll(state, estate); }, [state, estate]);
    var scrollRef = React.useRef(null);
    React.useLayoutEffect(function () {
        if (view.name === 'main' && _ready && scrollRef.current) scrollRef.current.scrollTo({ top: _mainScrollTop, behavior: 'instant' });
    }, [view.name, _ready]);
    var back = view.name === 'main' ? null : function () { setView({ name: 'main' }); };
    var body;
    if (!_ready) body = E('div', { style: { padding: 32, textAlign: 'center', fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 } }, 'Loading…');
    else if (view.name === 'edit') body = E(EditView, { id: view.id, state: state, estate: estate, onDone: back });
    else if (view.name === 'paste') body = E(PasteView, { state: state, estate: estate, privacy: props.privacyMode });
    else body = E(MainView, { bills: bills, privacy: props.privacyMode, onPaste: function () { setView({ name: 'paste' }); },
                              onEdit: function (id) { setView({ name: 'edit', id: id }); } });
    var title = view.name === 'paste' ? 'Paste bills' : view.id ? 'Edit bill' : 'Add bill';
    return E('div', {
        'data-swipe-tabs': view.name === 'main' ? '' : null, 'data-tab-screen': 'lifeadmin',
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
    componentDidCatch(error, info) { console.error('Life Admin screen error:', error, info); }
    render() {
        if (!this.state.error) return this.props.children;
        var ui = this.props.ui;
        return E('div', { style: { position: 'fixed', top: 'var(--topbar-h, 0px)', left: 0, right: 0, bottom: 0, zIndex: 9995, background: ui.C.bg, padding: '40px 20px', fontFamily: ui.sys } },
            E('div', { style: { color: ui.C.rose, fontSize: 16, fontWeight: 600, marginBottom: 8 } }, 'Life Admin hit a problem'),
            E('div', { style: { color: ui.C.zinc600, fontSize: 13, marginBottom: 20, lineHeight: 1.5 } },
                String(this.state.error && this.state.error.message || this.state.error) + '. Your saved bills are untouched.'),
            E('button', { onClick: this.props.onClose, style: buttonStyle(ui) }, 'Back to Investments'));
    }
}

function LifeAdminScreen(props) {
    var ui = Object.assign({}, DEFAULT_UI, props.ui || {});
    ui.C = Object.assign({}, DEFAULT_UI.C, (props.ui && props.ui.C) || {});
    return E(UICtx.Provider, { value: ui }, E(Boundary, { ui: ui, onClose: props.onClose }, E(ScreenInner, props)));
}

window.LifeAdminScreen = LifeAdminScreen;
window.LifeAdminStore = LifeAdminStore;
window.LifeAdminIcon = ListIcon;
window.LifeAdminColor = TEAL;
// For tests only: the pure parts, no UI.
window.__lifeAdminInternals = { validateState: validateState, validBill: validBill, validLink: validLink, parsePaste: parsePaste, parseDate: parseDate,
    parseMoney: parseMoney, costFrom: costFrom, mergeBills: mergeBills, resolveBill: resolveBill, resolveAll: resolveAll, totals: totals,
    sortBills: sortBills, renewalAlerts: renewalAlerts, hintFor: hintFor, guessCategory: guessCategory, subLine: subLine };
})();
