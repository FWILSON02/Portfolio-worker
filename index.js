// Cloudflare Worker for the portfolio app — copied from the app's Settings.
// Interface the app uses:  GET /proxy?url=<encoded target URL>
//   • Forwards ONLY to Yahoo Finance, Twelve Data, Naver Finance, Marketstack and giltsyield.com (not an open proxy: the
//     Worker URL is visible in the app, and an open proxy invites abuse that
//     burns the free quota and gets Cloudflare's shared IPs blocked by Yahoo).
//   • GET only; no cookies or client headers forwarded; nothing logged.
//   • Answers only the app's own site (ALLOWED_ORIGINS), so other websites can't
//     use it from a visitor's browser. Scripts can still fake an Origin header;
//     this stops casual reuse, not a determined caller.
// Deploy: Cloudflare dashboard → Workers → your worker → Edit code → paste over
// the existing code → Deploy. If your current Worker does anything extra
// (other routes, special Yahoo headers), keep those parts.

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function reply(status, body, cors) {
  return new Response(body, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.has(origin)) return new Response('origin not allowed', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Vary': 'Origin' } });
    const CORS = corsFor(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return reply(405, 'method not allowed', CORS);

    const url = new URL(request.url);
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
