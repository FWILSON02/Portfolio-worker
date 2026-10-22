// The error log (Settings → Diagnostics): index.html's first inline script keeps the last 50 errors and warnings in
// localStorage. Run that script in a sandbox and check what it keeps.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
const boot = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('APP_LOG_KEY'));

function sandbox() {
    const store = new Map(), printed = [];
    const ctx = {
        localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
        console: { error: (...a) => printed.push(a), warn: (...a) => printed.push(a), log() {} },
        setTimeout: () => 0, Event: class {}, dispatchEvent() {}, addEventListener() {},
        document: { getElementById: () => ({ style: {}, textContent: '' }) },
        React: {}, Date, JSON, Array, String, Error,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(boot, ctx);
    return { ctx, printed, log: () => ctx.appLogRead() };
}

test('the boot script with the error log is found', () => assert.ok(boot));

test('console.error and console.warn are logged and still printed', () => {
    const { ctx, printed, log } = sandbox();
    ctx.console.error('IDB save failed:', new Error('quota'));
    ctx.console.warn('Cloud backup failed:', 'HTTP 500');
    assert.equal(printed.length, 2);
    assert.deepEqual(log().map(e => [e.kind, e.msg]), [['error', 'IDB save failed: quota'], ['warn', 'Cloud backup failed: HTTP 500']]);
    assert.match(log()[0].detail, /quota/); // the stack
});

test('a repeat of the newest entry bumps its count instead of adding one', () => {
    const { ctx, log } = sandbox();
    ctx.appLog('price', 'Live prices failed');
    ctx.appLog('price', 'Live prices failed');
    ctx.appLog('price', 'Live prices failed');
    assert.equal(log().length, 1);
    assert.equal(log()[0].n, 3);
});

test('only the last 50 are kept', () => {
    const { ctx, log } = sandbox();
    for (let i = 0; i < 60; i++) ctx.appLog('error', 'e' + i);
    assert.equal(log().length, 50);
    assert.equal(log()[0].msg, 'e10');
    assert.equal(log()[49].msg, 'e59');
});

test('an AbortError (a cancelled share sheet) is not logged', () => {
    const { ctx, log } = sandbox();
    const e = new Error('cancelled'); e.name = 'AbortError';
    ctx.console.warn('Web Share failed, falling back:', e);
    assert.equal(log().length, 0);
});

test('uncaught errors and rejections are logged as crashes', () => {
    const { ctx, log } = sandbox();
    ctx.onerror('boom', 'https://x/app.js', 12, 3, new Error('boom'));
    assert.equal(log()[0].kind, 'crash');
    assert.equal(log()[0].msg, 'boom');
});

test('a broken store never throws', () => {
    const { ctx } = sandbox();
    ctx.localStorage.setItem = () => { throw new Error('full'); };
    assert.doesNotThrow(() => ctx.appLog('error', 'x'));
    ctx.localStorage.getItem = () => '{not json';
    assert.equal(ctx.appLogRead().length, 0);
});
