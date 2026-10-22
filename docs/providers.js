// Price providers: API keys, gilt yields, the daily cross-check, Twelve Data / Alpha Vantage / Marketstack fetchers, live-quote gate, exchange hours and the restricted-shares timeline.
// Loaded by index.html before app.js, in the order core, providers, sync, widgets, components; shares their globals (no module system, no build step).


// ══════════════════════════════════════════════════════════════════════════════
// DAILY-CLOSE VERIFICATION — one module for every "Today" / 1D figure in the app
// ──────────────────────────────────────────────────────────────────────────────
// Used by: Holdings "Today", restricted schemes (Citi / HSBC), and the Markets tab.
//
// Why: Yahoo's daily series sometimes omits a session (22 Sep 2026: FLRK, SEMI,
// SMGB, EQGB, IGUS and Citi all had no Tuesday bar), and the old resolvers then
// silently paired today's price with an older session, showing a multi-day move
// as Today. The Markets tab additionally preferred meta.chartPreviousClose, which
// on a range=5d request is the close from BEFORE the 5-day window, and dated FX
// bars in UTC, which during BST files each London-day bar under the previous date.
//
// The rules, applied identically everywhere:
//   1. Bars are dated in the instrument's own exchange timezone (Yahoo's
//      meta.exchangeTimezoneName), never UTC.
//   2. The previous close must be from the exchange's previous trading session
//      (weekends + holiday calendars below). If no source has that session, the
//      figure shows "—" — a multi-day move is never presented as one day.
//   3. Where a free second source covers the instrument, closes are cross-checked:
//        US equities, FX, crypto → Twelve Data (free tier: US equities/FX/crypto)
//        LSE-listed              → Alpha Vantage (free tier covers LSE via .LON;
//                                  25 requests/day, called directly — see below)
//        Indices and yields      → no free second source; Yahoo + rule 2 only
//      Each date is graded: verified / yahoo-only / alt-only / conflict.
//      A conflict on the previous-close date shows "—" (no third source to break it).
//   4. A per-instrument plausibility ceiling catches unit errors and garbage bars.
//
// Today's price is always Yahoo's regularMarketPrice. The existing session guards
// (weekend, Monday pre-market, stale quotes) decide WHICH session "today" is; this
// module decides what the previous close is.
// ══════════════════════════════════════════════════════════════════════════════

const DAILY_VERIFY_TOLERANCE = 0.005;          // 0.5 % default cross-source agreement band

// Twelve Data free tier: 8 credits/minute, 800/day; 1 credit per symbol, batchable.
const TD_CREDITS_PER_MIN  = 8;
const TD_REFETCH_MS       = 30 * 60 * 1000;    // re-ask while the expected prev session is missing
const TD_ERROR_RETRY_MS   = 15 * 60 * 1000;
const TD_MINUTE_RETRY_MS  = 65 * 1000;         // per-minute credit limit hit → retry next minute
const TD_CACHE_KEY        = 'twelvedata_daily_cache_v1';
const TD_APIKEY_STORAGE   = 'twelvedata_api_key';

// Alpha Vantage free tier: 25 requests/day, 5/minute. No batch endpoint.
const AV_DAILY_BUDGET     = 25;                // the real daily cap — Marketstack is now the buffer
const AV_MIN_INTERVAL_MS  = 13000;             // > 12 s between calls keeps under 5/minute
const AV_REFETCH_MS       = 2 * 60 * 60 * 1000;// re-ask at most every 2 h while prev session missing
const AV_ERROR_RETRY_MS   = 15 * 60 * 1000;
const AV_CACHE_KEY        = 'alphavantage_daily_cache_v1';
const AV_BUDGET_KEY       = 'alphavantage_budget_v1';
const AV_APIKEY_STORAGE   = 'alphavantage_api_key';

// Marketstack free tier: 100 requests/MONTH (1 request per symbol, batching only
// saves round-trips, not quota). Since 29 Sep 2026 it is the FALLBACK FOR THE US HOLDING (Citi, NYSE)
// only — used when Twelve Data has no usable answer for it, or on a manual Marketstack re-check.
// It is NOT used for London holdings any more. FINDING (29 Sep 2026, from a real export + Marketstack's docs):
// this account returns no London data — "HSBA", "HSBA.XLON" (+exchange=XLON) came back HTTP 200 with an empty
// result on 28 Sep, and "HSBA.L" was rejected outright (HTTP 422 no_valid_symbols_provided) on 29 Sep. Marketstack's
// v2 documentation lists the EOD exchanges as NASDAQ, PINK, SHG, NYSE, NYSE ARCA, OTCQB and BATS — no London.
// (Its ticker *search* does list ".L" names, but that does not mean the EOD endpoint serves them.)
// Alpha Vantage remains the LSE cross-check source.
const MS_MONTHLY_BUDGET   = 100;               // the real monthly cap — no self-imposed buffer
const MS_REFETCH_MS       = 6 * 60 * 60 * 1000;// re-ask at most every 6 h while prev session missing
const MS_ERROR_RETRY_MS   = 15 * 60 * 1000;
const MS_CACHE_KEY        = 'marketstack_daily_cache_v1';
const MS_BUDGET_KEY       = 'marketstack_budget_v1';
const MS_APIKEY_STORAGE   = 'marketstack_api_key';
// Endpoint + symbol form. v2 is tried first (Marketstack says new functionality is v2-only); v1 is used only if v2
// answers with an endpoint/plan/404-type error, and the version that worked is remembered. US symbols go bare
// ("C") with exchange=XNYS so a same-lettered ticker on another exchange can never be picked up by mistake.
const MS_FORMAT_KEY = 'marketstack_symbol_format_v1';
const MS_FORMAT_VERSION = 3;                        // v3: US-only, v2 endpoint, no London discovery — resets the old remembered/failed state
const MS_ENDPOINTS = [
    { id: 'v2', url: 'https://api.marketstack.com/v2/eod' },
    { id: 'v1', url: 'https://api.marketstack.com/v1/eod' },
];
const MS_US_EXCHANGE = 'XNYS';
const MS_ENDPOINT_ERROR_CODES = /function_access|https_access|invalid_api_function|404|not_found|endpoint/i;

// Exchange holiday calendars — full-day closures only (half-days trade normally).
// Sources: LSE/NYSE published calendars; JPX market-holiday page; KRX = Korean public
// holidays on weekdays + 1 May + 31 Dec; Eurex non-trading days (all derivatives).
// Only dates confirmed from those sources are listed. A holiday missing from a list
// produces a visible "—" the next trading day (safe); a wrongly listed trading day
// could hide a real gap (unsafe) — so uncertain dates are deliberately left out.
// ⚠ Extend each December. For a year not listed, the check still runs on a
// weekdays-only basis (so the day after a holiday shows "—"), and Settings →
// Daily close check flags that the calendar needs extending.
const EXCHANGE_CALENDARS = {
    LSE: {
        years: [2026, 2027],
        holidays: new Set([
            '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25',
            '2026-08-31', '2026-12-25', '2026-12-28',
            '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31',
            '2027-08-30', '2027-12-27', '2027-12-28',
        ]),
    },
    NYSE: {
        years: [2026, 2027],
        holidays: new Set([
            '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
            '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
            '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
            '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
        ]),
    },
    JPX: {
        years: [2026, 2027],
        holidays: new Set([
            '2026-01-01', '2026-01-02', '2026-01-12', '2026-02-11', '2026-02-23',
            '2026-03-20', '2026-04-29', '2026-05-04', '2026-05-05', '2026-05-06',
            '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23',
            '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-31',
            '2027-01-01', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-22',
            '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19',
            '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03',
            '2027-11-23', '2027-12-31',
        ]),
    },
    KRX: {
        years: [2026],
        holidays: new Set([
            '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02',
            '2026-05-01', '2026-05-05', '2026-05-25', '2026-06-03', '2026-08-17',
            '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25',
            '2026-12-31',
        ]),
    },
    EUREX: {
        years: [2026, 2027],
        holidays: new Set([
            '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25',
            '2027-01-01', '2027-03-26', '2027-03-29',
        ]),
    },
    FX:     { weekdaysOnly: true },   // every weekday is a session
    CRYPTO: { everyDay: true },       // every calendar day is a session
};

// Yahoo index / yield symbols → the calendar of the market that sets them.
const INDEX_CALENDAR = {
    '^GSPC': 'NYSE', '^SP500TR': 'NYSE', '^NDX': 'NYSE', '^RUT': 'NYSE', '^VIX': 'NYSE', '^DJI': 'NYSE', '^IXIC': 'NYSE',
    '^TNX': 'NYSE', '^FVX': 'NYSE', '^TYX': 'NYSE', '^IRX': 'NYSE',
    '^FTSE': 'LSE', '^FTMC': 'LSE',
    '^STOXX50E': 'EUREX', '^GDAXI': 'EUREX',
    '^N225': 'JPX',
    '^KS200': 'KRX', '^KS11': 'KRX',
};

function getTdApiKey()   { try { return (localStorage.getItem(TD_APIKEY_STORAGE) || '').trim(); } catch { return ''; } }
function setTdApiKey(k)  { try { localStorage.setItem(TD_APIKEY_STORAGE, String(k || '').trim()); } catch {} }
function getAvApiKey()   { try { return (localStorage.getItem(AV_APIKEY_STORAGE) || '').trim(); } catch { return ''; } }
function setAvApiKey(k)  { try { localStorage.setItem(AV_APIKEY_STORAGE, String(k || '').trim()); } catch {} }
function getMsApiKey()   { try { return (localStorage.getItem(MS_APIKEY_STORAGE) || '').trim(); } catch { return ''; } }
function setMsApiKey(k)  { try { localStorage.setItem(MS_APIKEY_STORAGE, String(k || '').trim()); } catch {} }

// ── giltsyield.com: market prices for the gilt ladder ─────────────────────────────────────────────────────────
// GET /api/portfolio/pl/<portfolio>/?apikey=KEY returns a CSV with one row per gilt booked in a (dummy) giltsyield
// portfolio. `dirty_price` is the dirty price per £100 nominal (clean + accrued, T+1 settlement), so it does not depend
// on the position size booked there. The file carries NO timestamp: the app dates each price itself (when it fetched it,
// as a London trading session) and never uses one older than GY_MAX_AGE_MS. Anything implausible is rejected and the gilt is
// left unpriced (there is no model estimate).
const GY_APIKEY_STORAGE    = 'giltsyield_api_key';
const GY_PORTFOLIO_STORAGE = 'giltsyield_portfolio';
const GY_CACHE_KEY         = 'giltsyield_snapshots_v1';
const GY_MIN_INTERVAL_MS   = 10 * 60 * 1000;          // automatic fetches are at least this far apart
const GY_MAX_AGE_MS        = 4 * 24 * 3600 * 1000;    // a stored price older than this is not used (long weekend + a day)
const GY_DIRTY_MIN = 50, GY_DIRTY_MAX = 130;          // per £100 nominal; outside this is not a gilt price
const GY_KEEP_SESSIONS = 12;
function getGyApiKey()     { try { return (localStorage.getItem(GY_APIKEY_STORAGE) || '').trim(); } catch { return ''; } }
function setGyApiKey(k)    { try { localStorage.setItem(GY_APIKEY_STORAGE, String(k || '').trim()); } catch {} }
function getGyPortfolio()  { try { return (localStorage.getItem(GY_PORTFOLIO_STORAGE) || '').trim() || 'Ferg'; } catch { return 'Ferg'; } }
function setGyPortfolio(p) { try { localStorage.setItem(GY_PORTFOLIO_STORAGE, String(p || '').trim()); } catch {} }

// ── Secrets file import (Settings → Data → Import Secrets File): API keys, backup token and passphrase, login hints ───────────────────────────────────────────────────────────
// A small CSV — setting,value — filled in once, privately, and loaded in one go instead of pasting each key into its field.
// The file is read in the browser and applied through the very same setters the fields use. No key value is ever shown,
// logged or kept: the file is not stored, and the messages below name only WHICH settings were set, never what they were set to.
// A blank value means "leave this one as it is" — an import can only add or replace a value, never clear one.
const API_KEY_SETTINGS = [
    { id: 'td',  name: 'twelve_data_api_key',   label: 'Twelve Data API key',      short: 'Twelve Data',   kind: 'key',  aliases: ['twelvedata', 'twelvedatakey'],
      get: () => getTdApiKey(), apply: v => { setTdApiKey(v); saveTdDailyCache({}); } },     // new key → forget cached Twelve Data results/errors (as the field does)
    { id: 'av',  name: 'alpha_vantage_api_key', label: 'Alpha Vantage API key',    short: 'Alpha Vantage', kind: 'key',  aliases: ['alphavantage', 'alphavantagekey'],
      get: () => getAvApiKey(), apply: v => setAvApiKey(v) },
    { id: 'ms',  name: 'marketstack_api_key',   label: 'Marketstack API key',      short: 'Marketstack',   kind: 'key',  aliases: ['marketstack', 'marketstackkey'],
      get: () => getMsApiKey(), apply: v => setMsApiKey(v) },
    { id: 'gy',  name: 'giltsyield_api_key',    label: 'giltsyield.com API key',   short: 'giltsyield',    kind: 'key',  aliases: ['giltsyield', 'giltsyieldkey'],
      get: () => getGyApiKey(), apply: v => setGyApiKey(v) },
    { id: 'gyp', name: 'giltsyield_portfolio',  label: 'giltsyield portfolio name', short: 'giltsyield portfolio', kind: 'text', aliases: ['giltsyieldportfolioname'],
      get: () => getGyPortfolio(), apply: v => setGyPortfolio(v) },
    { id: 'wk',  name: 'cloudflare_worker_url', label: 'Cloudflare Worker URL',    short: 'Worker URL',    kind: 'url',  aliases: ['workerurl', 'cloudflareworker'],
      get: () => getWorkerUrl(), apply: v => setWorkerUrl(v) },
    // Cloud backup (see runCloudBackup). The passphrase may have spaces, so it gets its own check.
    { id: 'cbt', name: 'cloud_backup_token',      label: 'Cloud backup token',      short: 'Backup token',      kind: 'key',  aliases: ['backuptoken'],
      get: () => getCloudBackupToken(), apply: v => { setCloudBackupToken(v); saveCloudBackupState(loadCloudBackupState()); } },
    { id: 'cbp', name: 'cloud_backup_passphrase', label: 'Cloud backup passphrase', short: 'Backup passphrase', kind: 'pass', aliases: ['backuppassphrase'],
      get: () => getCloudBackupPass(), apply: v => { setCloudBackupPass(v); saveCloudBackupState(loadCloudBackupState()); } },
];
function _akNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
// Returns a reason string when a value is not acceptable for its setting, else null.
function _akCheck(entry, v) {
    if (entry.kind === 'key') {
        if (/\s/.test(v)) return 'contains a space or line break';
        if (v.length < 6 || v.length > 200) return 'does not look like an API key (wrong length)';
    } else if (entry.kind === 'url') {
        if (!/^https:\/\/[^\s]+$/i.test(v)) return 'must be a full https:// address';
    } else if (entry.kind === 'pass') {
        if (v.length < 8 || v.length > 200) return 'should be 8 to 200 characters';
    } else if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(v)) return 'has characters a portfolio name should not';
    return null;
}
// text → { updates:[{id,label,short,value}], hints:[{account,hint}], blank:[short], unknown:[row numbers], invalid:[{short,reason}], error }.
// A row named "hint: <Estate account name>" carries a login hint for that account (never the password itself); a blank
// hint removes the one saved.
// Layout: one setting per row, name in the first column, value in the second; a header row (setting,value) is optional and
// any further columns (notes) are ignored. Names are matched without regard to case, spaces or underscores.
function parseApiKeyCsv(text) {
    const res = { updates: [], hints: [], blank: [], unknown: [], invalid: [], error: null };
    const rows = _gyCsvRows(text);
    if (!rows.length) { res.error = 'The file is empty.'; return res; }
    const byName = {};
    for (const e of API_KEY_SETTINGS) for (const n of [e.name, ...e.aliases]) byName[_akNorm(n)] = e;
    let start = 0, iN = 0, iV = 1;
    const head = rows[0].map(_akNorm);
    const hN = head.findIndex(h => h === 'setting' || h === 'name' || h === 'service');
    if (hN >= 0) {
        start = 1; iN = hN;
        const hV = head.findIndex(h => h === 'value' || h === 'key' || h === 'apikey');
        iV = hV >= 0 ? hV : hN + 1;
    }
    const latest = new Map();                       // a setting listed twice: the later row wins
    const hints = new Map();
    for (let r = start; r < rows.length; r++) {
        const hm = /^\s*(?:login[\s_-]*)?hint\s*[:\-–]\s*(\S.*?)\s*$/i.exec(String(rows[r][iN] == null ? '' : rows[r][iN]));
        if (hm) { hints.set(_akNorm(hm[1]), { account: hm[1], hint: String(rows[r][iV] == null ? '' : rows[r][iV]).trim().slice(0, 300) }); continue; }
        const entry = byName[_akNorm(rows[r][iN])];
        if (!entry) { res.unknown.push(r + 1); continue; }                  // reported by row number: a stray key must never be echoed
        latest.set(entry.id, { entry, value: String(rows[r][iV] == null ? '' : rows[r][iV]).trim() });
    }
    for (const { entry, value } of latest.values()) {
        if (!value) { res.blank.push(entry.short); continue; }
        const why = _akCheck(entry, value);
        if (why) res.invalid.push({ short: entry.short, reason: why });
        else res.updates.push({ id: entry.id, label: entry.label, short: entry.short, value });
    }
    res.hints = [...hints.values()];
    return res;
}
// Saves login hints for the Estate tab's Update balances screen (balances.js reads LOGIN_HINTS_KEY). They stay in this
// browser's storage only. Returns the account names saved or cleared, and those no Estate account is called.
const LOGIN_HINTS_KEY = 'estate_login_hints';
function applyLoginHints(hints) {
    const out = { saved: [], cleared: [], unmatched: [], failed: false };
    if (!hints || !hints.length) return out;
    let map = {};
    try { map = JSON.parse(localStorage.getItem(LOGIN_HINTS_KEY) || '{}') || {}; } catch {}
    const accounts = (window.BalancesStore && window.BalancesStore.get().accounts) || [];
    const names = new Set(accounts.map(a => _akNorm(a.name)));
    // Cash Flow (lifeadmin.js) finds a bill's hint by its provider or its name.
    const bills = (window.LifeAdminStore && window.LifeAdminStore.get().bills) || [];
    bills.forEach(b => { names.add(_akNorm(b.name)); if (b.provider) names.add(_akNorm(b.provider)); });
    for (const h of hints) {
        const k = _akNorm(h.account);
        if (h.hint) { map[k] = h.hint; out.saved.push(h.account); } else if (map[k]) { delete map[k]; out.cleared.push(h.account); }
        if (h.hint && !names.has(k)) out.unmatched.push(h.account);
    }
    try { localStorage.setItem(LOGIN_HINTS_KEY, JSON.stringify(map)); out.failed = localStorage.getItem(LOGIN_HINTS_KEY) !== JSON.stringify(map); } catch { out.failed = true; }
    return out;
}
// Writes each value, then READS IT BACK. The setters swallow storage errors (private browsing, storage full), so without the
// read-back an import could claim success for a key that was never saved. Returns the updates that really stuck and the
// names of those that did not.
function applyApiKeyUpdates(updates) {
    const saved = [], failed = [];
    for (const u of updates || []) {
        const e = API_KEY_SETTINGS.find(x => x.id === u.id);
        if (!e) continue;
        try { e.apply(u.value); } catch (err) { /* read-back below decides */ }
        let stuck = false;
        try { stuck = e.get() === u.value; } catch (err) { stuck = false; }
        (stuck ? saved : failed).push(stuck ? u : u.short);
    }
    return { saved, failed };
}
// What to tell the user. Names only — never a value.
function describeApiKeyImport(res) {
    if (res.error) return { tone: 'warn', text: res.error };
    const parts = [];
    if (res.updates.length) parts.push('Imported ' + res.updates.map(u => u.short).join(', ') + '.');
    const lh = res.loginHints;
    if (lh && lh.failed) parts.push('Could not save the login hints — this browser is blocking storage.');
    else if (lh) {
        if (lh.saved.length) parts.push('Login hints for ' + lh.saved.length + (lh.saved.length === 1 ? ' account.' : ' accounts.'));
        if (lh.cleared.length) parts.push('Removed the hint for ' + lh.cleared.join(', ') + '.');
        if (lh.unmatched.length) parts.push('No Estate account or bill called ' + lh.unmatched.join(', ') + ' (check the spelling).');
    }
    if (res.failed && res.failed.length) parts.push('Could not save ' + res.failed.join(', ') + ' — this browser is blocking storage (private browsing?).');
    if (res.invalid.length) parts.push('Not imported: ' + res.invalid.map(x => x.short + ' (' + x.reason + ')').join('; ') + '.');
    if (res.unknown.length) parts.push('Row' + (res.unknown.length > 1 ? 's ' : ' ') + res.unknown.join(', ') + ' not recognised — expected a setting name in the first column.');
    if (res.blank.length) parts.push('Left as they were (blank in the file): ' + res.blank.join(', ') + '.');
    const bad = (res.failed || []).length;
    const hintsDone = !!(lh && !lh.failed && (lh.saved.length || lh.cleared.length));
    if (!res.updates.length && !hintsDone && !bad && !res.invalid.length && !res.unknown.length && !res.blank.length) parts.push('No settings found in the file.');
    else if (!res.updates.length && !hintsDone && !bad && !res.invalid.length) parts.unshift('Nothing was imported.');
    return { tone: (bad || res.invalid.length || res.unknown.length || (lh && (lh.failed || lh.unmatched.length)) || (!res.updates.length && !hintsDone)) ? 'warn' : 'ok', text: parts.join(' ') };
}

