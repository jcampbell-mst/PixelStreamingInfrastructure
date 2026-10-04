// Stream grid: lists the streams the signalling server knows about, previews
// each one with its snapshot, and links through to the player.

const POLL_MS = 5000;
const RECONNECT_MS = 2000;
// The snapshot index reports how old each preview is, so previews are reloaded
// when a new frame has actually landed rather than on a timer. That keeps the
// grid correct for any `refreshSeconds` the SFU is configured with.
const INDEX_POLL_MS = 5000;
const INDEX_URL = './snapshots';
const DEFAULT_REFRESH_MS = 60000;
// Used only when the index cannot be read at all: re-request each preview now
// and then instead of never.
const FALLBACK_REFRESH_MS = 60000;
// After a preview fails to load, wait this long before asking for it again.
const RETRY_MS = 10000;
// The SFU keeps a permanent discovery connection on the streamer port, so it
// appears in streamerList as a streamer even though it is not watchable. This
// must match `autoHost.discoveryId` in SFU/config.js.
const DISCOVERY_STREAMER_ID = 'SFU-Discovery';
const PLACEHOLDER_URL = (document.getElementById('placeholder') as HTMLImageElement).src;
// How often the backdrop montage moves on to the next preview, how many layers
// are kept (so one can fade into the next), and a ceiling on retained frames.
const WASH_MS = 12000;
// How long a frame takes to become the next one, and how many discrete steps it
// gets. The fade runs inside the montage canvas and every step costs it a
// re-raster at viewport size, so a handful of coarse steps is far cheaper than a
// smooth fade and indistinguishable on an image this blurred.
const WASH_FADE_MS = 1200;
const WASH_FADE_STEPS = 10;
const WASH_MAX_FRAMES = 64;
// The montage is captured tiny and blown up, which is far cheaper to draw than
// blurring at full size. `WASH_FILTER` is applied once per capture, on the
// 128x72 canvas, rather than by the compositor on a full-viewport layer.
const WASH_W = 128;
const WASH_H = 72;
const WASH_FILTER = 'blur(2px) saturate(1.45) brightness(1.05)';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// The ambient backdrop is decorative, so it is dropped entirely when it turns
// out to cost more frames than the machine can spare. `?fx=off` forces it off
// and `?fx=on` keeps it on regardless; the topbar button cycles the same three
// states and remembers the choice.
const FX_MIN_FPS = 48;   // below this the whole backdrop is a liability
const FX_FULL_FPS = 58;  // below this the montage goes, but the orbs stay
const FX_WATCH_MS = 2000;
const FX_STORE_KEY = 'ps-grid-fx';
// Operator preferences that belong beside the backdrop choice: the pin set, the
// sort, and whether drop/return alerts should also leave the page.
const PIN_STORE_KEY = 'ps-grid-pins';
const SORT_STORE_KEY = 'ps-grid-sort';
const NOTIFY_STORE_KEY = 'ps-grid-alert-notify';
const SOUND_STORE_KEY = 'ps-grid-alert-sound';
// A feed has to have been up for a while before losing it is worth interrupting
// an operator for, and the same feed is not announced twice in a row inside the
// cooldown, so a feed that flaps reads as one event rather than a stream of them.
const ALERT_SETTLE_MS = 15000;
const ALERT_COOLDOWN_MS = 45000;
// Nothing is reported in the first seconds after load: the index is settling
// into its first reading then, and that reading is not a change from anything.
const ALERT_WARMUP_MS = 8000;
const TOAST_MS = 14000;
const TOAST_MAX = 4;
// How far outside the viewport a tile still counts as worth having loaded. The
// grid is a wall of stills, so the row below the fold is fetched before it is
// scrolled to rather than while it is being looked at.
const TILE_PRELOAD_MARGIN = '150px';

type FxPref = 'auto' | 'on' | 'nowash' | 'off';
// In the order the topbar button cycles them.
const FX_PREFS: FxPref[] = ['auto', 'on', 'nowash', 'off'];
const FX_LABELS: Record<FxPref, string> = {
    auto: 'Backdrop: Auto',
    on: 'Backdrop: On',
    nowash: 'Backdrop: No montage',
    off: 'Backdrop: Off',
};

function readFxPref(): FxPref {
    const fromUrl = new URLSearchParams(location.search).get('fx');
    if (fromUrl === 'on' || fromUrl === 'nowash' || fromUrl === 'off') {
        return fromUrl;
    }
    try {
        const stored = window.localStorage.getItem(FX_STORE_KEY);
        if (stored === 'on' || stored === 'nowash' || stored === 'off' || stored === 'auto') {
            return stored;
        }
    } catch {
        // Storage can be blocked; the default still works.
    }
    return 'auto';
}

function readStore(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        // Storage can be blocked; the default still works.
        return null;
    }
}

function writeStore(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // A blocked store only costs the memory of the choice.
    }
}

function readPins(): Set<string> {
    const raw = readStore(PIN_STORE_KEY);
    if (!raw) {
        return new Set();
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return new Set();
        }
        return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    } catch {
        return new Set();
    }
}

function readSortMode(stored: string | null): SortMode {
    return stored === 'live' || stored === 'viewers' ? stored : 'name';
}

// Software rendering means every layer of the backdrop is composited on the
// CPU, and the browser shares that work with whatever else it is showing — a
// video in another window, for instance. The backdrop is the first thing that
// should go when the graphics stack has no GPU to put it on.
function softwareRenderer(): boolean {
    try {
        const probe = document.createElement('canvas');
        const gl = probe.getContext('webgl');
        if (!gl) {
            return false;
        }
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return /swiftshader|llvmpipe|software|basic render|warp/i.test(name);
    } catch {
        // An exotic failure here is no reason to hide the backdrop.
        return false;
    }
}

