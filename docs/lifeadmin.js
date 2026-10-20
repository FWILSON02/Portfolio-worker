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
    { id: 'mortgage',  label: 'Mortgage',  color: '#f472b6' },
    { id: 'childcare', label: 'Childcare', color: '#4ade80' },
    { id: 'home',      label: 'Home',      color: '#2dd4bf' },
    { id: 'utilities', label: 'Utilities', color: '#60a5fa' },
    { id: 'insurance', label: 'Insurance', color: '#a78bfa' },
    { id: 'services',  label: 'Services',  color: '#fb923c' },
    { id: 'other',     label: 'Other',     color: '#9da5b4' },
];
var CATEGORY_BY_ID = {};
CATEGORIES.forEach(function (c) { CATEGORY_BY_ID[c.id] = c; });
function categoryOf(id) { return CATEGORY_BY_ID[id] || CATEGORY_BY_ID.other; }
var CHILDCARE = /nursery|childcare|child care|nanny|creche|crèche|childminder|after.?school|preschool|pre-school/;
// Mortgage and Childcare came later (Fergus): a bill saved under the old guess moves to them.
function migrateCategory(cat, name, estate) {
    var n = String(name || '').toLowerCase();
    if (cat === 'home' && (estate || /mortgage/.test(n))) return 'mortgage';
    if ((cat === 'services' || cat === 'other') && CHILDCARE.test(n)) return 'childcare';
    return cat;
}
// A pasted bill's category from its name.
function guessCategory(name) {
    var n = String(name || '').toLowerCase();
    if (/insur|cover|warranty|protect/.test(n)) return 'insurance';
    if (/mortgage/.test(n)) return 'mortgage';
    if (CHILDCARE.test(n)) return 'childcare';
    if (/rent|council|service charge|ground rent/.test(n)) return 'home';
    if (/energy|gas|electric|water|internet|broadband|wifi|fibre|tv|licen[cs]e|phone|mobile|sim/.test(n)) return 'utilities';
    if (/clean|gardener|gym|subscription|netflix|spotify|window/.test(n)) return 'services';
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
//          costFrom: 'last12' | 'forecast' | null: an energy bill's yearly cost follows its usage page (the last 12 months'
//                    use at today's rates, or the 12-month forecast) instead of the amount typed in (Fergus asked). amount stays as the
//                    fallback until the usage has the figure.
var COST_FROM = [{ id: 'last12', label: "Last 12 months' use at today's rates" }, { id: 'forecast', label: '12-month forecast' }];
var COST_FROM_BY_ID = { last12: COST_FROM[0], forecast: COST_FROM[1] };
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
        category: CATEGORY_BY_ID[b.category] ? migrateCategory(b.category, name, b.estate) : guessCategory(name),
        amount: amount,
        every: EVERY_BY_ID[b.every] ? b.every : 'month',
        account: text(b.account, 80),
        username: text(b.username, 120),
        link: validLink(b.link),
        end: ISO_DATE.test(b.end || '') ? b.end : null,
        notes: text(b.notes, 500),
        estate: text(b.estate, 60) || null,
        usage: validUsage(b.usage),
        costFrom: COST_FROM_BY_ID[b.costFrom] ? b.costFrom : null,
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
// An Estate mortgage's current deal: the last of its deals (Estate keeps them oldest first).
function currentDeal(a) { var d = a && a.loan && a.loan.deals; return d && d.length ? d[d.length - 1] : null; }
// Estate mortgages a bill can follow: open debts whose current deal has a monthly payment.
function estateMortgages(estate) {
    return ((estate && estate.accounts) || []).filter(function (a) { var d = currentDeal(a); return a && !a.closed && a.debt && d && typeof d.payment === 'number'; });
}
// A bill as shown: its yearly and monthly cost, with an Estate mortgage's payment and deal end in place of its own.
// fromEstate: the Estate account followed; missing: it follows one that is no longer there (or has no payment).
function resolveBill(b, estate) {
    var out = Object.assign({}, b, { fromEstate: null, missing: false });
    if (b.estate) {
        var a = estateMortgages(estate).filter(function (x) { return x.id === b.estate; })[0];
        if (a) {
            out.fromEstate = a;
            out.amount = Math.abs(currentDeal(a).payment);
            out.every = 'month';
            out.end = currentDeal(a).end || null;
            if (!out.provider) out.provider = a.name;
            if (!out.link && a.link) out.link = a.link;
        } else out.missing = true;
    }
    out.formula = null;
    if (b.costFrom && b.usage) {
        var st = usageStats(b.usage), v = b.costFrom === 'last12' ? st.current && st.current.cost : st.forecast && st.forecast.cost;
        if (v != null) { out.amount = Math.round(v * 100) / 100; out.every = 'year'; out.formula = b.costFrom; }
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
// A unit rate or standing charge: keeps its decimals (0.05476 is 5.476p), and reads pence ('22.45p') too.
function parseRate(v) {
    var t = String(v == null ? '' : v).replace(/[£,\s]|Â/g, ''), pence = /p$/i.test(t);
    if (pence) t = t.slice(0, -1);
    if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
    return Math.round(Number(t) / (pence ? 100 : 1) * 1e5) / 1e5;
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

// ── Energy usage (Energy bill → Usage) ──────────────────────────────────────
// Month by month electricity and gas use, as in Fergus's usage sheet, kept on the bill (so backups carry it):
//   bill.usage = { months: [Month], meters: { mpan, mprn, elecSerial, gasSerial } }
//   Month = { month: 'YYYY-MM', elec: Fuel, gas: Fuel, support }
//   Fuel  = { kwh, standing (£ a day), unit (£ a kWh), cost (£ for the month), m3, cv }; any of them may be null.
//   m3, cv: gas meters read in cubic metres; with the calorific value (MJ/m³, on the bill) kWh = m³ × 1.02264 × cv ÷ 3.6,
//   the regulated conversion UK suppliers bill by.
//   tariff (optional) = { elec: { unit, standing }, gas: {...} }: rates for the forecast; else the latest month's.
//   support: government support credited that month (£), taken off the month's cost.
// A month's cost for a fuel is the one entered, else kWh × unit rate + standing charge × days in the month.
// "Annual cost" is the sheet's rolling figure: the last 12 months of electricity + gas − support.
var MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
var METER_FIELDS = [
    { id: 'mpan', label: 'Electricity MPAN' }, { id: 'elecSerial', label: 'Electricity meter serial' },
    { id: 'mprn', label: 'Gas MPRN' }, { id: 'gasSerial', label: 'Gas meter serial' },
];
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
var DEFAULT_WEIGHT = 2 / 3;
var DEFAULT_CV = 39.5, VOLUME_CORRECTION = 1.02264;
function m3ToKwh(m3, cv) { return m3 * VOLUME_CORRECTION * (cv || DEFAULT_CV) / 3.6; }
function validFuel(f) {
    if (!f || typeof f !== 'object') return null;
    var o = { kwh: num(f.kwh), standing: num(f.standing), unit: num(f.unit), cost: num(f.cost) };
    ['kwh', 'standing', 'unit', 'cost'].forEach(function (k) { if (o[k] != null) o[k] = Math.round(Math.abs(o[k]) * 1e5) / 1e5; });
    if (num(f.m3) != null) {
        o.m3 = Math.round(Math.abs(f.m3) * 1000) / 1000;
        if (num(f.cv) != null && f.cv >= 30 && f.cv <= 50) o.cv = Math.round(f.cv * 100) / 100;
        if (o.kwh == null) o.kwh = Math.round(m3ToKwh(o.m3, o.cv) * 10) / 10;
    }
    return o.kwh == null && o.standing == null && o.unit == null && o.cost == null ? null : o;
}
function validTariff(t) {
    if (!t || typeof t !== 'object') return null;
    var out = {}, any = false;
    ['elec', 'gas'].forEach(function (k) {
        var x = t[k], unit = x && num(x.unit), standing = x && num(x.standing);
        if (unit == null && standing == null) return;
        out[k] = { unit: unit == null ? null : Math.round(Math.abs(unit) * 1e5) / 1e5, standing: standing == null ? null : Math.round(Math.abs(standing) * 1e5) / 1e5 };
        any = true;
    });
    return any ? out : null;
}
function validUsage(u) {
    if (!u || typeof u !== 'object') return null;
    var by = {};
    (Array.isArray(u.months) ? u.months : []).forEach(function (m) {
        if (!m || !MONTH_KEY.test(m.month || '')) return;
        var x = { month: m.month, elec: validFuel(m.elec), gas: validFuel(m.gas), support: num(m.support) == null ? null : Math.abs(m.support) };
        if (x.elec || x.gas || x.support != null) by[m.month] = x;
    });
    var meters = {}, any = false;
    METER_FIELDS.forEach(function (f) { var v = text(u.meters && u.meters[f.id], 40); if (v) { meters[f.id] = v; any = true; } });
    var months = Object.keys(by).sort().map(function (k) { return by[k]; });
    var out = { months: months, meters: meters };
    if (num(u.weight) != null && u.weight >= 0 && u.weight <= 1) out.weight = Math.round(u.weight * 100) / 100;
    // Forecast adjustment per fuel (Fergus): −0.1 takes 10% off, for a year that won't repeat (who's home changes).
    var adjust = {};
    ['elec', 'gas'].forEach(function (k) { var v = u.adjust && num(u.adjust[k]); if (v != null && v !== 0 && v >= -0.5 && v <= 0.5) adjust[k] = Math.round(v * 100) / 100; });
    if (Object.keys(adjust).length) out.adjust = adjust;
    var tariff = validTariff(u.tariff);
    if (tariff) out.tariff = tariff;
    return months.length || any || tariff ? out : null;
}
function monthNo(mk) { return Number(mk.slice(0, 4)) * 12 + Number(mk.slice(5, 7)) - 1; }
function monthOf(n) { return Math.floor(n / 12) + '-' + pad2(n % 12 + 1); }
function daysIn(mk) { return new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)).getUTCDate(); }
function fuelCost(f, mk) {
    if (!f) return null;
    if (f.cost != null) return f.cost;
    if (f.kwh != null && f.unit != null) return f.kwh * f.unit + (f.standing || 0) * daysIn(mk);
    return null;
}
// The month's cost: electricity + gas − support. null when neither fuel has a cost.
function monthCost(m) {
    var e = fuelCost(m.elec, m.month), g = fuelCost(m.gas, m.month);
    if (e == null && g == null) return null;
    return (e || 0) + (g || 0) - (m.support || 0);
}
// A month counts toward the averages and the rolling year once it has a reading (kWh) for either fuel. A month with
// only rates or a part cost (the month in progress) is shown but left out.
function hasReading(m) { return !!((m.elec && m.elec.kwh != null) || (m.gas && m.gas.kwh != null)); }
// Rates in use: the latest month that has them.
function latestRates(months) {
    var out = { elec: null, gas: null };
    months.forEach(function (m) {
        ['elec', 'gas'].forEach(function (k) { var f = m[k]; if (f && f.unit != null) out[k] = { unit: f.unit, standing: f.standing || 0, from: m.month }; });
    });
    return out;
}
// Rates the forecast uses: the tariff Fergus entered, filling any gap from the latest month's.
function forecastRates(usage) {
    var latest = latestRates((usage && usage.months) || []), t = (usage && usage.tariff) || {}, out = {};
    ['elec', 'gas'].forEach(function (k) {
        var x = t[k] || {}, l = latest[k];
        var unit = x.unit != null ? x.unit : l ? l.unit : null;
        out[k] = unit == null ? null : { unit: unit, standing: x.standing != null ? x.standing : l ? l.standing : 0,
                                         from: x.unit != null ? 'tariff' : l.from };
    });
    return out;
}
function sumKwh(list, k) {
    var s = 0, n = 0;
    list.forEach(function (m) { if (m[k] && m[k].kwh != null) { s += m[k].kwh; n++; } });
    return n ? s : null;
}
function pctVs(a, b) { return a == null || !b ? null : a / b - 1; }
// Everything the usage page shows. today: 'YYYY-MM-DD' (for the forecast's starting month).
function usageStats(usage, today) {
    var months = (usage && usage.months) || [];
    var done = months.filter(hasReading);
    var byKey = {};
    months.forEach(function (m) { byKey[m.month] = m; });
    // Average use in each calendar month (1-12), over every year with a reading for it.
    var avg = { elec: [], gas: [] };
    ['elec', 'gas'].forEach(function (k) {
        for (var c = 0; c < 12; c++) {
            var vals = done.filter(function (m) { return +m.month.slice(5, 7) - 1 === c && m[k] && m[k].kwh != null; }).map(function (m) { return m[k].kwh; });
            avg[k][c] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null;
        }
    });
    var avgYear = {};
    ['elec', 'gas'].forEach(function (k) { avgYear[k] = avg[k].every(function (v) { return v == null; }) ? null : avg[k].reduce(function (a, v) { return a + (v || 0); }, 0); });
    var latest = done.length ? done[done.length - 1].month : null;
    var first = done.length ? done[0].month : null;
    function window12(end) {
        var out = [], e = monthNo(end);
        for (var n = e - 11; n <= e; n++) if (byKey[monthOf(n)]) out.push(byKey[monthOf(n)]);
        return out;
    }
    // The rolling year once there are 12 months behind it (as the sheet starts it).
    var rolling = [];
    if (first) for (var n = monthNo(first) + 11; n <= monthNo(latest); n++) {
        var w = window12(monthOf(n)), cost = 0, any = false;
        w.forEach(function (m) { var c = monthCost(m); if (c != null) { cost += c; any = true; } });
        if (any && byKey[monthOf(n)] && hasReading(byKey[monthOf(n)])) rolling.push({ month: monthOf(n), cost: cost });
    }
    var year = latest ? window12(latest) : [], prev = latest ? window12(monthOf(monthNo(latest) - 12)) : [];
    var running = { elec: sumKwh(year, 'elec'), gas: sumKwh(year, 'gas') };
    var before = { elec: prev.length === 12 ? sumKwh(prev, 'elec') : null, gas: prev.length === 12 ? sumKwh(prev, 'gas') : null };
    // Next 12 months (Fergus): each calendar month's use from the last 12 months, blended with the average of the
    // same month in earlier years, the recent one counting `weight` (default 2/3, so twice the older average). A month
    // with only one of the two takes that one. Priced at the latest unit rates and standing charges.
    var weight = usage && num(usage.weight) != null ? Math.min(1, Math.max(0, usage.weight)) : DEFAULT_WEIGHT;
    var recentStart = latest ? monthNo(latest) - 11 : 0;
    var adjust = (usage && usage.adjust) || {};
    var rates = forecastRates(usage), forecast = null, current = null;
    if (latest) {
        var plan = [], total = 0, priced = true, kwhTotal = { elec: 0, gas: 0 }, days = 0;
        for (var i = 1; i <= 12; i++) {
            var mk = monthOf(monthNo(latest) + i), c = +mk.slice(5, 7) - 1, row = { month: mk, cost: 0 };
            days += daysIn(mk);
            ['elec', 'gas'].forEach(function (k) {
                var recent = null, older = [];
                done.forEach(function (m) {
                    if (+m.month.slice(5, 7) - 1 !== c || !m[k] || m[k].kwh == null) return;
                    if (monthNo(m.month) >= recentStart) recent = m[k].kwh; else older.push(m[k].kwh);
                });
                var old = older.length ? older.reduce(function (a, b) { return a + b; }, 0) / older.length : null;
                var kwh = recent != null && old != null ? weight * recent + (1 - weight) * old : recent != null ? recent : old;
                if (kwh != null && adjust[k]) kwh *= 1 + adjust[k];
                row[k] = kwh;
                if (kwh != null) kwhTotal[k] += kwh;
                if (kwh != null && rates[k]) row.cost += kwh * rates[k].unit + rates[k].standing * daysIn(mk);
                else if (kwh != null) priced = false;
            });
            total += row.cost;
            plan.push(row);
        }
        // The sum shown under the forecast: kWh × unit rate + days × standing charge, per fuel.
        var parts = {};
        ['elec', 'gas'].forEach(function (k) {
            if (rates[k]) parts[k] = { kwh: kwhTotal[k], unit: rates[k].unit, standing: rates[k].standing, days: days,
                                       energy: kwhTotal[k] * rates[k].unit, standingCost: rates[k].standing * days };
        });
        // The last 12 months' use priced at today's rates (Fergus: past usage, current costs), no adjustment.
        if (year.length === 12) {
            var cur = 0, curParts = {}, curOk = true;
            ['elec', 'gas'].forEach(function (k) {
                if (running[k] == null) return;
                if (!rates[k]) { curOk = false; return; }
                curParts[k] = { kwh: running[k], unit: rates[k].unit, standing: rates[k].standing, days: days,
                                energy: running[k] * rates[k].unit, standingCost: rates[k].standing * days };
                cur += curParts[k].energy + curParts[k].standingCost;
            });
            if (curOk && (curParts.elec || curParts.gas)) current = { cost: cur, parts: curParts, days: days };
        }
        forecast = { months: plan, kwh: kwhTotal, cost: priced && (rates.elec || rates.gas) ? total : null, weight: weight, parts: parts, days: days, adjust: { elec: adjust.elec || 0, gas: adjust.gas || 0 } };
    }
    // Use by calendar month, one series per year (the year-on-year bars).
    var years = {};
    done.forEach(function (m) {
        var y = m.month.slice(0, 4);
        if (!years[y]) years[y] = { elec: [], gas: [] };
        years[y].elec[+m.month.slice(5, 7) - 1] = m.elec ? m.elec.kwh : null;
        years[y].gas[+m.month.slice(5, 7) - 1] = m.gas ? m.gas.kwh : null;
    });
    return { months: months, done: done, latest: latest, avg: avg, avgYear: avgYear, rolling: rolling,
             annual: rolling.length && rolling[rolling.length - 1].month === latest ? rolling[rolling.length - 1].cost : null,
             running: running, vsAverage: { elec: pctVs(running.elec, avgYear.elec), gas: pctVs(running.gas, avgYear.gas) },
             vsLastYear: { elec: pctVs(running.elec, before.elec), gas: pctVs(running.gas, before.gas) },
             full: year.length === 12, rates: rates, forecast: forecast, current: current, years: years };
}

// Paste from the usage sheet: a row per month ('April 2021') with electricity kWh, standing charge, unit rate and
// cost, then the same for gas, then government support. Header rows say which column is which; without them, that
// order from the second column. Meter numbers anywhere in the paste ('MPAN' then its number) are picked up too.
var MONTH_ROW = /^([a-z]{3,9})\.?[\s\-]+(\d{2}|\d{4})$/i;
function monthKeyOf(cell) {
    var t = String(cell || '').trim(), m;
    if ((m = /^(\d{4})-(\d{1,2})$/.exec(t))) return +m[2] >= 1 && +m[2] <= 12 ? m[1] + '-' + pad2(+m[2]) : null;
    if ((m = /^(\d{1,2})\/(\d{4})$/.exec(t))) return +m[1] >= 1 && +m[1] <= 12 ? m[2] + '-' + pad2(+m[1]) : null;
    if ((m = MONTH_ROW.exec(t))) {
        var mi = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()), y = +m[2];
        if (mi < 0) return null;
        if (y < 100) y += 2000;
        return y + '-' + pad2(mi + 1);
    }
    return null;
}
var USAGE_DEFAULT = { ek: 1, es: 2, eu: 3, ec: 4, gk: 5, gs: 6, gu: 7, gc: 8, sup: 9 };
function usageColumns(heads) {
    var cols = {}, standing = [], unit = [];
    heads.forEach(function (row) {
        row.forEach(function (c, i) {
            var t = String(c || '').toLowerCase();
            if (!t) return;
            if (/support|rebate|discount|credit/.test(t)) cols.sup = i;
            else if (/standing/.test(t)) standing.push(i);
            else if (/unit/.test(t)) unit.push(i);
            else if (/electric/.test(t) && /usage|kwh|use/.test(t) && !/average/.test(t)) cols.ek = i;
            else if (/electric/.test(t) && /cost|£/.test(t)) cols.ec = i;
            else if (/calorific|\bcv\b/.test(t)) cols.gcv = i;
            else if (/gas/.test(t) && /m3|m³|cubic/.test(t) && !/average/.test(t)) cols.gm = i;
            else if (/gas/.test(t) && /usage|kwh|use/.test(t) && !/average/.test(t)) cols.gk = i;
            else if (/gas/.test(t) && /cost|£/.test(t)) cols.gc = i;
        });
    });
    if (cols.ek == null || (cols.gk == null && cols.gm == null)) return USAGE_DEFAULT;
    if (cols.gk == null) cols.gk = cols.gm;
    var pick = function (list, lo, hi) { return list.filter(function (i) { return i > lo && i < hi; })[0]; };
    cols.es = pick(standing, cols.ek, cols.gk); cols.eu = pick(unit, cols.ek, cols.gk);
    cols.gs = pick(standing, cols.gk, 1e9); cols.gu = pick(unit, cols.gk, 1e9);
    return cols;
}
function parseUsagePaste(textIn) {
    var rows = splitRows(textIn), heads = [], out = { months: [], meters: {}, skipped: 0 };
    var cols = null;
    rows.forEach(function (row) {
        // Meter numbers: a label cell, then its value in the next filled cell.
        row.forEach(function (c, i) {
            var t = String(c || '').toLowerCase(), id = null;
            if (/^mpan\b/.test(t)) id = 'mpan';
            else if (/^mprn\b/.test(t)) id = 'mprn';
            else if (/electric.*serial/.test(t)) id = 'elecSerial';
            else if (/gas.*serial/.test(t)) id = 'gasSerial';
            if (!id) return;
            var v = row.slice(i + 1).filter(function (x) { return x; })[0];
            if (v) out.meters[id] = text(v, 40);
        });
        var mk = monthKeyOf(row[0]);
        if (!mk) { if (!out.months.length) heads.push(row); return; }
        if (!cols) cols = usageColumns(heads);
        var cell = function (k) { return cols[k] == null ? '' : row[cols[k]]; };
        var kwh = function (k) { var v = String(cell(k) || '').replace(/[,\s]/g, ''); return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null; };
        var m = validUsage({ months: [{ month: mk,
            elec: { kwh: kwh('ek'), standing: parseRate(cell('es')), unit: parseRate(cell('eu')), cost: parseMoney(cell('ec')) },
            gas:  { kwh: cols.gk === cols.gm ? null : kwh('gk'), m3: kwh('gm'), cv: kwh('gcv'), standing: parseRate(cell('gs')), unit: parseRate(cell('gu')), cost: parseMoney(cell('gc')) },
            support: parseMoney(cell('sup')) }] });
        if (m && m.months.length) out.months.push(m.months[0]); else out.skipped++;
    });
    return out;
}
// Pasted months replace the same months already saved; other saved months stay. Meter numbers fill in or replace.
function mergeUsage(usage, pasted) {
    var by = {};
    ((usage && usage.months) || []).forEach(function (m) { by[m.month] = m; });
    pasted.months.forEach(function (m) { by[m.month] = m; });
    return validUsage({ months: Object.keys(by).map(function (k) { return by[k]; }), weight: usage && usage.weight, tariff: usage && usage.tariff, adjust: usage && usage.adjust,
                        meters: Object.assign({}, (usage && usage.meters) || {}, pasted.meters) });
}
function isEnergyBill(b) { return !!(b && (b.usage || /energy|electric|gas\b|power/i.test(b.name || ''))); }

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
    childcare: icon([{ t: 'c', cx: 12, cy: 12, r: 9 }, 'M9 14.5a4 4 0 0 0 6 0', { t: 'c', cx: 9, cy: 10, r: 0.8 }, { t: 'c', cx: 15, cy: 10, r: 0.8 }]),
};
BILL_ICONS.mortgage = BILL_ICONS.home;
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
                E('span', { style: { minWidth: 48, marginLeft: 8, textAlign: 'right', color: ui.C.zinc700, fontVariantNumeric: 'tabular-nums' } }, Math.round(c.share * 100) + '%'));
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
    // From the usage page: a FORMULA tag beside Cost and a blue value, like an Estate balance worked out by a formula.
    var costLabel = b.formula ? E('span', null, 'Cost', E('span', { style: { fontSize: 10, color: ui.C.blue, letterSpacing: '0.02em', marginLeft: 8 } }, 'FORMULA')) : 'Cost';
    rows.push(E(Field, { key: 'cost', label: costLabel },
        b.formula ? E('span', { style: { textAlign: 'right' } },
                E('span', { style: money(ui, 14, p, ui.C.blue, 500) }, fmtExact(b.amount) + ' a year'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 1 } }, COST_FROM_BY_ID[b.formula].label))
          : E('span', { style: money(ui, 14, p, ui.C.white, 500) }, b.amount == null ? 'Not set' : fmtExact(b.amount) + ' ' + EVERY_BY_ID[b.every].unit)));
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
        isEnergyBill(b) && E('button', { onClick: props.onUsage, style: Object.assign(buttonStyle(ui), { width: '100%', marginTop: 10 }) },
            'Usage and forecast' + (b.usage && b.usage.months.length ? ' · ' + b.usage.months.length + ' months' : '')),
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
        props.open && E(Details, { bill: b, hints: props.hints, privacy: p, onEdit: props.onEdit, onUsage: props.onUsage }));
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
                    onEdit: function () { props.onEdit(b.id); }, onUsage: function () { props.onUsage(b.id); } });
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
                 notes: b.notes || '', estate: b.estate || '', costFrom: b.costFrom || '' };
    });
    var form = f[0], err = React.useState(null), del = React.useState(false);
    function set(k, v) { var n = Object.assign({}, form); n[k] = v; f[1](n); }
    function save() {
        var amount = form.amount === '' ? null : parseMoney(form.amount);
        if (form.amount !== '' && amount == null) return err[1]('The cost should be a number of pounds.');
        if (form.link.trim() && !validLink(form.link)) return err[1]('The website should start with https:// (or be an app address).');
        var bill = validBill({ id: existing ? existing.id : null, name: form.name, provider: form.provider, category: form.category || guessCategory(form.name),
                               amount: amount, every: form.every, account: form.account, username: form.username, link: form.link, end: form.end,
                               notes: form.notes, estate: form.estate || null, usage: existing ? existing.usage : null,
                               costFrom: form.costFrom || null });
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
    // An energy bill with usage can take its cost from the usage page instead of a typed amount.
    var usage = existing && existing.usage, canFormula = !fromEstate && !!(usage && usage.months.length) && isEnergyBill(existing);
    var formula = canFormula && form.costFrom ? form.costFrom : null;
    var formulaValue = null;
    if (formula) { var st = usageStats(usage); formulaValue = formula === 'last12' ? st.current && st.current.cost : st.forecast && st.forecast.cost; }
    return E('div', { style: { padding: '16px 16px 0' } },
        E(Label, { text: 'Bill' }, input('name', { placeholder: 'Energy', autoCapitalize: 'words' })),
        E(Label, { text: 'Provider' }, input('provider', { placeholder: 'Who it’s with', autoCapitalize: 'words' })),
        E(Label, { text: 'Category' }, select('category', [{ id: '', label: 'Pick from the name' }].concat(CATEGORIES))),
        mortgages.length > 0 && E(Label, { text: 'Cost and end date' },
            select('estate', [{ id: '', label: 'Entered here' }].concat(mortgages.map(function (a) { return { id: a.id, label: 'From Estate: ' + a.name }; })))),
        canFormula && E(Label, { text: 'Cost from' }, select('costFrom', [{ id: '', label: 'Amount typed in' }].concat(COST_FROM.map(function (c) { return { id: c.id, label: 'Formula: ' + c.label }; })))),
        // Formula: shown like an Estate balance worked out by a formula (blue, not typed in).
        formula && E(Label, { text: 'Cost a year (£)' },
            E('div', { style: inputStyle(ui, { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', color: ui.C.blue, fontFamily: ui.rounded, fontVariantNumeric: 'tabular-nums' }) },
                formulaValue == null ? '—' : Math.round(formulaValue).toLocaleString('en-GB')),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11, color: ui.C.zinc700, marginTop: 4 } },
                formulaValue == null ? (formula === 'last12' ? 'Needs 12 months of readings and unit rates; until then the amount typed in is used.' : 'Needs unit rates to price it; until then the amount typed in is used.')
                                     : 'Worked out from the usage page; it updates as you add months.')),
        !fromEstate && !formula && E('div', { style: { display: 'flex', gap: 10 } },
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

// ── Energy usage page ────────────────────────────────────────────────────────
var FUELS = [{ id: 'elec', label: 'Electricity', color: '#60a5fa' }, { id: 'gas', label: 'Gas', color: '#34d399' }];
var FUEL_BY_ID = { elec: FUELS[0], gas: FUELS[1] };
var FC_COLOR = '#fbbf24';
var MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
var GAS_UNITS = [{ id: 'kwh', label: 'kWh' }, { id: 'm3', label: 'm³' }];
var ADJUSTS = [{ id: -0.2, label: '−20%' }, { id: -0.1, label: '−10%' }, { id: -0.05, label: '−5%' }, { id: 0, label: '0' }, { id: 0.1, label: '+10%' }];
var WEIGHTS = [{ id: 0.5, label: '50%' }, { id: 2 / 3, label: '67%' }, { id: 0.8, label: '80%' }, { id: 1, label: '100%' }];
function monthLabel(mk) { return MONTHS[+mk.slice(5, 7) - 1] + ' ' + mk.slice(0, 4); }
function fmtKwh(v) { return v == null ? '—' : Math.round(v).toLocaleString('en-GB') + ' kWh'; }
function fmtPctSigned(v) { return v == null ? null : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%'; }
function fmtRate(v) { return v == null ? '—' : (Math.round(v * 10000) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + 'p'; }
function saveUsage(state, billId, usage) {
    var bills = state.bills.map(function (b) { return b.id === billId ? Object.assign({}, b, { usage: validUsage(usage) }) : b; });
    return saveState(Object.assign({}, state, { bills: bills })).catch(function () {});
}

function Segmented(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', background: 'rgba(0,0,0,0.3)', borderRadius: 9, padding: 2, gap: 2 } },
        props.options.map(function (o) {
            var on = o.id === props.value;
            return E('button', { key: String(o.id), onClick: function () { props.onChange(o.id); },
                style: { flex: props.fill ? 1 : 'none', border: 'none', borderRadius: 7, padding: props.tight ? '5px 2px' : '5px 10px', fontFamily: ui.sys, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                         background: on ? 'rgba(255,255,255,0.10)' : 'transparent', color: on ? ui.C.white : ui.C.zinc600 } }, o.label);
        }));
}
function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
// Round steps from lo to hi; the line chart fits its data (no £0 floor: Fergus found one made the Estate scale silly).
function niceRange(lo, hi, zero) {
    if (zero) lo = 0;
    if (!(hi > lo)) hi = lo + 1;
    var step = niceMax((hi - lo) / 4);
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
    return { lo: a, hi: b === a ? a + step : b, step: step };
}
function axisText(v) { return v >= 1000 ? (v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + 'k' : String(Math.round(v)); }
var CW = 340, CH = 150, PAD_L = 30, PAD_B = 18, PAD_T = 6;
function Axes(props) {
    var lines = [], r = props.range;
    for (var v = r.lo, i = 0; v <= r.hi + r.step / 1e6; v += r.step, i++) {
        var y = yOf(v, r);
        lines.push(E('line', { key: 'g' + i, x1: PAD_L, x2: CW, y1: y, y2: y, stroke: 'rgba(255,255,255,0.07)' }));
        lines.push(E('text', { key: 't' + i, x: PAD_L - 5, y: y + 3, textAnchor: 'end', fontSize: 9, fill: '#888894' }, axisText(v)));
    }
    var step = (CW - PAD_L) / 12;
    MONTH_INITIALS.forEach(function (m, i) {
        lines.push(E('text', { key: 'm' + i, x: PAD_L + step * (i + 0.5), y: CH - 5, textAnchor: 'middle', fontSize: 9, fill: '#888894' }, m));
    });
    return E('g', null, lines);
}
function yOf(v, r) { return PAD_T + (CH - PAD_T - PAD_B) * (1 - (v - r.lo) / (r.hi - r.lo)); }
function xOf(i) { return PAD_L + (CW - PAD_L) / 12 * (i + 0.5); }
function pathOf(vals, max) {
    var d = '', pen = false;
    vals.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v, max).toFixed(1);
        pen = true;
    });
    return d;
}
function Legend(props) {
    var ui = useUI();
    return E('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8, fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600 } },
        props.items.map(function (it) {
            return E('span', { key: it.label, style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
                E('span', { style: { width: it.bar ? 8 : 12, height: it.bar ? 8 : 0, borderRadius: it.bar ? 2 : 0, background: it.bar ? it.color : 'none',
                                     borderTop: it.bar ? 'none' : '2px ' + (it.dashed ? 'dashed ' : 'solid ') + it.color } }), it.label);
        }));
}
// Average use in each month (the sheet's top chart), the last 12 months, and the forecast.
function SeasonChart(props) {
    var st = props.stats, f = FUEL_BY_ID[props.fuel];
    var recent = [], fc = [];
    var start = st.latest ? monthNo(st.latest) - 11 : 0;
    st.done.forEach(function (m) { if (monthNo(m.month) >= start && m[props.fuel] && m[props.fuel].kwh != null) recent[+m.month.slice(5, 7) - 1] = m[props.fuel].kwh; });
    (st.forecast ? st.forecast.months : []).forEach(function (m) { fc[+m.month.slice(5, 7) - 1] = m[props.fuel]; });
    for (var i = 0; i < 12; i++) { if (recent[i] === undefined) recent[i] = null; if (fc[i] === undefined) fc[i] = null; }
    var vals = st.avg[props.fuel].concat(recent, fc).filter(function (v) { return v != null; });
    var max = niceRange(Math.min.apply(null, vals.concat([Infinity])) * 0.95, Math.max.apply(null, vals.concat([1])) * 1.02);
    return E('div', null,
        E('svg', { viewBox: '0 0 ' + CW + ' ' + CH, width: '100%', style: { display: 'block' }, 'aria-label': f.label + ' use by month' },
            E(Axes, { range: max }),
            E('path', { d: pathOf(st.avg[props.fuel], max), fill: 'none', stroke: f.color, strokeWidth: 2.2, strokeLinejoin: 'round' }),
            E('path', { d: pathOf(recent, max), fill: 'none', stroke: 'rgba(255,255,255,0.55)', strokeWidth: 1.2 }),
            recent.map(function (v, i) { return v == null ? null : E('circle', { key: i, cx: xOf(i), cy: yOf(v, max), r: 2, fill: '#fff' }); }),
            E('path', { d: pathOf(fc, max), fill: 'none', stroke: FC_COLOR, strokeWidth: 1.8, strokeDasharray: '4 3' })),
        E(Legend, { items: [{ label: 'Average', color: f.color }, { label: 'Last 12 months', color: 'rgba(255,255,255,0.7)' }, { label: 'Forecast', color: FC_COLOR, dashed: true }] }));
}
// Each year's use by month (the sheet's bar charts): a bar per year, darker for older years.
function YearBars(props) {
    var st = props.stats, f = FUEL_BY_ID[props.fuel];
    var ys = Object.keys(st.years).sort().slice(-5);
    if (!ys.length) return null;
    var all = [];
    ys.forEach(function (y) { st.years[y][props.fuel].forEach(function (v) { if (v != null) all.push(v); }); });
    var max = niceRange(0, Math.max.apply(null, all.concat([1])), true);
    var step = (CW - PAD_L) / 12, bw = Math.max(2, (step - 4) / ys.length);
    var shade = function (i) { return 0.18 + 0.82 * (ys.length === 1 ? 1 : i / (ys.length - 1)); };
    var bars = [];
    ys.forEach(function (y, yi) {
        st.years[y][props.fuel].forEach(function (v, c) {
            if (v == null) return;
            var x = PAD_L + step * c + 2 + bw * yi, top = yOf(v, max);
            bars.push(E('rect', { key: y + c, x: x, y: top, width: Math.max(1, bw - 0.6), height: Math.max(0, yOf(0, max) - top), fill: f.color, fillOpacity: shade(yi) }));
        });
    });
    return E('div', null,
        E('svg', { viewBox: '0 0 ' + CW + ' ' + CH, width: '100%', style: { display: 'block' }, 'aria-label': f.label + ' use by year' }, E(Axes, { range: max }), bars),
        E(Legend, { items: ys.map(function (y, yi) { return { label: y, color: 'rgba(' + (props.fuel === 'gas' ? '52,211,153,' : '96,165,250,') + shade(yi) + ')', bar: true }; }) }));
}

function StatLine(props) {
    var ui = useUI();
    var bits = [fmtPctSigned(props.vsAvg) && fmtPctSigned(props.vsAvg) + ' vs average', fmtPctSigned(props.vsLy) && fmtPctSigned(props.vsLy) + ' vs year before'].filter(Boolean);
    return E('div', { style: { padding: '6px 0', fontFamily: ui.sys } },
        E('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            E('span', { style: { width: 8, height: 8, borderRadius: 2, background: props.color, flexShrink: 0 } }),
            E('span', { style: { fontSize: 14, color: ui.C.zinc400, flex: 1 } }, props.label),
            E('span', { style: { fontSize: 14, color: ui.C.white, fontVariantNumeric: 'tabular-nums' } }, fmtKwh(props.kwh))),
        bits.length > 0 && E('div', { style: { fontSize: 12, color: ui.C.zinc600, textAlign: 'right', marginTop: 2 } }, bits.join(' · ')));
}

var _usageFuel = 'elec', _usageAll = false;
var COL_W = 70;
// One fuel's share of the forecast: kWh × unit rate, plus days × standing charge.
function ForecastSum(props) {
    var ui = useUI(), f = props.fuel, x = props.part, p = props.privacy;
    var row = function (l, v) {
        return E('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, color: ui.C.zinc600, marginTop: 2 } },
            E('span', null, l), E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, v));
    };
    return E('div', { style: { padding: '8px 0', fontFamily: ui.sys, fontVariantNumeric: 'tabular-nums' } },
        E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            E('span', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: ui.C.white } },
                E('span', { style: { width: 8, height: 8, borderRadius: 2, background: f.color } }), f.label),
            E('span', { style: money(ui, 14, p, ui.C.white, 600) }, x ? fmtGBP(x.energy + x.standingCost) : '—')),
        x ? [row(fmtKwh(props.kwh) + (props.adjust ? ' (' + fmtPctSigned(props.adjust) + ')' : '') + ' × ' + fmtRate(x.unit) + ' per kWh', fmtGBP(x.energy)),
             row(x.days + ' days × ' + fmtRate(x.standing) + ' a day', fmtGBP(x.standingCost))].map(function (r, i) { return E(React.Fragment, { key: i }, r); })
          : row(fmtKwh(props.kwh) + ', no unit rate yet', ''));
}