function _gyDow(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }
function _gyAddDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function _gyPrevWeekday(iso) { let d = _gyAddDays(iso, -1); while (_gyDow(d) === 0 || _gyDow(d) === 6) d = _gyAddDays(d, -1); return d; }
function _gyLondon(ms) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
                                                      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const g = t => (parts.find(p => p.type === t) || {}).value;
    return { date: g('year') + '-' + g('month') + '-' + g('day'), minutes: parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10) };
}
// Which London trading session a price belongs to, and whether it is that session's final price. A weekend fetch is
// Friday's close; a weekday fetch before 08:00 is the previous weekday's close; a weekday fetch from 16:45 is today's
// close; anything in between is intraday. (UK bank holidays are not modelled: the check below is simply conservative.)
function gySessionOf(ms) {
    const p = _gyLondon(ms), dow = _gyDow(p.date);
    let d = p.date;
    if (dow === 6) d = _gyAddDays(d, -1);
    else if (dow === 0) d = _gyAddDays(d, -2);
    else if (p.minutes < 8 * 60) d = _gyPrevWeekday(d);
    return { session: d, final: d !== p.date || p.minutes >= 16 * 60 + 45 };
}
function loadGyCache() {
    try {
        const o = JSON.parse(localStorage.getItem(GY_CACHE_KEY) || 'null');
        if (o && o.v === 1 && o.snaps && typeof o.snaps === 'object') { o.meta = o.meta || {}; return o; }
    } catch {}
    return { v: 1, snaps: {}, meta: {} };
}
function saveGyCache(c) { try { localStorage.setItem(GY_CACHE_KEY, JSON.stringify(c)); } catch {} }
function gyRecordSnapshots(cache, accepted, ms) {
    const c = { v: 1, snaps: Object.assign({}, cache.snaps), meta: Object.assign({}, cache.meta) };
    const s = gySessionOf(ms);
    for (const [tk, a] of Object.entries(accepted || {})) {
        const byS = Object.assign({}, c.snaps[tk] || {});
        byS[s.session] = { dirty: a.dirty, t: ms, final: s.final, isin: a.isin || null, maturity: a.maturity || null, coupon: Number.isFinite(a.coupon) ? a.coupon : null };
        const keys = Object.keys(byS).sort();
        while (keys.length > GY_KEEP_SESSIONS) delete byS[keys.shift()];
        c.snaps[tk] = byS;
    }
    return c;
}
// Latest stored price for a gilt (null when none, or older than GY_MAX_AGE_MS) plus the previous session's FINAL price,
// which is what makes a daily change honest: it is only ever measured against a price the app itself stored as a close.
function gyMarketFor(cache, ticker, nowMs) {
    const byS = cache && cache.snaps && cache.snaps[ticker];
    if (!byS) return null;
    const sessions = Object.keys(byS).sort();
    if (!sessions.length) return null;
    const curSession = sessions[sessions.length - 1], cur = byS[curSession];
    if (!cur || !Number.isFinite(cur.dirty) || !Number.isFinite(cur.t) || (nowMs - cur.t) > GY_MAX_AGE_MS) return null;
    const prevSession = _gyPrevWeekday(curSession), prev = byS[prevSession];
    return { dirty: cur.dirty, t: cur.t, session: curSession, final: !!cur.final, isin: cur.isin || null, maturity: cur.maturity || null, coupon: cur.coupon,
             prevCloseDirty: (prev && prev.final && Number.isFinite(prev.dirty)) ? prev.dirty : null, prevSession };
}
// ── Gilt price history in the JSON backup ──────────────────────────────────────────────────────────────────────
// The stored gilt closes (giltsyield_snapshots_v1) travel in payload.giltPriceHistory as { v: 1, snaps: { TK: { 'YYYY-MM-DD': {...} } } }.
// Nothing from a file is trusted: every entry is range- and shape-checked, and a bad one is dropped (and counted), never repaired.
// Restoring MERGES into what the app already holds (it never discards a newer stored close) and keeps the latest GY_KEEP_SESSIONS
// sessions per gilt. A restored price older than GY_MAX_AGE_MS is still never used as a live price (gyMarketFor enforces that);
// what a restore gives back is the previous-session close, which is what makes tomorrow's daily change possible.
const _GY_SESSION_RE = /^\d{4}-\d{2}-\d{2}$/;
function validateGiltSnapshots(raw) {
    const out = { snaps: {}, tickers: 0, sessions: 0, rejected: 0 };
    const srcSnaps = raw && typeof raw === 'object' && raw.snaps && typeof raw.snaps === 'object' && !Array.isArray(raw.snaps) ? raw.snaps : null;
    if (!srcSnaps) return out;
    const latestOk = Date.now() + 24 * 3600 * 1000;      // a fetch time in the future is not a fetch time
    for (const [tkRaw, byS] of Object.entries(srcSnaps)) {
        const tk = String(tkRaw || '').trim().toUpperCase();
        if (!/^[A-Z0-9_.\-]{1,24}$/.test(tk) || !byS || typeof byS !== 'object' || Array.isArray(byS)) { out.rejected++; continue; }
        const clean = {};
        for (const [sess, e] of Object.entries(byS)) {
            const dirty = e && typeof e === 'object' ? Number(e.dirty) : NaN;
            const t     = e && typeof e === 'object' ? Number(e.t)     : NaN;
            if (!_GY_SESSION_RE.test(sess) || !(dirty >= GY_DIRTY_MIN && dirty <= GY_DIRTY_MAX) || !(Number.isFinite(t) && t > 0 && t <= latestOk)) { out.rejected++; continue; }
            clean[sess] = {
                dirty, t, final: e.final === true,
                isin: (typeof e.isin === 'string' && e.isin) ? e.isin : null,
                maturity: (typeof e.maturity === 'string' && e.maturity) ? e.maturity : null,
                coupon: (e.coupon != null && Number.isFinite(Number(e.coupon))) ? Number(e.coupon) : null,
            };
        }
        const n = Object.keys(clean).length;
        if (n > 0) { out.snaps[tk] = clean; out.tickers++; out.sessions += n; }
    }
    return out;
}
function mergeGiltSnapshots(cache, incomingSnaps) {
    const base = (cache && cache.snaps) || {}, inc = incomingSnaps || {};
    const c = { v: 1, snaps: {}, meta: Object.assign({}, (cache && cache.meta) || {}) };
    for (const tk of new Set(Object.keys(base).concat(Object.keys(inc)))) {
        const byS = Object.assign({}, base[tk] || {});
        for (const [sess, e] of Object.entries(inc[tk] || {})) {
            const cur = byS[sess];
            if (!cur) { byS[sess] = e; continue; }
            if (cur.final && !e.final) continue;                      // a stored close beats a not-yet-final price
            if (e.final && !cur.final) { byS[sess] = e; continue; }
            if (e.t > cur.t) byS[sess] = e;                           // otherwise the later fetch wins
        }
        const keys = Object.keys(byS).sort();
        while (keys.length > GY_KEEP_SESSIONS) delete byS[keys.shift()];
        if (keys.length) c.snaps[tk] = byS;
    }
    return c;
}
function _gyCsvRows(text) {
    const s = String(text || '').replace(/^\uFEFF/, '');
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
        else if (ch === '"') q = true;
        else if (ch === ',') { row.push(f); f = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && s[i + 1] === '\n') i++;
            row.push(f); f = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
}
// One request for every gilt booked in the giltsyield portfolio. Returns { ok, accepted:{TK:{dirty,isin,maturity,coupon}}, rejected:[{ticker,reason}] }
// or { ok:false, error }. Rows are only range-checked here; each price is checked against the ladder's own maturity and coupon
// (taken from the ledger) at the moment it is used — see gyCheckAgainstRegistry.

// ── Gilt registry from the ledger ─────────────────────────────────────────────────────────────────────────────
// A conventional gilt bought through the broker is described as e.g. "Treasury 0.375% 22/10/2030 Gilt 35754 @ 84.40499":
// coupon, maturity, quantity and price are all in the row. So a new gilt needs no code change — an entry is built for it
// here, in place, whenever the ledger loads. Entries already in GILT_LADDER_REGISTRY are never touched. Coupons are paid on
// the maturity day and six months earlier (as giltsyield.com documents). Index-linked and "Treasury Stock" lines do not
// match the pattern and are left unpriced instead of being guessed at. purchaseCleanPrice and
// purchaseDate (quantity-weighted over the buys) are kept on the entry but no longer drive any valuation: a gilt is valued from its
// market price only.
let _giltUnrecognised = [];
const _GILT_DESC_RE = /Treasury\s+(\d+(?:\.\d+)?)%\s+(\d{2})\/(\d{2})\/(\d{2}|\d{4})\s+Gilt\b/i;
function deriveLedgerGilts(rows) {
    const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const by = {}, unrec = new Set(), net = {};
    for (const t of rows || []) {
        const tk = t.instrument && t.instrument.ticker;
        const desc = String(t.description || t.assetName || '');
        if (!tk || tk === 'UNTICKERED' || tk.includes('.') || !/\bgilt\b/i.test(desc)) continue;
        { const q0 = parseFloat(String(t.quantity || '').replace(/,/g, '')) || 0;
          if (t.category === 'buy' || t.category === 'transfer_in') net[tk] = (net[tk] || 0) + q0;
          else if (t.category === 'sell' || t.category === 'transfer_out') net[tk] = (net[tk] || 0) - q0; }
        if (GILT_LADDER_REGISTRY[tk] && !GILT_LADDER_REGISTRY[tk].__derived) continue;      // hand-written entry wins
        const m = desc.match(_GILT_DESC_RE);
        if (!m) { unrec.add(tk); continue; }
        const g = by[tk] || (by[tk] = { m, sumQ: 0, sumQP: 0, sumQT: 0, firstT: Infinity, any: 0 });
        const q = parseFloat(String(t.quantity || '').replace(/,/g, '')) || 0;
        let p = parseFloat(String(t.unitCost == null ? '' : t.unitCost).replace(/,/g, ''));
        if (!(p > 0)) { const mm = desc.match(/@\s*([\d.]+)/); p = mm ? parseFloat(mm[1]) : NaN; }
        const d = t.parsedDate instanceof Date ? t.parsedDate.getTime() : NaN;
        if (Number.isFinite(d)) g.firstT = Math.min(g.firstT, d);
        g.any++;
        if (t.category === 'buy' && q > 0 && p > 0 && Number.isFinite(d)) { g.sumQ += q; g.sumQP += q * p; g.sumQT += q * d; }
    }
    for (const [tk, g] of Object.entries(by)) {
        const dd = parseInt(g.m[2], 10), mo = parseInt(g.m[3], 10);
        let yy = parseInt(g.m[4], 10); if (yy < 100) yy += 2000;
        if (!(mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31)) { unrec.add(tk); continue; }
        const iso = n => String(n).padStart(2, '0');
        const mo2 = ((mo - 1 + 6) % 12) + 1;
        const months = [mo, mo2].sort((a, b) => a - b);
        const dayFor = mm => Math.min(dd, dim[mm - 1]);
        const havePrice = g.sumQ > 0;
        const purchaseISO = new Date(havePrice ? g.sumQT / g.sumQ : g.firstT).toISOString().slice(0, 10);
        GILT_LADDER_REGISTRY[tk] = {
            __derived: true,
            name: 'Treasury ' + g.m[1] + '% ' + iso(dd) + '/' + iso(mo) + '/' + yy,
            purchaseCleanPrice: havePrice ? g.sumQP / g.sumQ : 100,
            purchaseDate: Number.isFinite(g.firstT) ? purchaseISO : '2000-01-01',
            maturityDate: yy + '-' + iso(mo) + '-' + iso(dd),
            couponRate: parseFloat(g.m[1]) / 100,
            couponMonths: months, couponDays: months.map(dayFor),
            nominalQuantityFallback: 0,
        };
    }
    _giltUnrecognised = Array.from(unrec).filter(tk => !GILT_LADDER_REGISTRY[tk] && (net[tk] || 0) > 0.5);   // only gilts still held
}
// A market price is believed only if giltsyield.com and the ledger agree on WHICH gilt it is. Maturity and coupon come
// from two independent places (the CSV; the ledger description or the hand-written registry entry), plus the ISIN when
// the registry has one. Returns a reason string, or null when they agree.
function gyCheckAgainstRegistry(m, reg) {
    if (!m || !reg) return 'no price or no registry entry';
    if (reg.isin && m.isin && m.isin !== reg.isin) return 'ISIN ' + m.isin + ' does not match the ledger gilt (' + reg.isin + ')';
    if (!m.maturity) return 'giltsyield.com gave no maturity date to check';
    if (m.maturity !== toISODate(reg.maturityDate)) return 'maturity ' + m.maturity + ' does not match the ledger gilt (' + toISODate(reg.maturityDate) + ')';
    if (Number.isFinite(m.coupon) && Math.abs(m.coupon / 100 - reg.couponRate) > 1e-6) return 'coupon ' + m.coupon + '% does not match the ledger gilt (' + (reg.couponRate * 100) + '%)';
    return null;
}
async function fetchGiltsyieldPrices(signal) {
    const key = getGyApiKey(), port = getGyPortfolio();
    if (!key) return { ok: false, error: 'no API key set' };
    const url = 'https://giltsyield.com/api/portfolio/pl/' + encodeURIComponent(port) + '/?apikey=' + encodeURIComponent(key);
    let res;
    try { res = await proxyFetch(url, signal, { purpose: 'gilt prices', allowHttpError: true }); }
    catch (e) { return { ok: false, error: paScrub((e && e.message) || 'request failed') }; }
    const text = await res.text();
    if (res.status === 403 && /host not allowed/i.test(text)) return { ok: false, error: 'the Cloudflare Worker does not allow giltsyield.com yet \u2014 it redeploys when main changes, so check the latest merge went live' };
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + (res.status === 401 || res.status === 403 ? ' (check the API key)' : '') };
    if (/^\s*</.test(text)) return { ok: false, error: 'giltsyield.com returned a web page, not data (wrong key or portfolio name?)' };
    const rows = _gyCsvRows(text);
    if (rows.length < 2) return { ok: false, error: 'empty response (is the portfolio name right, and does it hold gilts?)' };
    const head = rows[0].map(h => String(h).trim().toLowerCase());
    const iT = head.indexOf('ticker'), iD = head.indexOf('dirty_price'), iI = head.indexOf('isin_code'), iM = head.indexOf('maturity_date');
    if (iT < 0 || iD < 0) return { ok: false, error: 'unexpected columns: ' + head.slice(0, 8).join(', ') };
    const iC = head.indexOf('coupon');
    const accepted = {}, rejected = [];
    for (const r of rows.slice(1)) {
        const tk = String(r[iT] || '').trim().toUpperCase();
        if (!tk) continue;
        const dirty = parseFloat(r[iD]);
        if (!Number.isFinite(dirty) || dirty < GY_DIRTY_MIN || dirty > GY_DIRTY_MAX) { rejected.push({ ticker: tk, reason: 'dirty price ' + r[iD] + ' is outside ' + GY_DIRTY_MIN + '\u2013' + GY_DIRTY_MAX }); continue; }
        accepted[tk] = {
            dirty,
            isin: iI >= 0 ? String(r[iI] || '').trim() : '',
            maturity: iM >= 0 ? String(r[iM] || '').trim().slice(0, 10) : '',
            coupon: iC >= 0 ? parseFloat(r[iC]) : NaN,       // percent, e.g. 0.125
        };
    }
    return { ok: true, accepted, rejected };
}

function _dcUp(s) { return String(s || '').toUpperCase().trim(); }

// Gilts, money-market funds and other internal codes — never priced externally.
function _isSyntheticForDailyCheck(tk) {
    if (typeof MKT_PSEUDO_TICKERS !== 'undefined' && MKT_PSEUDO_TICKERS.has(tk)) return true;
    if (tk.includes('_MM')) return true;
    if (typeof GILT_LADDER_REGISTRY !== 'undefined' && GILT_LADDER_REGISTRY && GILT_LADDER_REGISTRY[tk]) return true;
    // HL gilt codes: 'T' + optional G/N + two-digit year + optional letter (T26A, TN28, TG29).
    // Anchored at both ends so real listings such as TGT or TNA are never treated as gilts.
    if (/^T[GN]?\d{2}[A-Z]?$/.test(tk)) return true;
    return false;
}