interface SnapshotEntry {
    sfuId: string;
    state: string;
    hasImage: boolean;
    ageMs: number | null;
    /** Viewers watching the feed; absent or null when the SFU does not say. */
    players?: number | null;
    /** When the streamer started sending media; null when it is not streaming. */
    sinceMs?: number | null;
}

interface SnapshotIndex {
    refreshSeconds?: number;
    snapshots?: SnapshotEntry[];
}

/** Whether the feed itself is sending media, as far as the index can say. */
type Liveness = 'live' | 'idle' | 'unknown';

interface Tile {
    id: string;
    el: HTMLElement;
    link: HTMLAnchorElement;
    img: HTMLImageElement;
    badge: HTMLSpanElement;
    liveChip: HTMLSpanElement;
    liveText: HTMLSpanElement;
    viewersChip: HTMLSpanElement;
    viewersText: HTMLSpanElement;
    pin: HTMLButtonElement;
    copyLink: HTMLButtonElement;
    copyId: HTMLButtonElement;
    players: number | null;
    liveness: Liveness;
    /**
     * Age of the frame last requested, as reported by the index. Comparing it
     * with the newest age is how a new frame is recognised; null means the frame
     * on screen was fetched with no index reading to go by.
     */
    frameAgeMs: number | null;
    /** Newest age the index has reported, so a tile can catch up on scroll-in. */
    lastAgeMs: number | null;
    hasFrame: boolean;
    /**
     * What the index last said about this feed having a frame to fetch. False
     * means asking for the image anyway would only be a 404, which is the one
     * case a catch-up load is skipped; null means the index cannot say, so the
     * tile asks for itself.
     */
    indexHasImage: boolean | null;
    /** When the current preview was last requested, to fall back on. */
    requestedAt: number;
    /**
     * Set once the observer has reported this tile's position at least once.
     * Until then the tile counts as visible, so a not-yet-measured tile loads.
     */
    observed: boolean;
    onScreen: boolean;
    retryAt: number;
}

type SortMode = 'name' | 'live' | 'viewers';

/** What the grid remembers about one feed between tiles, for drop/return alerts. */
interface FeedAlert {
    /** When the feed was last seen streaming; 0 when it is not known to be. */
    liveSince: number;
    /** A drop has been announced and the feed has not been seen back yet. */
    downAnnounced: boolean;
    lastDropAt: number;
    lastReturnAt: number;
}

type AlertKind = 'down' | 'up';

const gridEl = document.getElementById('grid') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const noResultsEl = document.getElementById('noresults') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const subtitleEl = document.getElementById('subtitle') as HTMLElement;
const searchEl = document.getElementById('search') as HTMLInputElement;
const reloadEl = document.getElementById('reload') as HTMLButtonElement;
const washEl = document.getElementById('wash') as HTMLElement;
const fxEl = document.getElementById('fx') as HTMLButtonElement;
const sortEl = document.getElementById('sort') as HTMLSelectElement;
const notifyEl = document.getElementById('notify') as HTMLButtonElement;
const soundEl = document.getElementById('sound') as HTMLButtonElement;
const alertsEl = document.getElementById('alerts') as HTMLElement;

const tiles = new Map<string, Tile>();
// The pin set and the sort outlive the tiles, because a pinned feed that is
// restarted is still the feed the operator wants in front of them.
const pinned = readPins();
let sortMode: SortMode = readSortMode(readStore(SORT_STORE_KEY));
let notifyPref = readStore(NOTIFY_STORE_KEY) === 'on';
let soundPref = readStore(SOUND_STORE_KEY) === 'on';
// Drop/return bookkeeping is kept per feed rather than per tile: a feed that
// disconnects loses its tile, and its return still has to be a return.
const feedAlerts = new Map<string, FeedAlert>();
const alertsPrimedAt = Date.now() + ALERT_WARMUP_MS;
let refreshMs = DEFAULT_REFRESH_MS;
let indexAvailable = false;
let requestToken = 0;
let washStarted = false;
let washTimer = 0;
let washFadeTimer = 0;
// The montage is the only layer that has to blend a full viewport on every
// frame, so it can be given up on its own (see `dropWash`) without losing the
// orbs that carry most of the look.
let washDropped = false;

// Backdrop montage. Frames are re-encoded from previews that already loaded, so
// the backdrop is decorative and never issues a request of its own. They are
// held as canvases rather than data URLs so a cross-fade can redraw them
// synchronously, with no image decode in the middle of it.
const washFrames = new Map<string, HTMLCanvasElement>();
type WashFrame = { id: string; canvas: HTMLCanvasElement };
// The one and only montage layer, stretched over the viewport by grid.css. The
// cross-fade runs inside it: blending 128x72 pixels there is free, whereas
// animating the opacity of a second stacked layer makes the compositor upscale
// and blend two full viewports on every frame of the fade — the most expensive
// thing this page could ask of a machine that is already busy compositing
// another window's video. It also means no layer is ever promoted for a fade
// and un-promoted after it.
const washLayerEl = document.createElement('canvas');
washLayerEl.className = 'wash-frame';
washLayerEl.width = WASH_W;
washLayerEl.height = WASH_H;
washEl.appendChild(washLayerEl);
const washContext = washLayerEl.getContext('2d');
// The frame currently on screen; the next one fades in over the top of it.
let washShown: WashFrame | null = null;
let washCursor = 0;

let fxPref: FxPref = readFxPref();
// Whether the ambient backdrop is worth keeping on this machine.
let fxActive = fxAllowed(fxPref);

if (!fxActive) {
    document.documentElement.classList.add('calm');
}