function UsageView(props) {
    var ui = useUI(), b = props.bill, p = props.privacy;
    var usage = b.usage || { months: [], meters: {} };
    var st = React.useMemo(function () { return usageStats(usage); }, [b.usage]);
    var fuel = React.useState(_usageFuel), all = React.useState(_usageAll), copied = React.useState(null);
    var setFuel = function (v) { _usageFuel = v; fuel[1](v); };
    var billYear = b.formula ? null : b.annual;   // a bill that follows this page would only compare with itself
    if (!st.months.length) {
        return E('div', { style: { padding: '16px' } },
            E('div', { style: cardStyle(ui, { padding: '22px 18px', textAlign: 'center' }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 16, color: ui.C.white, fontWeight: 600, marginBottom: 6 } }, 'No usage yet'),
                E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 16 } },
                    'Paste your usage sheet (a row per month: electricity kWh, standing charge, unit rate, cost, then the same for gas) or add months one at a time.'),
                E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    E('button', { style: buttonStyle(ui, 'primary'), onClick: props.onPaste }, 'Paste from spreadsheet'),
                    E('button', { style: buttonStyle(ui), onClick: function () { props.onMonth(null); } }, '+ Add month'))));
    }
    var range = st.latest ? monthLabel(monthOf(monthNo(st.latest) - 11)) + ' – ' + monthLabel(st.latest) : '';
    var diff = st.annual != null && billYear ? st.annual - billYear : null;
    var fc = st.forecast, fcDiff = fc && fc.cost != null && billYear ? fc.cost - billYear : null;
    var fromTariff = ['elec', 'gas'].some(function (k) { return st.rates[k] && st.rates[k].from === 'tariff'; });
    var rateFrom = ['elec', 'gas'].map(function (k) { return st.rates[k] && st.rates[k].from !== 'tariff' ? st.rates[k].from : null; }).filter(Boolean).sort().pop();
    var list = st.months.slice().reverse(), shown = all[0] ? list : list.slice(0, 12);
    var meters = METER_FIELDS.filter(function (f) { return usage.meters && usage.meters[f.id]; });
    function copy(id, v) { copyText(v).then(function (ok) { copied[1](ok ? id : null); if (ok) setTimeout(function () { copied[1](null); }, 1500); }); }
    var vsBill = function (d) {
        return d == null ? null : E('span', { style: { color: d > 0 ? ui.C.amber : ui.C.zinc400 } },
            E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(Math.abs(d))), d > 0 ? ' more than' : ' less than', ' the bill’s ', E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(billYear)), ' a year');
    };
    return E('div', { style: { padding: '12px 16px 0' } },
        // The rolling year, as the sheet's Annual Cost.
        E('div', { style: cardStyle(ui, { padding: '18px 20px' }) },
            E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                E('span', { style: capsLabel(ui) }, 'Last 12 months'),
                E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600 } }, range)),
            E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 } },
                E('span', { style: money(ui, 32, p) }, st.annual == null ? '—' : fmtGBP(st.annual)),
                E('span', { style: { fontFamily: ui.sys, fontSize: 15, color: ui.C.zinc600 } }, 'energy cost')),
            diff != null && E('div', { style: { fontFamily: ui.sys, fontSize: 13, marginTop: 4 } }, vsBill(diff)),
            st.annual == null && E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, marginTop: 4 } }, 'Needs 12 months of readings.'),
            st.current && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, marginTop: 4 } },
                'Same use at today’s rates: ', E('span', { style: { filter: p ? 'blur(6px)' : 'none' } }, fmtGBP(st.current.cost))),
            E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 14, paddingTop: 8 } },
                FUELS.map(function (f) { return E(StatLine, { key: f.id, label: f.label, color: f.color, kwh: st.running[f.id], vsAvg: st.vsAverage[f.id], vsLy: st.vsLastYear[f.id] }); }))),
        // The forecast.
        fc && E('div', { style: cardStyle(ui, { padding: '18px 20px', marginTop: 12 }) },
            E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
                E('span', { style: Object.assign(capsLabel(ui), { color: FC_COLOR }) }, 'Next 12 months'),
                E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600 } }, monthLabel(fc.months[0].month) + ' – ' + monthLabel(fc.months[11].month))),
            E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 } },
                E('span', { style: money(ui, 28, p) }, fc.cost == null ? '—' : fmtGBP(fc.cost)),
                E('span', { style: { fontFamily: ui.sys, fontSize: 14, color: ui.C.zinc600 } }, fc.cost == null ? 'add unit rates to price it' : 'forecast · ' + fmtGBP(fc.cost / 12) + ' a month')),
            fcDiff != null && E('div', { style: { fontFamily: ui.sys, fontSize: 13, marginTop: 4 } }, vsBill(fcDiff)),
            // How the figure is worked out, fuel by fuel.
            E('div', { style: { borderTop: '1px solid ' + ui.C.border, marginTop: 14, paddingTop: 4 } },
                FUELS.map(function (f) { return E(ForecastSum, { key: f.id, fuel: f, kwh: fc.kwh[f.id], part: fc.parts[f.id], days: fc.days, adjust: fc.adjust[f.id], privacy: p }); })),
            E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 6 } },
                E('span', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, lineHeight: 1.4 } },
                    fromTariff ? 'Rates: your tariff' + (rateFrom ? ', gaps from ' + monthLabel(rateFrom) : '') : rateFrom ? 'Rates: from ' + monthLabel(rateFrom) : 'No rates yet'),
                E(Chip, { onClick: props.onTariff }, fromTariff ? 'Edit rates' : 'Set rates')),
            E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 14 } },
                E('span', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc400 } }, 'Weight on last 12 months'),
                E(Segmented, { options: WEIGHTS, value: WEIGHTS.filter(function (w) { return Math.abs(w.id - fc.weight) < 0.01; }).map(function (w) { return w.id; })[0],
                    onChange: function (v) { saveUsage(props.state, b.id, Object.assign({}, usage, { weight: v })); } })),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.4 } },
                'Each month blends last year’s use with the average of earlier years. 67% counts last year twice as much; 100% repeats last year.'),
            // Tone down (or up) a fuel when the next year won't look like the last one.
            E('div', { style: { fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc400, marginTop: 16 } }, 'Adjust for changes at home'),
            FUELS.map(function (f) {
                return E('div', { key: f.id, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 8 } },
                    E('span', { style: { display: 'flex', alignItems: 'center', gap: 6, width: 92, flexShrink: 0, fontFamily: ui.sys, fontSize: 12.5, color: ui.C.zinc400 } },
                        E('span', { style: { width: 8, height: 8, borderRadius: 2, background: f.color } }), f.label),
                    E('div', { style: { flex: 1, minWidth: 0 } }, E(Segmented, { fill: true, tight: true, options: ADJUSTS, value: ADJUSTS.filter(function (a) { return Math.abs(a.id - fc.adjust[f.id]) < 0.001; }).map(function (a) { return a.id; })[0],
                        onChange: function (v) { var a = Object.assign({}, usage.adjust || {}); a[f.id] = v; saveUsage(props.state, b.id, Object.assign({}, usage, { adjust: a })); } })));
            }),
            E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, marginTop: 8, lineHeight: 1.4 } },
                'Scales that fuel’s forecast use, for a year that won’t repeat: fewer people home in the day, a new appliance.')),
        // Charts.
        E('div', { style: cardStyle(ui, { padding: '16px 16px 14px', marginTop: 12 }) },
            E('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
                E('span', { style: capsLabel(ui) }, 'Use by month'),
                E(Segmented, { options: FUELS, value: fuel[0], onChange: setFuel })),
            E(SeasonChart, { stats: st, fuel: fuel[0] }),
            E('div', { style: Object.assign(capsLabel(ui), { margin: '18px 0 10px' }) }, 'Each year'),
            E(YearBars, { stats: st, fuel: fuel[0] })),
        // Months.
        E('div', { style: Object.assign(capsLabel(ui), { margin: '22px 4px 8px' }) }, 'Months'),
        E('div', { style: cardStyle(ui, { overflow: 'hidden' }) },
            // Column heads, laid out like the rows so each sits over its column.
            E('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 14px 8px', borderBottom: '1px solid ' + ui.C.border, fontFamily: ui.sys, fontSize: 12, fontWeight: 600, color: ui.C.zinc600, lineHeight: 1.25 } },
                E('span', { style: { flex: 1 } }, 'Month'),
                E('span', { style: { width: COL_W, textAlign: 'right', color: FUELS[0].color } }, 'Electricity', E('br'), 'kWh'),
                E('span', { style: { width: COL_W, textAlign: 'right', color: FUELS[1].color } }, 'Gas', E('br'), 'kWh'),
                E('span', { style: { width: COL_W, textAlign: 'right' } }, 'Cost')),
            shown.map(function (m, i) {
                var c = monthCost(m), partial = !hasReading(m);
                return E('button', { key: m.month, onClick: function () { props.onMonth(m.month); },
                    style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '11px 14px', background: 'none', border: 'none', borderTop: i ? '1px solid ' + ui.C.border : 'none',
                             textAlign: 'left', cursor: 'pointer', fontFamily: ui.sys, fontVariantNumeric: 'tabular-nums' } },
                    E('span', { style: { flex: 1, fontSize: 14, color: ui.C.white } }, monthLabel(m.month), partial && E('span', { style: { color: ui.C.zinc600, fontSize: 12 } }, ' · so far')),
                    E('span', { style: { width: COL_W, textAlign: 'right', fontSize: 13, color: FUELS[0].color } }, m.elec && m.elec.kwh != null ? Math.round(m.elec.kwh).toLocaleString('en-GB') : '—'),
                    E('span', { style: { width: COL_W, textAlign: 'right', fontSize: 13, color: FUELS[1].color } }, m.gas && m.gas.kwh != null ? Math.round(m.gas.kwh).toLocaleString('en-GB') : '—'),
                    E('span', { style: Object.assign(money(ui, 13.5, p, ui.C.white, 600), { width: COL_W, textAlign: 'right' }) }, c == null ? '—' : fmtGBP(c)));
            }),
            list.length > 12 && E('button', { onClick: function () { _usageAll = !all[0]; all[1](!all[0]); },
                style: { display: 'block', width: '100%', padding: '11px', background: 'none', border: 'none', borderTop: '1px solid ' + ui.C.border, color: TEAL, fontFamily: ui.sys, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' } },
                all[0] ? 'Show the last 12' : 'Show all ' + list.length + ' months')),
        E('div', { style: { display: 'flex', gap: 10, marginTop: 14 } },
            // A month in progress (rates or a part cost, no reading yet) is the one to fill in next.
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { flex: 1 }), onClick: function () { props.onMonth(list[0] && !hasReading(list[0]) ? list[0].month : null); } },
                list[0] && !hasReading(list[0]) ? 'Finish ' + monthLabel(list[0].month) : '+ Add month'),
            E('button', { style: Object.assign(buttonStyle(ui), { flex: 1 }), onClick: props.onPaste }, 'Paste from sheet')),
        // Meters.
        E('div', { style: Object.assign(capsLabel(ui), { margin: '22px 4px 8px' }) }, 'Meters'),
        E('div', { style: cardStyle(ui, { padding: '2px 14px 6px' }) },
            meters.map(function (f, i) {
                return E(Field, { key: f.id, label: f.label },
                    E('span', { style: { fontVariantNumeric: 'tabular-nums', filter: p ? 'blur(6px)' : 'none', overflow: 'hidden', textOverflow: 'ellipsis' } }, usage.meters[f.id]),
                    E(Chip, { onClick: function () { copy(f.id, usage.meters[f.id]); } }, copied[0] === f.id ? 'Copied' : 'Copy'));
            }),
            E('button', { onClick: props.onMeters, style: { display: 'block', width: '100%', background: 'none', border: 'none', color: TEAL, fontFamily: ui.sys, fontSize: 13.5, padding: '10px 0 6px', cursor: 'pointer', textAlign: 'left' } },
                meters.length ? 'Edit meter numbers' : '+ Add meter numbers (MPAN, MPRN, serials)')));
}

