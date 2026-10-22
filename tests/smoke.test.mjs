// Render smoke test: loads the real app (docs/) in headless Chromium, restores made-up data through the app's own
// backup restore and CSV upload, then opens every tab, the Cash Flow pages and every Settings section. It fails on any
// uncaught error, any console error, the crash overlay, or an error card from a TabBoundary.
// Nothing touches the network: the app's site and the pinned CDN scripts are served from this checkout and
// node_modules (so the SRI hashes are checked too); every other request fails as if offline.
// Needs Playwright and the four CDN packages: see the Tests workflow. Without them it is skipped locally, and fails in
// CI (SMOKE_REQUIRED=1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { transactionsCsv, backupJson } from './fixtures/smoke-data.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const SITE = 'https://fwilson02.github.io/Portfolio-worker/';
let playwright = null;
try { playwright = require('playwright'); for (const p of ['react', 'react-dom', 'xlsx', 'papaparse']) require.resolve(p + '/package.json'); }
catch (e) { if (process.env.SMOKE_REQUIRED) throw e; playwright = null; }

// Network errors are expected (the test is offline); anything else in the console is a failure.
const EXPECTED = /Failed to load resource|net::ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|Load failed/i;

async function serve(page) {
    await page.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.origin + '/Portfolio-worker/' === SITE && u.pathname.startsWith('/Portfolio-worker/')) {
            const file = path.join(DOCS, decodeURIComponent(u.pathname.slice('/Portfolio-worker/'.length)) || 'index.html');
            if (file.startsWith(DOCS) && fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
            return route.fulfill({ status: 404, body: 'not found' });
        }
        const cdn = u.hostname === 'cdn.jsdelivr.net' && /^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.+)$/.exec(u.pathname);
        if (cdn) return route.fulfill({ path: path.join(path.dirname(require.resolve(cdn[1] + '/package.json')), cdn[2]),
                                        contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
        return route.abort('internetdisconnected');
    });
}

