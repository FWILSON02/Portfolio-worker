// Loads the app's own files into a sandbox so tests call the real functions, not copies of them.
// docs/app.js defines its helpers as top-level functions; docs/balances.js, docs/lifeadmin.js and docs/pay.js
// expose their pure parts on window.__balancesInternals, window.__lifeAdminInternals and window.__payInternals. Browser APIs are stubbed just enough for the files to load: nothing renders.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DOCS = path.join(__dirname, '..', 'docs');

function memoryStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
             clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
// Any DOM node: every property is another stub, and calling one returns a stub.
function stubNode() {
    return new Proxy(function () {}, {
        get: (t, p) => (p === 'style' ? {} : p === Symbol.toPrimitive ? () => '' : stubNode()),
        apply: () => stubNode(),
    });
}

function loadApp() {
    const ctx = {
        console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Intl, Date, Math, JSON,
        crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Blob, Response, CompressionStream, DecompressionStream, Event: class { constructor(t) { this.type = t; } }, dispatchEvent() {},
        localStorage: memoryStorage(), sessionStorage: memoryStorage(),
        React: { createElement: () => null, useState: v => [v, () => {}], useMemo: f => f(), useCallback: f => f, useEffect() {},
                 useLayoutEffect() {}, useRef: v => ({ current: v }), useReducer: (r, i) => [i, () => {}], useContext: () => null,
                 createContext: () => ({ Provider: 'Provider' }), Component: class {}, Fragment: 'Fragment', memo: x => x, forwardRef: x => x },
        ReactDOM: { createRoot: () => ({ render() {} }) },
        navigator: { userAgent: 'node' }, location: { href: 'http://localhost/', search: '', hash: '' },
        document: { getElementById: () => stubNode(), createElement: () => stubNode(), querySelector: () => null, addEventListener() {},
                    head: stubNode(), body: stubNode(), documentElement: stubNode(), visibilityState: 'visible' },
        addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        fetch: async () => { throw new Error('tests make no network calls'); },
    };
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);

    const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
    // The app's scripts are in docs/; index.html only sets APP_BUILD (a global const, like in the browser).
    vm.runInContext(html.match(/<script>(const APP_BUILD = \d+;)<\/script>/)[1], ctx, { filename: 'index.html' });
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'balances.js'), 'utf8'), ctx, { filename: 'balances.js' });
    // In index.html's order: Cash Flow (lifeadmin.js) uses Pay (pay.js).
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'pay.js'), 'utf8'), ctx, { filename: 'pay.js' });
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'lifeadmin.js'), 'utf8'), ctx, { filename: 'lifeadmin.js' });
    // The app is performance.js, app.js, settings.js and markets.js, loaded in index.html's order. Their consts are global lexical
    // bindings, which are not properties of the context: a lookup defined first reaches them for the tests.
    vm.runInContext('globalThis.__lookup = n => eval(n);', ctx, { filename: 'load.cjs' });
    for (const f of ['performance.js', 'app.js', 'settings.js', 'markets.js']) {
        vm.runInContext(fs.readFileSync(path.join(DOCS, f), 'utf8'), ctx, { filename: f });
    }
    const app = new Proxy(ctx, { get: (t, name) => (name in t || typeof name !== 'string' ? t[name] : t.__lookup(name)) });
    return { app, estate: ctx.__balancesInternals, lifeAdmin: ctx.__lifeAdminInternals, pay: ctx.__payInternals, ctx };
}

module.exports = { loadApp };