// One month: readings, rates and cost for each fuel, and any support.
function UsageMonthView(props) {
    var ui = useUI(), b = props.bill, usage = b.usage || { months: [], meters: {} };
    var existing = props.month ? usage.months.filter(function (m) { return m.month === props.month; })[0] : null;
    var rates = latestRates(usage.months);
    var lastKey = usage.months.length ? usage.months[usage.months.length - 1].month : todayISO().slice(0, 7);
    var str = function (v) { return v == null ? '' : String(v); };
    // Gas in m³ (what the meter shows) or kWh (what the bill charges); a new month follows the last one that had gas.
    var lastGas = usage.months.filter(function (m) { return m.gas && m.gas.kwh != null; }).pop();
    var f = React.useState(function () {
        var m = existing || {};
        var fuel = function (k) {
            var x = m[k] || {}, r = rates[k] || {};
            return { kwh: str(x.kwh), standing: str(existing ? x.standing : r.standing), unit: str(existing ? x.unit : r.unit), cost: str(x.cost),
                     m3: str(x.m3), cv: str(x.cv != null ? x.cv : lastGas && lastGas.gas.cv) };
        };
        var gasUnit = existing ? (existing.gas && existing.gas.m3 != null ? 'm3' : 'kwh') : (lastGas && lastGas.gas.m3 != null ? 'm3' : 'kwh');
        return { month: existing ? existing.month : (usage.months.length ? monthOf(monthNo(lastKey) + 1) : lastKey), elec: fuel('elec'), gas: fuel('gas'), support: str(m.support), gasUnit: gasUnit };
    });
    var form = f[0], err = React.useState(null), del = React.useState(false);
    function set(k, sub, v) { var n = JSON.parse(JSON.stringify(form)); if (sub) n[k][sub] = v; else n[k] = v; f[1](n); }
    var toNum = function (v) { var t = String(v).replace(/[£,\s]/g, ''); return t === '' ? null : /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
    var fuelOut = function (k) {
        var x = form[k], o = { kwh: toNum(x.kwh), standing: toNum(x.standing), unit: toNum(x.unit), cost: toNum(x.cost) };
        if (k === 'gas' && form.gasUnit === 'm3') {
            o.m3 = toNum(x.m3); o.cv = toNum(x.cv);
            o.kwh = o.m3 == null || isNaN(o.m3) || isNaN(o.cv) ? o.m3 : Math.round(m3ToKwh(o.m3, o.cv) * 10) / 10;
        }
        return o;
    };
    function save() {
        if (!MONTH_KEY.test(form.month)) return err[1]('Pick the month.');
        var m = { month: form.month, elec: fuelOut('elec'), gas: fuelOut('gas'), support: toNum(form.support) };
        var bad = [m.elec, m.gas].some(function (x) { return Object.keys(x).some(function (k) { return isNaN(x[k]) && x[k] !== null; }); }) || (m.support !== null && isNaN(m.support));
        if (bad) return err[1]('Use plain numbers: kWh or m³, and £ for rates and costs (0.245 for 24.5p).');
        if (m.gas.cv != null && (m.gas.cv < 30 || m.gas.cv > 50)) return err[1]('The calorific value is usually 37 to 43 MJ/m³; it’s on your bill.');
        var months = usage.months.filter(function (x) { return x.month !== m.month && (!existing || x.month !== existing.month); }).concat([m]);
        saveUsage(props.state, b.id, Object.assign({}, usage, { months: months }));
        props.onDone();
    }
    function remove() {
        if (!del[0]) { del[1](true); setTimeout(function () { del[1](false); }, 4000); return; }
        saveUsage(props.state, b.id, Object.assign({}, usage, { months: usage.months.filter(function (x) { return x.month !== existing.month; }) }));
        props.onDone();
    }
    var box = function (k, sub, ph) {
        return E('input', { value: sub ? form[k][sub] : form[k], inputMode: 'decimal', placeholder: ph || '',
                            onChange: function (e) { set(k, sub, e.target.value); }, style: inputStyle(ui) });
    };
    var fuelBlock = function (fu) {
        var gasM3 = fu.id === 'gas' ? form.gasUnit === 'm3' : null;
        var x = fuelOut(fu.id), est = !isNaN(x.kwh) && !isNaN(x.unit) && x.kwh != null && x.unit != null && MONTH_KEY.test(form.month)
            ? x.kwh * x.unit + (isNaN(x.standing) ? 0 : x.standing || 0) * daysIn(form.month) : null;
        return E('div', { key: fu.id, style: cardStyle(ui, { padding: '14px 14px 2px', marginBottom: 12 }) },
            E('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
                E('span', { style: { fontFamily: ui.sys, fontSize: 14, fontWeight: 600, color: fu.color } }, fu.label),
                gasM3 != null && E(Segmented, { options: GAS_UNITS, value: form.gasUnit, onChange: function (v) { set('gasUnit', null, v); } })),
            gasM3 ? E('div', { style: { display: 'flex', gap: 10 } },
                E(Label, { text: 'Used (m³)', flex: 1 }, box(fu.id, 'm3')),
                E(Label, { text: 'Calorific value (MJ/m³)', flex: 1 }, box(fu.id, 'cv', String(DEFAULT_CV)))) : null,
            E('div', { style: { display: 'flex', gap: 10 } },
                gasM3 ? E(Label, { text: 'Used (kWh)', flex: 1 },
                        E('div', { style: inputStyle(ui, { display: 'flex', alignItems: 'center', color: ui.C.zinc400 }) }, x.kwh != null && !isNaN(x.kwh) ? Math.round(x.kwh).toLocaleString('en-GB') : '—'))
                      : E(Label, { text: 'Used (kWh)', flex: 1 }, box(fu.id, 'kwh')),
                E(Label, { text: 'Cost (£)', flex: 1 }, box(fu.id, 'cost', est != null ? est.toFixed(2) : ''))),
            E('div', { style: { display: 'flex', gap: 10 } },
                E(Label, { text: 'Unit rate (£ per kWh)', flex: 1 }, box(fu.id, 'unit', '0.245')),
                E(Label, { text: 'Standing (£ a day)', flex: 1 }, box(fu.id, 'standing', '0.50'))),
            gasM3 ? E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600, lineHeight: 1.4, marginBottom: 12, marginTop: -2 } },
                'kWh = m³ × 1.02264 × calorific value ÷ 3.6, the way your supplier converts it. Leave the calorific value blank to use ' + DEFAULT_CV + '.') : null);
    };
    return E('div', { style: { padding: '16px 16px 0' } },
        E(Label, { text: 'Month' }, E('input', { type: 'month', value: form.month, onChange: function (e) { set('month', null, e.target.value); }, style: inputStyle(ui) })),
        FUELS.map(fuelBlock),
        E(Label, { text: 'Government support (£, taken off the cost)' }, box('support', null)),
        E('div', { style: { fontFamily: ui.sys, fontSize: 12, color: ui.C.zinc600, lineHeight: 1.45, marginBottom: 14 } },
            'Leave Cost blank to work it out: kWh × unit rate + standing charge × days in the month. Rates are in pounds (0.245 is 24.5p) and start as last month’s.'),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            E('button', { style: buttonStyle(ui, 'primary'), onClick: save }, existing ? 'Save' : 'Add month'),
            existing && E('button', { style: buttonStyle(ui, 'danger'), onClick: remove }, del[0] ? 'Tap again to delete' : 'Delete month')));
}

