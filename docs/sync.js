// Sync and network: the Worker URL, encrypted cloud backups, the provider audit log, proxied fetching, Yahoo history and the price-feed health strip.
// Loaded by index.html before app.js, in the order core, providers, sync, widgets, components; shares their globals (no module system, no build step).

// ─── Price fetching ───────────────────────────────────────────────────────────
// All sources are free with no API key. The chain tries the most direct/reliable
// option first and falls back through diverse proxy operators so a single service
// going down or blocking a target doesn't kill everything.
//
// Chain per ticker:
//   1. Stooq direct        — fastest; works when the browser's residential IP isn't blocked
//   2. Stooq via allorigins — different operator/allowlist from corsproxy
//   3. Stooq via codetabs  — another distinct operator
//   4. Stooq via corsproxy — kept as a further fallback
//   5. Yahoo via allorigins — different data source entirely; good for US tickers + indices
//   6. Yahoo via corsproxy  — final fallback
//
// Stooq symbol map:
//   LSE tickers (.L) → strip suffix, lowercase, + .uk  (e.g. VWRL.L → vwrl.uk)
//   ^GSPC → ^spx   ^NDX → ^ndx   GBPUSD=X → gbpusd   EURGBP=X → eurgbp
// parseYahooJson removed — using v7 CSV instead
// ─── CORS proxy ──────────────────────────────────────────────────────────────
// We use a personal Cloudflare Worker as the proxy. It runs on Cloudflare's
// free tier, answers only this app's site (ALLOWED_ORIGINS), and forwards to stooq.com
// or Yahoo Finance. The worker URL is stored in localStorage and entered once
// in the Settings panel.
//
// Worker URL format: https://your-worker.your-subdomain.workers.dev
// The worker accepts:  GET /proxy?url=<encoded-target-url>
//
const WORKER_URL = 'https://morning-tree-9d1b.fergushastiewilson.workers.dev';
function getWorkerUrl() {
    // Check localStorage override first (allows changing without redeploying)
    try { return localStorage.getItem('cf_worker_url') || WORKER_URL; } catch { return WORKER_URL; }
}
function setWorkerUrl(u) {
    try { localStorage.setItem('cf_worker_url', u.trim()); } catch {}
}
function makeProxyUrl(targetUrl) {
    const w = getWorkerUrl();
    if (!w) return null;
    return `${w.replace(/\/$/, '')}/proxy?url=${encodeURIComponent(targetUrl)}`;
}
// ── Cloud backup ─────────────────────────────────────────────────────────────
// The full JSON backup (Settings → Backup & Recovery → Export), encrypted on this phone and kept by the Worker
// (PUT /backup), so losing or wiping the phone doesn't lose the history. The Worker and anyone reading the public repo
// only ever see the encrypted copy: AES-GCM with a key made from the passphrase (PBKDF2), which never leaves the phone.
// The backup token is the Worker's BACKUP_TOKEN secret and stops anyone else overwriting the backup.
// Neither is ever written into a backup or export.
const CLOUD_BACKUP_TOKEN_KEY = 'cloud_backup_token';
const CLOUD_BACKUP_PASS_KEY  = 'cloud_backup_passphrase';
const CLOUD_BACKUP_STATE_KEY = 'cloud_backup_state';    // { at, hash, bytes, counts, error, errorAt, held }
const CLOUD_BACKUP_ITERATIONS = 600000;
const CLOUD_BACKUP_MAX_AGE = 24 * 3600 * 1000;           // unchanged data is still backed up once a day
// Changed data goes at most this often on its own. Each upload is two KV writes on the Worker, and Cloudflare's free tier
// allows 1,000 a day; live prices move linked Estate accounts every 15 seconds while a market is open.
const CLOUD_BACKUP_MIN_GAP = 10 * 60 * 1000;
function getCloudBackupToken()  { try { return (localStorage.getItem(CLOUD_BACKUP_TOKEN_KEY) || '').trim(); } catch { return ''; } }
function setCloudBackupToken(v) { try { localStorage.setItem(CLOUD_BACKUP_TOKEN_KEY, String(v || '').trim()); } catch {} }
function getCloudBackupPass()   { try { return localStorage.getItem(CLOUD_BACKUP_PASS_KEY) || ''; } catch { return ''; } }
function setCloudBackupPass(v)  { try { localStorage.setItem(CLOUD_BACKUP_PASS_KEY, String(v || '')); } catch {} }
function loadCloudBackupState() { try { return JSON.parse(localStorage.getItem(CLOUD_BACKUP_STATE_KEY) || '{}') || {}; } catch { return {}; } }
function saveCloudBackupState(s) {
    try { localStorage.setItem(CLOUD_BACKUP_STATE_KEY, JSON.stringify(s)); } catch {}
    try { window.dispatchEvent(new Event('cloud-backup')); } catch {}
}
function cloudBackupReady() { return !!(getCloudBackupToken() && getCloudBackupPass() && getWorkerUrl()); }

// Monzo balances were removed (Fergus couldn't get the Monzo login to work): clear what they left on the phone.
try { localStorage.removeItem('monzo_cache'); } catch {}

