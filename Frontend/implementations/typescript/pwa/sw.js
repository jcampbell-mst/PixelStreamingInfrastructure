/*
 * Service worker for the pixel streaming frontend.
 *
 * What it is for here is modest and deliberate: the app shell (pages, bundles, styles, icons)
 * is served from cache so the wall and the player open instantly and still render something
 * sensible when the signalling server is briefly unreachable. Everything that is live data -
 * the streamer list, the snapshot index, the snapshot previews themselves, and the WebRTC and
 * signalling sockets - is never cached, because a stale preview or a stale feed list would be
 * worse than no preview at all.
 *
 * The bundles are emitted with stable names (no content hashes), so __PS_VERSION__ is
 * substituted with the build time by copy-webpack-plugin. Every build therefore gets a fresh
 * cache name and the previous one is dropped on activate.
 */

const VERSION = '__PS_VERSION__';
const CACHE = `ps-shell-${VERSION}`;

// Precached by name, not by list: a missing entry (a page that was renamed, an icon that was
// not emitted) must not fail the install and leave the app with no worker at all.
const PRECACHE = [
    './',
    './grid.html',
    './player.html',
    './wall.html',
    './grid.js',
    './player.js',
    './wall.js',
    './css/grid.css',
    './css/player.css',
    './css/wall.css',
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

function isStaticAsset(url) {
    return /\.(?:js|css|png|jpg|jpeg|svg|ico|webmanifest|woff2?)$/i.test(url.pathname);
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

    if (!isStaticAsset(url)) {
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
