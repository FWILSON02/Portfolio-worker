// Cloudflare Worker for the portfolio app — copied from the app's Settings.
// Interface the app uses:  GET /proxy?url=<encoded target URL>
//                           PUT /backup, GET /backup[?day=YYYY-MM-DD], GET /backup/list  (encrypted cloud backup)
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
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.has(origin)) return new Response('origin not allowed', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Vary': 'Origin' } });
    const CORS = corsFor(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/backup' || url.pathname === '/backup/list') return backup(request, url, env, CORS);
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
