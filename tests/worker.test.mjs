// The Cloudflare Worker (index.js): only the app's own site may use it, and only for the allowed hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../index.js';

const APP = 'https://fwilson02.github.io';
const proxy = target => 'https://w.example/proxy?url=' + encodeURIComponent(target);
const YAHOO = proxy('https://query1.finance.yahoo.com/v8/finance/chart/VWRL.L');

globalThis.fetch = async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } });

test('the app\'s site gets through, with CORS for that site', async () => {
    const r = await worker.fetch(new Request(YAHOO, { headers: { Origin: APP } }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), APP);
    const pre = await worker.fetch(new Request(YAHOO, { method: 'OPTIONS', headers: { Origin: APP } }));
    assert.equal(pre.status, 204);
});

test('other sites and requests with no Origin are refused', async () => {
    assert.equal((await worker.fetch(new Request(YAHOO, { headers: { Origin: 'https://example.com' } }))).status, 403);
    assert.equal((await worker.fetch(new Request(YAHOO))).status, 403);
});

test('only the allowed hosts are proxied', async () => {
    const r = await worker.fetch(new Request(proxy('https://example.com/'), { headers: { Origin: APP } }));
    assert.equal(r.status, 403);
});

test('the copy in Settings → Worker code matches index.js', () => {
    const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
    const embedded = JSON.parse(html.match(/const CLOUDFLARE_WORKER_SOURCE = (".*");\n/)[1]);
    assert.equal(embedded, fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8'));
});

// ── Backups ──
function memoryKV() {
    const m = new Map();
    return { map: m,
             get: async k => (m.has(k) ? m.get(k) : null),
             put: async (k, v) => { m.set(k, v); },
             delete: async k => { m.delete(k); },
             list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) };
}
const ENC = JSON.stringify({ format: 'portfolio-cloud-backup', v: 1, data: 'c2NyYW1ibGVk' });
const call = (env, path, init = {}) => worker.fetch(new Request('https://w.example' + path,
    { ...init, headers: { Origin: APP, ...(init.headers || {}) } }), env);
const auth = { Authorization: 'Bearer s3cret' };

test('backup: 501 until the KV namespace and token are set up', async () => {
    assert.equal((await call({}, '/backup', { headers: auth })).status, 501);
    assert.equal((await call(undefined, '/backup', { headers: auth })).status, 501);
});

