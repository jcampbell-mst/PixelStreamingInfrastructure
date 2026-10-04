/*
 * Service worker for the pixel streaming frontend.
 *
 * What it is for here is modest and deliberate: the app shell (the pages, the icons and the
 * manifest) is served from cache so the wall and the player open instantly and still render
 * something sensible when the signalling server is briefly unreachable. Everything that is live
 * data - the streamer list, the snapshot index, the snapshot previews themselves, and the WebRTC
 * and signalling sockets - is never cached, because a stale preview or a stale feed list would be
 * worse than no preview at all.
 *
 * What it must never do is serve a page out of two different builds. That failure looks exactly
 * like a broken feature: the navigation is fresh, so a new control is on screen, while the
 * script answering it is the previous build's and knows nothing about it. Two rules keep it
 * from happening. The bundles and styles carry content hashes (see webpack.base.js), so the
 * names a new page asks for cannot be satisfied by anything already in a cache. And scripts and
 * styles are answered from the network first regardless, with the cache only as the answer when
 * the server cannot be reached at all. Pictures, icons and the manifest keep the cache-first
 * treatment: they are not wired to the markup, and they are what has to appear instantly.
 *
 * Pages are network-first for the same reason. __PS_VERSION__ is substituted with the build
 * time by copy-webpack-plugin, so every build gets a fresh cache name and the previous one is
 * dropped on activate.
 */

const VERSION = '__PS_VERSION__';
const CACHE = `ps-shell-${VERSION}`;

// Precached by name, not by list: a missing entry (a page that was renamed, an icon that was
// not emitted) must not fail the install and leave the app with no worker at all. The bundles
// and their stylesheets are deliberately absent - their names change with their contents, so
// there is no name to precache, and caching them by hand is what used to let a stale script
// outlive a deploy. They are cached as they are used instead, from the network-first branch.
const PRECACHE = [
    './',
    './grid.html',
    './player.html',
    './wall.html',
    './manifest.webmanifest',
    './images/icon-192.png',
    './images/icon-512.png',
    './images/icon-maskable-512.png',
    './images/placeholder.svg'
];

// Live endpoints: the SFU's snapshot API and its index. Both are proxied by the signalling
// server at /snapshots, and neither may ever come from cache.
const LIVE_PREFIX = '/snapshots';

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => undefined))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

function isLiveRequest(url) {
    return url.pathname.startsWith(LIVE_PREFIX);
}

// A picture, an icon, a font or the manifest: nothing in the page's behaviour depends on which
// build it came from, so the cached copy is the answer and the network is the backup.
function isCacheFirstAsset(url) {
    return /\.(?:png|jpg|jpeg|svg|ico|webmanifest|woff2?)$/i.test(url.pathname);
}

// A script or a stylesheet: the opposite call. These are what the markup is wired to, so they
// are answered from the network unless there is no network.
function isScriptOrStyle(url) {
    return /\.(?:js|css)$/i.test(url.pathname);
}

// Network first, cache as the offline answer, and the copy that was just fetched put back. This
// is what a navigation wants and what a script or a stylesheet wants, for the same reason: the
// newest build is the only one that matches the page that is loading.
function freshFirst(request) {
    return fetch(request)
        .then((response) => {
            if (response && response.ok) {
                const copy = response.clone();
                caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
            }
            return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()));
}

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Let the browser handle anything this worker has no opinion about: non-GET, cross-origin
    // (the fonts CDN), range requests and the streaming media itself.
    if (request.method !== 'GET') {
        return;
    }
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || isLiveRequest(url) || request.headers.has('range')) {
        return;
    }

    // Pages: network first, so a rebuilt frontend is picked up on the next navigation, with the
    // cached copy as the answer when the server cannot be reached at all.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
                    return response;
                })
                .catch(() =>
                    caches.match(request, { ignoreSearch: true }).then((cached) => cached || caches.match('./grid.html'))
                )
        );
        return;
    }

    if (isScriptOrStyle(url)) {
        event.respondWith(freshFirst(request));
        return;
    }

    if (!isCacheFirstAsset(url)) {
        return;
    }

    // Static assets: cache first, revalidated in the background so the next load is current.
    event.respondWith(
        caches.match(request, { ignoreSearch: true }).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