function _cbToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
function _cbFromB64(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
async function _cbPipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
async function _cbKey(passphrase, salt, iterations) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function cbSha256Hex(str) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}
// JSON text → { format: 'portfolio-cloud-backup', ... } with the text gzipped (where the browser can) and encrypted.
async function encryptBackup(jsonString, passphrase) {
    if (!passphrase) throw new Error('no passphrase');
    let bytes = new TextEncoder().encode(jsonString), gzip = false;
    if (typeof CompressionStream !== 'undefined') { bytes = await _cbPipe(bytes, new CompressionStream('gzip')); gzip = true; }
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await _cbKey(passphrase, salt, CLOUD_BACKUP_ITERATIONS);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    return { format: 'portfolio-cloud-backup', v: 1, at: new Date().toISOString(), gzip,
             kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: CLOUD_BACKUP_ITERATIONS, salt: _cbToB64(salt) },
             cipher: { name: 'AES-GCM', iv: _cbToB64(iv) }, data: _cbToB64(data) };
}
// The reverse. A wrong passphrase (or a tampered copy) fails AES-GCM's check and says so.
async function decryptBackup(obj, passphrase) {
    if (!obj || obj.format !== 'portfolio-cloud-backup' || obj.v !== 1) throw new Error('not a cloud backup');
    const key = await _cbKey(passphrase, _cbFromB64(obj.kdf.salt), obj.kdf.iterations);
    let bytes;
    try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _cbFromB64(obj.cipher.iv) }, key, _cbFromB64(obj.data))); }
    catch (e) { throw new Error('wrong passphrase, or the backup is damaged'); }
    if (obj.gzip) {
        if (typeof DecompressionStream === 'undefined') throw new Error('this browser can’t unzip the backup');
        bytes = await _cbPipe(bytes, new DecompressionStream('gzip'));
    }
    return new TextDecoder().decode(bytes);
}
async function cloudBackupFetch(method, path, body) {
    const base = (getWorkerUrl() || '').replace(/\/$/, '');
    const res = await fetch(base + path, { method, body, cache: 'no-store',
        headers: Object.assign({ Authorization: 'Bearer ' + getCloudBackupToken() }, body ? { 'Content-Type': 'application/json' } : {}) });
    if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch {}
        const err = new Error(msg); err.status = res.status;
        throw err;
    }
    return res;
}
// How much a JSON backup holds, to spot one that has lost data (see runCloudBackup).
function cloudBackupCounts(payload) {
    const p = payload || {}, b = p.balances || {}, la = p.lifeAdmin || {}, pay = p.pay || {};
    const n = v => Array.isArray(v) ? v.length : 0;
    const usage = (Array.isArray(la.bills) ? la.bills : []).reduce((s, x) => s + n(x && x.usage && x.usage.months), 0);
    return { trades: n(p.transactions), plans: n(p.compConfigs), accounts: n(b.accounts), entries: n(b.snapshots), bills: n(la.bills), usage, payYears: n(pay.years) };
}
const CLOUD_BACKUP_COUNT_LABELS = { trades: 'trades', plans: 'equity plans', accounts: 'Estate accounts', entries: 'Estate entries', bills: 'Cash Flow bills', usage: 'energy usage months', payYears: 'years of pay' };
// What `now` has fewer of than `before`, e.g. "3 trades (the last backup had 120)". null = nothing lost.
function cloudBackupShrink(before, now) {
    if (!before) return null;
    const lost = Object.keys(CLOUD_BACKUP_COUNT_LABELS).filter(k => (now[k] || 0) < (before[k] || 0));
    return lost.length ? lost.map(k => `${now[k] || 0} ${CLOUD_BACKUP_COUNT_LABELS[k]} (the last backup had ${before[k]})`).join(', ') : null;
}
// Backs up `jsonString` (the full JSON backup) when its data differs from the last one sent, or that was over a day
// ago, or `force`. Only the data is compared: live prices and the export time change all the time, and so do the Estate
// data's lastExportAt and updatedAt, which every backup itself sets. Without `force`, a change sent less than
// CLOUD_BACKUP_MIN_GAP after the last upload waits: `retryIn` says how long.
// Without `force` it also holds back a backup that has fewer trades, plans or Estate entries than the last one, so data
// lost or damaged on this phone doesn't replace the good copy; Back Up Now (force) sends it anyway. On a phone that has
// never backed up, the last one is read from the cloud first, which also catches a passphrase that doesn't open it.
async function runCloudBackup(jsonString, force) {
    if (!cloudBackupReady()) return { skipped: 'not set up' };
    const st = loadCloudBackupState();
    try {
        const p = (JSON.parse(jsonString) || {}).payload || {};
        const bal = p.balances ? Object.assign({}, p.balances, { lastExportAt: null, updatedAt: null }) : p.balances;
        const la = p.lifeAdmin ? Object.assign({}, p.lifeAdmin, { updatedAt: null }) : null;
        const pay = p.pay ? Object.assign({}, p.pay, { updatedAt: null }) : null;
        // Bills and pay (Cash Flow) go last and only when they hold something, so backups made before they existed hash the same as before.
        const hash = await cbSha256Hex(JSON.stringify([p.transactions, p.compConfigs, p.externalHoldings, bal, p.loadSource].concat(la ? [la] : [], pay ? [{ pay }] : [])));
        const counts = cloudBackupCounts(p);
        const since = st.at ? Date.now() - st.at : Infinity;
        if (!force && st.hash === hash && since < CLOUD_BACKUP_MAX_AGE) {
            if (st.held) saveCloudBackupState(Object.assign({}, st, { held: null }));
            return { skipped: 'unchanged' };
        }
        if (!force && since < CLOUD_BACKUP_MIN_GAP) return { skipped: 'too soon', retryIn: CLOUD_BACKUP_MIN_GAP - since };
        if (!force) {
            let before = st.counts || null;
            if (!before && !st.at) {
                try { before = cloudBackupCounts((JSON.parse(await fetchCloudBackup()) || {}).payload); }
                catch (e) {
                    if (e && e.status === 404) before = null;   // nothing in the cloud yet
                    else if (/passphrase/.test(String(e && e.message))) {
                        const held = { at: Date.now(), reason: 'The passphrase doesn\u2019t open the backup already in the cloud.' };
                        saveCloudBackupState(Object.assign({}, st, { held }));
                        return { skipped: 'held', held };
                    } else throw e;
                }
            }
            const shrink = cloudBackupShrink(before, counts);
            if (shrink) {
                const held = { at: Date.now(), reason: 'This phone has ' + shrink + '.' };
                saveCloudBackupState(Object.assign({}, st, { held }));
                return { skipped: 'held', held };
            }
        }
        const body = JSON.stringify(await encryptBackup(jsonString, getCloudBackupPass()));
        await cloudBackupFetch('PUT', '/backup', body);
        const next = { at: Date.now(), hash, bytes: body.length, counts, error: null, errorAt: null, held: null };
        saveCloudBackupState(next);
        return next;
    } catch (e) {
        saveCloudBackupState(Object.assign({}, st, { error: String(e && e.message || e), errorAt: Date.now() }));
        throw e;
    }
}
// The days the Worker keeps a copy for (newest first, UTC dates of the last upload that day). One KV list.
async function listCloudBackups() {
    const res = await cloudBackupFetch('GET', '/backup/list');
    const j = await res.json();
    return Array.isArray(j && j.days) ? j.days.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
}
// The latest cloud backup (or one day's), decrypted back to the JSON backup text.
async function fetchCloudBackup(day) {
    const res = await cloudBackupFetch('GET', '/backup' + (day ? '?day=' + encodeURIComponent(day) : ''));
    return decryptBackup(await res.json(), getCloudBackupPass());
}
// ── Provider audit trail (every market-data source) ──────────────────────────
// Marketstack's attempt log (above) was the model: every request to every source
// leaves a persistent, key-scrubbed trace that is exported with the backup
// (diagnostics.providerAudit), so a failure can be audited after the fact rather
// than reconstructed from memory. It sits in the transport layer, so Yahoo, Twelve
// Data, Alpha Vantage, Naver and Marketstack are all covered, including calls made
// from screens that have no diagnostics of their own.
//   • one entry per HTTP exchange: provider, purpose, symbols, scrubbed target URL,
//     status, timing, size, safe response headers, a category and an outcome
//     (ok / partial / failed / aborted), plus the body excerpt on any problem
//   • callers add what only they can see (rows returned, which symbols were missing)
//     with paAnnotate(); a Yahoo retry on the other host is logged as its own entry
//   • skips and notable non-requests (no key, budget spent, cool-off) are logged too
//   • per provider: running counters, the newest successes, the newest problems
//     (kept apart so a flood of successes can never push a failure out), skips/events
// API keys are scrubbed from everything stored; the export file may well be shared.
const PAUDIT_KEY     = 'provider_audit_log_v1';
const PAUDIT_OK_MAX  = 12;    // newest successes kept per provider
const PAUDIT_BAD_MAX = 30;    // newest partial/failed attempts kept per provider
const PAUDIT_EVT_MAX = 20;    // newest skip/note events kept per provider
const PAUDIT_RECENT  = 40;    // outcome sequence used for the consecutive-failure streak
const PAUDIT_BODY_MAX = 600;  // characters of response body kept for a problem
let _paState = null, _paSaveTimer = null, _paSeq = 0;

