// Cloudflare Worker for the portfolio app — copied from the app's Settings. git
// Interface the app uses:  GET /proxy?url=<encoded target URL>
//   • Forwards ONLY to Yahoo Finance, Twelve Data, Naver Finance and Marketstack (not an open proxy: the
//     Worker URL is visible in the app, and an open proxy invites abuse that
//     burns the free quota and gets Cloudflare's shared IPs blocked by Yahoo).
//   • GET only; no cookies or client headers forwarded; nothing logged.
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
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function reply(status, body) {
  return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return reply(405, 'method not allowed');

    const url = new URL(request.url);
    if (url.pathname !== '/proxy') return reply(404, 'not found');

    let target;
    try { target = new URL(url.searchParams.get('url') || ''); }
    catch { return reply(400, 'bad url'); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) return reply(403, 'host not allowed');

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
      return reply(502, 'upstream fetch failed');
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