test('every screen renders with data, with no errors', { skip: !playwright && 'Playwright not installed', timeout: 180000 }, async t => {
    // SMOKE_CHROME_CHANNEL=chrome (the Tests workflow) uses the installed Google Chrome instead of Playwright's download.
    const browser = await playwright.chromium.launch(process.env.SMOKE_CHROME_CHANNEL ? { channel: process.env.SMOKE_CHROME_CHANNEL } : {});
    t.after(() => browser.close());
    // iPhone 17 size, touch, in a fresh profile (empty IndexedDB and localStorage).
    const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
                                           timezoneId: 'Europe/London', locale: 'en-GB',
                                           // The offline copy (docs/sw.js) would answer the app's requests before serve() sees them; tests/sw-browser.test.mjs covers it.
                                           serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('uncaught: ' + (e.stack || e.message)));
    page.on('console', m => { if (m.type() === 'error' && !EXPECTED.test(m.text())) errors.push('console.error: ' + m.text()); });
    await serve(page);

    const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'smoke-'));
    const today = new Date();
    fs.writeFileSync(path.join(dir, 'backup.json'), backupJson(today));
    fs.writeFileSync(path.join(dir, 'transactions.csv'), transactionsCsv(today));

    const settle = (ms = 800) => page.waitForTimeout(ms);
    // After each step: no errors so far, no crash overlay, no error card.
    // SMOKE_SHOTS=<folder> saves a screenshot after each step, to see what the test saw.
    let shot = 0;
    const check = async step => {
        if (process.env.SMOKE_SHOTS) await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, String(++shot).padStart(2, '0') + ' ' + step.replace(/[^\w &-]+/g, '') + '.png') });
        const overlay = await page.locator('#_err').evaluate(el => el.style.display !== 'none' ? el.textContent : '').catch(() => '');
        const cards = await page.locator('[data-tab-error]').evaluateAll(els => els.map(el => el.getAttribute('data-tab-error') + ': ' + el.textContent));
        const found = [...errors, ...(overlay ? ['crash overlay: ' + overlay] : []), ...cards.map(c => 'error card: ' + c)];
        assert.deepEqual(found, [], 'after "' + step + '"');
    };
    const openSettings = async () => { await page.getByRole('button', { name: 'Settings' }).click(); await settle(); };
    const closeSettings = async () => { await page.locator('.settings-sheet button:has(svg)').first().click(); await settle(); };
    const tab = async name => { await page.getByRole('tab', { name }).click(); await settle(1200); await check('open ' + name); };

    // The phone last had prices three hours ago and has failed since: the strip at the top of Investments says so.
    await page.addInitScript(k => { try { localStorage.setItem(k, JSON.stringify({ okAt: Date.now() - 3 * 36e5, failAt: Date.now() - 36e5, fresh: 5, requested: 5 })); } catch (e) {} }, 'feed_health_v1');
    await page.goto(SITE);
    await page.getByRole('tab', { name: 'Investments' }).waitFor();
    await settle(1500);
    await check('load with no data');
    assert.equal(await page.locator('[data-feed-banner]').count(), 1, 'the price-feed strip should show');

    // Restore the backup (Estate, Cash Flow, Pay and prices) the way a file restore is done on the phone.
    await openSettings();
    await page.getByRole('button', { name: /^Backup/ }).click();
    await page.locator('.settings-sheet input[type=file][accept^=".json"]').setInputFiles(path.join(dir, 'backup.json'));
    await page.getByRole('button', { name: /Confirm & Overwrite|^Restore$/ }).click();
    await settle(1500);
    await check('restore the backup');

    // Then the trades, from a CSV like the broker's.
    if (await page.locator('.settings-sheet').count()) await closeSettings();
    await page.locator('input[type=file][accept=".csv"]').first().setInputFiles(path.join(dir, 'transactions.csv'));
    await settle(2500);
    await check('upload the transactions CSV');
    assert.ok(await page.getByText('Upload a CSV to begin').count() === 0, 'the trades did not load');

    // Markets is not a tab: it opens full screen from Market Movers on Investments, and Back returns.
    assert.equal(await page.getByRole('tab', { name: 'Markets' }).count(), 0, 'Markets should no longer be a tab');
    await page.getByRole('button', { name: /^Market Movers/ }).click();
    await settle(1500); await check('Markets from Market Movers');
    assert.ok(await page.locator('[data-tab-screen="markets"]').count() === 1, 'Market Movers should open the Markets screen');
    await page.getByRole('button', { name: 'Back' }).first().click();
    await settle();
    assert.ok(await page.locator('[data-tab-screen="markets"]').count() === 0, 'Back should close the Markets screen');

    for (const name of ['Investments', 'Estate', 'Cash Flow']) await tab(name);

    // Cash Flow's own pages: Pay and the bills.
    for (const label of ['Pay', 'Bills']) {
        await page.getByRole('button', { name: new RegExp('^' + label + '\\b') }).first().click();
        await settle(1000); await check('Cash Flow page ' + label);
        // Pay values the year's share vests at today's price: the Acme share plan supplies it.
        if (label === 'Pay') assert.ok((await page.locator('body').innerText()).includes('today\u2019s price'), 'the vest should use the share plan\'s price');
        await page.getByRole('button', { name: /Back/ }).first().click();
        await settle();
    }

    // Investments: the account's holdings sheet.
    await tab('Investments');
    assert.ok((await page.locator('body').innerText()).includes('SPXT'), 'the chart should name its benchmark SPXT');
    await page.getByText('ISA', { exact: true }).first().click();
    await settle(1000); await check('holdings sheet');
    await page.getByRole('button', { name: 'Close' }).first().click();
    await settle();

    // Every Settings section, opened in turn.
    await openSettings();
    const sections = await page.locator('.settings-sheet button[aria-expanded]').count();
    assert.ok(sections >= 5, 'expected the Settings sections, found ' + sections);
    for (let i = 0; i < sections; i++) {
        const head = page.locator('.settings-sheet button[aria-expanded]').nth(i);
        const title = (await head.textContent()).trim();
        await head.click(); await settle(600); await check('Settings section ' + title);
    }
    await closeSettings();
    await check('close Settings');
});
