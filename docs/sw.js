// Service worker: lets the Home Screen app open with no signal, and makes it pick up a new build on the next open.
//   • The page (index.html): network first, past the browser's cache, so a merge shows on the next open. With no answer
//     in NETWORK_WAIT_MS (no signal, a dead spot) the last copy opens, and the network answer still lands for next time.
//   • The app's scripts and icons: cache first. Their address carries ?v=, so one address is one version; GitHub Pages
//     ignores ?v= and serves today's file, so fetching an old address from the network could mix builds. Each fresh
//     page fetches every script it names into the cache, which also covers a file whose ?v= someone forgot to bump.
//   • The pinned CDN scripts (React, xlsx, PapaParse; exact versions with SRI): cache first, they never change.
//   • Everything else (Yahoo, the Worker, the price APIs, the cloud backup) is not touched: it goes to the network as
//     before, and fails offline as before.
//   • Reload app (fetch with cache: 'reload') is not touched either, so it can say when the server can't be reached.
// Kill switch: SW_ENABLED = false in index.html makes the page unregister this and delete its cache; Settings →
// Diagnostics → Offline copy does the same on the phone. Shipping this file with KILL = true unregisters it everywhere.
const KILL = false;
const CACHE = 'portfolio-app-v1';
const NETWORK_WAIT_MS = 4000;
const CDN = 'https://cdn.jsdelivr.net/npm/';
const SCOPE = self.registration ? self.registration.scope : '';

// Install: fetch the page and everything it loads now, so the very first open after this arrives works offline next time.
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        if (KILL) return;
        try {
            const cache = await caches.open(CACHE), res = await clean(await fetch(SCOPE, { cache: 'no-cache', credentials: 'same-origin' }));
            if (res.ok) { await cache.put(SCOPE, res.clone()); await refreshScripts(cache, await res.text(), '', SCOPE); }
        } catch (e) {} // offline: the next open fills the cache
    })().then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        if (KILL) {
            await caches.delete(CACHE);
            await self.registration.unregister();
            return;
        }
        for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});

// The page's address with no query or hash: the Home Screen icon and Reload app open it with different ones.
const pageKey = url => url.split('#')[0].split('?')[0];
const isOwnFile = url => !!SCOPE && url.startsWith(SCOPE);
const scriptsIn = (html, pageUrl) => [...html.matchAll(/<script [^>]*src="([^"]+)"/g)].map(m => new URL(m[1], pageUrl).href);
const cdnIn = html => [...html.matchAll(/<script [^>]*src="(https:\/\/cdn\.jsdelivr\.net\/npm\/[^"]+)"/g)].map(m => m[1]);

// Safari refuses a page answer that followed a redirect (e.g. /Portfolio-worker to /Portfolio-worker/): copy it into a clean one.
async function clean(res) {
    if (!res.redirected) return res;
    return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// After a fresh page: fetch every script it names into the cache (overwriting, so a file whose ?v= wasn't bumped is
// still refreshed), then drop scripts that neither it nor the page before it names. The page before is kept because
// it may be the one still opening, from the cache. CDN scripts are fetched once, when missing.
async function refreshScripts(cache, html, oldHtml, pageUrl) {
    for (const url of cdnIn(html)) {
        try {
            if (await cache.match(url)) continue;
            const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
            if (res.ok) await cache.put(url, res);
        } catch (e) { return; }
    }
    const named = scriptsIn(html, pageUrl), want = named.filter(isOwnFile);
    for (const url of want) {
        try {
            const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
            if (res.ok) await cache.put(url, res);
        } catch (e) { return; } // offline again: keep what's there
    }
    const keep = new Set(named.concat(oldHtml ? scriptsIn(oldHtml, pageUrl) : []));
    for (const req of await cache.keys())
        if (isOwnFile(req.url) && /\.js(\?|$)/.test(req.url) && !keep.has(req.url)) await cache.delete(req);
}

async function page(event) {
    const cache = await caches.open(CACHE), key = pageKey(event.request.url);
    const cached = await cache.match(key);
    const fromNetwork = (async () => {
        const res = await clean(await fetch(key, { cache: 'no-cache', credentials: 'same-origin' }));
        if (res.ok) {
            const oldHtml = cached ? await cached.clone().text() : '';
            await cache.put(key, res.clone());
            event.waitUntil(res.clone().text().then(html => refreshScripts(cache, html, oldHtml, key)));
        }
        return res;
    })();
    event.waitUntil(fromNetwork.catch(() => {}));
    if (!cached) return fromNetwork;
    let timer;
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), NETWORK_WAIT_MS); });
    const res = await Promise.race([fromNetwork.catch(() => null), late]);
    clearTimeout(timer);
    return res && res.ok ? res : cached;
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request.url);
    if (cached) return cached;
    const res = await fetch(request);
    if (res.ok) await cache.put(request.url, res.clone());
    return res;
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (KILL || req.method !== 'GET' || req.cache === 'reload' || req.cache === 'no-store') return;
    if (req.mode === 'navigate' && isOwnFile(req.url)) event.respondWith(page(event));
    else if ((isOwnFile(req.url) && !req.url.endsWith('/sw.js')) || req.url.startsWith(CDN)) event.respondWith(cacheFirst(req));
});