// An explicit "no montage" starts without the montage but keeps the orbs.
washDropped = fxActive && fxPref === 'nowash';
if (washDropped) {
    document.documentElement.classList.add('nowash');
}

function fxAllowed(pref: FxPref): boolean {
    if (pref === 'off') {
        return false;
    }
    if (pref === 'auto') {
        return !softwareRenderer();
    }
    // 'on' and 'nowash' are explicit choices, and 'nowash' is a cheap one: the
    // montage is the layer that blends a full viewport, so dropping it is worth
    // honouring even where the whole backdrop would not be.
    return true;
}

function stopWash(): void {
    window.clearInterval(washTimer);
    window.clearTimeout(washFadeTimer);
    washTimer = 0;
    washFadeTimer = 0;
    washStarted = false;
    washShown = null;
    washContext?.clearRect(0, 0, WASH_W, WASH_H);
}

function disableBackdrop(): void {
    if (!fxActive) {
        return;
    }
    fxActive = false;
    washDropped = false;
    document.documentElement.classList.add('calm');
    document.documentElement.classList.remove('nowash');
    washFrames.clear();
    stopWash();
}

function dropWash(): void {
    if (washDropped) {
        return;
    }
    washDropped = true;
    washFrames.clear();
    stopWash();
    document.documentElement.classList.add('nowash');
}

function enableBackdrop(): void {
    // Already live, but the montage itself may still need to change: switching
    // between On and No montage must not be swallowed by the guard below.
    if (fxActive && washDropped === (fxPref === 'nowash')) {
        return;
    }
    fxActive = true;
    document.documentElement.classList.remove('calm');
    stopWash();
    washDropped = fxPref === 'nowash';
    document.documentElement.classList.toggle('nowash', washDropped);
    if (washDropped) {
        return;
    }
    collectWashFrames();
    startWash();
}

function setStatus(text: string): void {
    statusEl.textContent = text;
    statusEl.hidden = text.length === 0;
}

// Icons are inlined rather than fetched. Each one is drawn on every tile, so a
// symbol in the markup costs no request, and inheriting `currentColor` is what
// keeps an icon in step with the text beside it. Every string here is a constant,
// so nothing about a stream can reach the markup through them.
const ICONS = {
    clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.1v5.2l3.5 2.1"/></svg>',
    viewers: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.4 12S6.1 5.9 12 5.9 21.6 12 21.6 12 17.9 18.1 12 18.1 2.4 12 2.4 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>',
    link: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.2 13.8a3.7 3.7 0 0 0 5.3 0l2.9-2.9a3.7 3.7 0 0 0-5.2-5.2l-1.5 1.4"/><path d="M13.8 10.2a3.7 3.7 0 0 0-5.3 0l-2.9 2.9a3.7 3.7 0 0 0 5.2 5.2l1.5-1.4"/></svg>',
    id: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.7 4 8.2 20"/><path d="M15.8 4l-1.5 16"/><path d="M4.7 9.4h15"/><path d="M4.1 14.6h15"/></svg>',
    pin: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8.4 3.4h7.2v4.2H8.4z"/><path d="M12 7.6v5"/><path d="M6.8 12.6h10.4"/><path d="M12 12.6V21"/></svg>'
};

// The badge is the tile's tally, and the only thing this page knows about a
// stream is that the signalling server still lists it. Preview health
// deliberately does not reach the badge: a snapshot that failed to capture says
// nothing about whether the stream is up, so a stream that is listed reads as
// live however its preview is doing, and a preview that never arrives is shown by
// the placeholder in the frame and nothing else. `unknown` is for when the
// streamer list itself has gone away.
// The link is the tile's only accessible name, and a name given to a link replaces
// everything inside it, so what the badge and the chips say has to be said here as
// well or it never reaches a screen reader.
function linkLabel(id: string, state: 'live' | 'unknown'): string {
    return state === 'live'
        ? `Live stream ${id}: open it in the player`
        : `Stream ${id}, signalling state unknown: open it in the player`;
}