// Which trading calendar governs a Yahoo symbol.
function calendarFor(sym) {
    const tk = _dcUp(sym);
    if (!tk) return null;
    if (INDEX_CALENDAR[tk]) return INDEX_CALENDAR[tk];
    if (tk.startsWith('^')) return null;                // unmapped index — no calendar
    if (tk.endsWith('=X')) return 'FX';
    if (/-(USD|GBP|EUR)$/.test(tk)) return 'CRYPTO';
    if (tk.endsWith('.L')) return 'LSE';
    if (/^[A-Z][A-Z0-9\-]*$/.test(tk)) return 'NYSE';   // plain US listing
    return null;
}

// Holdings eligibility: real LSE / US listings only (not gilts, cash, indices, FX).
// isSyntheticTicker() elsewhere is too broad here — it treats any ticker with no
// '.', '^' or '=' as internal, which would wrongly drop US tickers like "C" (Citi).
function isDailyCheckVerifiableTicker(ticker) {
    const tk = _dcUp(ticker);
    if (!tk || tk.startsWith('^') || tk.includes('=')) return false;
    if (_isSyntheticForDailyCheck(tk)) return false;
    const cal = calendarFor(tk);
    return cal === 'LSE' || cal === 'NYSE';
}

function _fxTdSymbol(tk) {
    const b = tk.slice(0, -2);
    if (/^[A-Z]{6}$/.test(b)) return b.slice(0, 3) + '/' + b.slice(3);  // EURUSD=X → EUR/USD
    if (/^[A-Z]{3}$/.test(b)) return 'USD/' + b;                         // JPY=X    → USD/JPY
    return null;
}

// Everything the check needs to know about one symbol.
function dailyCheckProfileFor(sym) {
    const tk  = _dcUp(sym);
    const cal = calendarFor(tk);
    const p = { symbol: tk, calendar: cal, provider: null, providerName: null,
                tdSymbol: null, avSymbol: null, msSymbol: null,
                tolerance: DAILY_VERIFY_TOLERANCE, maxMove: MAX_SANE_DAILY_MOVE };
    if (!tk) return p;
    const synthetic = _isSyntheticForDailyCheck(tk);
    if (cal === 'LSE' && !tk.startsWith('^')) {
        p.maxMove = 0.25;
        if (!synthetic) {
            p.provider = 'av'; p.providerName = 'Alpha Vantage'; p.avSymbol = tk.slice(0, -2) + '.LON';
            // No Marketstack symbol for London: this account returns no London data (see the note at MS_MONTHLY_BUDGET).
        }
    } else if (cal === 'NYSE' && !tk.startsWith('^')) {
        p.maxMove = 0.30;
        if (!synthetic) { p.provider = 'td'; p.providerName = 'Twelve Data'; p.tdSymbol = tk; p.msSymbol = tk; }   // Marketstack = fallback for the US holding
    } else if (cal === 'FX') {
        p.tolerance = 0.0025; p.maxMove = 0.10;
        const s = _fxTdSymbol(tk);
        if (s) { p.provider = 'td'; p.providerName = 'Twelve Data'; p.tdSymbol = s; }
    } else if (cal === 'CRYPTO') {
        p.maxMove = 0.30;
        p.provider = 'td'; p.providerName = 'Twelve Data'; p.tdSymbol = tk.replace('-', '/');
    } else if (tk === '^VIX') {
        p.maxMove = 1.00;                                  // VIX can double in a day
    } else if (tk === '^TNX' || tk === '^FVX' || tk === '^TYX' || tk === '^IRX') {
        p.maxMove = 0.30;                                  // yields: relative move in the yield level
    }
    return p;
}

// Previous trading session for a calendar. Returns { date, covered } where
// covered=false means the holiday list didn't span that year (weekdays-only walk).
function previousExchangeSession(calendar, dateStr) {
    if (!dateStr || !calendar) return null;
    const spec = EXCHANGE_CALENDARS[calendar];
    if (!spec) return null;
    const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00Z');
    if (isNaN(d.getTime())) return null;
    if (spec.everyDay) {
        d.setUTCDate(d.getUTCDate() - 1);
        return { date: d.toISOString().slice(0, 10), covered: true };
    }
    let covered = true;
    for (let i = 0; i < 14; i++) {
        d.setUTCDate(d.getUTCDate() - 1);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const ds = d.toISOString().slice(0, 10);
        if (spec.holidays) {
            if (!spec.years.includes(d.getUTCFullYear())) covered = false;
            else if (spec.holidays.has(ds)) continue;
        }
        return { date: ds, covered };
    }
    return null;
}

function calendarCoversYear(calendar, year) {
    const spec = EXCHANGE_CALENDARS[calendar];
    if (!spec) return true;
    if (!spec.holidays) return true;
    return spec.years.includes(Number(year));
}

