// Loads the app's own files into a sandbox so tests call the real functions, not copies of them.
// docs/index.html's main <script> defines its helpers as top-level functions; docs/balances.js exposes its pure parts
// on window.__balancesInternals. Browser APIs are stubbed just enough for the files to load: nothing renders.
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
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    const main = inline.reduce((a, b) => (b.length > a.length ? b : a));   // the app itself; the others are boot helpers
    vm.runInContext(fs.readFileSync(path.join(DOCS, 'balances.js'), 'utf8'), ctx, { filename: 'balances.js' });
    // The app's script is one try { } block, so its consts and async functions live in that block. A lookup added at the
    // top of the block reaches them for the tests.
    if (!/^\s*try\{/.test(main)) throw new Error('index.html main script no longer starts with try{; update tests/load.cjs');
    vm.runInContext(main.replace(/^\s*try\{/, 'try{ globalThis.__lookup = n => eval(n);'), ctx, { filename: 'index.html' });
    const app = new Proxy(ctx, { get: (t, name) => (name in t || typeof name !== 'string' ? t[name] : t.__lookup(name)) });
    return { app, estate: ctx.__balancesInternals };
}

module.exports = { loadApp };