test('backup: the token is required', async () => {
    const env = { BACKUPS: memoryKV(), BACKUP_TOKEN: 's3cret' };
    assert.equal((await call(env, '/backup')).status, 401);
    assert.equal((await call(env, '/backup', { headers: { Authorization: 'Bearer s3cre' } })).status, 401);
    assert.equal((await call(env, '/backup', { method: 'PUT', body: ENC, headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal(env.BACKUPS.map.size, 0);
});

test('backup: store, read back, list days; only encrypted backups are accepted', async () => {
    const env = { BACKUPS: memoryKV(), BACKUP_TOKEN: 's3cret' };
    assert.equal((await call(env, '/backup', { headers: auth })).status, 404);
    assert.equal((await call(env, '/backup', { method: 'PUT', body: '{"plain":true}', headers: auth })).status, 400);
    const put = await call(env, '/backup', { method: 'PUT', body: ENC, headers: auth });
    assert.equal(put.status, 200);
    const { day } = await put.json();
    assert.equal(await (await call(env, '/backup', { headers: auth })).text(), ENC);
    assert.equal(await (await call(env, '/backup?day=' + day, { headers: auth })).text(), ENC);
    assert.deepEqual((await (await call(env, '/backup/list', { headers: auth })).json()).days, [day]);
});

test('backup: preflight allows PUT with the token header', async () => {
    const r = await call({}, '/backup', { method: 'OPTIONS' });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /PUT/);
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
});

// ── Monzo ──
const MONZO_ENV = () => ({ BACKUPS: memoryKV(), BACKUP_TOKEN: 's3cret', MONZO_CLIENT_ID: 'oauth2client_x', MONZO_CLIENT_SECRET: 'shh' });
function fakeMonzo(routes) {
    const calls = [];
    globalThis.fetch = async (u, init = {}) => {
        const url = String(u); calls.push({ url, init });
        for (const [k, f] of Object.entries(routes)) if (url.startsWith('https://api.monzo.com' + k)) return f(url, init);
        return new Response('{}', { status: 404 });
    };
    return calls;
}
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

test('monzo: 501 until set up, then needs the token', async () => {
    assert.equal((await call({ BACKUPS: memoryKV(), BACKUP_TOKEN: 's3cret' }, '/monzo/balances', { headers: auth })).status, 501);
    assert.equal((await call(MONZO_ENV(), '/monzo/balances')).status, 401);
});

test('monzo: login, callback, balances and pots', async () => {
    const env = MONZO_ENV();
    const start = await (await call(env, '/monzo/start', { method: 'POST', headers: auth })).json();
    const login = new URL(start.url);
    assert.equal(login.origin, 'https://auth.monzo.com');
    assert.equal(login.searchParams.get('redirect_uri'), 'https://w.example/monzo/callback');
    const state = login.searchParams.get('state');

    fakeMonzo({ '/oauth2/token': () => jsonRes({ access_token: 'at1', refresh_token: 'rt1', expires_in: 21600 }) });
    // A made-up state is refused; the real one works once, with no Origin (it's Monzo's redirect).
    assert.equal((await worker.fetch(new Request('https://w.example/monzo/callback?code=c&state=' + 'a'.repeat(32)), env)).status, 400);
    assert.equal((await worker.fetch(new Request('https://w.example/monzo/callback?code=c&state=' + state), env)).status, 200);
    assert.equal((await worker.fetch(new Request('https://w.example/monzo/callback?code=c&state=' + state), env)).status, 400);

    fakeMonzo({ '/accounts': () => jsonRes({}, 403) });
    assert.equal((await (await call(env, '/monzo/balances', { headers: auth })).json()).status, 'approve');

    fakeMonzo({
        '/accounts': () => jsonRes({ accounts: [{ id: 'acc_1', type: 'uk_retail', closed: false }, { id: 'acc_old', type: 'uk_retail', closed: true }] }),
        '/balance': () => jsonRes({ balance: 123456, total_balance: 223456 }),
        '/pots': () => jsonRes({ pots: [{ id: 'pot_1', name: 'Holiday', balance: 100000, deleted: false }, { id: 'pot_2', name: 'Old', balance: 5, deleted: true }] }),
    });
    const b = await (await call(env, '/monzo/balances', { headers: auth })).json();
    assert.equal(b.status, 'ok');
    assert.deepEqual(b.items, [{ id: 'acc_1', label: 'Current account', value: 1234.56 }, { id: 'pot_1', label: 'Pot: Holiday', value: 1000 }]);
});

test('monzo: an expired access token is refreshed and the new refresh token kept', async () => {
    const env = MONZO_ENV();
    await env.BACKUPS.put('monzo:tokens', JSON.stringify({ access_token: 'old', refresh_token: 'rt1', expires_at: Date.now() - 1 }));
    const calls = fakeMonzo({
        '/oauth2/token': (u, init) => { assert.match(String(init.body), /grant_type=refresh_token/); return jsonRes({ access_token: 'new', refresh_token: 'rt2', expires_in: 21600 }); },
        '/accounts': (u, init) => { assert.equal(init.headers.Authorization, 'Bearer new'); return jsonRes({ accounts: [] }); },
    });
    assert.equal((await (await call(env, '/monzo/balances', { headers: auth })).json()).status, 'ok');
    assert.equal(JSON.parse(env.BACKUPS.map.get('monzo:tokens')).refresh_token, 'rt2');
    assert.ok(calls.some(c => c.url.endsWith('/oauth2/token')));
});