function UsagePasteView(props) {
    var ui = useUI(), b = props.bill;
    var txt = React.useState(''), done = React.useState(null);
    var parsed = React.useMemo(function () { return parseUsagePaste(txt[0]); }, [txt[0]]);
    var meterNames = METER_FIELDS.filter(function (f) { return parsed.meters[f.id]; }).map(function (f) { return f.label; });
    function add() {
        var replaced = ((b.usage && b.usage.months) || []).filter(function (m) { return parsed.months.some(function (x) { return x.month === m.month; }); }).length;
        saveUsage(props.state, b.id, mergeUsage(b.usage, parsed));
        done[1]({ months: parsed.months.length, replaced: replaced });
        txt[1]('');
    }
    var first = parsed.months[0], last = parsed.months[parsed.months.length - 1];
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, lineHeight: 1.5, marginBottom: 12 } },
            'Copy your usage sheet, header rows included, and paste it below. A row per month (‘April 2021’): electricity kWh, standing charge, unit rate and cost, the same for gas (kWh, or m³ with a calorific value column), then government support. Rates and costs in pounds. Pasted months replace the same months already here.'),
        E('textarea', { value: txt[0], rows: 6, placeholder: 'Paste here', onChange: function (e) { txt[1](e.target.value); done[1](null); },
                        autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false,
                        style: inputStyle(ui, { height: 'auto', padding: '10px', fontSize: 13, fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical', whiteSpace: 'pre', overflowX: 'auto' }) }),
        done[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.emerald, margin: '12px 0' } },
            'Saved ' + done[0].months + ' months' + (done[0].replaced ? ' (' + done[0].replaced + ' replaced)' : '') + '.'),
        parsed.months.length > 0 && E('div', { style: cardStyle(ui, { padding: '14px', marginTop: 14, fontFamily: ui.sys }) },
            E('div', { style: { fontSize: 14, color: ui.C.white, fontWeight: 600 } }, parsed.months.length + ' months · ' + monthLabel(first.month) + ' – ' + monthLabel(last.month)),
            E('div', { style: { fontSize: 12.5, color: ui.C.zinc600, marginTop: 4, lineHeight: 1.45 } },
                parsed.months.filter(hasReading).length + ' with readings' + (meterNames.length ? ' · meter numbers: ' + meterNames.join(', ') : '') +
                (parsed.skipped ? ' · ' + parsed.skipped + ' empty months skipped' : '')),
            E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%', marginTop: 12 }), onClick: add }, 'Save ' + parsed.months.length + ' months')),
        txt[0].trim() && !parsed.months.length && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.amber, marginTop: 12 } },
            'No months found. Each row should start with the month, like ‘April 2021’.'));
}