function paScrub(v) {
    let s = String(v == null ? '' : v);
    try {
        for (const k of [getTdApiKey(), getAvApiKey(), getMsApiKey(), getGyApiKey()]) {
            if (!k || k.length < 6) continue;
            s = s.split(k).join('\u2039key\u203a');
            const enc = encodeURIComponent(k);
            if (enc !== k) s = s.split(enc).join('\u2039key\u203a');
        }
    } catch { /* storage unavailable: the pattern pass below still runs */ }
    return s.replace(/((?:apikey|api_key|access_key|token)(?:=|%3D))[^&"'\s%]+/gi, '$1\u2039redacted\u203a');
}
function paScrubDeep(o) {
    try { return JSON.parse(paScrub(JSON.stringify(o))); } catch { return null; }
}
function paProviderOf(url) {
    let h = '';
    try { h = new URL(url).hostname.toLowerCase(); } catch { return 'other'; }
    if (h.endsWith('finance.yahoo.com')) return 'yahoo';
    if (h.endsWith('twelvedata.com'))    return 'twelvedata';
    if (h.endsWith('alphavantage.co'))   return 'alphavantage';
    if (h.endsWith('naver.com'))         return 'naver';
    if (h.endsWith('marketstack.com'))   return 'marketstack';
    if (h.endsWith('giltsyield.com'))    return 'giltsyield';
    return 'other';
}
// Calls through the Worker arrive as <worker>/proxy?url=<target>; the entry is about the target.
function paTarget(fetchedUrl) {
    try {
        const u = new URL(fetchedUrl);
        const t = u.searchParams.get('url');
        if (/\/proxy$/.test(u.pathname) && t) return { url: t, via: 'worker' };
        return { url: String(fetchedUrl), via: 'direct' };
    } catch { return { url: String(fetchedUrl), via: 'unknown' }; }
}
function paSymbols(provider, url) {
    try {
        const u = new URL(url), q = u.searchParams;
        let raw = null;
        if (provider === 'yahoo') { const m = u.pathname.match(/\/chart\/([^/?]+)/); raw = m ? decodeURIComponent(m[1]) : null; }
        else if (provider === 'twelvedata' || provider === 'alphavantage') raw = q.get('symbol');
        else if (provider === 'marketstack') raw = q.get('symbols');
        else if (provider === 'naver') { const m = u.pathname.match(/\/index\/([^/?]+)/); raw = m ? decodeURIComponent(m[1]) : q.get('symbol'); }
        return raw ? String(raw).split(',').filter(Boolean) : null;
    } catch { return null; }
}
function paPurposeOf(provider, url) {
    try {
        const u = new URL(url), q = u.searchParams;
        if (provider === 'yahoo')
            return 'chart ' + (q.get('range') ? 'range=' + q.get('range') : (q.get('period1') ? 'dated' : 'default')) + ' interval=' + (q.get('interval') || '?');
        if (provider === 'twelvedata') return u.pathname.replace(/^\//, '') + (q.get('outputsize') ? ' outputsize=' + q.get('outputsize') : '') + (q.get('interval') ? ' ' + q.get('interval') : '');
        if (provider === 'alphavantage') return q.get('function') || 'query';
        if (provider === 'naver') return u.pathname.replace(/^\//, '') + (q.get('page') ? ' page=' + q.get('page') : '');
        return u.pathname.replace(/^\//, '');
    } catch { return null; }
}
function paEnv() {
    return { online: typeof navigator !== 'undefined' ? navigator.onLine : null,
             visibility: typeof document !== 'undefined' ? document.visibilityState : null };
}
// One coarse label per outcome, so failures can be counted and grouped at a glance.
// Looks past the HTTP status: Twelve Data and Alpha Vantage report many errors with a
// 200, and Yahoo reports an unknown symbol as chart.error.
function paClassify(provider, status, ok, text) {
    const body = String(text == null ? '' : text);
    const fail = (category, message, outcome) => ({ category, outcome: outcome || 'failed', message });
    if (status === 403 && /host not allowed/i.test(body))
        return fail('worker-allowlist', 'the Cloudflare Worker does not allow this host \u2014 it redeploys when main changes, so check the latest merge went live');
    let json = null;
    if (body.length <= 30000 && /^\s*[\[{]/.test(body)) { try { json = JSON.parse(body); } catch { json = null; } }
    const clip = x => String(x == null ? '' : x).replace(/\*\*/g, '').slice(0, 200);

    if (provider === 'twelvedata' && json && typeof json === 'object') {
        if (json.status === 'error') {
            const code = Number(json.code) || status;
            const msg = clip(json.message || 'request rejected') + (json.code ? ' [' + json.code + ']' : '');
            if (code === 429) return fail(/day|daily/i.test(String(json.message || '')) ? 'quota-exhausted' : 'rate-limited', msg);
            if (code === 401 || code === 403) return fail('auth', msg);
            if (code === 404) return fail('not-found', msg);
            if (code === 400) return fail('bad-request', msg);
            return fail('api-error', msg);
        }
        if (!Array.isArray(json.values) && !Array.isArray(json.data)) {   // batched: {SYM: {...}, SYM2: {...}}
            const entries = Object.values(json).filter(v => v && typeof v === 'object');
            const bad = entries.filter(v => v.status === 'error');
            if (entries.length && bad.length)
                return fail(bad.length === entries.length ? 'api-error' : 'partial',
                            bad.length + ' of ' + entries.length + ' symbols rejected: ' + clip(bad[0].message),
                            bad.length === entries.length ? 'failed' : 'partial');
        }
    }
    if (provider === 'alphavantage' && json && typeof json === 'object') {
        const info = json['Note'] || json['Information'];
        if (info) return fail(/per day|daily|25 requests/i.test(String(info)) ? 'quota-exhausted' : 'rate-limited', clip(info));
        if (json['Error Message']) return fail('symbol-error', clip(json['Error Message']));
        if (!json['Time Series (Daily)']) return fail('empty-response', 'no daily series in the response');
    }
    if (provider === 'yahoo' && json && json.chart) {
        if (json.chart.error) {
            const code = json.chart.error.code || null;
            return fail(/not found/i.test(String(code)) ? 'not-found' : 'api-error',
                        clip((code ? code + ': ' : '') + (json.chart.error.description || 'chart error')));
        }
        if (!json.chart.result || !json.chart.result.length) return fail('empty-response', 'chart.result is empty');
    }
    if (provider === 'marketstack' && json && json.error) {
        let cat = 'api-error';
        try { cat = _msCategory({ status, errCode: json.error.code, errMessage: json.error.message }); } catch {}
        return fail(cat, clip((json.error.message || json.error.code || 'error') + (json.error.code ? ' [' + json.error.code + ']' : '')));
    }

    if (status === 429)  return fail('rate-limited', 'HTTP 429');
    if (status === 401 || status === 403) return fail('auth-or-blocked', 'HTTP ' + status);
    if (status === 404)  return fail('not-found', 'HTTP 404');
    if (status >= 500)   return fail('server-error', 'HTTP ' + status);
    if (!ok)             return fail('http-error', 'HTTP ' + status);
    // A 200 whose small body isn't JSON is a block page or an error page, not data.
    // (Naver's fchart endpoint legitimately answers in XML.)
    if (provider !== 'naver' && provider !== 'other' && !json && body.length <= 30000)
        return fail(body.trim() ? 'non-json' : 'empty-response', body.trim() ? 'HTTP ' + status + ' but the body is not JSON' : 'HTTP ' + status + ' with an empty body');
    return { category: 'ok', outcome: 'ok', message: null };
}

function paState() {
    if (_paState) return _paState;
    let st = null;
    try { st = JSON.parse(localStorage.getItem(PAUDIT_KEY) || 'null'); } catch { st = null; }
    if (!st || typeof st !== 'object' || st.v !== 1 || !st.providers || typeof st.providers !== 'object')
        st = { v: 1, since: new Date().toISOString(), providers: {} };
    _paState = st;
    return st;
}
function paProv(name) {
    const st = paState();
    if (!st.providers[name]) st.providers[name] = {
        counters: { total: 0, ok: 0, partial: 0, failed: 0, aborted: 0, byCategory: {} },
        recent: [], okRing: [], badRing: [], events: [],
    };
    return st.providers[name];
}
function paFlush() {
    _paSaveTimer = null;
    if (!_paState) return;
    try { localStorage.setItem(PAUDIT_KEY, JSON.stringify(_paState)); }
    catch {
        // Quota: shrink the rings and try once more; the audit must never break a fetch.
        try {
            Object.values(_paState.providers).forEach(P => { P.badRing = P.badRing.slice(-10); P.okRing = P.okRing.slice(-4); P.events = P.events.slice(-8); });
            localStorage.setItem(PAUDIT_KEY, JSON.stringify(_paState));
        } catch { /* give up quietly */ }
    }
}
// Debounced: a Markets refresh makes dozens of Yahoo calls; one write per burst is plenty.
function paQueueSave() { if (!_paSaveTimer) _paSaveTimer = setTimeout(paFlush, 1200); }
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', paFlush);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') paFlush(); });
}
function _paBump(c, e, d) {
    c.total += d;
    c[e.outcome] = Math.max(0, (c[e.outcome] || 0) + d);
    const n = Math.max(0, (c.byCategory[e.category] || 0) + d);
    if (n) c.byCategory[e.category] = n; else delete c.byCategory[e.category];
}
function _paTrim(ring, max) { while (ring.length > max) ring.shift(); }
function paCommit(entry) {
    const P = paProv(entry.provider);
    _paBump(P.counters, entry, +1);
    P.recent.push({ id: entry.id, o: entry.outcome });
    _paTrim(P.recent, PAUDIT_RECENT);
    if (entry.outcome === 'ok')           { P.okRing.push(entry);  _paTrim(P.okRing, PAUDIT_OK_MAX); }
    else if (entry.outcome !== 'aborted') { P.badRing.push(entry); _paTrim(P.badRing, PAUDIT_BAD_MAX); }
    paQueueSave();
}
// Adds what only the caller knows (rows returned, which symbols were missing) to the
// entry for a response. If that changes the verdict, the counters and rings follow.
// Accepts the response object returned by proxyFetch / _fetchBuffered, or an entry.
function paAnnotate(target, patch) {
    try {
        const e = target && (target.audit || target);
        if (!e || !e.id || !e.provider || !patch) return;
        const clean = paScrubDeep(patch);
        if (!clean) return;
        const oldOutcome = e.outcome, oldCategory = e.category;
        Object.keys(clean).forEach(k => { if (clean[k] !== undefined) e[k] = clean[k]; });
        if (e.outcome !== oldOutcome || e.category !== oldCategory) {
            const P = paProv(e.provider);
            _paBump(P.counters, { outcome: oldOutcome, category: oldCategory }, -1);
            _paBump(P.counters, e, +1);
            const slot = P.recent.find(r => r.id === e.id);
            if (slot) slot.o = e.outcome;
            const from = oldOutcome === 'ok' ? P.okRing : P.badRing;
            const to   = e.outcome === 'ok' ? P.okRing : (e.outcome === 'aborted' ? null : P.badRing);
            if (from !== to) {
                const i = from.indexOf(e);
                if (i >= 0) from.splice(i, 1);
                if (to) { to.push(e); _paTrim(to, to === P.okRing ? PAUDIT_OK_MAX : PAUDIT_BAD_MAX); }
            }
        }
        paQueueSave();
    } catch (err) { console.warn('[audit] annotate failed:', err && err.message); }
}
function paRecordHttp(fetchedUrl, r, ctx) {
    try {
        const tgt = paTarget(fetchedUrl);
        const provider = paProviderOf(tgt.url);
        const cls = paClassify(provider, r.status, r.ok, r.text);
        const entry = {
            v: 1, id: Date.now().toString(36) + '-' + (++_paSeq), at: new Date().toISOString(),
            provider, via: tgt.via,
            purpose: (ctx && ctx.purpose) || paPurposeOf(provider, tgt.url),
            symbols: paSymbols(provider, tgt.url),
            target: paScrub(tgt.url).slice(0, 400),
            attempt: (ctx && ctx.attempt) || 1, retryOf: (ctx && ctx.retryOf) || null,
            status: r.status, ok: !!r.ok, statusText: r.statusText || null, redirected: !!r.redirected,
            headers: r.headers || {}, bytes: String(r.text || '').length, durationMs: r.durationMs,
            category: cls.category, outcome: cls.outcome, message: cls.message ? paScrub(cls.message) : null,
            env: paEnv(),
        };
        if (cls.outcome !== 'ok') entry.bodyExcerpt = paScrub(String(r.text || '')).slice(0, PAUDIT_BODY_MAX);
        paCommit(entry);
        return entry;
    } catch (err) { console.warn('[audit] record failed:', err && err.message); return null; }
}
// The request never produced a response: timeout, dropped connection, no Worker URL, or
// a caller abort (a superseded refresh — counted, but not a provider failure).
function paRecordException(fetchedUrl, e, x, ctx) {
    try {
        const tgt = paTarget(fetchedUrl);
        const provider = paProviderOf(tgt.url);
        const raw = paScrub((e && e.message) || String(e || ''));
        const category = x.timedOut ? 'timeout' : (x.callerAborted ? 'aborted' : (/no worker url/i.test(raw) ? 'no-worker' : 'network'));
        const entry = {
            v: 1, id: Date.now().toString(36) + '-' + (++_paSeq), at: new Date().toISOString(),
            provider, via: tgt.via,
            purpose: (ctx && ctx.purpose) || paPurposeOf(provider, tgt.url),
            symbols: paSymbols(provider, tgt.url),
            target: paScrub(tgt.url).slice(0, 400),
            attempt: (ctx && ctx.attempt) || 1, retryOf: (ctx && ctx.retryOf) || null,
            status: null, ok: false, durationMs: x.durationMs,
            category, outcome: category === 'aborted' ? 'aborted' : 'failed', message: raw,
            exception: { name: (e && e.name) || null, message: raw },
            env: paEnv(),
        };
        // No HTTP response, and far faster than any completed upstream call: the request almost
        // certainly never reached the provider. Usual cause is a Worker that refuses the host and
        // answers without CORS headers, which the browser reports only as "Load failed".
        if (category === 'network' && tgt.via === 'worker' && x.durationMs != null && x.durationMs < 250) {
            try {
                const tu = new URL(tgt.url), wu = new URL(fetchedUrl);
                entry.hint = 'No HTTP response in ' + x.durationMs + ' ms \u2014 too quick to have reached ' + tu.hostname +
                    '. Usual cause: the Worker refused the host and replied without CORS headers (an out-of-date Worker). ' +
                    'Check by opening ' + wu.origin + '/proxy?url=' + encodeURIComponent(tu.origin + tu.pathname) +
                    ' in Safari: "host not allowed" means redeploy the Worker.';
            } catch { /* hint only */ }
        }
        paCommit(entry);
        return entry;
    } catch (err) { console.warn('[audit] record failed:', err && err.message); return null; }
}
// Something worth knowing that isn't a request: a source that was skipped (no key,
// budget spent, cooling off) or a note about what happened. Identical consecutive
// events fold into one with a count, so a polling loop can't flood the log.
function paEvent(provider, kind, reason, tickers, ctx) {
    try {
        const P = paProv(provider), last = P.events[P.events.length - 1];
        const sig = (tickers || []).slice().sort().join(',');
        const now = new Date().toISOString();
        if (last && last.kind === kind && last.reason === reason && last.sig === sig) {
            last.count = (last.count || 1) + 1; last.lastAt = now;
        } else {
            P.events.push({ v: 1, kind, at: now, lastAt: now, count: 1, reason: paScrub(reason), sig,
                            tickers: (tickers || []).slice(), forced: !!(ctx && ctx.forced),
                            detail: (ctx && ctx.detail) ? paScrubDeep(ctx.detail) : null });
            _paTrim(P.events, PAUDIT_EVT_MAX);
        }
        paQueueSave();
    } catch (err) { console.warn('[audit] event failed:', err && err.message); }
}
function paSkip(provider, reason, tickers, ctx) { paEvent(provider, 'skip', reason, tickers, ctx); }
function paNote(provider, reason, tickers, ctx) { paEvent(provider, 'note', reason, tickers, ctx); }
// Yahoo's chart answers a bad symbol with a 200 and an empty result, so what came back is
// recorded from the parsed result: bars returned, and the quote's own price/time/currency.
function paYahooResult(res, result, symbol) {
    try {
        if (!res || !res.audit) return;
        const meta = (result && result.meta) || {};
        const bars = result && Array.isArray(result.timestamp) ? result.timestamp.length : 0;
        const patch = {
            symbols: symbol ? [symbol] : undefined,
            rows: bars,
            quote: { price: meta.regularMarketPrice ?? null, time: meta.regularMarketTime ?? null,
                     currency: meta.currency || null, marketState: meta.marketState || null,
                     exchangeTz: meta.exchangeTimezoneName || null },
        };
        if (result && bars === 0 && meta.regularMarketPrice == null) { patch.outcome = 'failed'; patch.category = 'empty-response'; patch.message = 'no bars and no quote in the result'; }
        paAnnotate(res, patch);
    } catch { /* audit only */ }
}
function paSnapshot() {
    const st = paState();
    const out = { schema: 1, since: st.since, generatedAt: new Date().toISOString(), providers: {} };
    Object.keys(st.providers).sort().forEach(name => {
        const P = st.providers[name], c = P.counters;
        const lastOk  = P.okRing.length ? P.okRing[P.okRing.length - 1] : null;
        const lastBad = P.badRing.length ? P.badRing[P.badRing.length - 1] : null;
        let streak = 0;
        for (let i = P.recent.length - 1; i >= 0; i--) {
            if (P.recent[i].o === 'aborted') continue;
            if (P.recent[i].o === 'ok') break;
            streak++;
        }
        out.providers[name] = {
            summary: {
                requests: c.total, ok: c.ok, partial: c.partial, failed: c.failed, aborted: c.aborted,
                byCategory: Object.assign({}, c.byCategory), consecutiveNonOk: streak,
                lastOkAt: lastOk ? lastOk.at : null,
                lastProblem: lastBad ? { at: lastBad.at, category: lastBad.category, message: lastBad.message, hint: lastBad.hint || null,
                                         purpose: lastBad.purpose, symbols: lastBad.symbols } : null,
                skipsAndNotes: P.events.reduce((n, e) => n + (e.count || 1), 0),
            },
            recentProblems: P.badRing.slice(),
            recentSuccesses: P.okRing.slice(),
            events: P.events.slice(),
        };
    });
    return out;
}

// ── Network: buffered fetch with timeout ──────────────────────────────────────
// Every market-data request goes through _fetchBuffered: the WHOLE response
// (headers and body) must arrive within timeoutMs or the request is aborted, so
// a stalled connection can never hang a refresh. The body is read here and
// handed back as { ok, status, text() } — the only parts of a Response the
// callers use. A caller-supplied AbortSignal still cancels the request.
// Each exchange is also written to the provider audit trail above; the entry is
// returned as res.audit so a caller can annotate it (paAnnotate).
const NET_TIMEOUT_MS = 12000;
async function _fetchBuffered(url, signal, timeoutMs, auditCtx) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t0 = Date.now();
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs || NET_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
        const res  = await fetch(url, { signal: ctrl.signal });
        const text = await res.text();
        // Only the CORS-safelisted headers are readable from the browser; kept for diagnostics.
        const headers = {};
        try { for (const n of ['content-type', 'content-length', 'cache-control', 'last-modified', 'expires']) { const v = res.headers.get(n); if (v != null) headers[n] = v; } } catch {}
        const audit = paRecordHttp(url, { status: res.status, ok: res.ok, statusText: res.statusText, redirected: !!res.redirected,
                                          headers, text, durationMs: Date.now() - t0 }, auditCtx);
        return { ok: res.ok, status: res.status, statusText: res.statusText, redirected: !!res.redirected, headers, text: async () => text, audit };
    } catch (e) {
        const callerAborted = !!(signal && signal.aborted) && !timedOut;
        const ent = paRecordException(url, e, { timedOut, callerAborted, durationMs: Date.now() - t0 }, auditCtx);
        if (timedOut) {
            const t = new Error('timed out after ' + Math.round((timeoutMs || NET_TIMEOUT_MS) / 1000) + ' s');
            t.timeout = true;
            if (ent) t.auditId = ent.id;
            throw t;
        }
        if (ent && e && typeof e === 'object') { try { e.auditId = ent.id; } catch {} }
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// Yahoo serves the same API from query1 and query2. One retry on the other host
// covers a throttled or failing edge (the Worker's shared Cloudflare IPs are
// rate-limited by Yahoo from time to time, as they were by Alpha Vantage).
function _yahooAltHost(url) {
    const s = String(url || '');
    if (s.includes('://query1.finance.yahoo.com/')) return s.replace('://query1.finance.yahoo.com/', '://query2.finance.yahoo.com/');
    if (s.includes('://query2.finance.yahoo.com/')) return s.replace('://query2.finance.yahoo.com/', '://query1.finance.yahoo.com/');
    return null;
}

// Fetch a URL through the Worker. Yahoo requests that time out, fail at the
// network level, or return 429/5xx are retried once on the other Yahoo host
// after a short jittered pause. Nothing else is retried (Twelve Data calls cost
// credits; a 4xx is a real answer). Caller aborts are never retried.
async function proxyFetch(targetUrl, signal, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || NET_TIMEOUT_MS;
    const purpose = (opts && opts.purpose) || null;
    const once = (url, attempt, retryOf) => {
        const proxied = makeProxyUrl(url);
        if (!proxied) {
            // Never reached the network, but a missing Worker URL is exactly what an audit should show.
            const e = new Error('no worker URL configured');
            const ent = paRecordException(url, e, { timedOut: false, callerAborted: false, durationMs: 0 }, { purpose, attempt, retryOf });
            if (ent) e.auditId = ent.id;
            return Promise.reject(e);
        }
        return _fetchBuffered(proxied, signal, timeoutMs, { purpose, attempt, retryOf });
    };
    let res = null, err = null;
    try { res = await once(targetUrl, 1, null); } catch (e) { err = e; }
    const alt = _yahooAltHost(targetUrl);
    const callerAborted = !!(signal && signal.aborted);
    const retryable = !!alt && !callerAborted && (err ? true : (res.status === 429 || res.status >= 500));
    if (retryable) {
        const firstId = (res && res.audit && res.audit.id) || (err && err.auditId) || null;
        await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 500)));
        try { res = await once(alt, 2, firstId); err = null; } catch (e2) { err = e2; res = null; }
    }
    if (err) throw err;
    if (!res.ok && !(opts && opts.allowHttpError)) throw new Error(`HTTP ${res.status}`);
    return res;
}
// ── Stored price history (`prices`) from Yahoo ──────────────────────────────
// Basis: dividend/split-ADJUSTED closes (adjclose; raw close only if Yahoo sends
// no adjusted series). Deliberate: the transaction ledger has no dividend
// category (HL dividend rows fall through categoriseTransaction to 'other' and
// never reach cash), so adjusted prices are the only way dividends enter
// historical values and TWR. Yahoo rewrites adjusted history at every
// ex-dividend date, so a stored series is always REPLACED over the fetched range
// by one fetch (mergeHistorySeries), never stitched from fetches made on
// different days. Live prices and the 1D check use raw closes; the two meet
// cleanly because adjusted = raw for every bar after the latest ex-date.
// Dating: each bar's date in the exchange's own timezone (meta.exchangeTimezoneName),
// as in the 1D module — UTC dating filed London FX bars a day early during BST.
// Completed bars only: bars dated on/after the exchange's current date are
// dropped (live injection owns today). Weekly bars: Yahoo stamps a weekly bar at
// the START of its week but its close is the END-of-week close, so each is
// re-dated to the Friday of its week; the current, incomplete week is dropped.
function _weekEndFriday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7));
    return d.toISOString().slice(0, 10);
}
function yahooHistoryRowsFromChart(result, interval, nowMs) {
    if (!result) return [];
    const meta = result.meta || {};
    const tz   = meta.exchangeTimezoneName || null;
    const off  = meta.gmtoffset;
    const ts   = result.timestamp || [];
    const adj  = result.indicators && result.indicators.adjclose && result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose;
    const raw  = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
    const closes = (Array.isArray(adj) && adj.some(v => Number(v) > 0)) ? adj : raw;
    const today = exchangeLocalDate(Math.floor((nowMs || Date.now()) / 1000), tz, off);
    const weekly = interval === '1wk';
    const byDate = new Map();
    ts.map((t, i) => ({ t: Number(t), c: Number(closes[i]) }))
      .filter(x => Number.isFinite(x.t) && Number.isFinite(x.c) && x.c > 0)
      .sort((a, b) => a.t - b.t)
      .forEach(x => {
          let d = exchangeLocalDate(x.t, tz, off);
          if (!d) return;
          if (weekly) d = _weekEndFriday(d);
          byDate.set(d, x.c);                      // later timestamp for the same date wins
      });
    return Array.from(byDate.entries())
        .filter(([d]) => !today || d < today)      // completed sessions / weeks only
        .map(([date, close]) => ({ date, close }))
        .sort((a, b) => a.date.localeCompare(b.date));
}
async function tryYahoo(ticker, fromDate, toDate, signal, interval) {
    interval = interval || '1wk'; // '1d' = daily, '1wk' = weekly
    const p1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
    const p2 = Math.floor(new Date(toDate   + 'T00:00:00Z').getTime() / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=${interval}&includeAdjustedClose=true`;
    const res = await proxyFetch(url, signal);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error('bad JSON'); }
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error(json?.chart?.error?.description || 'no result');
    const data = yahooHistoryRowsFromChart(result, interval, Date.now());
    paYahooResult(res, result, ticker);
    paAnnotate(res, data.length ? { usableRows: data.length } : { usableRows: 0, outcome: 'failed', category: 'empty-response', message: 'no completed bars after filtering' });
    if (data.length === 0) throw new Error('empty');
    return data;
}
// Returns { data, source, attempts }. Yahoo is the only history source (Stooq
// was dropped: its anti-bot challenge blocks every request). Timeouts and the
// query1/query2 retry live in proxyFetch.
// Synthetic/cash tickers (T26A, JPM_MM, n/a, etc.) bypass the network immediately.
// opts.yahooIsMarketSymbol — the caller KNOWS yahooTicker is a real Yahoo symbol
// (declared in an equity-plan config or custody file, the same tickers
// fetchLivePrices quotes live). Needed because isSyntheticTicker treats any
// suffix-less ticker as an internal code, which would block bare US listings
// such as Citi ("C").
async function fetchPriceSeries(yahooTicker, fromDate, toDate, interval, opts) {
    interval = interval || 'weekly'; // 'daily' or 'weekly'
    opts = opts || {};
    if (!opts.yahooIsMarketSymbol && isSyntheticTicker(yahooTicker)) {
        return { data: [], source: 'synthetic', attempts: [{ src: 'guard', result: 'skip', msg: 'synthetic asset — cost-basis series used' }] };
    }
    try {
        const data = await tryYahoo(yahooTicker, fromDate, toDate, opts.signal || null, interval === 'daily' ? '1d' : '1wk');
        return { data, source: 'yahoo', attempts: [{ src: 'yahoo', result: 'ok', msg: `${data.length} pts` }] };
    } catch (e) {
        const err = new Error('all sources failed');
        err.attempts = [{ src: 'yahoo', result: 'fail', msg: (e && e.message) || 'failed' }];
        throw err;
    }
}

// ── History merge + quality ───────────────────────────────────────────────────
// mergeHistorySeries: the fetched weekly + daily rows (daily wins on a shared
// date) REPLACE the stored series from the earliest fetched date onward. Stored
// points before that date (e.g. uploaded history older than Yahoo's) are kept.
function mergeHistorySeries(existing, weeklyRows, dailyRows) {
    const fetched = new Map();
    (weeklyRows || []).forEach(r => { if (r && r.date && Number(r.close) > 0) fetched.set(String(r.date).slice(0, 10), Number(r.close)); });
    (dailyRows  || []).forEach(r => { if (r && r.date && Number(r.close) > 0) fetched.set(String(r.date).slice(0, 10), Number(r.close)); });
    if (fetched.size === 0) return (existing || []).slice();
    const dates = Array.from(fetched.keys()).sort();
    const start = dates[0];
    const kept  = (existing || []).filter(p => p && p.date && String(p.date).slice(0, 10) < start);
    return kept.concat(dates.map(d => ({ date: d, close: fetched.get(d) })))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// cleanHistorySeries: removes bars that are data errors, never real moves.
//   unit-flip — bars on a different unit scale (~×100 / ÷100) from most of the series
//   spike     — an isolated bar beyond the instrument's plausibility ceiling from BOTH
//               neighbouring bars, in the same direction, with the bars either side
//               within half the ceiling of each other
//   disagrees-with-<provider> — where a second source's cached closes cover the
//               dates, BOTH the return into and out of the bar differ from the
//               second source's returns by more than its tolerance. Returns, not
//               levels, so units and dividend adjustment don't matter; an ex-dividend
//               date shifts only one return and is never flagged.
// Dropped bars are returned for the fetch log. Gaps are left as gaps (priceAt
// carries the previous close), never filled with invented prices.
function cleanHistorySeries(rows, profile, altRows, altName) {
    const lim = (profile && Number.isFinite(profile.maxMove)) ? profile.maxMove : MAX_SANE_DAILY_MOVE;
    const tol = (profile && Number.isFinite(profile.tolerance)) ? profile.tolerance : DAILY_VERIFY_TOLERANCE;
    const src = (rows || []).filter(p => p && p.date && Number(p.close) > 0)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const dropped = [];
    // 1. unit flips (pence/pounds slips, single bars or whole runs). Walk the
    //    series; every jump of ~×100 (50–200×) between consecutive bars moves one
    //    scale level up, every ~÷100 jump one level down. Real prices never move
    //    50× in one bar, so each level is one unit scale. Keep the level holding
    //    the most bars (tie: the level of the latest bar) and drop the rest.
    const level = [];
    let lvl = 0;
    for (let i = 0; i < src.length; i++) {
        if (i > 0) {
            const r = Number(src[i].close) / Number(src[i - 1].close);
            if (r >= 50 && r <= 200) lvl += 1;
            else if (r <= 1 / 50 && r >= 1 / 200) lvl -= 1;
        }
        level.push(lvl);
    }
    const counts = new Map();
    level.forEach(l => counts.set(l, (counts.get(l) || 0) + 1));
    let keepLevel = level.length ? level[level.length - 1] : 0;
    counts.forEach((n, l) => { if (n > (counts.get(keepLevel) || 0)) keepLevel = l; });
    const pass1 = [];
    src.forEach((p, i) => {
        if (level[i] === keepLevel) pass1.push(p);
        else dropped.push({ date: p.date, close: p.close, reason: 'unit-flip' });
    });
    // 2. second-source return disagreement
    const alt = new Map((altRows || []).filter(r => r && r.date && Number(r.close) > 0)
        .map(r => [String(r.date).slice(0, 10), Number(r.close)]));
    let pass2 = pass1;
    if (alt.size >= 3) {
        pass2 = [];
        for (let i = 0; i < pass1.length; i++) {
            const a = pass1[i - 1], b = pass1[i], c = pass1[i + 1];
            if (a && c) {
                const A = alt.get(String(a.date).slice(0, 10)), B = alt.get(String(b.date).slice(0, 10)), C = alt.get(String(c.date).slice(0, 10));
                if (A && B && C) {
                    const d1 = Math.abs((b.close / a.close) / (B / A) - 1);
                    const d2 = Math.abs((c.close / b.close) / (C / B) - 1);
                    if (d1 > tol && d2 > tol) { dropped.push({ date: b.date, close: b.close, reason: 'disagrees-with-' + (altName || 'second-source') }); continue; }
                }
            }
            pass2.push(b);
        }
    }
    // 3. isolated spikes
    const out = [];
    for (let i = 0; i < pass2.length; i++) {
        const prev = out[out.length - 1], cur = pass2[i], next = pass2[i + 1];
        if (prev && next) {
            // Both legs measured from the suspect bar, as mktAnchorIsSpike does. Measured as the move in and the move out,
            // the way back down from a bad high print is always smaller (+34% in is only -25% out), so XSPX.L's bad
            // 24 Oct 2025 print (+34.6% in, -24.3% out) slipped under the 25% ceiling and stayed in the history.
            const vsPrev = cur.close / prev.close - 1, vsNext = cur.close / next.close - 1, net = next.close / prev.close - 1;
            if (Math.abs(vsPrev) > lim && Math.abs(vsNext) > lim && Math.sign(vsPrev) === Math.sign(vsNext) && Math.abs(net) < lim / 2) {
                dropped.push({ date: cur.date, close: cur.close, reason: 'spike' });
                continue;
            }
        }
        out.push(cur);
    }
    return { rows: out, dropped };
}

// Second-source closes already cached by the 1D check (Alpha Vantage ~100 days
// for LSE lines, Twelve Data 14 days for US/FX) — reused to vet stored history
// at no API cost.
function cachedSecondSourceRows(ticker) {
    const p = dailyCheckProfileFor(ticker);
    if (!p.provider) return { rows: [], name: null };
    const cache = p.provider === 'av' ? loadAvDailyCache() : loadTdDailyCache();
    const e = cache[p.symbol];
    return { rows: (e && Array.isArray(e.series)) ? e.series : [], name: p.providerName };
}

// ── Single-day gap backfill for stored history ────────────────────────────────
// Yahoo's history endpoint occasionally omits one session entirely for a given
// instrument (documented above the daily-close-check module — the same gap that
// resolveVerifiedDailyPrevClose papers over for Today's move also leaves a real
// hole in the long-run series, which would otherwise show as a flat day on charts
// and in TWR). Where the ticker's routed second source (Alpha Vantage for LSE,
// Twelve Data for NYSE) already has that one date cached — no extra API calls —
// this fills it in, unit-scaled to match Yahoo's series via the same factor the
// 1D check uses.
//
// Deliberately narrow: fills ONE missing trading day at a time (per the exchange
// calendar — a weekend or listed holiday is never "missing"), and never touches a
// gap of two or more consecutive missing trading days — that's a bigger hole than
// a one-off vendor glitch and shouldn't be quietly papered over with two
// interpolated-looking points from a thinner data source.
function backfillHistoryGapsFromSecondSource(rows, ticker) {
    const prof = dailyCheckProfileFor(ticker);
    if (!prof.provider || !prof.calendar) return { rows, filled: [] };
    const sorted = (rows || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length < 2) return { rows: sorted, filled: [] };

    const sec = cachedSecondSourceRows(ticker);
    if (sec.rows.length === 0) return { rows: sorted, filled: [] };
    const factor = crossSourceUnitFactor(sorted, sec.rows, null);
    if (!factor) return { rows: sorted, filled: [] };
    const altByDate = new Map(sec.rows.map(r => [String(r.date).slice(0, 10), Number(r.close)]));

    const out = [sorted[0]];
    const filled = [];
    for (let i = 1; i < sorted.length; i++) {
        const prevDate = String(out[out.length - 1].date).slice(0, 10);
        const curDate  = String(sorted[i].date).slice(0, 10);
        // Only the daily-resolution stretch of the series can have a "missing one
        // trading day" gap worth checking — the older weekly spine (one point every
        // ~7 days by design) must never be mistaken for one, so skip anything more
        // than a long weekend apart.
        const rawGapDays = (new Date(curDate + 'T12:00:00Z') - new Date(prevDate + 'T12:00:00Z')) / 86400000;
        const expected = (rawGapDays <= 5) ? previousExchangeSession(prof.calendar, curDate) : null;
        // A real, single missing trading day: the calendar's expected previous
        // session isn't the row we actually have, and it isn't today's own row.
        if (expected && expected.date !== prevDate && expected.date < curDate) {
            const altClose = altByDate.get(expected.date);
            if (altClose > 0) {
                out.push({ date: expected.date, close: altClose / factor, source: sec.name === 'Alpha Vantage' ? 'alpha-vantage' : 'twelve-data' });
                filled.push(expected.date);
            }
            // Two or more consecutive missing days, or the gap date has no second-
            // source cover: leave the gap as-is rather than guess further back.
        }
        out.push(sorted[i]);
    }
    return { rows: out, filled };
}

// ── History refresh cadence ───────────────────────────────────────────────────
// History holds completed sessions only, so one refresh per London calendar
// day is enough (today is covered by the live quote). HISTORY_SCHEMA_VERSION
// forces a full refresh the first time a new storage format is installed.
// Tickers whose refresh failed are kept as `pending` and retried on their own
// later the same day. (The day used to be marked done as soon as ANY ticker
// refreshed, so a run where FX refreshed but the LSE lines failed left those
// lines a session behind until the next day.)
const HISTORY_SCHEMA_VERSION = 2;   // v2: exchange-local dates, Friday-dated weekly bars, completed bars only
const HISTORY_REFRESH_KEY    = 'history_refresh_state';
function londonDateStr(nowMs) { return exchangeLocalDate(Math.floor((nowMs || Date.now()) / 1000), 'Europe/London', 0); }
function _historyRefreshToday(nowMs) {
    const o = _dcLoad(HISTORY_REFRESH_KEY);
    return (o && o.schema === HISTORY_SCHEMA_VERSION && o.day === londonDateStr(nowMs)) ? o : null;
}
function historyRefreshDue(nowMs) { return !_historyRefreshToday(nowMs); }
// Tickers still waiting for today's refresh (empty when a full refresh is due instead).
function historyRefreshPending(nowMs) {
    const o = _historyRefreshToday(nowMs);
    return (o && Array.isArray(o.pending)) ? o.pending.slice() : [];
}
function markHistoryRefreshed(nowMs, pending) {
    _dcSave(HISTORY_REFRESH_KEY, { schema: HISTORY_SCHEMA_VERSION, day: londonDateStr(nowMs), at: nowMs || Date.now(),
        pending: Array.isArray(pending) ? pending.slice().sort() : [] });
}

// ── Price-feed health: tells Fergus when Yahoo prices stop arriving (his ask) ───────────────────────────────────────
// Every live-quote refresh records one event: ok (with how many fresh quotes survived the gate out of how many were asked
// for) or failed. The record lives in localStorage so a reopened app still knows. feedBanner turns it into the strip at the
// top of Investments: nothing while all is well, amber once the last success is 30 minutes old and a later attempt failed,
// red after a day, and amber if a refresh worked for fewer than half of the holdings (Yahoo answering with gaps).
const FEED_HEALTH_KEY = 'feed_health_v1';
const FEED_STALE_MS = 30 * 60 * 1000;
const FEED_RED_MS = 24 * 3600 * 1000;
function feedHealthLoad() {
    const o = _dcLoad(FEED_HEALTH_KEY);
    return { okAt: Number(o.okAt) || null, failAt: Number(o.failAt) || null, fresh: Number(o.fresh) || 0, requested: Number(o.requested) || 0 };
}
function feedHealthNext(prev, ev, now) {
    const p = prev || {};
    return ev && ev.ok
        ? { okAt: now, failAt: p.failAt || null, fresh: ev.fresh || 0, requested: ev.requested || 0 }
        : { okAt: p.okAt || null, failAt: now, fresh: p.fresh || 0, requested: p.requested || 0 };
}
function feedSince(ms, now) {
    const d = new Date(ms), t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return new Date(now).toDateString() === d.toDateString() ? t
        : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + t;
}
function feedBanner(h, now) {
    if (!h || !h.okAt) return null;
    if (h.failAt && h.failAt > h.okAt && now - h.okAt >= FEED_STALE_MS)
        return { level: now - h.okAt >= FEED_RED_MS ? 'red' : 'amber',
                 text: 'Prices haven\u2019t updated since ' + feedSince(h.okAt, now) + '. Yahoo isn\u2019t responding, so these are the last prices.' };
    if (h.requested >= 4 && h.fresh * 2 < h.requested)
        return { level: 'amber', text: 'Yahoo sent prices for only ' + h.fresh + ' of ' + h.requested + ' holdings; the rest are the last prices.' };
    return null;
}

// Recent daily closes straight from Yahoo's chart endpoint, as { date, close }
// rows dated in the exchange's own timezone, raw (unadjusted) closes, one row
// per date — i.e. exactly the same shape and basis as the rows fetchLivePrices
// builds from the 5-day live chart (both use yahooDailyRowsFromChart). Used to
// backfill liveDailyCloses when the live chart came back without a close series.
async function fetchYahooDailyCloseRows(ticker, fromDate, toDate, signal) {
    const p1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
    const p2 = Math.floor(new Date(toDate   + 'T00:00:00Z').getTime() / 1000) + 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`;
    const res  = await proxyFetch(url, signal);
    const json = JSON.parse(await res.text());
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (!result) throw new Error((json && json.chart && json.chart.error && json.chart.error.description) || 'no chart result');
    paYahooResult(res, result, ticker);
    return yahooDailyRowsFromChart(result);
}
