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

test('the app no longer carries its own copy of the Worker: index.js is the only one', () => {
    const html = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
    assert.equal(html.includes('CLOUDFLARE_WORKER_SOURCE'), false);
    assert.equal(html.includes('Copy Worker code'), false);
});

// ── Backups ──
function memoryKV() {
    const m = new Map();
    return { map: m,
             get: async k => (m.has(k) ? m.get(k) : null),
             put: async (k, v) => { m.set(k, v); },
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