// The rates the forecast uses: Fergus's current tariff. Blank fields fall back to the latest month's.
function TariffView(props) {
    var ui = useUI(), b = props.bill, usage = b.usage || { months: [], meters: {} };
    var latest = latestRates(usage.months), t = usage.tariff || {};
    var str = function (v) { return v == null ? '' : String(v); };
    var f = React.useState(function () {
        var o = {};
        FUELS.forEach(function (fu) { var x = t[fu.id] || {}; o[fu.id] = { unit: str(x.unit), standing: str(x.standing) }; });
        return o;
    });
    var err = React.useState(null);
    var toNum = function (v) { var s2 = String(v).replace(/[£,\s]/g, ''); return s2 === '' ? null : /^\d+(\.\d+)?$/.test(s2) ? Number(s2) : NaN; };
    function set(k, sub, v) { var n = JSON.parse(JSON.stringify(f[0])); n[k][sub] = v; f[1](n); }
    function save() {
        var out = {}, bad = false;
        FUELS.forEach(function (fu) {
            var u = toNum(f[0][fu.id].unit), sd = toNum(f[0][fu.id].standing);
            if (isNaN(u) || isNaN(sd)) bad = true;
            out[fu.id] = { unit: u, standing: sd };
        });
        if (bad) return err[1]('Use plain numbers in pounds: 0.245 for 24.5p.');
        saveUsage(props.state, b.id, Object.assign({}, usage, { tariff: out }));
        props.onDone();
    }
    var hint = function (k, sub) {
        var v = toNum(f[0][k][sub]);
        return v != null && !isNaN(v) ? '= ' + fmtRate(v) + (sub === 'unit' ? ' per kWh' : ' a day') : '';
    };
    return E('div', { style: { padding: '16px 16px 0' } },
        E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc400, lineHeight: 1.5, marginBottom: 14 } },
            'Your current tariff, from your supplier’s app or bill. The forecast prices each fuel at these. Leave a box blank to use the latest month’s rate.'),
        FUELS.map(function (fu) {
            var l = latest[fu.id];
            var box = function (sub) {
                return E('input', { value: f[0][fu.id][sub], inputMode: 'decimal', placeholder: l ? String(sub === 'unit' ? l.unit : l.standing) : '',
                                    onChange: function (e) { set(fu.id, sub, e.target.value); }, style: inputStyle(ui) });
            };
            return E('div', { key: fu.id, style: cardStyle(ui, { padding: '14px 14px 2px', marginBottom: 12 }) },
                E('div', { style: { fontFamily: ui.sys, fontSize: 14, fontWeight: 600, color: fu.color, marginBottom: 10 } }, fu.label),
                E('div', { style: { display: 'flex', gap: 10 } },
                    E(Label, { text: 'Unit rate (£ per kWh)', flex: 1 }, box('unit'),
                        E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600, minHeight: 16, marginTop: 4 } }, hint(fu.id, 'unit'))),
                    E(Label, { text: 'Standing (£ a day)', flex: 1 }, box('standing'),
                        E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc600, minHeight: 16, marginTop: 4 } }, hint(fu.id, 'standing')))),
                l && E('div', { style: { fontFamily: ui.sys, fontSize: 11.5, color: ui.C.zinc700, marginBottom: 12 } },
                    'Latest month (' + monthLabel(l.from) + '): ' + fmtRate(l.unit) + ' per kWh, ' + fmtRate(l.standing) + ' a day'));
        }),
        err[0] && E('div', { style: { fontFamily: ui.sys, fontSize: 13, color: ui.C.rose, marginBottom: 10 } }, err[0]),
        E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%' }), onClick: save }, 'Save rates'));
}

