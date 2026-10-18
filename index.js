// Cloudflare Worker for the portfolio app — copied from the app's Settings.
// Interface the app uses:  GET /proxy?url=<encoded target URL>
//                           PUT /backup, GET /backup[?day=YYYY-MM-DD], GET /backup/list  (encrypted cloud backup)
//                           POST /monzo/start, GET /monzo/balances, POST /monzo/disconnect; GET /monzo/callback (Monzo's redirect)
//   • Forwards ONLY to Yahoo Finance, Twelve Data, Naver Finance, Marketstack and giltsyield.com (not an open proxy: the
//     Worker URL is visible in the app, and an open proxy invites abuse that
//     burns the free quota and gets Cloudflare's shared IPs blocked by Yahoo).
//   • The proxy is GET only; no cookies or client headers forwarded; nothing logged.
//   • Answers only the app's own site (ALLOWED_ORIGINS), so other websites can't
//     use it from a visitor's browser. Scripts can still fake an Origin header;
//     this stops casual reuse, not a determined caller.
//   • Backups: the app encrypts on the phone before sending, so this only ever holds
//     scrambled data. Needs a KV namespace bound as BACKUPS (wrangler.json) and a
//     secret BACKUP_TOKEN (Worker → Settings → Variables and Secrets); the app sends
//     that token with every backup call. Without them /backup answers 501.
//   • Monzo: reads your own Monzo balances and pots with the Monzo Developer API. Needs secrets MONZO_CLIENT_ID and
//     MONZO_CLIENT_SECRET (a confidential client from developers.monzo.com whose redirect URL is
//     <this Worker's URL>/monzo/callback) and the BACKUPS KV namespace, where the Monzo tokens are kept. The app calls it
//     with the same BACKUP_TOKEN. Monzo only lets the token read anything once you approve it in the Monzo app.
// Deploy: merging to main in the GitHub repo redeploys it (Cloudflare is linked to
// the repo). Or: Cloudflare dashboard → Workers → your worker → Edit code → paste
// over the existing code → Deploy.

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'api.twelvedata.com',
  'm.stock.naver.com',        // Naver Finance: KOSPI 200 history
  'fchart.stock.naver.com',
  'api.marketstack.com',      // Marketstack: LSE fallback when Alpha Vantage is exhausted
  'giltsyield.com',           // giltsyield.com: gilt prices for the gilt ladder (CSV)
]);

// Sites allowed to call the Worker. Add an origin here if the app moves.
const ALLOWED_ORIGINS = new Set([
  'https://fwilson02.github.io',  // GitHub Pages: the app and its Home Screen icon
]);

function corsFor(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function reply(status, body, cors) {
  return new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });
}

// ── Backups ──────────────────────────────────────────────────────────────────
const BACKUP_MAX_BYTES = 20 * 1024 * 1024;     // KV holds up to 25 MB a value
const BACKUP_DAY_TTL = 90 * 24 * 60 * 60;      // one copy per day, kept 90 days; the latest is kept until replaced

function json(status, obj, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// Compares in time that doesn't depend on where the strings differ.
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function backup(request, url, env, cors) {
  if (!env || !env.BACKUPS || !env.BACKUP_TOKEN) return json(501, { error: 'backups not set up on the Worker' }, cors);
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), env.BACKUP_TOKEN)) return json(401, { error: 'wrong backup token' }, cors);

  if (url.pathname === '/backup/list' && request.method === 'GET') {
    const days = [];
    let cursor;
    do {
      const page = await env.BACKUPS.list({ prefix: 'day:', cursor });
      page.keys.forEach(k => days.push(k.name.slice(4)));
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return json(200, { days: days.sort().reverse() }, cors);
  }
  if (url.pathname !== '/backup') return reply(404, 'not found', cors);

  if (request.method === 'GET') {
    const day = url.searchParams.get('day');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { error: 'bad day' }, cors);
    const body = await env.BACKUPS.get(day ? 'day:' + day : 'latest');
    if (body == null) return json(404, { error: 'no backup' }, cors);
    return new Response(body, { status: 200, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > BACKUP_MAX_BYTES) return json(413, { error: 'backup too large' }, cors);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return json(400, { error: 'not JSON' }, cors); }
    if (!parsed || parsed.format !== 'portfolio-cloud-backup' || typeof parsed.data !== 'string') return json(400, { error: 'not an encrypted backup' }, cors);
    const day = new Date().toISOString().slice(0, 10);
    await env.BACKUPS.put('latest', body);
    await env.BACKUPS.put('day:' + day, body, { expirationTtl: BACKUP_DAY_TTL });
    return json(200, { ok: true, day, bytes: body.length }, cors);
  }
  return reply(405, 'method not allowed', cors);
}