// ── Exchange-local dating of Yahoo bars ─────────────────────────────────────
const _dcDtf = {};
function exchangeLocalDate(tsSec, tz, gmtoffsetSec) {
    const ms = Number(tsSec) * 1000;
    if (!Number.isFinite(ms)) return null;
    if (tz) {
        try {
            let f = _dcDtf[tz];
            if (!f) f = _dcDtf[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
            const parts = f.formatToParts(new Date(ms));
            const get = t => (parts.find(p => p.type === t) || {}).value;
            const y = get('year'), m = get('month'), dd = get('day');
            if (y && m && dd) return y + '-' + m + '-' + dd;
        } catch {}
    }
    const off = Number(gmtoffsetSec);
    return new Date(ms + (Number.isFinite(off) ? off * 1000 : 0)).toISOString().slice(0, 10);
}

// Daily closes from a Yahoo v8 chart result, dated in the exchange's timezone,
// one row per date (a later timestamp on the same date — e.g. Yahoo's trailing
// live tick — replaces the earlier one).
function yahooDailyRowsFromChart(result) {
    if (!result) return [];
    const meta = result.meta || {};
    const tz   = meta.exchangeTimezoneName || null;
    const off  = meta.gmtoffset;
    const ts   = result.timestamp || [];
    const cl   = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
    const byDate = new Map();
    ts.map((t, i) => ({ t: Number(t), c: Number(cl[i]) }))
      .filter(x => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
      .sort((a, b) => a.t - b.t)
      .forEach(x => { const d = exchangeLocalDate(x.t, tz, off); if (d) byDate.set(d, x.c); });
    return Array.from(byDate.entries())
        .map(([date, close]) => ({ date, close }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

// Session date of Yahoo's current quote, in the exchange's timezone.
function yahooQuoteSessionDate(meta) {
    const t = Number(meta && meta.regularMarketTime);
    if (!Number.isFinite(t) || t <= 0) return null;
    return exchangeLocalDate(t, meta.exchangeTimezoneName || null, meta.gmtoffset);
}

// ── Second-source fetchers ─────────────────────────────────────────────────
// Twelve Data: one batched request (via the Worker). Returns { [yahooSym]: {rows}|{error} }.
async function fetchTwelveDataBatch(tickers, apiKey, signal) {
    if (!apiKey) throw new Error('no Twelve Data API key set');
    const symToTicker = {};
    (tickers || []).forEach(tk => {
        const p = dailyCheckProfileFor(tk);
        if (p.tdSymbol) symToTicker[p.tdSymbol] = p.symbol;
    });
    const syms = Object.keys(symToTicker);
    if (syms.length === 0) return {};
    const url = 'https://api.twelvedata.com/time_series?symbol=' + encodeURIComponent(syms.join(',')) +
        '&interval=1day&outputsize=14&apikey=' + encodeURIComponent(apiKey);
    const res  = await proxyFetch(url, signal);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('Twelve Data returned something other than JSON'); }
    if (json && json.status === 'error') throw new Error('Twelve Data: ' + (json.message || 'request rejected') + (json.code ? ' (' + json.code + ')' : ''));
    // Single-symbol responses are {meta, values}; batched ones are {SYM: {...}}.
    const bySymbol = (json && Array.isArray(json.values)) ? { [syms[0]]: json } : (json || {});
    const out = {};
    for (const [sym, orig] of Object.entries(symToTicker)) {
        const entry = bySymbol[sym];
        if (!entry) { out[orig] = { error: 'Twelve Data: no response for ' + sym }; continue; }
        if (entry.status === 'error' || !Array.isArray(entry.values)) {
            out[orig] = { error: 'Twelve Data: ' + (entry.message || 'no data for ' + sym) };
            continue;
        }
        out[orig] = { rows: entry.values
            .map(v => ({ date: String(v.datetime).slice(0, 10), close: Number(v.close) }))
            .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
            .sort((a, b) => a.date.localeCompare(b.date)) };
    }
    // Audit: what came back for each symbol (a symbol missing from a batched answer is
    // invisible at the HTTP level, so it is recorded here).
    {
        const perTicker = {}; let matched = 0; const missing = [];
        for (const [sym, orig] of Object.entries(symToTicker)) {
            const o = out[orig] || {};
            if (o.rows && o.rows.length) { matched++; perTicker[orig] = { symbol: sym, rows: o.rows.length, latest: o.rows[o.rows.length - 1].date }; }
            else { missing.push(orig); perTicker[orig] = { symbol: sym, rows: 0, error: o.error || 'no rows' }; }
        }
        const patch = { perTicker };
        if (matched < syms.length) {
            patch.outcome = matched > 0 ? 'partial' : 'failed';
            patch.category = matched > 0 ? 'partial' : 'no-data';
            patch.message = 'no usable rows for ' + missing.join(', ');
            patch.bodyExcerpt = text.slice(0, 600);
        }
        paAnnotate(res, patch);
    }
    return out;
}

// Alpha Vantage: called directly from the browser, NOT through the Worker.
// Alpha Vantage sends permissive CORS headers, and going direct avoids a real
// problem with the Worker route: Cloudflare Workers share outbound IP ranges with
// many unrelated users, and Alpha Vantage rate-limits per IP as well as per key,
// so Worker calls were throttled by other people's traffic.
async function fetchAlphaVantageSeries(ticker, apiKey, signal) {
    if (!apiKey) throw new Error('no Alpha Vantage API key set');
    const p = dailyCheckProfileFor(ticker);
    if (!p.avSymbol) throw new Error('Alpha Vantage: no symbol mapping for ' + ticker);
    const url = 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=' +
        encodeURIComponent(p.avSymbol) + '&outputsize=compact&apikey=' + encodeURIComponent(apiKey);
    const res  = await _fetchBuffered(url, signal, 15000, { purpose: 'daily-close cross-check' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('Alpha Vantage returned something other than JSON'); }
    const info = json['Note'] || json['Information'];
    if (info) {
        const daily = /per day|daily|25 requests/i.test(String(info));
        const e = new Error(daily ? 'Alpha Vantage daily limit reached (25/day)' : 'Alpha Vantage rate limit hit (per-minute)');
        e.avDaily = daily;
        throw e;
    }
    if (json['Error Message']) throw new Error('Alpha Vantage: unknown symbol ' + p.avSymbol);
    const series = json['Time Series (Daily)'];
    if (!series || typeof series !== 'object') throw new Error('Alpha Vantage: no daily series returned');
    const avRows = Object.entries(series)
        .map(([date, row]) => ({ date, close: Number(row['4. close']) }))
        .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
    paAnnotate(res, avRows.length
        ? { rows: avRows.length, latest: avRows[avRows.length - 1].date }
        : { rows: 0, outcome: 'failed', category: 'empty-response', message: 'daily series had no usable rows', bodyExcerpt: text.slice(0, 600) });
    return avRows;
}

// ── Marketstack attempt log ─────────────────────────────────────────────────
// Every Marketstack attempt — and every time it was skipped when it might have
// been expected — goes into a small persistent ring buffer that is exported with
// the backup (diagnostics.marketstack), so a failure can be audited after the fact
// rather than reconstructed from memory. The API key is scrubbed out of everything
// stored here: the export file may well be shared.
const MS_LOG_KEY = 'marketstack_attempt_log_v1';
const MS_LOG_MAX = 40;
function loadMsLog() {
    try { const a = JSON.parse(localStorage.getItem(MS_LOG_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
}
function saveMsLog(list) {
    try { localStorage.setItem(MS_LOG_KEY, JSON.stringify((list || []).slice(-MS_LOG_MAX))); }
    catch (e) { console.warn('[marketstack] could not persist attempt log:', e && e.message); }
}
function _msScrub(v, key) {
    let s = String(v == null ? '' : v);
    for (const k of [key, key ? encodeURIComponent(key) : null]) if (k) s = s.split(k).join('\u2039key\u203a');
    return s.replace(/(access_key(?:=|%3D))[^&"'\s%]+/gi, '$1\u2039redacted\u203a');
}
function _msScrubObj(o, key) {
    try { return JSON.parse(_msScrub(JSON.stringify(o), key)); } catch { return _msScrub(String(o), key); }
}
// One coarse label per outcome, so failures can be counted and grouped at a glance.
function _msCategory(t) {
    if (t.exception) return t.exception.timeout ? 'timeout' : (t.exception.aborted ? 'aborted' : (t.exception.noWorker ? 'no-worker' : 'network'));
    if (t.hostBlocked) return 'worker-allowlist';
    const code = String(t.errCode || '').toLowerCase();
    if (code) {
        if (/https_access/.test(code))                       return 'plan-https-restricted';
        if (/function_access|endpoint_access/.test(code))    return 'plan-endpoint-restricted';
        if (/invalid_access_key|missing_access_key|inactive|account/.test(code)) return 'auth';
        if (/usage_limit/.test(code))                        return 'quota-exhausted';
        if (/rate_limit/.test(code))                         return 'rate-limited';
        if (/validation/.test(code))                         return 'validation';
        if (/not_found|404/.test(code))                      return 'not-found';
        return 'api-error';
    }
    if (t.status === 429) return 'rate-limited';
    if (t.status === 401) return 'auth';
    if (t.nonJson)        return 'non-json';
    if (t.status >= 400)  return 'http-error';
    if (!t.rows)          return 'empty-response';
    if (t.matched === 0)  return 'symbol-mismatch';
    if (t.matched < t.wanted) return 'partial';
    return 'ok';
}
function recordMsAttempt(entry) {
    const log = loadMsLog(); log.push(entry); saveMsLog(log);
}
// "Not tried" is worth knowing too (no key, monthly budget spent). Identical
// consecutive skips fold into one entry with a count, so a poll loop can't flood the log.
function recordMsSkip(reason, tickers, ctx) {
    const log = loadMsLog(), last = log[log.length - 1];
    const sig = (tickers || []).slice().sort().join(',');
    const now = new Date().toISOString();
    if (last && last.kind === 'skip' && last.reason === reason && last.sig === sig) {
        last.count = (last.count || 1) + 1; last.lastAt = now;
    } else {
        log.push({ v: 1, kind: 'skip', at: now, lastAt: now, count: 1, reason, sig, tickers: (tickers || []).slice(),
                   forced: !!(ctx && ctx.forced), budget: (ctx && ctx.budget) || null });
    }
    saveMsLog(log);
}
function summariseMsLog(log) {
    const list = Array.isArray(log) ? log : [];
    const attempts = list.filter(e => e.kind === 'attempt');
    const byCategory = {};
    attempts.forEach(e => { const c = e.category || 'unknown'; byCategory[c] = (byCategory[c] || 0) + 1; });
    const ok  = attempts.filter(e => e.outcome === 'ok');
    const bad = attempts.filter(e => e.outcome !== 'ok');
    let streak = 0;
    for (let i = attempts.length - 1; i >= 0 && attempts[i].outcome !== 'ok'; i--) streak++;
    const lastBad = bad[bad.length - 1] || null;
    return {
        entriesKept: list.length, attempts: attempts.length, ok: ok.length,
        partial: attempts.filter(e => e.outcome === 'partial').length,
        failed:  attempts.filter(e => e.outcome === 'failed').length,
        skips:   list.filter(e => e.kind === 'skip').reduce((n, e) => n + (e.count || 1), 0),
        byCategory, consecutiveNonOk: streak,
        lastOkAt: ok.length ? ok[ok.length - 1].at : null,
        lastProblem: lastBad ? { at: lastBad.at, category: lastBad.category, message: lastBad.message } : null,
    };
}

// Marketstack: routed through the Worker, since (unlike Alpha Vantage) its CORS
// support is undocumented. One symbol equals one unit of the monthly quota whether
// requested individually or batched, so batching only saves round-trips.
// US (NYSE) holdings only — i.e. Citi — and only ever called as a fallback for a ticker
// Twelve Data couldn't serve, or on a manual Marketstack re-check (see fetchSecondaryDailyCloses).
// Builds a full trace of the attempt as it goes (request, HTTP details, Marketstack's
// own error object, per-ticker outcome, timing). It is attached to the thrown error
// (e.trace) or to the returned object (non-enumerable __trace) for the caller to log.
async function fetchMarketstackBatch(tickers, apiKey, signal) {
    const symToTicker = {};
    (tickers || []).forEach(tk => {
        const p = dailyCheckProfileFor(tk);
        if (p.msSymbol) symToTicker[p.msSymbol] = p.symbol;
    });
    const syms = Object.keys(symToTicker);
    if (syms.length === 0) return {};
    const n = syms.length;
    const t0 = Date.now();
    const memo0 = loadMsFormat();
    const limit = Math.min(1000, 100 * n);   // the limit is shared across all symbols in one request
    let spent = 0, charged = n;   // credits actually consumed / credits charged so far (see the budget note below)
    const trace = {
        v: 2, kind: 'attempt', at: new Date().toISOString(),
        request: { endpoint: null, via: 'cloudflare-worker',
                   params: { symbols: syms.join(','), exchange: MS_US_EXCHANGE, limit }, format: memo0.endpoint || 'v2',
                   symbolToTicker: { ...symToTicker } },
        env: { online: typeof navigator !== 'undefined' ? navigator.onLine : null,
               visibility: typeof document !== 'undefined' ? document.visibilityState : null },
        response: null, exception: null, error: null, parsed: null,
        calls: [], endpointFallbacks: [], probes: null, control: null,
        perTicker: {}, outcome: null, category: null, message: null, durationMs: null,
    };
    const seal = (category, message, outcome) => {
        trace.category = category; trace.message = message; trace.outcome = outcome; trace.durationMs = Date.now() - t0;
        trace.creditsSpent = spent;
    };
    // e.refundable marks a definitive rejection (Marketstack doesn't count errors
    // against the quota, so the app's own counter shouldn't either).
    const bail = (category, message, refundable) => {
        seal(category, message, 'failed');
        const e = new Error(message);
        e.refundable = !!refundable; e.category = category; e.trace = trace;
        return e;
    };
    // Marketstack returns the ticker either bare ("C") or with an exchange suffix; match on the bare form.
    const bare = x => String(x || '').toUpperCase().replace(/\.(XNYS|XLON|LON|L)$/, '');

    // Budget: the caller has already charged n (one per symbol). Requests made here draw on that;
    // anything beyond it is charged as it happens, and whatever was pre-charged but not spent is returned.
    const ensureCharged = k => {
        if (spent + k > charged) { const b = loadMsBudget(); b.used += spent + k - charged; saveMsBudget(b); charged = spent + k; }
    };
    const settle = () => {
        if (charged > spent) { const b = loadMsBudget(); b.used = Math.max(0, b.used - (charged - spent)); saveMsBudget(b); charged = spent; }
    };

    // One /eod request against one endpoint version. Returns { rows, rejected } or throws bail().
    // A 422 "no valid symbol" is a definitive answer about the SYMBOL (not a fault): it comes back as
    // { rejected } so the caller reports it per ticker instead of aborting, and it costs no quota.
    const call = async (ep, bareList, purpose) => {
        const c0 = Date.now();
        trace.request.endpoint = ep.url;
        const url = ep.url + '?access_key=' + encodeURIComponent(apiKey) +
            '&symbols=' + encodeURIComponent(bareList.join(',')) + '&exchange=' + MS_US_EXCHANGE + '&limit=' + limit;
        ensureCharged(bareList.length);
        // allowHttpError: Marketstack reports its errors WITH an HTTP error status, so the
        // default "throw on non-2xx" would hide the one thing worth reading — its message.
        let res;
        try { res = await proxyFetch(url, signal, { allowHttpError: true, purpose }); }
        catch (e) {
            const raw = _msScrub(e && e.message, apiKey);
            trace.exception = { name: (e && e.name) || null, message: raw, timeout: !!(e && e.timeout),
                                aborted: !!(signal && signal.aborted), noWorker: /no worker url/i.test(raw) };
            const cat = _msCategory({ exception: trace.exception });
            // A timeout may still have reached Marketstack, so it stays counted. A plain network
            // failure or a missing Worker URL never got an answer, so it is refunded.
            const elapsed = Date.now() - c0;
            const fast = cat === 'network' && elapsed < 250;
            throw bail(cat, 'Marketstack: ' + (cat === 'timeout' ? 'request timed out'
                : cat === 'no-worker' ? 'no Worker URL configured'
                : fast ? 'no response from the Worker in ' + elapsed + ' ms (' + raw + ') \u2014 too quick to have reached Marketstack; the Worker most likely refuses api.marketstack.com (out of date): it redeploys when main changes, so check the latest merge went live'
                : 'network error \u2014 ' + raw), cat === 'network' || cat === 'no-worker');
        }
        const text = await res.text();
        trace.response = { status: res.status, ok: res.ok, statusText: res.statusText || null, redirected: !!res.redirected,
                           headers: res.headers || {}, bytes: text.length, endpoint: ep.id };
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (!json || typeof json !== 'object') {
            trace.response.bodyExcerpt = _msScrub(text, apiKey).slice(0, 1500);
            const blocked = res.status === 403 && /host not allowed/i.test(text);
            const cat = _msCategory({ status: res.status, hostBlocked: blocked, nonJson: true });
            const e = bail(cat, blocked
                ? 'Marketstack: the Cloudflare Worker doesn\u2019t allow api.marketstack.com yet \u2014 it redeploys when main changes, so check the latest merge went live'
                : 'Marketstack: HTTP ' + res.status + ' and not JSON' + (text ? ' \u2014 ' + _msScrub(text, apiKey).slice(0, 80) : ''), true);
            e.endpointProblem = res.status === 404;
            throw e;
        }
        if (json.error) {
            trace.response.bodyExcerpt = _msScrub(text, apiKey).slice(0, 1500);
            trace.error = _msScrubObj(json.error, apiKey);      // code, message, and any validation context
            const errCode = String(json.error.code || '');
            const code = errCode ? ' [' + errCode + ']' : '';
            const msg = _msScrub(json.error.message || errCode || ('HTTP ' + res.status), apiKey);
            if (/no_valid_symbols|invalid_symbol/i.test(errCode) || (res.status === 422 && /valid symbol/i.test(msg))) {
                // The symbol itself was refused. Not a fault, not billed — report it per ticker.
                trace.calls.push({ purpose, endpoint: ep.id, symbolsSent: bareList.slice(), status: res.status, bytes: text.length,
                                   rowCount: 0, pagination: null, bodyExcerpt: _msScrub(text, apiKey).slice(0, 300) });
                return { res, text, json, rows: [], rejected: msg + code };
            }
            const cat = _msCategory({ status: res.status, errCode, errMessage: json.error.message });
            const e = bail(cat, 'Marketstack: ' + msg + code, true);
            e.endpointProblem = res.status === 404 || MS_ENDPOINT_ERROR_CODES.test(errCode);
            throw e;
        }
        if (!res.ok) {
            trace.response.bodyExcerpt = _msScrub(text, apiKey).slice(0, 1500);
            const e = bail(_msCategory({ status: res.status }), 'Marketstack: HTTP ' + res.status, true);
            e.endpointProblem = res.status === 404;
            throw e;
        }
        spent += bareList.length;     // it answered, so it counted
        const rows = Array.isArray(json.data) ? json.data : [];
        trace.calls.push({ purpose, endpoint: ep.id, symbolsSent: bareList.slice(), status: res.status, bytes: text.length,
                           rowCount: rows.length, pagination: json.pagination || null,
                           bodyExcerpt: rows.length ? null : _msScrub(text, apiKey).slice(0, 300) });
        // The transport can only see "HTTP 200 with JSON", so say here that the result was empty.
        paAnnotate(res, rows.length
            ? { rows: rows.length }
            : { rows: 0, outcome: 'failed', category: 'empty-response', message: 'HTTP 200 but the result was empty for ' + bareList.join(','),
                bodyExcerpt: _msScrub(text, apiKey).slice(0, 300) });
        return { res, text, json, rows, rejected: null };
    };

    let result = null, usedEp = null, lastRes = null;
    try {
        // The endpoint version that worked last time goes first; the other is tried only after an
        // endpoint/plan/404-type error (never after a symbol, auth, quota or network problem).
        const order = memo0.endpoint === 'v1' ? MS_ENDPOINTS.slice().reverse() : MS_ENDPOINTS;
        let lastErr = null;
        for (const ep of order) {
            try {
                result = await call(ep, syms, 'US fallback (' + ep.id + ')');
                usedEp = ep;
                break;
            } catch (e) {
                lastErr = e;
                if (!e || !e.endpointProblem) throw e;
                trace.endpointFallbacks.push({ endpoint: ep.id, status: trace.response ? trace.response.status : null,
                                               message: e.message, error: trace.error || null });
                trace.error = null;
            }
        }
        if (!result) throw lastErr;
        lastRes = result.res;
    } catch (e) {
        // A failure after an earlier request already answered: return only what wasn't actually spent.
        if (spent > 0) { const was = !!(e && e.refundable); if (e) e.refundable = false; if (was) settle(); }
        throw e;
    }

    const rows = result.rows.filter(r => !r || !r.exchange || String(r.exchange).toUpperCase() === MS_US_EXCHANGE);
    const droppedOtherExchange = result.rows.length - rows.length;
    if (usedEp && (rows.length || result.rejected)) {
        // Remember which endpoint version answered, so the next attempt starts there.
        if (rows.length) saveMsFormat({ best: 'us-nyse', endpoint: usedEp.id, at: new Date().toISOString() });
    }

    const bySymbol = {}, symCounts = {}, exch = new Set();
    let dMin = null, dMax = null;
    for (const r of rows) {
        const sym = bare(r && r.symbol);
        if (r && r.exchange) exch.add(String(r.exchange));
        const d = r && r.date ? String(r.date).slice(0, 10) : null;
        if (d) { if (!dMin || d < dMin) dMin = d; if (!dMax || d > dMax) dMax = d; }
        if (!sym) continue;
        symCounts[String(r.symbol)] = (symCounts[String(r.symbol)] || 0) + 1;
        (bySymbol[sym] || (bySymbol[sym] = [])).push(r);
    }
    const lastCall = trace.calls.length ? trace.calls[trace.calls.length - 1] : null;
    trace.parsed = { pagination: lastCall ? lastCall.pagination : null, rowCount: rows.length, droppedOtherExchange,
                     symbolsReturned: symCounts, exchangesReturned: Array.from(exch), dateRange: dMin ? [dMin, dMax] : null,
                     sampleRow: rows[0] || null };
    const out = {};
    let matched = 0;
    for (const [sym, orig] of Object.entries(symToTicker)) {
        const entryRows = bySymbol[bare(sym)];
        if (!entryRows || !entryRows.length) {
            const got = Object.keys(bySymbol).slice(0, 4).join(', ');
            const err = result.rejected
                ? 'Marketstack: ' + sym + ' was refused as an unknown symbol (' + result.rejected + ')'
                : (!rows.length && droppedOtherExchange > 0)
                ? 'Marketstack: only returned ' + sym + ' from other exchanges (' + Array.from(new Set(result.rows.map(r => r && r.exchange).filter(Boolean))).join(', ') + '), ignored \u2014 not ' + MS_US_EXCHANGE
                : 'Marketstack: no data for ' + sym + (rows.length ? ' (it returned ' + rows.length + ' rows for: ' + (got || 'none') + ')' : ' (HTTP 200 but an empty result)');
            out[orig] = { error: err };
            trace.perTicker[orig] = { symbol: sym, rows: 0, error: err };
            continue;
        }
        const clean = entryRows
            .map(v => ({ date: String(v.date).slice(0, 10), close: Number(v.close) }))
            .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.close) && r.close > 0)
            .sort((a, b) => a.date.localeCompare(b.date));
        out[orig] = { rows: clean };
        trace.perTicker[orig] = { symbol: sym, rows: clean.length, latest: clean.length ? clean[clean.length - 1].date : null };
        if (clean.length) matched++;
    }
    settle();
    const cat = result.rejected ? 'symbol-rejected'
        : _msCategory({ status: trace.response ? trace.response.status : 200, rows: rows.length, matched, wanted: syms.length });
    const bad = Object.entries(trace.perTicker).filter(([, v]) => !v.rows).map(([k]) => k);
    const outcome = matched === syms.length ? 'ok' : (matched > 0 ? 'partial' : 'failed');
    seal(cat, cat === 'ok' ? 'ok' : (bad.length ? 'no usable rows for ' + bad.join(', ') + (result.rejected ? ' \u2014 ' + result.rejected : '') : cat), outcome);
    if (outcome !== 'ok' && lastRes) paAnnotate(lastRes, { perTicker: trace.perTicker, outcome, category: outcome === 'partial' ? 'partial' : (result.rejected ? 'symbol-rejected' : 'empty-response'), message: trace.message });
    Object.defineProperty(out, '__trace', { value: trace, enumerable: false });
    return out;
}

function _dcLoad(key) {
    try { const raw = localStorage.getItem(key); const o = raw ? JSON.parse(raw) : {}; return (o && typeof o === 'object') ? o : {}; }
    catch { return {}; }
}
function _dcSave(key, obj) { try { localStorage.setItem(key, JSON.stringify(obj || {})); } catch {} }
function loadTdDailyCache()      { return _dcLoad(TD_CACHE_KEY); }
function saveTdDailyCache(cache) { _dcSave(TD_CACHE_KEY, cache); }
function loadAvDailyCache()      { return _dcLoad(AV_CACHE_KEY); }
function saveAvDailyCache(cache) { _dcSave(AV_CACHE_KEY, cache); }

function loadAvBudget() {
    const todayKey = new Date().toISOString().slice(0, 10);
    const o = _dcLoad(AV_BUDGET_KEY);
    return (o && o.day === todayKey) ? o : { day: todayKey, used: 0 };
}
function saveAvBudget(b) { _dcSave(AV_BUDGET_KEY, b); }

function loadMsDailyCache()      { return _dcLoad(MS_CACHE_KEY); }
function saveMsDailyCache(cache) { _dcSave(MS_CACHE_KEY, cache); }
// Marketstack's cap is monthly, not daily — the budget resets on the calendar month.
function loadMsBudget() {
    const monthKey = new Date().toISOString().slice(0, 7);   // YYYY-MM
    const o = _dcLoad(MS_BUDGET_KEY);
    return (o && o.month === monthKey) ? o : { month: monthKey, used: 0 };
}
function saveMsBudget(b) { _dcSave(MS_BUDGET_KEY, b); }
function loadMsFormat() {
    const o = _dcLoad(MS_FORMAT_KEY);
    return (o && o.ver === MS_FORMAT_VERSION) ? o : { ver: MS_FORMAT_VERSION, best: null, failedAt: null, probes: [], control: null };
}
function saveMsFormat(o) { _dcSave(MS_FORMAT_KEY, Object.assign({}, o, { ver: MS_FORMAT_VERSION })); }
// One-time correction: earlier versions kept attempts that never got an answer (network error,
// no Worker) on the monthly counter. Refund any such attempt in this month's log, once.
(function reconcileMsBudgetFromLog() {
    try {
        const log = loadMsLog(), month = new Date().toISOString().slice(0, 7);
        let refund = 0, changed = false;
        for (const e of log) {
            if (e && e.kind === 'attempt' && e.outcome === 'failed' && (e.category === 'network' || e.category === 'no-worker')
                && e.budget && !e.budget.refunded && !e.reconciled && String(e.at || '').slice(0, 7) === month) {
                refund += Number(e.budget.chargedUnits) || 0; e.reconciled = true; changed = true;
            }
        }
        if (changed) {
            saveMsLog(log);
            const b = loadMsBudget(); b.used = Math.max(0, (Number(b.used) || 0) - refund); saveMsBudget(b);
        }
    } catch (e) { /* counter housekeeping only */ }
})();

// Twelve Data per-minute credit limiter (shared by Holdings and Markets).
const _tdCreditLog = [];
function _tdCreditsAvailable() {
    const now = Date.now();
    while (_tdCreditLog.length && now - _tdCreditLog[0] > 60000) _tdCreditLog.shift();
    return Math.max(0, TD_CREDITS_PER_MIN - _tdCreditLog.length);
}
function _tdSpendCredits(n) { const now = Date.now(); for (let i = 0; i < n; i++) _tdCreditLog.push(now); }

// Alpha Vantage call queue — serialises calls from anywhere in the app with a
// ≥13 s gap so the 5/minute limit is never tripped.
let _avChain = Promise.resolve();
let _avLastCallAt = 0;
// True when a fetch produced no HTTP response at all (network failure, blocked, offline) rather than an answer.
// Timeouts are excluded: those may have reached the server, so they stay counted.
function _avNoResponse(e) {
    if (!e || e.timeout || e.avDaily) return false;
    return /^(load failed|failed to fetch|networkerror|the network connection was lost|the internet connection appears to be offline)/i.test(String(e.message || ''));
}
function _avSchedule(fn) {
    const run = async () => {
        const wait = _avLastCallAt + AV_MIN_INTERVAL_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        _avLastCallAt = Date.now();
        return fn();
    };
    const p = _avChain.then(run, run);
    _avChain = p.catch(() => {});
    return p;
}

// Is a cached second-source entry good enough to use without re-asking?
function _dcEntryFresh(entry, expectedDate, todayKey, now, refetchMs) {
    if (!entry) return false;
    if (entry.retryAfter && now < entry.retryAfter) return true;          // backing off after an error
    if (entry.fetchedDay !== todayKey || entry.error) return false;
    const rows = Array.isArray(entry.series) ? entry.series : [];
    if (expectedDate ? rows.some(r => r.date === expectedDate) : rows.length > 0) return true;
    return (now - (entry.fetchedAt || 0)) < refetchMs;                  // missing it, but asked recently
}

// ── Selective re-check ───────────────────────────────────────────────────────
// A manual re-check names the sources it may spend on: any of 'yahoo' (free), 'td', 'av', 'ms'.
// The old opts.force === true still means "all of them". An empty list is the normal automatic cycle.
const DC_SOURCES = ['yahoo', 'td', 'av', 'ms'];
function normaliseForceSources(opts) {
    if (opts && Array.isArray(opts.forceSources)) return DC_SOURCES.filter(k => opts.forceSources.indexOf(k) >= 0);
    return (opts && opts.force) ? DC_SOURCES.slice() : [];
}
// Which providers may make network calls in a run. A selective re-check fetches ONLY the sources it
// names (the rest answer from cache), so pressing one button can never spend another source's quota.
function dailyCheckAllowFetch(sources) {
    if (!sources || sources.length === 0) return { td: true, av: true, ms: true };
    return { td: sources.indexOf('td') >= 0, av: sources.indexOf('av') >= 0, ms: sources.indexOf('ms') >= 0 };
}

// Second-source closes for a set of Yahoo symbols, from cache and (optionally) network.
//   opts.allowFetch = { td: bool, av: bool } — false = cache only (never blocks)
//   opts.sessionDateFor(sym) — the session "today" is for that symbol
// Returns { [SYM]: { provider, rows, error, pending } } for symbols with a provider.
async function fetchSecondaryDailyCloses(symbols, opts) {
    opts = opts || {};
    const allowTd = !!(opts.allowFetch && opts.allowFetch.td);
    const allowAv = !!(opts.allowFetch && opts.allowFetch.av);
    const allowMs = !!(opts.allowFetch && opts.allowFetch.ms);
    // Manual re-check: ignore cache freshness ONLY for the sources it names.
    const _fs = normaliseForceSources(opts);
    const forceTd = _fs.indexOf('td') >= 0, forceAv = _fs.indexOf('av') >= 0, forceMs = _fs.indexOf('ms') >= 0;
    const sessionDateFor = typeof opts.sessionDateFor === 'function' ? opts.sessionDateFor : () => null;
    const tdKey = getTdApiKey(), avKey = getAvApiKey(), msKey = getMsApiKey();
    const now = Date.now(), todayKey = new Date().toISOString().slice(0, 10);
    const tdCache = loadTdDailyCache(), avCache = loadAvDailyCache(), msCacheRead = loadMsDailyCache();
    const out = {}, tdNeed = [], avNeed = [], msEligible = [], noKeyTd = [], noKeyAv = [], avBudgetCut = [];

    for (const tk of Array.from(new Set((symbols || []).map(_dcUp))).filter(Boolean)) {
        const prof = dailyCheckProfileFor(tk);
        if (!prof.provider) continue;
        if (prof.msSymbol) msEligible.push(tk);
        const sd  = sessionDateFor(tk) || getCurrentPnlSessionDateStr();
        const exp = prof.calendar ? previousExchangeSession(prof.calendar, sd) : null;
        const expectedDate = exp ? exp.date : null;
        const cache = prof.provider === 'td' ? tdCache : avCache;
        const key   = prof.provider === 'td' ? tdKey : avKey;
        const entry = cache[tk];
        out[tk] = {
            provider: prof.providerName,
            rows:     (entry && Array.isArray(entry.series)) ? entry.series : [],
            error:    !key ? ('No ' + prof.providerName + ' key set') : ((entry && entry.error) || null),
            pending:  false,
            // Every source's own answer for this ticker, kept separately so the
            // Settings grid can show exactly which source responded. Only the primary
            // (or a Marketstack fallback when the primary has nothing) feeds the merge.
            bySource: {},
            _pk:      prof.provider,
        };
        if (prof.msSymbol) {
            const me = msCacheRead[tk];
            if (!msKey) out[tk].bySource.ms = { rows: [], error: 'No Marketstack key set', pending: false };
            else if (me && me.fetchedDay === todayKey)
                out[tk].bySource.ms = { rows: Array.isArray(me.series) ? me.series : [], error: me.error || null, pending: false };
        }
        if (!key) { (prof.provider === 'td' ? noKeyTd : noKeyAv).push(tk); continue; }
        const fresh = _dcEntryFresh(entry, expectedDate, todayKey, now,
                                    prof.provider === 'td' ? TD_REFETCH_MS : AV_REFETCH_MS);
        if (!fresh || (prof.provider === 'td' ? forceTd : forceAv)) (prof.provider === 'td' ? tdNeed : avNeed).push(tk);
    }

    // Audit trail: sources that were wanted but couldn't be asked (logged only on a pass that may fetch).
    if (allowTd && noKeyTd.length) paSkip('twelvedata', 'no-api-key', noKeyTd, { forced: forceTd });
    if (allowAv && noKeyAv.length) paSkip('alphavantage', 'no-api-key', noKeyAv, { forced: forceAv });
    // ── Twelve Data: one batch, capped by the per-minute credit budget ──────────
    if (tdNeed.length) {
        const avail = allowTd ? _tdCreditsAvailable() : 0;
        const batch = tdNeed.slice(0, avail);
        tdNeed.slice(avail).forEach(tk => { out[tk].pending = true; });
        if (allowTd && tdNeed.length > avail) paSkip('twelvedata', 'per-minute-credit-limit', tdNeed.slice(avail), { forced: forceTd, detail: { creditsPerMinute: TD_CREDITS_PER_MIN, creditsAvailable: avail } });
        if (batch.length) {
            _tdSpendCredits(batch.length);
            try {
                const res = await fetchTwelveDataBatch(batch, tdKey, opts.signal || null);
                const t = Date.now();
                for (const tk of batch) {
                    const r = res[tk] || { error: 'Twelve Data: no data returned' };
                    const prev = tdCache[tk];
                    if (r.rows && r.rows.length) {
                        tdCache[tk] = { series: r.rows, fetchedAt: t, fetchedDay: todayKey, error: null, retryAfter: null };
                        out[tk].rows = r.rows; out[tk].error = null;
                    } else {
                        tdCache[tk] = { series: (prev && prev.series) || [], fetchedAt: (prev && prev.fetchedAt) || null,
                                        fetchedDay: todayKey, error: r.error, retryAfter: t + TD_ERROR_RETRY_MS };
                        out[tk].error = r.error;
                    }
                }
            } catch (e) {
                const msg = (e && e.message) || 'Twelve Data fetch failed';
                const perMinute = /429|current minute|run out of api credits/i.test(msg);
                for (const tk of batch) {
                    const prev = tdCache[tk];
                    tdCache[tk] = { series: (prev && prev.series) || [], fetchedAt: (prev && prev.fetchedAt) || null,
                                    fetchedDay: todayKey, error: msg,
                                    retryAfter: Date.now() + (perMinute ? TD_MINUTE_RETRY_MS : TD_ERROR_RETRY_MS) };
                    out[tk].error = msg;
                }
            }
            saveTdDailyCache(tdCache);
        }
    }

    // ── Alpha Vantage: sequential via the shared queue, within the daily budget ─
    // (Marketstack is no longer an Alpha Vantage backstop: it has no London data. It backs up the US holding only — see the td-failed queue below.)
    const msFallbackCandidates = forceMs ? msEligible.slice() : [];
    const msReason = {};   // why each ticker is being sent to Marketstack — recorded in the attempt log
    if (forceMs) msEligible.forEach(tk => { msReason[tk] = 'forced-recheck'; });
    const queueMsFallback = (tk, why) => {
        if (!msFallbackCandidates.includes(tk)) msFallbackCandidates.push(tk);
        if (why) msReason[tk] = msReason[tk] ? (msReason[tk].split('+').includes(why) ? msReason[tk] : msReason[tk] + '+' + why) : why;
    };
    // Twelve Data is the primary source for the US holding (Citi). If it was asked this cycle and came back
    // with an error (not merely "pending" behind the per-minute limit), Marketstack is the fallback.
    for (const tk of tdNeed) {
        if (out[tk] && out[tk].error && !out[tk].pending && dailyCheckProfileFor(tk).msSymbol) queueMsFallback(tk, 'td-failed');
    }
    if (avNeed.length) {
        if (!allowAv) {
            avNeed.forEach(tk => { out[tk].pending = true; });
        } else {
            for (const tk of avNeed) {
                const budget = loadAvBudget();
                if (budget.used >= AV_DAILY_BUDGET) {
                    out[tk].error = 'Alpha Vantage daily budget used (' + AV_DAILY_BUDGET + '/day) — resumes tomorrow';
                    if (dailyCheckProfileFor(tk).msSymbol) queueMsFallback(tk, 'av-budget-exhausted');
                    avBudgetCut.push(tk);
                    continue;
                }
                budget.used += 1; saveAvBudget(budget);
                try {
                    // A request that got NO response (iOS "Load failed": blocked, offline, app just resumed) never reached
                    // Alpha Vantage, so it isn't counted by them and must not be counted here either — the 29 Sep export
                    // showed 6 such instant failures eating 6 of the 25 daily requests. Refund it and retry once after a pause.
                    let rows;
                    for (let tryNo = 1; ; tryNo++) {
                        try { rows = await _avSchedule(() => fetchAlphaVantageSeries(tk, avKey, opts.signal || null)); break; }
                        catch (e1) {
                            if (!_avNoResponse(e1)) throw e1;
                            const bR = loadAvBudget(); bR.used = Math.max(0, bR.used - 1); saveAvBudget(bR);
                            if (tryNo >= 2 || (opts.signal && opts.signal.aborted)) throw e1;
                            await new Promise(r => setTimeout(r, 2500));
                            const bC = loadAvBudget(); bC.used += 1; saveAvBudget(bC);
                        }
                    }
                    const fresh = loadAvDailyCache();
                    fresh[tk] = { series: rows, fetchedAt: Date.now(), fetchedDay: todayKey, error: null, retryAfter: null };
                    saveAvDailyCache(fresh);
                    out[tk].rows = rows; out[tk].error = null;
                } catch (e) {
                    const msg = (e && e.message) || 'Alpha Vantage fetch failed';
                    const fresh = loadAvDailyCache();
                    const prev = fresh[tk];
                    const tomorrow = new Date(todayKey + 'T00:00:00Z').getTime() + 86400000 + 60000;
                    fresh[tk] = { series: (prev && prev.series) || [], fetchedAt: (prev && prev.fetchedAt) || null,
                                  fetchedDay: todayKey, error: msg,
                                  retryAfter: e && e.avDaily ? tomorrow : Date.now() + AV_ERROR_RETRY_MS };
                    saveAvDailyCache(fresh);
                    out[tk].error = msg;
                    if (e && e.avDaily && dailyCheckProfileFor(tk).msSymbol) queueMsFallback(tk, 'av-daily-limit-error');
                }
            }
        }
    }

    if (avBudgetCut.length) paSkip('alphavantage', 'daily-budget-exhausted', avBudgetCut, { forced: forceAv, detail: { cap: AV_DAILY_BUDGET, used: loadAvBudget().used } });

    for (const tk of Object.keys(out)) {
        const o = out[tk];
        if (o._pk) o.bySource[o._pk] = { rows: o.rows, error: o.error, pending: o.pending };
    }

    // ── Marketstack: fallback for the US holding (Citi). Queued when Twelve Data has no usable answer for it,
    // and on a forced Marketstack "Re-check" (deliberately queried whatever the primary said, cache or no cache,
    // so a manual re-check actually verifies that source). London holdings never come here: this account has no London data.
    if (msFallbackCandidates.length) {
        const now2 = Date.now();
        const msCache = loadMsDailyCache();
        // Record Marketstack's answer in its own column; feed it into the merge ONLY
        // when the primary source (Alpha Vantage) has nothing usable for this ticker.
        // A successful Alpha Vantage answer is never overwritten or masked by it.
        const setMs = (tk, rows, error, pending) => {
            out[tk].bySource.ms = { rows: rows || [], error: error || null, pending: !!pending };
            const primaryEmpty = !(out[tk].rows && out[tk].rows.length);
            if (rows && rows.length && primaryEmpty) {
                out[tk].rows = rows; out[tk].error = null; out[tk].pending = false; out[tk].provider = 'Marketstack';
            }
        };
        const need = [];
        for (const tk of msFallbackCandidates) {
            const entry = msCache[tk];
            if (!forceMs && _dcEntryFresh(entry, null, todayKey, now2, MS_REFETCH_MS)) {
                if (entry && !entry.error && Array.isArray(entry.series) && entry.series.length) setMs(tk, entry.series, null, false);
                else if (entry && entry.error) setMs(tk, [], entry.error, false);
            } else {
                need.push(tk);
            }
        }
        // What the primary source said for each ticker — logged with every attempt so a
        // Marketstack failure can be read alongside it without guesswork.
        const avStateOf = tk => {
            const a = out[tk].bySource && (out[tk].bySource.td || out[tk].bySource.av);   // the primary source for that ticker
            if (!a) return null;
            const last = a.rows && a.rows.length ? a.rows[a.rows.length - 1] : null;
            return { rows: (a.rows || []).length, latest: last ? last.date : null, error: a.error || null };
        };
        if (need.length) {
            if (!msKey) {
                need.forEach(tk => setMs(tk, [], 'No Marketstack key set', false));
                if (allowMs) recordMsSkip('no-api-key', need, { forced: forceMs });
            } else if (!allowMs) {
                need.forEach(tk => { setMs(tk, [], null, true); if (!(out[tk].rows && out[tk].rows.length)) out[tk].pending = true; });
            } else {
                const budget = loadMsBudget();
                const budgetBefore = budget.used;
                const room  = Math.max(0, MS_MONTHLY_BUDGET - budget.used);
                const batch = need.slice(0, room);
                const cut   = need.slice(room);
                cut.forEach(tk => setMs(tk, [], 'Marketstack monthly budget used (' + MS_MONTHLY_BUDGET + '/month)', false));
                if (cut.length) recordMsSkip('monthly-budget-exhausted', cut, { forced: forceMs, budget: { cap: MS_MONTHLY_BUDGET, used: budgetBefore } });
                if (batch.length) {
                    budget.used += batch.length; saveMsBudget(budget);
                    let res = null, thrown = null, trace = null;
                    try {
                        res = await fetchMarketstackBatch(batch, msKey, opts.signal || null);
                        trace = (res && res.__trace) || null;
                    } catch (e) { thrown = e; trace = (e && e.trace) || null; }
                    if (!thrown) {
                        const t = Date.now();
                        for (const tk of batch) {
                            const r = res[tk] || { error: 'Marketstack: no data returned' };
                            const prev = msCache[tk];
                            if (r.rows && r.rows.length) {
                                msCache[tk] = { series: r.rows, fetchedAt: t, fetchedDay: todayKey, error: null, retryAfter: null };
                                setMs(tk, r.rows, null, false);
                            } else {
                                msCache[tk] = { series: (prev && prev.series) || [], fetchedAt: (prev && prev.fetchedAt) || null,
                                                fetchedDay: todayKey, error: r.error, retryAfter: t + MS_ERROR_RETRY_MS };
                                setMs(tk, [], r.error, false);
                            }
                        }
                    } else {
                        const msg = (thrown && thrown.message) || 'Marketstack fetch failed';
                        if (thrown.refundable) {      // rejected outright: Marketstack didn't count it, so neither do we
                            const b2 = loadMsBudget();
                            b2.used = Math.max(0, b2.used - batch.length);
                            saveMsBudget(b2);
                        }
                        for (const tk of batch) {
                            const prev = msCache[tk];
                            msCache[tk] = { series: (prev && prev.series) || [], fetchedAt: (prev && prev.fetchedAt) || null,
                                            fetchedDay: todayKey, error: msg, retryAfter: Date.now() + MS_ERROR_RETRY_MS };
                            setMs(tk, [], msg, false);
                        }
                    }
                    saveMsDailyCache(msCache);
                    // ── Audit trail: one full entry per attempt, success or failure ──
                    try {
                        const entry = trace || {
                            v: 1, kind: 'attempt', at: new Date().toISOString(),
                            request: { params: { symbols: batch.map(tk => dailyCheckProfileFor(tk).msSymbol).join(',') } },
                            response: null, parsed: null, perTicker: {}, outcome: 'failed', category: 'unexpected-error',
                            message: _msScrub((thrown && thrown.message) || 'unknown', msKey), durationMs: null,
                            exception: { name: (thrown && thrown.name) || null, message: _msScrub((thrown && thrown.message) || '', msKey),
                                         stack: _msScrub((thrown && thrown.stack) || '', msKey).slice(0, 800) },
                        };
                        entry.forced = forceMs;
                        entry.sessionDate = todayKey;
                        entry.requestedTickers = batch.slice();
                        entry.triggers = Object.fromEntries(batch.map(tk => [tk, msReason[tk] || null]));
                        entry.primary = Object.fromEntries(batch.map(tk => [tk, avStateOf(tk)]));
                        entry.budget = { cap: MS_MONTHLY_BUDGET, before: budgetBefore, chargedUnits: batch.length,
                                         after: loadMsBudget().used, refunded: !!(thrown && thrown.refundable) };
                        recordMsAttempt(entry);
                    } catch (logErr) { console.warn('[marketstack] could not record attempt:', logErr && logErr.message); }
                }
            }
        }
    }
    return out;
}

// Per-source answers carried into dailyCheckStatus for the Settings grid. Only the
// last few rows are kept — the grid needs the previous session's close, nothing more.
// Single source of truth for a holding's pricing health — used by BOTH the
// Settings "Daily close check" grid and the main-page pricing badge, so the two
// can never disagree. tier drives the badge: 'verified' (green), 'degraded'
// (grey, "unconfirmed" — a price exists but isn't independently cross-checked, e.g.
// single-source, carried-forward, or still catching up: the concern is missing
// data, not a disagreement), or 'failed' (red — no usable price, or the sources
// disagree / the move is implausible).
const DC_UNCONFIRMED_COLOUR = '#a1a1aa';   // grey: a price exists but can't be cross-checked (missing data, not a mismatch)
function buildDailyCheckRows({ liveDailyCloses, liveQuoteSessionDates, dailyCheckStatus, liveQuoteChecks, livePrices }) {
    const map = liveDailyCloses || {};
    const st  = dailyCheckStatus || {};
    const qc  = liveQuoteChecks || {};
    // Every verifiable holding, plus ANY fetched ticker whose live quote was
    // held back or whose currency label disagrees (e.g. GBPUSD=X, ^GSPC).
    const flagged = Object.keys(qc).filter(k => qc[k] && (qc[k].status === 'rejected' || qc[k].status === 'fetch-failed'
                                                          || qc[k].carried || qc[k].currencyMismatch));
    const tks = Array.from(new Set([
        ...Object.keys(map).concat(Object.keys(st)).filter(isDailyCheckVerifiableTicker),
        ...flagged,
    ])).sort();
    const fmtD = d => {
        if (!d) return '—';
        const x = new Date(d + 'T12:00:00Z');
        return x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    };
    return tks.map(tk => {
        const session = (liveQuoteSessionDates && liveQuoteSessionDates[tk]) || getCurrentPnlSessionDateStr();
        const lp  = livePrices ? Number(livePrices[tk]) : NaN;
        const vr  = resolveVerifiedDailyPrevClose({ ticker: tk, sessionDate: session, livePx: lp, dailyCloses: map });
        const rows = Array.isArray(map[tk]) ? map[tk] : [];
        const row  = vr.date ? rows.find(r => r.date === vr.date) : null;
        const s0   = st[tk] || {};
        const provider = s0.provider || dailyCheckProfileFor(tk).providerName || 'second source';
        const q   = qc[tk] || null;
        let label, color;
        if (q && q.status === 'rejected') {
            label = q.carried ? 'Held · last good price' : 'Live price held'; color = '#f87171';
        } else if (q && q.carried) {
            label = 'Last good price'; color = DC_UNCONFIRMED_COLOUR;
        } else if (q && q.status === 'fetch-failed') {
            label = 'No quote'; color = '#f87171';
        } else if (vr.ok) {
            label = ({ 'verified': 'Verified', 'yahoo-only': 'Yahoo only', 'alt-only': provider + ' only' })[vr.status] || vr.status;
            color = vr.status === 'verified' ? '#34d399' : DC_UNCONFIRMED_COLOUR;
        } else if (vr.reason === 'prev-session-missing') { label = 'Missing ' + fmtD(vr.expectedDate); color = '#f87171'; }
        else if (vr.reason === 'sources-disagree')        { label = 'Sources differ'; color = '#f87171'; }
        else if (vr.reason === 'implausible-move')        { label = 'Implausible move'; color = '#f87171'; }
        else                                              { label = 'No data'; color = '#71717a'; }
        // Badge tier: derived straight from color so it can never drift from what
        // the detailed grid displays. The light grey is "unconfirmed"; the darker grey
        // ("No data") counts as failed — it means no usable price of any kind, same
        // as the red reasons (which include sources that disagree).
        const tier = color === '#34d399' ? 'verified' : color === DC_UNCONFIRMED_COLOUR ? 'degraded' : 'failed';
        const pct = (vr.ok && lp > 0) ? (lp / vr.value - 1) : null;
        const heldText = (q && q.status === 'rejected')
            ? ('quote ' + (q.px != null ? Number(q.px).toFixed(2) : '?') + ' held: ' +
               (q.reason === 'units-differ-from-history'
                   ? 'units differ from stored history (' + (q.historyClose != null ? Number(q.historyClose).toFixed(2) : '?') + ')'
                   : (q.reason || 'failed check') + (q.refClose != null ? ' (' + Number(q.refClose).toFixed(2) + ')' : '')))
            : null;
        const ccyText = (q && q.currencyMismatch)
            ? ('Yahoo quotes ' + q.quoteCurrency + ', file says ' + q.expectedCurrency + ' — using Yahoo\'s') : null;
        const carryText = (q && q.carried)
            ? ('using ' + Number(q.carriedPx).toFixed(2) + (q.lastGoodAt ? ' from ' + new Date(q.lastGoodAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '')
               + (q.status === 'fetch-failed' ? ' — this refresh failed' : ''))
            : ((q && q.status === 'fetch-failed') ? 'this refresh failed and there is no earlier quote' : null);
        // ── One cell per pricing source, all read at the SAME target date ──
        // (the previous session being used, or the one expected if it's missing).
        const prof = dailyCheckProfileFor(tk);
        const target = vr.date || vr.expectedDate || vr.foundDate || null;
        const yRowsRaw = rows.filter(r => r && r.yahoo != null).map(r => ({ date: r.date, close: Number(r.yahoo) }));
        const yAtTarget = target ? (yRowsRaw.find(r => r.date === target) || null) : null;
        const srcs = s0.sources || {};
        const cellFor = (key, applies) => {
            if (!applies) return { state: 'na' };
            const v = srcs[key];
            if (!v) return { state: s0.pending ? 'pending' : 'none' };
            const hit = target ? (v.rows || []).find(r => r.date === target) : null;
            if (hit) {
                let agree = null;
                if (yAtTarget) {
                    const f = crossSourceUnitFactor(yRowsRaw, v.rows, lp);
                    agree = f ? Math.abs(hit.close / f / yAtTarget.close - 1) <= prof.tolerance : false;
                }
                return { state: 'ok', value: hit.close, agree };
            }
            if (v.pending) return { state: 'pending' };
            if (v.error)   return { state: 'err', msg: v.error };
            return { state: (v.rows && v.rows.length) ? 'missing' : 'none' };
        };
        const cells = {
            yahoo: yAtTarget ? { state: 'ok', value: yAtTarget.close, agree: null } : { state: rows.length ? 'missing' : 'none' },
            td: cellFor('td', prof.provider === 'td'),
            av: cellFor('av', !!prof.avSymbol),
            ms: cellFor('ms', !!prof.msSymbol),
        };
        const srcNames = { td: 'Twelve Data', av: 'Alpha Vantage', ms: 'Marketstack' };
        const srcErrs = ['td', 'av', 'ms'].filter(k => cells[k].state === 'err').map(k => srcNames[k] + ': ' + cells[k].msg);
        const err = [heldText, carryText, ccyText,
                     (s0.unitMismatch ? provider + ' price does not match this instrument/units' : null),
                     ...srcErrs]
            .filter(Boolean).join(' · ') || null;
        return { tk, provider, prevLabel: fmtD(target), label, color, tier,
                 yahoo: row ? row.yahoo : null, alt: row ? row.alt : null, pct, err, cells,
                 calendarCovered: vr.calendarCovered, calendar: prof.calendar };
    });
}

function compactDailyCheckSources(sec) {
    const src = (sec && sec.bySource) || {};
    const out = {};
    for (const k of Object.keys(src)) {
        const v = src[k] || {};
        out[k] = { rows: Array.isArray(v.rows) ? v.rows.slice(-15) : [], error: v.error || null, pending: !!v.pending };
    }
    return out;
}
function dailyCheckSourcesSig(src) {
    return Object.keys(src || {}).sort().map(k => {
        const v = src[k] || {}, r = v.rows || [], last = r.length ? r[r.length - 1] : null;
        return k + '=' + r.length + '/' + (last ? last.date + '@' + last.close : '') + '/' + (v.error || '') + '/' + (v.pending ? 1 : 0);
    }).join(',');
}

function _median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Units: a second source can quote the same LSE line in pence vs pounds.
// Returns the divisor to convert otherRows → Yahoo units (1, 100 or 0.01), or
// null when no clean factor fits (then the second source isn't used for that symbol).
function crossSourceUnitFactor(yahooRows, otherRows, yahooLivePx) {
    if (!Array.isArray(otherRows) || otherRows.length === 0) return null;
    const yMap = new Map((yahooRows || [])
        .filter(r => r && Number(r.close) > 0)
        .map(r => [String(r.date).slice(0, 10), Number(r.close)]));
    const ratios = otherRows
        .filter(r => yMap.has(r.date))
        .map(r => r.close / yMap.get(r.date))
        .filter(Number.isFinite);
    let ref = null, tol = 0.05;
    if (ratios.length > 0) {
        ref = _median(ratios);
    } else if (Number(yahooLivePx) > 0) {
        ref = otherRows[otherRows.length - 1].close / Number(yahooLivePx);
        tol = 0.20; // no common date: compare the other source's latest close with the live price
    }
    if (ref == null || !Number.isFinite(ref) || ref <= 0) return null;
    for (const f of [1, 100, 0.01]) {
        if (Math.abs(ref / f - 1) <= tol) return f;
    }
    return null;
}

// Merge Yahoo and (unit-normalised) second-source closes by date and grade each
// date. Rows keep { date, close } so existing consumers still work; status / yahoo
// / alt are read by resolveVerifiedDailyPrevClose.
function mergeDailyCloseSources(yahooRows, altRowsNorm, tolerance) {
    const tol = Number.isFinite(tolerance) ? tolerance : DAILY_VERIFY_TOLERANCE;
    const byDate = new Map();
    for (const r of (yahooRows || [])) {
        const c = Number(r && r.close);
        if (!r || !r.date || !Number.isFinite(c) || c <= 0) continue;
        byDate.set(String(r.date).slice(0, 10), { yahoo: c, alt: null });
    }
    for (const r of (altRowsNorm || [])) {
        const c = Number(r && r.close);
        if (!r || !r.date || !Number.isFinite(c) || c <= 0) continue;
        const k = String(r.date).slice(0, 10);
        const e = byDate.get(k) || { yahoo: null, alt: null };
        e.alt = c;
        byDate.set(k, e);
    }
    return Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, e]) => {
            if (e.yahoo != null && e.alt != null) {
                const agree = Math.abs(e.alt / e.yahoo - 1) <= tol;
                return { date, close: e.yahoo, status: agree ? 'verified' : 'conflict', yahoo: e.yahoo, alt: e.alt };
            }
            if (e.yahoo != null) return { date, close: e.yahoo, status: 'yahoo-only', yahoo: e.yahoo, alt: null };
            return { date, close: e.alt, status: 'alt-only', yahoo: null, alt: e.alt };
        });
}

// Yahoo rows + one symbol's second-source result → graded rows.
function mergeYahooWithSecondary(sym, yahooRows, sec, livePx) {
    const prof  = dailyCheckProfileFor(sym);
    const aRows = (sec && Array.isArray(sec.rows)) ? sec.rows : [];
    const factor = aRows.length ? crossSourceUnitFactor(yahooRows, aRows, livePx) : null;
    const aNorm  = factor ? aRows.map(r => ({ date: r.date, close: r.close / factor })) : [];
    return { rows: mergeDailyCloseSources(yahooRows, aNorm, prof.tolerance),
             factor, unitMismatch: aRows.length > 0 && factor == null };
}

// The single previous-close decision for every 1D figure in the app.
// Holdings, restricted schemes, the Markets tab, the SPX chart patch and the
// Settings/diagnostics views all call this; there is no fallback resolver.
//   sessionDate — the session "today" represents (from the existing session guards)
//   livePx      — Yahoo live price (same units as the rows)
//   maxMove     — optional override of the instrument's plausibility ceiling
// Selection rule: when the instrument's calendar has explicit holidays (equities —
// LSE, NYSE, JPX, KRX, EUREX), the previous close must be the row dated EXACTLY on
// the expected previous session; a row dated between that session and today (e.g.
// a bank-holiday stub bar) is not a session and is ignored, so a holiday can never
// silently hide a two-day move. For a calendar with no holiday concept — FX
// (every weekday trades) and crypto (every day trades) — "was there a session" is
// never in doubt, only its exact date LABEL can be a day off (Yahoo's own bar
// dating for continuously-traded instruments doesn't always land on the calendar
// day our weekday-walk expects), so a row up to a day either side of the expected
// date is accepted; anything older than that is still treated as a genuine gap.
// With no calendar at all (unmapped instrument) the latest row before today is used.
// Returns:
//   { ok:true,  value, date, status, expectedDate, calendarCovered, ignoredNonSessionRows }
//   { ok:false, reason, ... }  → show "—"
//     reasons: no-ticker-or-session | no-daily-series | no-prior-close |
//              prev-session-missing | sources-disagree | implausible-move
function resolveVerifiedDailyPrevClose({ ticker, sessionDate, livePx, dailyCloses, maxMove }) {
    const tk = _dcUp(ticker);
    if (!tk || !sessionDate) return { ok: false, reason: 'no-ticker-or-session' };
    const rows = dailyCloses && (dailyCloses[tk] ??
        Object.entries(dailyCloses).find(([k]) => _dcUp(k) === tk)?.[1]);
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, reason: 'no-daily-series' };

    const prof = dailyCheckProfileFor(tk);
    const spec = prof.calendar ? EXCHANGE_CALENDARS[prof.calendar] : null;
    const isWeekend = ds => { const g = new Date(ds + 'T12:00:00Z').getUTCDay(); return g === 0 || g === 6; };

    const prior = rows
        .filter(r => r && r.date && String(r.date).slice(0, 10) < sessionDate && Number(r.close) > 0)
        // Weekend-dated stubs (e.g. FX ticks from Sunday evening) are not sessions.
        .filter(r => !(spec && !spec.everyDay && isWeekend(String(r.date).slice(0, 10))))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const expected = prof.calendar ? previousExchangeSession(prof.calendar, sessionDate) : null;
    const expectedDate = expected ? expected.date : null;
    const calendarCovered = expected ? expected.covered : null;
    if (prior.length === 0) return { ok: false, reason: 'no-prior-close', expectedDate, calendarCovered };

    // Candidate rows: with a known expected session, only rows on or before it count.
    const eligible = expected ? prior.filter(r => String(r.date).slice(0, 10) <= expected.date) : prior;
    const ignoredNonSessionRows = prior.length - eligible.length;
    if (eligible.length === 0) {
        return { ok: false, reason: 'prev-session-missing', expectedDate, foundDate: null, calendarCovered, ignoredNonSessionRows };
    }
    const last     = eligible[eligible.length - 1];
    const lastDate = String(last.date).slice(0, 10);
    const status   = last.status || 'yahoo-only'; // rows restored from older backups carry no status

    // Missing-session check: no source has the previous trading day.
    // FX/crypto: every day is a session, so a same-or-adjacent-day label is still
    // "the previous session", just dated a day off from our calendar walk — accept
    // it. A gap of 2+ days is a genuine missing session even for these calendars.
    const dateOnlyDiffDays = (a, b) => Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000);
    const noHolidayCalendar = !!(spec && !spec.holidays);
    const labelDrift = expected ? dateOnlyDiffDays(expected.date, lastDate) : 0;
    if (expected && labelDrift !== 0 && !(noHolidayCalendar && labelDrift >= 0 && labelDrift <= 1)) {
        return { ok: false, reason: 'prev-session-missing', expectedDate, foundDate: lastDate, calendarCovered, ignoredNonSessionRows };
    }
    if (status === 'conflict') {
        return { ok: false, reason: 'sources-disagree', date: lastDate, expectedDate, calendarCovered,
                 yahoo: last.yahoo ?? null, alt: last.alt ?? null };
    }
    const prev  = Number(last.close);
    const lp    = Number(livePx);
    const limit = Number.isFinite(maxMove) ? maxMove : prof.maxMove;
    if (Number.isFinite(lp) && lp > 0 && Math.abs(lp / prev - 1) > limit) {
        return { ok: false, reason: 'implausible-move', date: lastDate, expectedDate, calendarCovered, value: prev };
    }
    return { ok: true, value: prev, date: lastDate, status, expectedDate, calendarCovered, ignoredNonSessionRows };
}

// ── Live-quote gate ──────────────────────────────────────────────────────────
// Decides whether a Yahoo live price may be used ANYWHERE — portfolio value,
// charts, restricted schemes, Today. It runs once per fetch cycle, before the
// quotes are committed to livePrices (and again on JSON restore), so every
// consumer of livePrices only ever sees accepted quotes. A rejected quote is
// treated exactly like a failed fetch for that ticker, and the reason is kept
// in liveQuoteChecks for Settings → Daily close check and the diagnostics export.
//
// Two checks, both aimed at gross data errors rather than policing real moves:
//   1. Move check — vs the latest completed close before the quote's session in
//      the graded daily rows (the same rows the previous-close resolver uses),
//      if that close is at most LIVE_GATE_MAX_REF_AGE_DAYS old. Ceiling: the
//      instrument's plausibility limit (LSE 25 %, US 30 %, FX 10 %, …).
//   2. Units check — vs the latest close in stored price history. Catches a
//      pence/pounds slip that affects Yahoo's recent daily rows as well as the
//      live price (which check 1 cannot see). The band is deliberately wide
//      (×/÷ LIVE_GATE_UNIT_RATIO) because stored history may be weeks old.
// Currency label (Yahoo meta.currency vs the CSV / config currency) never rejects
// a quote. Yahoo's label is what the app converts with (buildEffectiveCurrencyMap);
// a disagreement is recorded as currencyMismatch so Settings can list it.
// Status: 'ok' | 'unchecked' (no reference close available) | 'rejected'.
const LIVE_GATE_MAX_REF_AGE_DAYS = 10;
const LIVE_GATE_UNIT_RATIO       = 10;

function normaliseQuoteCurrency(c) {
    if (c == null) return null;
    const s = String(c).trim();
    if (!s) return null;
    if (s === 'GBp' || s === 'GBx' || s.toUpperCase() === 'GBX') return 'GBX';
    return s.toUpperCase();
}

// Expected quote currency per ticker, from the HL CSV, equity-plan configs and
// custody holdings (later sources win). Keys normalised to UPPER.TRIM.
function buildExpectedQuoteCurrencyMap(tickerCurrencyMap, compConfigs, externalHoldings) {
    const out = {};
    Object.entries(tickerCurrencyMap || {}).forEach(([k, v]) => { if (k && v) out[_dcUp(k)] = v; });
    (compConfigs || []).forEach(p => {
        const tk = p && (p.yahoo_ticker || p.yahooTicker);
        if (tk && p.currency) out[_dcUp(tk)] = p.currency;
    });
    (externalHoldings || []).forEach(h => { if (h && h.ticker && h.currency) out[_dcUp(h.ticker)] = h.currency; });
    return out;
}

function assessLiveQuote({ ticker, livePx, sessionDate, dailyCloses, historySeries, quoteCurrency, expectedCurrency }) {
    const tk   = _dcUp(ticker);
    const px   = Number(livePx);
    const prof = dailyCheckProfileFor(tk);
    const out  = {
        ticker: tk, status: 'unchecked', reason: null,
        px: Number.isFinite(px) ? px : null,
        refClose: null, refDate: null, move: null, maxMove: prof.maxMove,
        historyClose: null, historyDate: null,
        quoteCurrency: normaliseQuoteCurrency(quoteCurrency),
        expectedCurrency: normaliseQuoteCurrency(expectedCurrency),
        currencyMismatch: false,
    };
    if (!Number.isFinite(px) || px <= 0) { out.status = 'rejected'; out.reason = 'not-a-positive-price'; return out; }
    if (out.quoteCurrency && out.expectedCurrency && out.quoteCurrency !== out.expectedCurrency) out.currencyMismatch = true;

    // 1. Move check against the latest completed close in the daily rows.
    const sd   = sessionDate || getCurrentPnlSessionDateStr();
    const rows = dailyCloses && (dailyCloses[tk] ??
        Object.entries(dailyCloses).find(([k]) => _dcUp(k) === tk)?.[1]);
    let checked = false;
    if (Array.isArray(rows) && rows.length > 0 && sd) {
        const floor = new Date(sd + 'T12:00:00Z');
        floor.setUTCDate(floor.getUTCDate() - LIVE_GATE_MAX_REF_AGE_DAYS);
        const floorStr = floor.toISOString().slice(0, 10);
        const prior = rows
            .filter(r => r && r.date && Number(r.close) > 0)
            .map(r => ({ date: String(r.date).slice(0, 10), close: Number(r.close) }))
            .filter(r => r.date < sd && r.date >= floorStr)
            .sort((a, b) => a.date.localeCompare(b.date));
        if (prior.length > 0) {
            const ref = prior[prior.length - 1];
            out.refClose = ref.close; out.refDate = ref.date;
            out.move = px / ref.close - 1;
            checked = true;
            if (Math.abs(out.move) > prof.maxMove) {
                out.status = 'rejected';
                out.reason = 'implausible-vs-' + ref.date + '-close';
                return out;
            }
        }
    }

    // 2. Units check against stored history (any age).
    if (Array.isArray(historySeries) && historySeries.length > 0) {
        for (let i = historySeries.length - 1; i >= 0; i--) {
            const c = Number(historySeries[i] && historySeries[i].close);
            if (Number.isFinite(c) && c > 0) {
                out.historyClose = c; out.historyDate = historySeries[i].date || null;
                break;
            }
        }
        if (out.historyClose != null) {
            checked = true;
            const ratio = px / out.historyClose;
            if (ratio > LIVE_GATE_UNIT_RATIO || ratio < 1 / LIVE_GATE_UNIT_RATIO) {
                out.status = 'rejected';
                out.reason = 'units-differ-from-history';
                return out;
            }
        }
    }

    out.status = checked ? 'ok' : 'unchecked';
    if (!checked) out.reason = 'no-reference-close';
    return out;
}

// Runs assessLiveQuote over a whole quote map. Returns the accepted quotes and
// the per-ticker check results. Used by the fetch commit and by JSON restore.
function gateLiveQuotes({ quotes, sessionDates, dailyCloses, prices, quoteCurrencies, expectedCurrencies }) {
    const accepted = {}, checks = {};
    const findSeries = tk => {
        if (!prices) return null;
        if (prices[tk]) return prices[tk];
        const k = Object.keys(prices).find(kk => _dcUp(kk) === tk);
        return k ? prices[k] : null;
    };
    Object.keys(quotes || {}).forEach(key => {
        const tk = _dcUp(key);
        const chk = assessLiveQuote({
            ticker: tk, livePx: quotes[key],
            sessionDate: (sessionDates && sessionDates[tk]) || null,
            dailyCloses, historySeries: findSeries(tk),
            quoteCurrency: quoteCurrencies ? quoteCurrencies[tk] : null,
            expectedCurrency: expectedCurrencies ? expectedCurrencies[tk] : null,
        });
        checks[tk] = chk;
        if (chk.status !== 'rejected') accepted[key] = quotes[key];
    });
    return { accepted, checks };
}

function liveQuoteChecksSignature(map) {
    return Object.keys(map || {}).sort().map(k => {
        const c = map[k] || {};
        return k + ':' + c.status + ':' + (c.reason || '') + ':' + (c.currencyMismatch ? 1 : 0) + ':' + (c.px ?? '') + ':' + (c.carried ? 1 : 0) + ':' + (c.carriedPx ?? '');
    }).join('|');
}

// ── Last-good-quote carry-forward ─────────────────────────────────────────────
// A ticker that produced no accepted quote this cycle (request failed, or the
// live gate rejected it) keeps its last accepted quote and daily rows instead of
// dropping back to stored history. The check entry is marked carried (Settings
// and the spot badge show it as delayed), so nothing is silently stale. The
// per-ticker session date (merged at commit) still governs whether a carried
// quote counts for today, so a quote from an earlier session is never treated
// as today's. Only used when the cycle produced at least one fresh quote — a
// total outage stays visible as a failed refresh.
function carryForwardLiveQuotes({ requested, fresh, previous, freshRows, previousRows, checks, lastGoodAt, now }) {
    const quotes = Object.assign({}, fresh);
    const rows   = Object.assign({}, freshRows);
    const out    = Object.assign({}, checks);
    const good   = Object.assign({}, lastGoodAt);
    Object.keys(fresh || {}).forEach(tk => { good[tk] = now; });
    Array.from(new Set(requested || [])).forEach(tk => {
        if (quotes[tk] != null) return;
        const prev = previous ? previous[tk] : null;
        const base = out[tk] || { ticker: tk, status: 'fetch-failed', reason: 'no-quote-this-cycle' };
        if (prev != null && Number.isFinite(Number(prev)) && Number(prev) > 0) {
            quotes[tk] = prev;
            if (!(Array.isArray(rows[tk]) && rows[tk].length) && previousRows && Array.isArray(previousRows[tk])) rows[tk] = previousRows[tk];
            out[tk] = Object.assign({}, base, { carried: true, carriedPx: Number(prev), lastGoodAt: good[tk] || null });
        } else {
            out[tk] = Object.assign({}, base, { carried: false });
        }
    });
    return { quotes, rows, checks: out, lastGoodAt: good };
}

// ── Market hours (polling) ────────────────────────────────────────────────────
// Local clock of an exchange from the device clock, via Intl (no string parsing).
const EXCHANGE_HOURS = {
    LSE:  { tz: 'Europe/London',    open: 8 * 60,       close: 16 * 60 + 30 },
    NYSE: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
    KRX:  { tz: 'Asia/Seoul',       open: 9 * 60,       close: 15 * 60 + 30 },   // Markets tab (Naver) only
};
const _clockFmt = {};
function exchangeClock(tz, nowMs) {
    let f = _clockFmt[tz];
    if (!f) f = _clockFmt[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    const p = {}; f.formatToParts(new Date(nowMs)).forEach(x => { p[x.type] = x.value; });
    const dow = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[p.weekday];
    return { date: p.year + '-' + p.month + '-' + p.day, dow, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function isExchangeTradingDay(calendar, clock) {
    if (clock.dow === 0 || clock.dow === 6) return false;
    const spec = EXCHANGE_CALENDARS[calendar];
    return !(spec && spec.holidays && spec.holidays.has(clock.date));
}
function isExchangeOpenAt(calendar, nowMs) {
    const h = EXCHANGE_HOURS[calendar];
    if (!h) return false;
    const c = exchangeClock(h.tz, nowMs);
    return isExchangeTradingDay(calendar, c) && c.minutes >= h.open && c.minutes <= h.close;
}
// Poll while either market the app holds is trading: London for the LSE lines,
// New York for Citi and the S&P benchmark (14:30–21:00 UK time).
function anyTrackedMarketOpen(nowMs) {
    return isExchangeOpenAt('LSE', nowMs) || isExchangeOpenAt('NYSE', nowMs);
}
// Delays (ms) to a one-off reconciliation fetch 30 minutes after each market's
// close, for closes still ahead today (within 4 hours), on trading days.
function msUntilCloseReconciles(nowMs) {
    const out = [];
    ['LSE', 'NYSE'].forEach(cal => {
        const h = EXCHANGE_HOURS[cal];
        const c = exchangeClock(h.tz, nowMs);
        if (!isExchangeTradingDay(cal, c)) return;
        const ms = (h.close + 30 - c.minutes) * 60000;
        if (ms > 0 && ms < 4 * 3600000) out.push(ms);
    });
    return out;
}

// ── Previous-session FX for USD holdings ─────────────────────────────────────
// A GBP "Today" move on a USD line must price yesterday's close at yesterday's
// GBP/USD, or the FX move is left out. Returns the GBPUSD=X close on or before
// dateStr (at most maxAgeDays older) from the graded daily rows, or null.
function fxCloseOnOrBefore(dailyCloses, fxTicker, dateStr, maxAgeDays) {
    if (!dailyCloses || !dateStr) return null;
    const tk = _dcUp(fxTicker);
    const rows = dailyCloses[tk] ?? Object.entries(dailyCloses).find(([k]) => _dcUp(k) === tk)?.[1];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const floor = new Date(dateStr + 'T12:00:00Z');
    floor.setUTCDate(floor.getUTCDate() - (Number.isFinite(maxAgeDays) ? maxAgeDays : 5));
    const floorStr = floor.toISOString().slice(0, 10);
    const cand = rows
        .filter(r => r && r.date && Number(r.close) > 0 && r.status !== 'conflict')
        .map(r => ({ date: String(r.date).slice(0, 10), close: Number(r.close) }))
        .filter(r => r.date <= dateStr && r.date >= floorStr)
        .sort((a, b) => a.date.localeCompare(b.date));
    return cand.length ? { rate: cand[cand.length - 1].close, date: cand[cand.length - 1].date } : null;
}

// Compact signature for change-detection of a merged daily-close map.
function dailyClosesSignature(map) {
    return Object.keys(map || {}).sort().map(k =>
        k + '=' + (map[k] || []).map(r => r.date + ':' + r.close + ':' + (r.status || '')).join(',')
    ).join('|');
}

// ── Troubleshooting snapshot for the JSON export ────────────────────────────
// Written to envelope.diagnostics (outside payload): never restored on import,
// never contains API keys — only whether each key is set. Records every input
// and every decision behind each 1D figure so a wrong number can be traced later.
const DAILY_CHECK_DIAGNOSTICS_VERSION = 5; // v5: + providerAudit (every source: Yahoo, Twelve Data, Alpha Vantage, Naver, Marketstack); v4: + marketstack attempt log; v3: carried quotes, pricingWarnings, gbpusd source, history refresh state
function buildDailyCheckDiagnostics(ctx) {
    ctx = ctx || {};
    const iso = ms => (Number.isFinite(Number(ms)) && Number(ms) > 0) ? new Date(Number(ms)).toISOString() : null;
    const out = { diagnosticsVersion: DAILY_CHECK_DIAGNOSTICS_VERSION, generatedAt: new Date().toISOString() };

    // Environment — date handling depends on device timezone.
    let workerHost = null;
    try { const w = getWorkerUrl(); workerHost = w ? new URL(w).host : null; } catch {}
    let deviceTz = null;
    try { deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch {}
    out.environment = {
        userAgent:         (typeof navigator !== 'undefined' && navigator.userAgent) || null,
        online:            (typeof navigator !== 'undefined') ? !!navigator.onLine : null,
        deviceTimeZone:    deviceTz,
        utcOffsetMinutes:  -new Date().getTimezoneOffset(),
        currentPnlSession: getCurrentPnlSessionDateStr(),
        workerHost:        workerHost,
        keysSet:           { twelveData: !!getTdApiKey(), alphaVantage: !!getAvApiKey(), marketstack: !!getMsApiKey(), giltsyield: !!getGyApiKey() },
    };

    // Rules in force.
    const yr = new Date().getUTCFullYear();
    const calendars = {};
    Object.keys(EXCHANGE_CALENDARS).forEach(c => {
        const spec = EXCHANGE_CALENDARS[c];
        calendars[c] = spec.holidays
            ? { years: spec.years.slice(), coversCurrentYear: spec.years.includes(yr), holidayCount: spec.holidays.size }
            : { rule: spec.everyDay ? 'every calendar day' : 'every weekday' };
    });
    out.rules = {
        defaultTolerance: DAILY_VERIFY_TOLERANCE,
        calendars,
        twelveData:   { creditsPerMinute: TD_CREDITS_PER_MIN, creditsUsedLastMinute: TD_CREDITS_PER_MIN - _tdCreditsAvailable() },
        alphaVantage: { appDailyBudget: AV_DAILY_BUDGET, providerDailyCap: 25, budgetToday: loadAvBudget() },
        marketstack:  { appMonthlyBudget: MS_MONTHLY_BUDGET, providerMonthlyCap: 100, budgetThisMonth: loadMsBudget(), role: 'US-holding (Citi) fallback only — used when Twelve Data has no answer, or on a manual Marketstack re-check. No London data on this account.' },
    };

    // Per-ticker decision log — exactly what the resolver decided, and from what.
    const map    = ctx.liveDailyCloses || {};
    const status = ctx.dailyCheckStatus || {};
    const shown  = {};
    (ctx.holdings || []).forEach(h => {
        const tk = _dcUp(h && h.ticker);
        if (!tk) return;
        shown[tk] = {
            todayPctChange: Number.isFinite(h.todayPctChange) ? h.todayPctChange : null,
            todayAbsChange: Number.isFinite(h.todayAbsChange) ? h.todayAbsChange : null,
            prevStatus:     h.todayPrevStatus || null,
            prevReason:     h.todayPrevReason || null,
            prevDate:       h.todayPrevDate || null,
        };
    });
    const tickers = Array.from(new Set([...Object.keys(map), ...Object.keys(status)].map(_dcUp)))
        .filter(isDailyCheckVerifiableTicker).sort();
    out.decisions = tickers.map(tk => {
        const prof    = dailyCheckProfileFor(tk);
        const session = (ctx.liveQuoteSessionDates && ctx.liveQuoteSessionDates[tk]) || getCurrentPnlSessionDateStr();
        const live    = ctx.livePrices ? Number(ctx.livePrices[tk]) : NaN;
        const rows    = Array.isArray(map[tk]) ? map[tk] : [];
        const vr      = resolveVerifiedDailyPrevClose({ ticker: tk, sessionDate: session, livePx: live, dailyCloses: map });
        const st      = status[tk] || {};
        return {
            ticker: tk, calendar: prof.calendar, secondSource: prof.providerName,
            sessionDate: session, livePrice: Number.isFinite(live) ? live : null,
            expectedPrevDate: vr.expectedDate || null, calendarCovered: vr.calendarCovered ?? null,
            result: vr.ok ? 'ok' : (vr.reason || 'unavailable'),
            prevDate: vr.date || vr.foundDate || null,
            prevClose: vr.ok ? vr.value : null,
            prevStatus: vr.ok ? vr.status : null,
            onePct: (vr.ok && live > 0) ? (live / vr.value - 1) * 100 : null,
            secondSourceState: {
                error: st.error || null, pending: !!st.pending, rows: st.altRows ?? null,
                unitFactor: st.unitFactor ?? null, unitMismatch: !!st.unitMismatch,
            },
            shownInHoldings: shown[tk] || null,
            recentRows: rows.slice(-8),   // date, close, status, yahoo, alt
        };
    });

    // Live-quote gate results — every fetched ticker, including rejected quotes
    // (which never reach livePrices) and currency-label warnings.
    out.liveQuoteChecks = ctx.liveQuoteChecks || {};
    out.pricingWarnings = ctx.pricingWarnings || [];
    out.gbpusd          = ctx.gbpusd || null;
    out.quoteCurrencies = _dcLoad(QUOTE_CURRENCY_KEY);
    out.historyRefresh  = _dcLoad(HISTORY_REFRESH_KEY);

    // Second-source caches (trimmed to recent rows).
    const cacheView = cache => {
        const o = {};
        Object.keys(cache || {}).forEach(tk => {
            const e = cache[tk] || {};
            o[tk] = {
                fetchedAt: iso(e.fetchedAt), fetchedDay: e.fetchedDay || null,
                error: e.error || null, retryAfter: iso(e.retryAfter),
                rowCount: Array.isArray(e.series) ? e.series.length : 0,
                recent: Array.isArray(e.series) ? e.series.slice(-8) : [],
            };
        });
        return o;
    };
    out.secondSourceCaches = { twelveData: cacheView(loadTdDailyCache()), alphaVantage: cacheView(loadAvDailyCache()), marketstack: cacheView(loadMsDailyCache()) };
    // Full audit trail of every Marketstack attempt (failures in detail) — API key scrubbed.
    const msLog = loadMsLog();
    out.marketstack = { keySet: !!getMsApiKey(), budget: loadMsBudget(), symbolFormat: loadMsFormat(), summary: summariseMsLog(msLog), attemptLog: msLog };
    { const gyc = loadGyCache(); out.giltsyield = { keySet: !!getGyApiKey(), portfolio: getGyPortfolio(), meta: gyc.meta, snapshots: gyc.snaps }; }
    // The same kind of trail for every source, recorded at the network layer (API keys scrubbed).
    out.providerAudit = paSnapshot();

    // Markets 1D — compact view (full rows are in payload.marketOverview).
    out.markets = (ctx.marketRows || []).map(r => ({
        id: r.id, symbol: r.liveSymbol, day: Number.isFinite(r.day) ? r.day : null,
        check: r.dayCheckStatus || null, reason: r.dayCheckReason || null,
        prevDate: r.previousCloseDate || null, expectedPrevDate: r.dayCheckExpected || null,
        yahooPrev: r.dayCheckYahoo ?? null, altPrev: r.dayCheckAlt ?? null,
        secondSource: r.dayCheckProvider || null, error: r.dayCheckError || null, pending: !!r.dayCheckPending,
        quoteSessionDate: r.quoteSessionDate || null, quoteStatus: r.quoteStatusLabel || null,
        primarySource: r.primarySource || null, primaryNote: r.primaryNote || null,
        fetchedLiveSymbol: r.fetchedLiveSymbol || null, fetchedHistorySymbol: r.fetchedHistorySymbol || null,
        dayWitnessNote: r.dayWitnessNote || null,
        m1: Number.isFinite(r.m1) ? r.m1 : null, ytd: Number.isFinite(r.ytd) ? r.ytd : null, y1: Number.isFinite(r.y1) ? r.y1 : null,
        periodNullReasons: r.periodNullReasons || null, historyNote: r.historyNote || null,
        historySeriesCount: r.historySeriesCount ?? null, historyFirstDate: r.historyFirstDate || null,
        historyAsOf: r.returnAsOfDate || null, historyError: r.historyError || null,
    }));

    // Headline counts.
    const count = (arr, f) => arr.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
    out.summary = {
        holdingsChecked:   out.decisions.length,
        holdingsVerified:  count(out.decisions, d => d.prevStatus === 'verified'),
        holdingsSingleSrc: count(out.decisions, d => d.prevStatus === 'yahoo-only' || d.prevStatus === 'alt-only'),
        holdingsWithheld:  count(out.decisions, d => d.result !== 'ok'),
        marketsRows:       out.markets.length,
        marketsVerified:   count(out.markets, m => m.check === 'verified'),
        marketsWithheld:   count(out.markets, m => m.day == null),
        liveQuotesRejected:        count(Object.values(out.liveQuoteChecks), c => c && c.status === 'rejected'),
        liveQuotesUnchecked:       count(Object.values(out.liveQuoteChecks), c => c && c.status === 'unchecked'),
        liveQuoteCurrencyWarnings: count(Object.values(out.liveQuoteChecks), c => c && c.currencyMismatch),
        providerProblems: Object.fromEntries(Object.entries(out.providerAudit.providers).map(([k, v]) => [k, v.summary.failed + v.summary.partial])),
    };
    return out;
}
// ══════════════════════════════════════════════════════════════════════════════
// Returns true only when both maps have identical keys and values within tolerance.
// Used by fetchLivePrices to guard setLivePrices / setLivePrevClose against
// spurious re-renders when polled data hasn't materially changed.
function shallowNumberMapEqual(a, b, tolerance) {
    if (tolerance === undefined) tolerance = 0.000001;
    const ak = Object.keys(a || {});
    const bk = Object.keys(b || {});
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        const av = Number(a[k]);
        const bv = Number(b[k]);
        if (Number.isFinite(av) && Number.isFinite(bv)) {
            if (Math.abs(av - bv) > tolerance) return false;
        } else if (a[k] !== b[k]) {
            return false;
        }
    }
    return true;
}

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}
// ── Stages 1.2 + 2.1 + 3.1 + 4.1: Restricted Compensation Timeline Builder ────
// Root script module scope — outside any React component, useMemo, or useCallback.
//
// Supported restricted_category values:
//   RSU    — Stage 1.2: unit × market price, post-tax on vesting
//   OPTION — Stage 2.1: SAYE-style accrued cash + bonus + intrinsic spread
//   SIP    — Stage 3.1: paycheck share plan (accrued cash + share market value)
//
// Stage 4.1 adds chronological handoff via completion_date:
//   DRAFT                    — always skipped, all dates
//   EXERCISED / CANCELLED    — skipped from completion_date onward; modelled
//                              before it (preserves historical trendlines)
//   VESTED_PENDING_CONFIRMATION — modelled as liquid, flagged in activeAlerts
//   ACTIVE                   — modelled normally; staleness alert if past
//                              maturity + auto_exercise_days window
//
// Note: priceAt() is scoped inside PortfolioApp so cannot be called from here.
// resolvePriceAt() is an equivalent implementation with the additional fallback
// to the first valid close required by the Stage 1.2 spec.
// todayFx — today's GBP/USD (live, else latest stored). Used for any date the
// stored GBP/USD series doesn't reach and the plan gives no manual_fx_rate. There
// is no fixed fallback rate: with no rate at all, a USD plan is left unvalued.
// Market prices convert at today's quote currency (Yahoo's, via tickerCurrencyMap)
// falling back to plan.currency; grant / purchase prices always use plan.currency,
// because they are figures from the config file, not Yahoo quotes.
function buildRestrictedTimeline(compConfigs, weeklyDates, prices, tickerCurrencyMap, todayFx) {
    const quoteCcyOf = plan => lookupCurrency(tickerCurrencyMap, plan.yahoo_ticker || plan.yahooTicker || plan.ticker)
        || normaliseQuoteCurrency(plan.currency);

    // Internal: walk the series returning the most recent close at or before
    // dateStr, then fall back to the first valid numeric close in the series
    // when dateStr precedes all data (handles pre-listing history gaps).
    function resolvePriceAt(series, dateStr) {
        if (!series || series.length === 0) return null;
        let resolved = null;
        for (const p of series) {
            if (p.date <= dateStr) {
                if (typeof p.close === 'number' && isFinite(p.close)) resolved = p.close;
            } else {
                break; // series is chronological — no need to look further
            }
        }
        if (resolved !== null) return resolved;
        // dateStr precedes all recorded closes: fall back to first valid entry
        for (const p of series) {
            if (typeof p.close === 'number' && isFinite(p.close)) return p.close;
        }
        return null;
    }

    // Internal: count fully completed monthly anniversaries between two
    // ISO date strings using discrete UTC calendar boundaries.
    // Spec: do NOT use 30.44-day averaging. Use year/month integer arithmetic,
    // then decrement by 1 if the anniversary day hasn't been reached yet.
    function elapsedCalendarMonths(startDateStr, checkDateStr, maxMonths) {
        const s = new Date(startDateStr);
        const c = new Date(checkDateStr);
        let months =
            (c.getUTCFullYear() - s.getUTCFullYear()) * 12 +
            (c.getUTCMonth()    - s.getUTCMonth());
        // Has the day-of-month anniversary been reached in the current month?
        if (c.getUTCDate() < s.getUTCDate()) months -= 1;
        // Clamp: never negative, never beyond contract length
        return Math.min(Math.max(0, months), maxMonths);
    }

    const gbpusdSeries    = prices['GBPUSD=X'];

    return weeklyDates.map(dateStr => {
        // Initialise coordinate point with the exact structural blueprint
        const point = {
            date: dateStr,
            restrictedCompensationValue:      0,
            liquidCompensationValue:          0,
            restrictedPerformanceBasisValue:  0,  // display-only cost floor; never touches P&L engine
            restrictedPerformanceBasisValid:  true, // aggregate validity: false forces MetricBlock to "—"
            activeAlerts: [],
            planDetails:  {},
        };

        for (const plan of compConfigs) {

            // ── Stage 4.1: Multi-status chronological lifecycle gate ───────────
            //
            // DRAFT: unconditional skip across all dates and all categories.
            if (plan.status === 'DRAFT') continue;

            // Determine whether completion_date is validly populated.
            const completionDate = plan.completion_date
                && (typeof plan.completion_date === 'string'
                    ? plan.completion_date.trim() : String(plan.completion_date).trim());
            const hasCompletionDate = !!(completionDate && completionDate !== '');

            // Flag set here, consumed post-dispatch to avoid crossing continue boundaries.
            let isVestedPending = false;

            if (hasCompletionDate) {
                if (dateStr >= completionDate) {
                    // ── Post-completion: clean handoff for terminal statuses ────
                    if (plan.status === 'EXERCISED' || plan.status === 'CANCELLED') {
                        // Value has moved to external holding pools or has expired.
                        // Skip this plan from completion_date onward — no value, no planDetails.
                        continue;
                    }
                    if (plan.status === 'VESTED_PENDING_CONFIRMATION') {
                        // Model the liquid value so net worth history is complete,
                        // but flag for user reconciliation via activeAlerts.
                        isVestedPending = true;
                    }
                    // ACTIVE past completion_date: model normally.
                }
                // dateStr < completion_date: model normally regardless of terminal status —
                // preserves correct historical trendlines for all past net worth points.
            } else {
                // completion_date is absent: config integrity check.
                if (plan.status === 'EXERCISED' || plan.status === 'CANCELLED') {
                    // Cannot truncate without a date — model normally and loudly warn.
                    point.activeAlerts.push(
                        `Plan ${plan.plan_id} is marked ${plan.status} but completion_date is missing. Modeling normally.`
                    );
                    // Fall through to model normally.
                }
                // ACTIVE / VESTED_PENDING_CONFIRMATION with no completion_date: model normally.
            }
            // ── All non-DRAFT statuses reaching here proceed through the category branches.
            // (ACTIVE, EXERCISED/CANCELLED pre-completion or missing-date, VESTED_PENDING_CONFIRMATION)

            // ══════════════════════════════════════════════════════════════════
            // BRANCH A — RSU (Stage 1.2)
            // ══════════════════════════════════════════════════════════════════
            if (plan.restricted_category === 'RSU') {

                // ── Mandatory descriptor field gate ───────────────────────────
                if (
                    !plan.plan_id           ||
                    plan.current_units == null ||
                    !plan.yahoo_ticker      ||
                    !plan.maturity_vesting_date
                ) continue;

                // ── Asset price resolution ─────────────────────────────────────
                // Asset price: live series → manual_spot_price fallback → skip
                const rawPrice =
                    resolvePriceAt(prices[plan.yahoo_ticker], dateStr) ??
                    (plan.manual_spot_price != null && isFinite(Number(plan.manual_spot_price))
                        ? Number(plan.manual_spot_price) : null);
                if (rawPrice == null) continue;

                // FX rate: stored series → manual_fx_rate → today's rate
                const dollarRate =
                    resolvePriceAt(gbpusdSeries, dateStr) ??
                    (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                        ? Number(plan.manual_fx_rate) : todayFx);
                const priceGBP   = pxToGBPWithCurrency(rawPrice, quoteCcyOf(plan), dollarRate);
                if (priceGBP == null || !isFinite(priceGBP)) continue;

                // ── Vesting phase evaluation ───────────────────────────────────
                let valueGBP, phase;
                const taxRate = vestingTaxRate(plan);

                if (dateStr < plan.maturity_vesting_date) {
                    phase    = 'RESTRICTED';
                    valueGBP = plan.current_units * priceGBP;
                    point.restrictedCompensationValue += valueGBP;

                    // Performance basis: grant-price cost floor (display only).
                    // Fallback chain: manual grant_price → historical series at grant date.
                    // If neither resolves, toggle aggregate validity flag so MetricBlock shows "—".
                    if (plan.current_units > 0) {
                        let resolvedGrantPrice = Number(plan.grant_price ?? 0);
                        const grantDate = plan.grant_date || plan.contribution_start_date || dateStr;

                        if (!(resolvedGrantPrice > 0)) {
                            // Uppercase-safe series lookup — matches resolvedPricesMap key casing
                            const tk = (plan.yahoo_ticker || plan.yahooTicker || '').toUpperCase().trim();
                            const historicalGrantPrice = tk ? resolvePriceAt(prices[tk] || prices[plan.yahoo_ticker], grantDate) : null;
                            resolvedGrantPrice = historicalGrantPrice ?? 0;
                        }

                        if (resolvedGrantPrice > 0) {
                            const grantFx = resolvePriceAt(gbpusdSeries, grantDate)
                                ?? (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                                    ? Number(plan.manual_fx_rate) : todayFx);
                            const grantPriceGBP = pxToGBPWithCurrency(resolvedGrantPrice, plan.currency, grantFx);
                            if (grantPriceGBP != null) {
                                point.restrictedPerformanceBasisValue += plan.current_units * grantPriceGBP;
                            } else {
                                // Currency conversion failed — basis unresolvable for this plan
                                point.restrictedPerformanceBasisValid = false;
                            }
                        } else {
                            // Both manual grant_price and historical fallback failed for an unvested grant
                            point.restrictedPerformanceBasisValid = false;
                        }
                    }
                } else {
                    phase    = 'MODELLED_LIQUID';
                    valueGBP = plan.current_units * (1 - taxRate) * priceGBP;
                    point.liquidCompensationValue += valueGBP;

                    // Stage 4.1: attention notification — ACTIVE plans past exercise window.
                    // Pushes the full contextual string (not bare plan_id) for UI clarity.
                    if (plan.status === 'ACTIVE' && plan.auto_exercise_days != null) {
                        const elapsedDays =
                            (new Date(dateStr).getTime() - new Date(plan.maturity_vesting_date).getTime())
                            / 86400000;
                        if (elapsedDays > plan.auto_exercise_days) {
                            point.activeAlerts.push(
                                `${plan.plan_id} is past vesting date. Confirm actual ${plan.institution || 'external'} statement and update config.`
                            );
                        }
                    }
                }

                // ── Plan-level detail record (keyed by plan_id) ───────────────
                point.planDetails[plan.plan_id] = {
                    planId:          plan.plan_id,
                    planName:        plan.plan_name,
                    institution:     plan.institution,
                    category:        plan.restricted_category,
                    ticker:          plan.yahoo_ticker,          // required by RestrictedSchemesWidget daily P&L
                    currency:        plan.currency,              // required by RestrictedSchemesWidget daily P&L
                    valueGBP,
                    phase,
                    units:           plan.current_units,
                    vestingDate:     plan.maturity_vesting_date,
                    status:          plan.status,
                    completionDate:  completionDate || null,
                    custodyPlatform: plan.custody_platform || null,
                    actualNetUnits:  plan.actual_net_units  != null ? plan.actual_net_units : null,
                    grantPrice:      Number(plan.grant_price ?? 0) > 0 ? Number(plan.grant_price) : null, // native-currency grant price for widget total P&L
                    grantDate:       plan.grant_date || null,    // the chart counts an RSU only from its grant
                };

            // ══════════════════════════════════════════════════════════════════
            // BRANCH B — SAYE OPTION (Stage 2.1)
            // ══════════════════════════════════════════════════════════════════
            } else if (plan.restricted_category === 'OPTION') {

                // ── Mandatory option parameter gate ───────────────────────────
                if (
                    !plan.plan_id                         ||
                    !plan.yahoo_ticker                    ||
                    !plan.contribution_start_date         ||
                    !plan.maturity_vesting_date           ||
                    plan.total_target_units    == null    ||
                    plan.option_strike_price   == null    ||
                    plan.monthly_contribution  == null    ||
                    plan.total_contract_months == null
                ) continue;

                // ── Pre-contribution guardrail ─────────────────────────────────
                if (dateStr < plan.contribution_start_date) continue;

                // ── Asset price resolution ─────────────────────────────────────
                // Asset price: live series → manual_spot_price fallback → skip
                const rawPrice =
                    resolvePriceAt(prices[plan.yahoo_ticker], dateStr) ??
                    (plan.manual_spot_price != null && isFinite(Number(plan.manual_spot_price))
                        ? Number(plan.manual_spot_price) : null);
                if (rawPrice == null) continue;

                // FX rate: stored series → manual_fx_rate → today's rate
                const dollarRate =
                    resolvePriceAt(gbpusdSeries, dateStr) ??
                    (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                        ? Number(plan.manual_fx_rate) : todayFx);
                const priceGBP   = pxToGBPWithCurrency(rawPrice, quoteCcyOf(plan), dollarRate);
                if (priceGBP == null || !isFinite(priceGBP)) continue;

                // ── Discrete calendar-month anniversary elapsed months ─────────
                const elapsedMonths = elapsedCalendarMonths(
                    plan.contribution_start_date,
                    dateStr,
                    plan.total_contract_months,
                );

                const accruedCash  = elapsedMonths * plan.monthly_contribution;
                const accruedBonus = (plan.guaranteed_bonus != null)
                    ? plan.guaranteed_bonus * (elapsedMonths / plan.total_contract_months)
                    : 0;
                // Pro-rate intrinsic spread by savings progress: at elapsedMonths=0
                // optionValue=£0; at maturity it equals the full contract value.
                // This ensures only the value already paid for via contributions is
                // reflected — avoids overstating unvested wealth.
                const proratedUnits = plan.total_contract_months > 0
                    ? (elapsedMonths / plan.total_contract_months) * plan.total_target_units
                    : 0;
                const spread       = Math.max(0, priceGBP - plan.option_strike_price);
                const optionValue  = proratedUnits * spread;
                const valueGBP     = accruedCash + accruedBonus + optionValue;

                // ── Vesting phase evaluation ───────────────────────────────────
                // SAYE options are tax-free on exercise (HMRC approved scheme).
                let phase;
                if (dateStr < plan.maturity_vesting_date) {
                    phase = 'RESTRICTED';
                    point.restrictedCompensationValue += valueGBP;
                    // Performance basis: gross purchase cost floor (units × strike price).
                    // Strike price IS the purchase price for SAYE — what you commit to pay.
                    // Falls back to accruedCash for older records lacking grant_price.
                    const optUnits         = Number(plan.total_target_units ?? plan.totalTargetUnits ?? plan.current_units ?? 0);
                    const optPurchasePrice = Number(plan.grant_price ?? plan.option_strike_price ?? plan.optionStrikePrice ?? 0);

                    if (optPurchasePrice > 0 && optUnits > 0) {
                        const purchaseDate = plan.grant_date || plan.contribution_start_date || dateStr;
                        const purchaseFx   = resolvePriceAt(gbpusdSeries, purchaseDate)
                            ?? (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                                ? Number(plan.manual_fx_rate) : todayFx);
                        const purchasePriceGBP = pxToGBPWithCurrency(optPurchasePrice, plan.currency, purchaseFx);
                        if (purchasePriceGBP != null) {
                            point.restrictedPerformanceBasisValue += optUnits * purchasePriceGBP;
                        } else {
                            point.restrictedPerformanceBasisValid = false;
                        }
                    } else {
                        // Fallback for older records lacking tranche price metadata
                        const optAccrued = Number(accruedCash ?? 0);
                        if (isFinite(optAccrued) && optAccrued >= 0) {
                            point.restrictedPerformanceBasisValue += optAccrued;
                        } else {
                            point.restrictedPerformanceBasisValid = false;
                        }
                    }
                } else {
                    phase = 'MODELLED_LIQUID';
                    point.liquidCompensationValue += valueGBP;

                    // Stage 4.1: attention notification — ACTIVE plans past exercise window.
                    if (plan.status === 'ACTIVE' && plan.auto_exercise_days != null) {
                        const elapsedDays =
                            (new Date(dateStr).getTime() - new Date(plan.maturity_vesting_date).getTime())
                            / 86400000;
                        if (elapsedDays > plan.auto_exercise_days) {
                            point.activeAlerts.push(
                                `${plan.plan_id} is past vesting date. Confirm actual ${plan.institution || 'external'} statement and update config.`
                            );
                        }
                    }
                }

                // ── Plan-level detail record with full SAYE + Stage 4.1 metadata ─
                point.planDetails[plan.plan_id] = {
                    planId:             plan.plan_id,
                    planName:           plan.plan_name,
                    institution:        plan.institution,
                    category:           plan.restricted_category,
                    ticker:             plan.yahoo_ticker,        // required by RestrictedSchemesWidget daily P&L
                    currency:           plan.currency,            // required by RestrictedSchemesWidget daily P&L
                    valueGBP,
                    phase,
                    units:              plan.total_target_units,
                    vestingDate:        plan.maturity_vesting_date,
                    elapsedMonths,
                    totalContractMonths: plan.total_contract_months,
                    accruedCash,
                    accruedBonus,
                    spread,
                    optionValue,
                    strikePrice:        plan.option_strike_price,
                    priceGBP,
                    status:             plan.status,
                    completionDate:     completionDate || null,
                    custodyPlatform:    plan.custody_platform || null,
                    actualNetUnits:     plan.actual_net_units != null ? plan.actual_net_units : null,
                };

            // ══════════════════════════════════════════════════════════════════
            // BRANCH C — SIP / Share Incentive Plan (Stage 3.1 + tranche update)
            // Two modes:
            //   Tranche mode — grant_price + current_units (no monthly_contribution needed)
            //   Rolling mode — contribution_start_date + current_units + monthly_contribution
            // Multiple rows with the same plan_id are stored under unique detailKeys
            // so tranches never overwrite each other in planDetails.
            // ══════════════════════════════════════════════════════════════════
            } else if (plan.restricted_category === 'SIP') {

                // ── Mandatory parameter gate ───────────────────────────────────
                const sipHasGrantPrice = plan.grant_price != null
                    && isFinite(Number(plan.grant_price))
                    && Number(plan.grant_price) > 0;
                const sipHasRolling = !!(plan.contribution_start_date
                    && plan.monthly_contribution != null);

                if (
                    !plan.plan_id          ||
                    !plan.yahoo_ticker     ||
                    plan.current_units == null ||
                    (!sipHasGrantPrice && !sipHasRolling)
                ) continue;

                // ── Pre-contribution guardrail ─────────────────────────────────
                // Uses contribution_start_date for rolling mode, grant_date for
                // tranche mode. If neither is present the row is always active.
                const sipStartDate = plan.contribution_start_date || plan.grant_date || null;
                if (sipStartDate && dateStr < sipStartDate) continue;

                // ── Asset price resolution ─────────────────────────────────────
                const rawPrice =
                    resolvePriceAt(prices[plan.yahoo_ticker], dateStr) ??
                    (plan.manual_spot_price != null && isFinite(Number(plan.manual_spot_price))
                        ? Number(plan.manual_spot_price) : null);
                if (rawPrice == null) continue;

                const dollarRate =
                    resolvePriceAt(gbpusdSeries, dateStr) ??
                    (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                        ? Number(plan.manual_fx_rate) : todayFx);
                const priceGBP = pxToGBPWithCurrency(rawPrice, quoteCcyOf(plan), dollarRate);
                if (priceGBP == null || !isFinite(priceGBP)) continue;

                // ── Value calculation: tranche mode vs rolling mode ────────────
                // Tranche mode: no monthly accrual — value is purely share value.
                // Rolling mode: accrued paycheck cash + current share value.
                let accruedCash   = 0;
                let elapsedMonths = 0;
                if (sipHasRolling) {
                    elapsedMonths = elapsedCalendarMonths(
                        plan.contribution_start_date, dateStr, 999,
                    );
                    accruedCash = elapsedMonths * plan.monthly_contribution;
                }
                const shareValue = plan.current_units * priceGBP;
                const valueGBP   = accruedCash + shareValue;

                // ── Phase assignment matrix ────────────────────────────────────
                let phase;
                if (plan.maturity_vesting_date && dateStr >= plan.maturity_vesting_date) {
                    phase = 'MODELLED_LIQUID';
                    point.liquidCompensationValue += valueGBP;
                } else {
                    phase = 'RESTRICTED';
                    point.restrictedCompensationValue += valueGBP;
                    // Performance basis: gross purchase cost floor (units × grant price).
                    // Falls back to accrued paycheck cash for rolling records lacking grant_price.
                    const sipUnits         = Number(plan.current_units ?? 0);
                    const sipPurchasePrice = Number(plan.grant_price ?? plan.option_strike_price ?? 0);

                    if (sipPurchasePrice > 0 && sipUnits > 0) {
                        const purchaseDate = plan.grant_date || plan.contribution_start_date || dateStr;
                        const purchaseFx   = resolvePriceAt(gbpusdSeries, purchaseDate)
                            ?? (plan.manual_fx_rate != null && isFinite(Number(plan.manual_fx_rate))
                                ? Number(plan.manual_fx_rate) : todayFx);
                        const purchasePriceGBP = pxToGBPWithCurrency(sipPurchasePrice, plan.currency, purchaseFx);
                        if (purchasePriceGBP != null) {
                            point.restrictedPerformanceBasisValue += sipUnits * purchasePriceGBP;
                        } else {
                            point.restrictedPerformanceBasisValid = false;
                        }
                    } else {
                        const sipAccrued = Number(accruedCash ?? 0);
                        if (isFinite(sipAccrued) && sipAccrued >= 0) {
                            point.restrictedPerformanceBasisValue += sipAccrued;
                        } else {
                            point.restrictedPerformanceBasisValid = false;
                        }
                    }
                }

                // ── Plan-level detail record ───────────────────────────────────
                // detailKey is unique per tranche so multiple SIP rows with the
                // same plan_id never overwrite each other in planDetails.
                const detailKey = plan.tranche_id
                    || plan.row_id
                    || `${plan.plan_id}_${plan.grant_date || dateStr}`;
                point.planDetails[detailKey] = {
                    planId:          plan.plan_id,       // parent grouping id
                    trancheId:       plan.tranche_id || plan.row_id || null,
                    planName:        plan.plan_name,
                    institution:     plan.institution,
                    category:        plan.restricted_category,
                    ticker:          plan.yahoo_ticker,          // required by RestrictedSchemesWidget daily P&L
                    currency:        plan.currency,              // required by RestrictedSchemesWidget daily P&L
                    valueGBP,
                    phase,
                    units:           plan.current_units,
                    vestingDate:     plan.maturity_vesting_date || 'Rolling',
                    elapsedMonths,
                    accruedCash,
                    shareValue,
                    priceGBP,
                    grantDate:       plan.grant_date || null,
                    grantPrice:      sipHasGrantPrice ? Number(plan.grant_price) : null,
                    status:          plan.status,
                    completionDate:  completionDate || null,
                    custodyPlatform: plan.custody_platform || null,
                    actualNetUnits:  plan.actual_net_units != null ? plan.actual_net_units : null,
                };

            }
            // Unknown restricted_category values are silently ignored to allow
            // forward-compatible CSV schemas without crashing the engine.

            // ── Stage 4.1: post-dispatch VESTED_PENDING_CONFIRMATION alert ────
            // Runs only when a branch completed successfully (no continue fired).
            // Pushes plan_id so ActionAlertBanner surfaces it for user action.
            if (isVestedPending) {
                point.activeAlerts.push(plan.plan_id);
            }
        }

        return point;
    });
}