function setState(tile: Tile, state: 'live' | 'unknown'): void {
    tile.el.dataset['state'] = state;
    tile.badge.textContent = state === 'live' ? 'Live' : 'Unknown';
    tile.link.setAttribute('aria-label', linkLabel(tile.id, state));
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function playerPath(id: string): string {
    return `./player.html?StreamerId=${encodeURIComponent(id)}`;
}

// The link an operator would paste into another browser or a second screen, so
// the copy affordance hands out an absolute URL rather than the page's own
// relative one.
function playerLink(id: string): string {
    return new URL(playerPath(id), location.href).href;
}

// `navigator.clipboard` needs a secure context, and a signalling server is
// routinely reached over plain http on a LAN, so the deprecated path is kept as
// the fallback rather than the feature simply not working there.
async function copyText(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Fall through to the textarea, which a permission prompt cannot block.
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off screen but still selectable: `display: none` would not be.
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch {
        copied = false;
    }
    area.remove();
    return copied;
}

// A tile action is an icon plus a label, so anything that changes the button's
// wording has to write to the label: writing to the button would take the icon
// with it.
function setActionLabel(button: HTMLButtonElement, text: string): void {
    let label = button.querySelector<HTMLSpanElement>('.action-label');
    if (!label) {
        label = document.createElement('span');
        label.className = 'action-label';
        button.appendChild(label);
    }
    label.textContent = text;
}

function flashCopied(button: HTMLButtonElement, label: string, copied: boolean): void {
    setActionLabel(button, copied ? 'Copied' : 'Copy failed');
    button.dataset['done'] = copied ? 'yes' : 'no';
    window.setTimeout(() => {
        setActionLabel(button, label);
        delete button.dataset['done'];
    }, 1400);
}

function copyFrom(tile: Tile, button: HTMLButtonElement, label: string, text: string): void {
    void copyText(text).then((copied) => flashCopied(button, label, copied));
}

function togglePin(tile: Tile): void {
    if (pinned.has(tile.id)) {
        pinned.delete(tile.id);
    } else {
        pinned.add(tile.id);
    }
    writeStore(PIN_STORE_KEY, JSON.stringify(Array.from(pinned)));
    updatePin(tile);
    applySort();
}

function updatePin(tile: Tile): void {
    const isPinned = pinned.has(tile.id);
    tile.el.dataset['pinned'] = String(isPinned);
    setActionLabel(tile.pin, isPinned ? 'Unpin' : 'Pin');
    tile.pin.setAttribute('aria-pressed', String(isPinned));
}

function liveRank(tile: Tile): number {
    return tile.liveness === 'live' ? 0 : tile.liveness === 'idle' ? 1 : 2;
}

function compareTiles(a: Tile, b: Tile): number {
    // The pin leads every sort: it is the operator saying they want this feed in
    // front of them whatever else the order is doing.
    const pin = Number(pinned.has(b.id)) - Number(pinned.has(a.id));
    if (pin !== 0) {
        return pin;
    }
    if (sortMode === 'live') {
        const rank = liveRank(a) - liveRank(b);
        if (rank !== 0) {
            return rank;
        }
    } else if (sortMode === 'viewers') {
        const viewers = (b.players ?? -1) - (a.players ?? -1);
        if (viewers !== 0) {
            return viewers;
        }
    }
    return a.id.localeCompare(b.id);
}

// Reorders the tiles in place. The order is recomputed on every index reading,
// so it only touches the DOM when it actually differs.
function applySort(): void {
    const order = Array.from(tiles.values()).sort(compareTiles);
    const current = Array.from(gridEl.children);
    if (order.length === current.length && order.every((tile, index) => tile.el === current[index])) {
        return;
    }
    for (const tile of order) {
        gridEl.appendChild(tile.el);
    }
}

function feedAlert(id: string): FeedAlert {
    let state = feedAlerts.get(id);
    if (!state) {
        state = { liveSince: 0, downAnnounced: false, lastDropAt: 0, lastReturnAt: 0 };
        feedAlerts.set(id, state);
    }
    return state;
}

function raiseAlert(id: string, kind: AlertKind): void {
    showToast(id, kind);
    if (notifyPref) {
        notifyDesktop(id, kind);
    }
    if (soundPref) {
        playTone(kind);
    }
}

function showToast(id: string, kind: AlertKind): void {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.dataset['kind'] = kind;
    const text = document.createElement('span');
    text.className = 'toast-text';
    const head = document.createElement('span');
    head.className = 'toast-head';
    head.textContent = kind === 'down' ? 'Feed dropped' : 'Feed back';
    const body = document.createElement('span');
    body.className = 'toast-body';
    body.textContent = kind === 'down' ? `${id} stopped streaming` : `${id} is streaming again`;
    text.append(head, body);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss this alert');
    close.addEventListener('click', () => toast.remove());
    toast.append(text, close);
    alertsEl.appendChild(toast);
    while (alertsEl.children.length > TOAST_MAX) {
        alertsEl.firstElementChild?.remove();
    }
    window.setTimeout(() => toast.remove(), TOAST_MS);
}

function notifySupported(): boolean {
    return typeof Notification !== 'undefined' && window.isSecureContext !== false;
}

function notifyDesktop(id: string, kind: AlertKind): void {
    if (!notifySupported() || Notification.permission !== 'granted') {
        return;
    }
    try {
        new Notification(kind === 'down' ? `${id} dropped` : `${id} is back`, {
            body: kind === 'down' ? `${id} stopped streaming` : `${id} is streaming again`,
            // One notification per feed per state, so a feed that flaps replaces
            // its own entry instead of stacking up new ones.
            tag: `ps-grid-${kind}-${id}`,
        });
    } catch {
        // A notification that will not construct is not worth failing over.
    }
}

let audioContext: AudioContext | null = null;

function playTone(kind: AlertKind): void {
    try {
        audioContext = audioContext ?? new AudioContext();
        // Audio starts suspended until a gesture unlocks it, and the toggle is
        // that gesture; the tone is short either way.
        void audioContext.resume();
        const now = audioContext.currentTime;
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(kind === 'down' ? 440 : 660, now);
        osc.frequency.linearRampToValueAtTime(kind === 'down' ? 300 : 880, now + 0.16);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        osc.connect(gain);
        gain.connect(audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.3);
    } catch {
        // No audio device, or no WebAudio: the banner still says what happened.
    }
}

// The feed has gone. Only a feed this page watched settle was worth a word, and
// only the first drop is announced; the return consumes the pair again.
function feedDropped(id: string): void {
    const state = feedAlert(id);
    const now = Date.now();
    const settled = state.liveSince > 0 && now - state.liveSince >= ALERT_SETTLE_MS;
    state.liveSince = 0;
    if (state.downAnnounced || !settled || now < alertsPrimedAt || now - state.lastDropAt < ALERT_COOLDOWN_MS) {
        return;
    }
    state.lastDropAt = now;
    state.downAnnounced = true;
    raiseAlert(id, 'down');
}

function feedCameBack(id: string): void {
    const state = feedAlert(id);
    const now = Date.now();
    const announced = state.downAnnounced;
    state.downAnnounced = false;
    state.liveSince = now;
    if (announced && now - state.lastReturnAt >= ALERT_COOLDOWN_MS) {
        state.lastReturnAt = now;
        raiseAlert(id, 'up');
    }
}

// Liveness comes from the feed's own `sinceMs` when the index reports it, and
// only when it reports it: an older index with no such field leaves the feed
// unknown rather than guessed at, which is also why it raises no alerts.
function livenessOf(entry: SnapshotEntry | undefined): Liveness {
    if (!entry) {
        return 'idle';
    }
    if (typeof entry.sinceMs === 'number') {
        return 'live';
    }
    return entry.sinceMs === null ? 'idle' : 'unknown';
}

function setLiveness(tile: Tile, next: Liveness): void {
    const previous = tile.liveness;
    if (previous === next) {
        return;
    }
    tile.liveness = next;
    if (next === 'live') {
        feedCameBack(tile.id);
    } else if (previous === 'live') {
        feedDropped(tile.id);
    }
}

function updateFacts(tile: Tile, entry: SnapshotEntry | undefined, now: number): void {
    const since = entry && typeof entry.sinceMs === 'number' ? entry.sinceMs : null;
    // A start time in the future means the two clocks disagree; a duration built
    // from it would be nonsense, so the readout stays empty instead.
    if (since === null || since > now) {
        tile.liveChip.hidden = true;
    } else {
        const duration = formatDuration(now - since);
        tile.liveText.textContent = duration;
        // The chip reads as a bare duration beside the badge, so what it is a
        // duration of is said here rather than repeated in the visible text.
        tile.liveChip.setAttribute('aria-label', `Live for ${duration}`);
        tile.liveChip.hidden = false;
    }
    const players = entry && typeof entry.players === 'number' ? entry.players : null;
    tile.players = players;
    if (players === null) {
        tile.viewersChip.hidden = true;
    } else {
        tile.viewersText.textContent = String(players);
        tile.viewersChip.setAttribute('aria-label', `${players} watching`);
        tile.viewersChip.hidden = false;
    }
}

function previewUrl(id: string): string {
    return `${INDEX_URL}/${encodeURIComponent(id)}.jpg?t=${++requestToken}`;
}

function loadPreview(tile: Tile, ageMs: number | null = null): void {
    tile.requestedAt = Date.now();
    tile.frameAgeMs = ageMs;
    tile.img.src = previewUrl(tile.id);
}

// A tile is only worth a request while it is somewhere an operator can see it.
// Until the observer has reported a position the tile counts as loadable, so the
// first paint never waits on it.
function loadAllowed(tile: Tile): boolean {
    return !tile.observed || tile.onScreen;
}

// Called as a tile comes back into view: whatever frame landed while it was off
// screen was never fetched, so it is fetched now rather than at the next poll.
function catchUp(tile: Tile): void {
    if (Date.now() < tile.retryAt) {
        return;
    }
    if (!tile.hasFrame) {
        if (tile.indexHasImage !== false) {
            loadPreview(tile, tile.lastAgeMs);
        }
        return;
    }
    if (tile.lastAgeMs !== null && (tile.frameAgeMs === null || tile.lastAgeMs < tile.frameAgeMs)) {
        loadPreview(tile, tile.lastAgeMs);
    }
}

const tileObserver = new IntersectionObserver(
    (records) => {
        for (const record of records) {
            const id = (record.target as HTMLElement).dataset['id'] ?? '';
            const tile = tiles.get(id);
            if (!tile) {
                continue;
            }
            const wasOnScreen = tile.onScreen;
            tile.observed = true;
            tile.onScreen = record.isIntersecting;
            if (tile.onScreen && !wasOnScreen) {
                catchUp(tile);
            }
        }
    },
    { rootMargin: TILE_PRELOAD_MARGIN }
);

// Redraws a loaded preview into a small backdrop frame. The capture is tiny on
// purpose: the browser's own upscaling is what makes the wash look soft, and the
// softening the eye notices is baked in here instead of being applied to a
// full-viewport layer by the compositor on every frame.
function captureWashFrame(id: string, img: HTMLImageElement): void {
    if (!fxActive || washDropped || img.naturalWidth === 0 || img.naturalHeight === 0) {
        return;
    }
    // A fresh canvas per capture, so that a frame in the middle of fading out
    // keeps the pixels it was drawn with even when the stream it came from is
    // the next one to fade in.
    const canvas = document.createElement('canvas');
    canvas.width = WASH_W;
    canvas.height = WASH_H;
    const context = canvas.getContext('2d');
    if (!context) {
        return;
    }
    const scale = Math.max(WASH_W / img.naturalWidth, WASH_H / img.naturalHeight);
    const width = img.naturalWidth * scale;
    const height = img.naturalHeight * scale;
    try {
        context.filter = WASH_FILTER;
        context.drawImage(img, (WASH_W - width) / 2, (WASH_H - height) / 2, width, height);
        context.filter = 'none';
    } catch {
        // A preview the browser will not let us read leaves nothing to show.
        return;
    }
    // Re-insert so the map stays in capture order, which is the order the
    // montage cycles through.
    washFrames.delete(id);
    washFrames.set(id, canvas);
    while (washFrames.size > WASH_MAX_FRAMES) {
        const oldest = washFrames.keys().next();
        if (oldest.done) {
            break;
        }
        // Never evict the frame that is on screen: it is still being faded from.
        if (washFrames.get(oldest.value) === washShown?.canvas) {
            break;
        }
        washFrames.delete(oldest.value);
    }
}

// Re-encodes whatever previews are already on screen, so the montage can come
// back after it was dropped without waiting for the next frame.
function collectWashFrames(): void {
    for (const [id, tile] of tiles) {
        if (tile.hasFrame && tile.img.complete && tile.img.naturalWidth > 0) {
            captureWashFrame(id, tile.img);
        }
    }
}

function startWash(): void {
    if (washStarted || washDropped || washFrames.size === 0) {
        return;
    }
    washStarted = true;
    showWashFrame();
    // Nothing but the first frame when the viewer has asked for less motion.
    if (!reduceMotion.matches) {
        washTimer = window.setInterval(showWashFrame, WASH_MS);
    }
}

// Composites one montage frame over whatever is already in the layer. Frames
// only ever come from same-origin previews, so the taint check that re-encoding
// to a data URL used to give us is replaced by dropping the frame outright if
// the browser refuses to draw it.
function drawWashFrame(frame: WashFrame, alpha: number): void {
    if (!washContext) {
        return;
    }
    washContext.globalAlpha = alpha;
    try {
        washContext.drawImage(frame.canvas, 0, 0);
    } catch {
        washFrames.delete(frame.id);
        if (washShown?.canvas === frame.canvas) {
            washShown = null;
        }
    } finally {
        washContext.globalAlpha = 1;
    }
}

function showWashFrame(): void {
    // Nothing to draw for a background tab, and no point burning a frame on it.
    if (document.hidden || washDropped || !washContext) {
        return;
    }
    const entries: WashFrame[] = Array.from(washFrames, ([id, canvas]) => ({ id, canvas }));
    if (entries.length === 0) {
        return;
    }
    const incoming = entries[washCursor % entries.length];
    washCursor++;
    const outgoing = washShown;
    washShown = incoming;
    // Nothing to fade from, nothing new to fade to, or a viewer who asked for
    // less motion: put the frame up and be done.
    if (!outgoing || outgoing.canvas === incoming.canvas || reduceMotion.matches) {
        washContext.globalAlpha = 1;
        washContext.drawImage(incoming.canvas, 0, 0);
        return;
    }
    window.clearTimeout(washFadeTimer);
    const started = performance.now();
    const step = (): void => {
        washFadeTimer = 0;
        if (washDropped || !fxActive) {
            return;
        }
        const progress = Math.min(1, (performance.now() - started) / WASH_FADE_MS);
        drawWashFrame(outgoing, 1);
        drawWashFrame(incoming, progress);
        if (progress < 1) {
            washFadeTimer = window.setTimeout(step, WASH_FADE_MS / WASH_FADE_STEPS);
        }
    };
    step();
}

// Samples the frame rate for a short window and gives up on the backdrop if the
// result says it is being paid for with dropped frames. Runs a couple of times
// after load — the first seconds are busy for other reasons — and never turns
// the backdrop back on, so it cannot oscillate.
function watchFrameRate(settled: boolean): void {
    if (!fxActive || fxPref === 'on' || document.hidden) {
        return;
    }
    let frames = 0;
    const started = performance.now();
    const sample = (): void => {
        if (!fxActive) {
            return;
        }
        frames++;
        const elapsed = performance.now() - started;
        if (elapsed < FX_WATCH_MS) {
            window.requestAnimationFrame(sample);
            return;
        }
        const fps = frames / (elapsed / 1000);
        if (fps < FX_MIN_FPS) {
            disableBackdrop();
            return;
        }
        // Once the page has settled, a merely imperfect rate is worth acting on:
        // the montage is the expensive half and the orbs are the half that shows.
        if (settled && fps < FX_FULL_FPS) {
            dropWash();
        }
    };
    window.requestAnimationFrame(sample);
}

function tileAction(label: string, title: string, icon: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action';
    button.title = title;
    // The accessible name is the label rather than the icon: an icon on its own
    // is an image, not a name.
    button.setAttribute('aria-label', label);
    const text = document.createElement('span');
    text.className = 'action-label';
    text.textContent = label;
    button.insertAdjacentHTML('afterbegin', icon);
    button.appendChild(text);
    return button;
}

// The feed's own figures, as chips pinned to the corners of the preview. Both are
// built the same way - icon, then the value as text - so the number is never the
// only cue for what it counts.
function tileChip(className: string, icon: string, title: string): { chip: HTMLSpanElement; text: HTMLSpanElement } {
    const chip = document.createElement('span');
    chip.className = className;
    chip.title = title;
    chip.hidden = true;
    const text = document.createElement('span');
    text.className = 'chip-text';
    chip.insertAdjacentHTML('afterbegin', icon);
    chip.appendChild(text);
    return { chip, text };
}

function addTile(id: string): void {
    // The tile is a container rather than a link now that it carries buttons:
    // interactive content nested inside an anchor is invalid, and a stray click
    // would navigate instead of acting.
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset['id'] = id;
    // A tile only exists because the streamer list named the stream, so it
    // starts out as live; only its preview has anything to wait for.
    el.dataset['state'] = 'live';
    el.dataset['frame'] = 'awaiting';

    const link = document.createElement('a');
    link.className = 'tile-link';
    link.href = playerPath(id);
    link.setAttribute('aria-label', linkLabel(id, 'live'));

    const thumb = document.createElement('div');
    thumb.className = 'thumb';

    const awaiting = document.createElement('img');
    awaiting.className = 'awaiting';
    awaiting.src = PLACEHOLDER_URL;
    awaiting.alt = '';
    awaiting.setAttribute('aria-hidden', 'true');

    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton';
    skeleton.setAttribute('aria-hidden', 'true');

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Live';

    const play = document.createElement('span');
    play.className = 'play';
    play.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'preview';
    img.alt = `Preview of ${id}`;
    img.decoding = 'async';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = id;
    meta.append(name);

    const time = tileChip('chip chip-time', ICONS.clock, 'How long this feed has been sending');
    const viewers = tileChip('chip chip-viewers', ICONS.viewers, 'Viewers watching this feed now');

    // The chips come after the play wash so that the wash dims the picture and not
    // the readouts - they are the one part of the frame an operator is reading.
    thumb.append(awaiting, skeleton, img, play, badge, time.chip, viewers.chip);
    link.append(thumb, meta);

    const foot = document.createElement('div');
    foot.className = 'foot';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const copyLink = tileAction('Copy link', `Copy a player link for ${id}`, ICONS.link);
    const copyId = tileAction('Copy ID', `Copy the stream id ${id}`, ICONS.id);
    const pin = tileAction('Pin', `Keep ${id} at the front of the grid`, ICONS.pin);
    actions.append(copyLink, copyId, pin);
    foot.append(actions);

    el.append(link, foot);
    gridEl.appendChild(el);

    const tile: Tile = {
        id,
        el,
        link,
        img,
        badge,
        liveChip: time.chip,
        liveText: time.text,
        viewersChip: viewers.chip,
        viewersText: viewers.text,
        pin,
        copyLink,
        copyId,
        players: null,
        liveness: 'unknown',
        frameAgeMs: null,
        lastAgeMs: null,
        hasFrame: false,
        indexHasImage: null,
        requestedAt: 0,
        retryAt: 0,
        observed: false,
        // Assumed on screen until the observer says otherwise, so that the first
        // reading of a tile that is already visible is not treated as a tile
        // arriving in view: the index load covers this case instead.
        onScreen: true
    };
    tiles.set(id, tile);

    copyLink.addEventListener('click', () => {
        copyFrom(tile, copyLink, 'Copy link', playerLink(id));
    });
    copyId.addEventListener('click', () => {
        copyFrom(tile, copyId, 'Copy ID', id);
    });
    pin.addEventListener('click', () => togglePin(tile));
    updatePin(tile);

    img.addEventListener('load', () => {
        tile.hasFrame = true;
        el.dataset['frame'] = 'loaded';
        if (!fxActive) {
            return;
        }
        captureWashFrame(id, img);
        startWash();
    });
    img.addEventListener('error', () => {
        // A preview can fail simply because the first frame has not been written
        // yet, or because the file was caught mid-write. Keep whatever frame is
        // already on screen and try again shortly.
        tile.retryAt = Date.now() + RETRY_MS;
        el.dataset['frame'] = tile.hasFrame ? 'loaded' : 'awaiting';
    });

    tileObserver.observe(el);
}

// Reloads a tile only when the index says its frame got newer, so a preview is
// fetched once per frame however long the refresh interval is.
function applyIndex(index: SnapshotIndex): void {
    if (typeof index.refreshSeconds === 'number' && index.refreshSeconds > 0) {
        refreshMs = index.refreshSeconds * 1000;
    }

    const entries = new Map<string, SnapshotEntry>();
    for (const entry of index.snapshots ?? []) {
        entries.set(entry.sfuId, entry);
    }

    indexAvailable = true;
    const now = Date.now();

    for (const tile of tiles.values()) {
        const entry = entries.get(tile.id);
        setLiveness(tile, livenessOf(entry));
        updateFacts(tile, entry, now);
        tile.indexHasImage = entry && typeof entry.hasImage === 'boolean' ? entry.hasImage : null;

        if (!entry || !entry.hasImage) {
            // The index says there is no frame to go and get, so the tile keeps
            // whatever it already has and waits for the next pass.
            continue;
        }

        const ageMs = typeof entry.ageMs === 'number' ? entry.ageMs : null;
        let wantsLoad = !tile.hasFrame;
        if (ageMs === null) {
            // An older snapshot API does not report the age, so fall back to
            // re-requesting on our own clock.
            wantsLoad = wantsLoad || now - tile.requestedAt >= refreshMs;
        } else {
            // A frame the tile has not fetched is one whose age is smaller than
            // the age of the frame it did fetch: ages only ever grow between
            // frames, so this compares identity without trusting either clock.
            wantsLoad = wantsLoad || tile.frameAgeMs === null || ageMs < tile.frameAgeMs;
        }
        tile.lastAgeMs = ageMs;

        if (wantsLoad && loadAllowed(tile) && now >= tile.retryAt) {
            loadPreview(tile, ageMs);
        }
    }

    applySort();
    updateSubtitle();
}

function refreshIndex(): void {
    fetch(INDEX_URL, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((index: SnapshotIndex) => applyIndex(index))
        .catch(() => {
            indexAvailable = false;
            // No index to go by (snapshots disabled, or an older SFU): ask for
            // the previews directly, occasionally.
            for (const tile of tiles.values()) {
                tile.indexHasImage = null;
                const due = Date.now() - tile.requestedAt >= FALLBACK_REFRESH_MS;
                if (due && loadAllowed(tile) && Date.now() >= tile.retryAt) {
                    loadPreview(tile);
                }
            }
            updateSubtitle();
        });
}

function updateSubtitle(): void {
    const count = tiles.size;
    const period = Math.max(1, Math.round(refreshMs / 1000));
    if (count === 0) {
        subtitleEl.textContent = indexAvailable ? 'Nothing is streaming right now' : 'Connected';
        return;
    }
    subtitleEl.textContent = `${count} stream${count === 1 ? '' : 's'} · previews refresh every ${period}s`;
}

function applyFilter(): void {
    const query = searchEl.value.trim().toLowerCase();
    let visible = 0;
    for (const tile of tiles.values()) {
        const match = query.length === 0 || tile.id.toLowerCase().includes(query);
        tile.el.hidden = !match;
        if (match) {
            visible++;
        }
    }
    noResultsEl.hidden = !(tiles.size > 0 && visible === 0);
}

function render(ids: string[]): void {
    const wanted = new Set(ids);
    for (const [id, tile] of tiles) {
        if (!wanted.has(id)) {
            // A streamer that is no longer listed is the strongest signal there
            // is that its feed went away, and its state has to outlive the tile.
            if (tile.liveness === 'live') {
                feedDropped(id);
            }
            tileObserver.unobserve(tile.el);
            tile.el.remove();
            tiles.delete(id);
            washFrames.delete(id);
        } else {
            // The signalling server has just named this stream again, which is
            // the tally's whole basis. This is also how a tile recovers from the
            // "Unknown" badge it was left with when the connection dropped.
            setState(tile, 'live');
        }
    }
    for (const id of ids) {
        if (!tiles.has(id)) {
            addTile(id);
        }
    }
    emptyEl.hidden = tiles.size > 0;
    applyFilter();
    applySort();
    updateSubtitle();
}

function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    let pollTimer: number | undefined;
    let indexTimer: number | undefined;

    ws.onopen = () => {
        setStatus('');
        subtitleEl.textContent = 'Connected';
        // Players are never sent `identify`; ask immediately.
        const poll = () => ws.send(JSON.stringify({ type: 'listStreamers' }));
        poll();
        pollTimer = window.setInterval(poll, POLL_MS);
        refreshIndex();
        indexTimer = window.setInterval(refreshIndex, INDEX_POLL_MS);
    };
    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data as string);
            if (msg.type === 'streamerList' && Array.isArray(msg.ids)) {
                render(
                    (msg.ids as string[])
                        .filter((id) => id !== DISCOVERY_STREAMER_ID)
                        .sort()
                );
            }
        } catch {
            /* ignore non-JSON */
        }
    };
    ws.onclose = () => {
        window.clearInterval(pollTimer);
        window.clearInterval(indexTimer);
        // The list on screen cannot be refreshed any more, so no tile can still
        // claim to be live.
        for (const tile of tiles.values()) {
            setState(tile, 'unknown');
        }
        setStatus('Disconnected — retrying');
        subtitleEl.textContent = 'Waiting for the signalling server…';
        window.setTimeout(connect, RECONNECT_MS);
    };
}