// ── Monzo ────────────────────────────────────────────────────────────────────
const MONZO_API = 'https://api.monzo.com';
const MONZO_TOKENS = 'monzo:tokens';            // { access_token, refresh_token, expires_at (ms) }
const MONZO_STATE_TTL = 15 * 60;                // a login link works for 15 minutes

function monzoReady(env) { return !!(env && env.BACKUPS && env.BACKUP_TOKEN && env.MONZO_CLIENT_ID && env.MONZO_CLIENT_SECRET); }
function authorised(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') && sameSecret(auth.slice(7), env.BACKUP_TOKEN);
}
function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
async function monzoTokenCall(env, form) {
  const r = await fetch(MONZO_API + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MONZO_CLIENT_ID, client_secret: env.MONZO_CLIENT_SECRET, ...form }).toString(),
  });
  if (!r.ok) return null;
  const t = await r.json();
  if (!t || !t.access_token) return null;
  const tokens = { access_token: t.access_token, refresh_token: t.refresh_token || null, expires_at: Date.now() + (Number(t.expires_in) || 21600) * 1000 };
  await env.BACKUPS.put(MONZO_TOKENS, JSON.stringify(tokens));
  return tokens;
}
// The saved tokens, refreshed first when the access token is about to run out. null = not connected (or refresh failed).
async function monzoTokens(env) {
  const raw = await env.BACKUPS.get(MONZO_TOKENS);
  if (!raw) return null;
  let t;
  try { t = JSON.parse(raw); } catch { return null; }
  if (t.expires_at - Date.now() > 60 * 1000) return t;
  if (!t.refresh_token) return null;
  return monzoTokenCall(env, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
}
async function monzoGet(path, token) {
  const r = await fetch(MONZO_API + path, { headers: { Authorization: 'Bearer ' + token } });
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const MONZO_ACCOUNT_NAMES = { uk_retail: 'Current account', uk_retail_joint: 'Joint account' };

function page(status, title, text) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><body style="font-family:-apple-system,system-ui,sans-serif;background:#0a0e14;color:#e4e4e7;padding:32px 20px;line-height:1.5">' +
    '<h2 style="margin:0 0 12px">' + esc(title) + '</h2><p>' + esc(text) + '</p></body>';
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

// Monzo sends you here after you log in (from the email link). No Origin on this one, so the one-time state proves the
// login was started from the app.
async function monzoCallback(url, env) {
  if (!monzoReady(env)) return page(501, 'Monzo is not set up', 'The Worker needs its Monzo secrets first.');
  const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!/^[0-9a-f]{32}$/.test(state) || !code) return page(400, 'Link not valid', 'Start again from the app: Settings → Monzo → Connect.');
  const key = 'monzo:state:' + state;
  if (!(await env.BACKUPS.get(key))) return page(400, 'Link expired', 'Start again from the app: Settings → Monzo → Connect.');
  await env.BACKUPS.delete(key);
  const tokens = await monzoTokenCall(env, { grant_type: 'authorization_code', redirect_uri: url.origin + '/monzo/callback', code });
  if (!tokens) return page(502, 'Monzo said no', 'Monzo did not accept the login. Start again from the app.');
  return page(200, 'Nearly done', 'Now open the Monzo app and allow access when it asks. Then go back to Portfolio and tap Refresh in Settings → Monzo.');
}

async function monzo(request, url, env, cors) {
  if (!monzoReady(env)) return json(501, { error: 'Monzo not set up on the Worker' }, cors);
  if (!authorised(request, env)) return json(401, { error: 'wrong backup token' }, cors);

  if (url.pathname === '/monzo/start' && request.method === 'POST') {
    const state = randomHex(16);
    await env.BACKUPS.put('monzo:state:' + state, '1', { expirationTtl: MONZO_STATE_TTL });
    const login = 'https://auth.monzo.com/?' + new URLSearchParams({ client_id: env.MONZO_CLIENT_ID,
      redirect_uri: url.origin + '/monzo/callback', response_type: 'code', state }).toString();
    return json(200, { url: login }, cors);
  }
  if (url.pathname === '/monzo/disconnect' && request.method === 'POST') {
    const raw = await env.BACKUPS.get(MONZO_TOKENS);
    if (raw) {
      try { await fetch(MONZO_API + '/oauth2/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + JSON.parse(raw).access_token } }); } catch {}
      await env.BACKUPS.delete(MONZO_TOKENS);
    }
    return json(200, { ok: true }, cors);
  }
  if (url.pathname === '/monzo/balances' && request.method === 'GET') {
    const t = await monzoTokens(env);
    if (!t) return json(200, { status: 'not_connected' }, cors);
    const acc = await monzoGet('/accounts', t.access_token);
    if (acc.status === 401) return json(200, { status: 'not_connected' }, cors);
    if (acc.status === 403) return json(200, { status: 'approve' }, cors);     // not yet allowed in the Monzo app
    if (acc.status !== 200 || !acc.body || !Array.isArray(acc.body.accounts)) return json(502, { error: 'Monzo accounts failed (' + acc.status + ')' }, cors);
    const items = [];
    for (const a of acc.body.accounts.filter(a => !a.closed && MONZO_ACCOUNT_NAMES[a.type])) {
      const bal = await monzoGet('/balance?account_id=' + encodeURIComponent(a.id), t.access_token);
      if (bal.status !== 200 || !bal.body) return json(502, { error: 'Monzo balance failed (' + bal.status + ')' }, cors);
      items.push({ id: a.id, label: MONZO_ACCOUNT_NAMES[a.type], value: bal.body.balance / 100 });
      const pots = await monzoGet('/pots?current_account_id=' + encodeURIComponent(a.id), t.access_token);
      if (pots.status === 200 && pots.body && Array.isArray(pots.body.pots)) {
        pots.body.pots.filter(p => !p.deleted).forEach(p => items.push({ id: p.id, label: 'Pot: ' + p.name, value: p.balance / 100 }));
      }
    }
    return json(200, { status: 'ok', items, fetchedAt: Date.now() }, cors);
  }
  return reply(404, 'not found', cors);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    // Monzo's redirect after login is a plain page visit with no Origin; it is guarded by its one-time state instead.
    if (request.method === 'GET' && new URL(request.url).pathname === '/monzo/callback') return monzoCallback(new URL(request.url), env);
    if (!ALLOWED_ORIGINS.has(origin)) return new Response('origin not allowed', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Vary': 'Origin' } });
    const CORS = corsFor(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/backup' || url.pathname === '/backup/list') return backup(request, url, env, CORS);
    if (url.pathname.startsWith('/monzo/')) return monzo(request, url, env, CORS);
    if (request.method !== 'GET') return reply(405, 'method not allowed', CORS);
    if (url.pathname !== '/proxy') return reply(404, 'not found', CORS);

    let target;
    try { target = new URL(url.searchParams.get('url') || ''); }
    catch { return reply(400, 'bad url', CORS); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) return reply(403, 'host not allowed', CORS);

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          'Accept': 'application/json,text/plain,*/*',
        },
        cf: { cacheTtl: 0 },
      });
    } catch (e) {
      return reply(502, 'upstream fetch failed', CORS);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