function MetersView(props) {
    var ui = useUI(), b = props.bill, usage = b.usage || { months: [], meters: {} };
    var f = React.useState(function () { var o = {}; METER_FIELDS.forEach(function (x) { o[x.id] = (usage.meters && usage.meters[x.id]) || ''; }); return o; });
    function save() {
        saveUsage(props.state, b.id, Object.assign({}, usage, { meters: f[0] }));
        props.onDone();
    }
    return E('div', { style: { padding: '16px 16px 0' } },
        METER_FIELDS.map(function (x) {
            return E(Label, { key: x.id, text: x.label }, E('input', { value: f[0][x.id], autoCapitalize: 'characters', autoCorrect: 'off', spellCheck: false,
                onChange: function (e) { var n = Object.assign({}, f[0]); n[x.id] = e.target.value; f[1](n); }, style: inputStyle(ui) }));
        }),
        E('button', { style: Object.assign(buttonStyle(ui, 'primary'), { width: '100%' }), onClick: save }, 'Save'));
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
    // The usage page's own forms go back to it; everything else goes back to the bills.
    var toUsage = function () { setView({ name: 'usage', id: view.id }); };
    var inUsage = view.name === 'usageMonth' || view.name === 'usagePaste' || view.name === 'meters' || view.name === 'tariff';
    var back = view.name === 'main' ? null : inUsage ? toUsage : function () { setView({ name: 'main' }); };
    var bill = view.id ? bills.filter(function (b) { return b.id === view.id; })[0] : null;
    var body;
    if (!_ready) body = E('div', { style: { padding: 32, textAlign: 'center', fontFamily: ui.sys, fontSize: 13, color: ui.C.zinc600 } }, 'Loading…');
    else if (view.name === 'edit') body = E(EditView, { id: view.id, state: state, estate: estate, onDone: back });
    else if (view.name === 'paste') body = E(PasteView, { state: state, estate: estate, privacy: props.privacyMode });
    else if (view.name === 'usage' && bill) body = E(UsageView, { bill: bill, state: state, privacy: props.privacyMode,
        onMonth: function (mk) { setView({ name: 'usageMonth', id: bill.id, month: mk }); },
        onPaste: function () { setView({ name: 'usagePaste', id: bill.id }); }, onMeters: function () { setView({ name: 'meters', id: bill.id }); },
        onTariff: function () { setView({ name: 'tariff', id: bill.id }); } });
    else if (view.name === 'tariff' && bill) body = E(TariffView, { bill: bill, state: state, onDone: toUsage });
    else if (view.name === 'usageMonth' && bill) body = E(UsageMonthView, { bill: bill, month: view.month, state: state, onDone: toUsage });
    else if (view.name === 'usagePaste' && bill) body = E(UsagePasteView, { bill: bill, state: state });
    else if (view.name === 'meters' && bill) body = E(MetersView, { bill: bill, state: state, onDone: toUsage });
    else body = E(MainView, { bills: bills, privacy: props.privacyMode, onPaste: function () { setView({ name: 'paste' }); },
                              onEdit: function (id) { setView({ name: 'edit', id: id }); }, onUsage: function (id) { setView({ name: 'usage', id: id }); } });
    var title = view.name === 'paste' ? 'Paste bills' : view.name === 'usage' ? (bill ? bill.name : '') + ' usage'
        : view.name === 'usageMonth' ? (view.month ? monthLabel(view.month) : 'Add month') : view.name === 'usagePaste' ? 'Paste usage'
        : view.name === 'meters' ? 'Meter numbers' : view.name === 'tariff' ? 'Forecast rates' : view.id ? 'Edit bill' : 'Add bill';
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
    sortBills: sortBills, renewalAlerts: renewalAlerts, hintFor: hintFor, guessCategory: guessCategory, subLine: subLine,
    validUsage: validUsage, parseUsagePaste: parseUsagePaste, mergeUsage: mergeUsage, usageStats: usageStats, monthCost: monthCost, fuelCost: fuelCost, isEnergyBill: isEnergyBill, m3ToKwh: m3ToKwh };
})();