searchEl.addEventListener('input', applyFilter);
reloadEl.addEventListener('click', () => {
    for (const tile of tiles.values()) {
        // Only what is on screen: the point of the reload is what can be seen.
        if (!loadAllowed(tile)) {
            continue;
        }
        tile.retryAt = 0;
        loadPreview(tile, tile.lastAgeMs);
    }
});
sortEl.addEventListener('change', () => {
    sortMode = readSortMode(sortEl.value);
    writeStore(SORT_STORE_KEY, sortMode);
    applySort();
});

// Backdrop control, so a machine that struggles can give up the animation
// without editing the URL, and have that choice remembered.
function updateFxButton(): void {
    fxEl.dataset['mode'] = fxPref;
    fxEl.textContent = FX_LABELS[fxPref];
}

fxEl.addEventListener('click', () => {
    const next = (FX_PREFS.indexOf(fxPref) + 1) % FX_PREFS.length;
    fxPref = FX_PREFS[next];
    try {
        window.localStorage.setItem(FX_STORE_KEY, fxPref);
    } catch {
        // A blocked store only costs the memory of the choice.
    }
    updateFxButton();
    if (fxAllowed(fxPref)) {
        enableBackdrop();
    } else {
        disableBackdrop();
    }
});
updateFxButton();

// Alert controls. Both are toggles so that the browser permission prompt is
// always the result of a click, which is the only kind of gesture that may ask.
function updateAlertButtons(): void {
    notifyEl.dataset['mode'] = notifyPref ? 'on' : 'off';
    notifyEl.textContent = !notifySupported()
        ? 'Alerts unavailable'
        : notifyPref
            ? 'Alerts on'
            : 'Alerts off';
    notifyEl.setAttribute('aria-pressed', String(notifyPref));
    notifyEl.title = notifySupported()
        ? 'Browser notifications when a feed drops or comes back'
        : 'This page is not on a secure origin, so browser notifications are unavailable; in-page alerts still appear';
    soundEl.dataset['mode'] = soundPref ? 'on' : 'off';
    soundEl.textContent = soundPref ? 'Sound on' : 'Sound off';
    soundEl.setAttribute('aria-pressed', String(soundPref));
    soundEl.title = 'Play a short tone with each alert';
}

