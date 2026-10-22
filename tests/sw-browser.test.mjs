// The offline copy (docs/sw.js) in a real browser: after one open with signal the app opens with none, a new
// index.html is picked up on the next open with signal, and swOff() (the kill switch) removes it and its cache.
// Everything is served by a local server at /Portfolio-worker/ (a service worker needs a real origin), including the
// pinned CDN scripts from node_modules under npm/: Playwright's routing would send requests past the worker, so it
// is not used. Needs Playwright like the smoke test; skipped locally without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
let playwright = null;
try { playwright = require('playwright'); for (const p of ['react', 'react-dom', 'xlsx', 'papaparse']) require.resolve(p + '/package.json'); }
catch (e) { if (process.env.SMOKE_REQUIRED) throw e; playwright = null; }

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.png': 'image/png' };

test('the app opens offline after one visit, takes a new build when online, and can be switched off',
     { skip: !playwright && 'Playwright not installed', timeout: 120000 }, async t => {
    let marker = 'build-one', down = false;
    const server = http.createServer((req, res) => {
        if (down) return req.socket.destroy(); // no signal: the connection drops
        const u = new URL(req.url, 'http://localhost');
        if (!u.pathname.startsWith('/Portfolio-worker/')) { res.writeHead(404); return res.end(); }
        const rel = decodeURIComponent(u.pathname.slice('/Portfolio-worker/'.length));
        const cdn = /^npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(rel);
        const file = cdn ? path.join(path.dirname(require.resolve(cdn[1] + '/package.json')), cdn[2]) : path.join(DOCS, rel || 'index.html');
        if (!(cdn || file.startsWith(DOCS)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
        let body = fs.readFileSync(file);
        if (file === path.join(DOCS, 'index.html'))
            body = Buffer.from(body.toString().split('https://cdn.jsdelivr.net/npm/').join('npm/').replace('<div id="root">', '<!-- ' + marker + ' --><div id="root">'));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
        res.end(body);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const SITE = 'http://localhost:' + server.address().port + '/Portfolio-worker/';

    const browser = await playwright.chromium.launch(process.env.SMOKE_CHROME_CHANNEL ? { channel: process.env.SMOKE_CHROME_CHANNEL } : {});
    t.after(() => browser.close());
    const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    const crashes = [];
    page.on('pageerror', e => crashes.push(e.message));

    const cached = () => page.evaluate(async () => (await (await caches.open('portfolio-app-v1')).keys()).map(r => r.url));
    const waitFor = async (what, fn) => {
        for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(200); }
        assert.fail('timed out waiting for ' + what + (what === 'the cache to fill' ? ': ' + (await cached()).join(' ') : ''));
    };
    const opened = async () => {
        await page.getByRole('tab', { name: 'Investments' }).waitFor({ timeout: 15000 });
        const overlay = await page.locator('#_err').evaluate(el => el.style.display !== 'none' ? el.textContent : '');
        assert.equal(overlay, '', 'crash overlay');
    };

    // 1. First open, with signal: the worker installs and caches the page, the app's scripts and the CDN scripts.
    await page.goto(SITE);
    await opened();
    await waitFor('the worker to control the page', () => page.evaluate(() => !!navigator.serviceWorker.controller));
    // Here the CDN scripts are the site's own files, which the worker caches as they load: one more open does that.
    await page.reload();
    await opened();
    const scripts = (fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8').match(/<script [^>]*src="[^"]+"/g) || []).length;
    await waitFor('the cache to fill', async () => (await cached()).length >= scripts + 1);
    const urls = await cached();
    assert.ok(urls.includes(SITE), 'page cached');
    assert.ok(urls.some(u => /\/app\.js\?v=\d+$/.test(u)), 'app.js cached');
    assert.ok(urls.some(u => u.includes('/npm/react@')), 'React cached');

    // 2. No signal: the app still opens, from the cache. (The site's connection drops. Playwright's setOffline is not used:
    //    in Chromium it fails the navigation before the worker sees it.)
    down = true;
    await page.reload();
    await opened();
    assert.match(await page.content(), /build-one/);
    down = false;

    // 3. A new build on the server shows on the next open with signal.
    marker = 'build-two';
    await page.reload();
    await opened();
    assert.match(await page.content(), /build-two/);

    // 4. The kill switch: no worker, no cache, and the app still opens from the network.
    await page.evaluate(() => swOff());
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    assert.deepEqual(crashes, []);
});
