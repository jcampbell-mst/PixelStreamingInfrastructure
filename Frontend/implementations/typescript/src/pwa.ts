// Copyright Epic Games, Inc. All Rights Reserved.

/**
 * Registers the shell service worker, from every page that can be a landing page.
 *
 * The worker is what makes the app open instantly and still render something when the
 * signalling server is briefly away, but it is also the one thing on a page that can outlive a
 * deploy: an activated worker answers from its own cache, and before the bundles carried
 * content hashes that cache could hand a new page's markup a previous build's script. The two
 * halves of that are fixed elsewhere - hashed bundle names in webpack.base.js, and scripts and
 * styles served network-first in pwa/sw.js - and this is the last piece: a page that is already
 * open when a new build lands reloads itself once the new worker takes control, instead of
 * running the previous build until the next navigation.
 */
export function registerServiceWorker(): void {
    // A worker only exists in a secure context (https, or localhost), so on a plain-HTTP LAN
    // address this is simply skipped. No page may ever depend on it.
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
        return;
    }

    // Reloading on the very first install would only be a wasted round trip: nothing was
    // cached when this page loaded, so nothing here is stale.
    const hadController = navigator.serviceWorker.controller !== null;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) {
            // Once, not repeatedly: the reloaded page registers again, but the worker it
            // finds is the one already running, so there is no second controllerchange.
            window.location.reload();
        }
    });

    navigator.serviceWorker
        .register('./sw.js')
        // Ask now rather than leaving it to the browser's own update check, so a deploy shows
        // up on the next load instead of at some point inside the next day.
        .then((registration) => registration.update())
        .catch(() => {
            /* no cached shell: the page is unaffected */
        });
}