notifyEl.addEventListener('click', () => {
    if (!notifySupported()) {
        notifyPref = false;
        writeStore(NOTIFY_STORE_KEY, 'off');
        updateAlertButtons();
        return;
    }
    if (!notifyPref && Notification.permission === 'default') {
        void Notification.requestPermission().then((permission) => {
            notifyPref = permission === 'granted';
            writeStore(NOTIFY_STORE_KEY, notifyPref ? 'on' : 'off');
            updateAlertButtons();
        });
        return;
    }
    // A permission that was already refused cannot be asked for again, so the
    // toggle simply stays off rather than pretending otherwise.
    notifyPref = !notifyPref && Notification.permission !== 'denied';
    writeStore(NOTIFY_STORE_KEY, notifyPref ? 'on' : 'off');
    updateAlertButtons();
});

soundEl.addEventListener('click', () => {
    soundPref = !soundPref;
    writeStore(SOUND_STORE_KEY, soundPref ? 'on' : 'off');
    updateAlertButtons();
    if (soundPref) {
        // The click doubles as the gesture that unlocks audio for later alerts.
        playTone('up');
    }
});

// Re-check the backdrop when the tab comes back: a machine that was struggling
// with something else at load time deserves a second, fairer look.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        return;
    }
    if (fxActive) {
        window.setTimeout(() => watchFrameRate(true), FX_WATCH_MS);
    }
});

emptyEl.hidden = false;
sortEl.value = sortMode;
updateAlertButtons();
connect();
window.setTimeout(() => watchFrameRate(false), 2000);
window.setTimeout(() => watchFrameRate(true), 20000);
