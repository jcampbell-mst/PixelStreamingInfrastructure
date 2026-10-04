// Multiviewer wall: one live player per feed, laid out as a single black surface.
//
// Every tile is the real player page loaded in bare mode (Chrome=0), so each tile is a full
// WebRTC subscription and a full decode. The wall only ever keeps tiles for the feeds that are
// on screen: a 2x2 layout with twelve streams connected subscribes to four of them, not twelve.
// Changing layout therefore tears down and rebuilds tiles, which is the point - the cost of the
// wall should follow what is being watched.

const POLL_MS = 5000;
const INDEX_POLL_MS = 5000;
const RECONNECT_MS = 2500;
const INDEX_URL = './snapshots';
// The SFU keeps a permanent discovery connection on the streamer port, so it appears in
// streamerList even though nothing can watch it. Must match `autoHost.discoveryId` in SFU/config.js.
const DISCOVERY_STREAMER_ID = 'SFU-Discovery';
const LAYOUT_KEY = 'ps.wall.layout';

type LayoutId = 'auto' | '1' | '4' | '9' | '16';
type Liveness = 'live' | 'idle' | 'unknown';

interface SnapshotEntry {
    sfuId: string;
    ageMs?: number | null;
    players?: number | null;
    sinceMs?: number | null;
}

interface SnapshotIndex {
    refreshSeconds?: number;
    snapshots?: SnapshotEntry[];
}

interface Tile {
    id: string;
    root: HTMLElement;
    frame: HTMLIFrameElement;
    veil: HTMLElement;
    name: HTMLAnchorElement;
    meta: HTMLElement;
    index: HTMLElement;
    dot: HTMLElement;
    sound: HTMLButtonElement;
    /** Audio state of this tile. Changed by reloading the tile, see `toggleSound`. */
    unmuted: boolean;
    loaded: boolean;
    liveness: Liveness;
    metaText: string;
}

const wallEl = document.getElementById('wall') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const statusEl = document.getElementById('wallStatus') as HTMLElement;
const countEl = document.getElementById('tileCount') as HTMLElement;
const clockEl = document.getElementById('clock') as HTMLElement;
const fullscreenButton = document.getElementById('wallFullscreen') as HTMLButtonElement;
const fullscreenLabel = document.getElementById('fullscreenLabel') as HTMLElement;
const layoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.layout button'));

const tiles = new Map<string, Tile>();
let currentIds: string[] = [];
let layout: LayoutId = readLayout();
let indexAvailable = false;

function readLayout(): LayoutId {
    const fromUrl = new URLSearchParams(location.search).get('layout') as LayoutId | null;
    if (fromUrl && ['auto', '1', '4', '9', '16'].includes(fromUrl)) {
        return fromUrl;
    }
    const saved = localStorage.getItem(LAYOUT_KEY) as LayoutId | null;
    return saved && ['auto', '1', '4', '9', '16'].includes(saved) ? saved : 'auto';
}

// Auto picks the smallest square that holds every feed, so a small setup never shows a wall of
// empty cells; the fixed layouts are a ceiling on how many feeds are watched at once.
function autoColumns(count: number): number {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    if (count <= 9) return 3;
    return 4;
}

function columnsFor(id: LayoutId, count: number): number {
    switch (id) {
        case '1':
            return 1;
        case '4':
            return 2;
        case '9':
            return 3;
        case '16':
            return 4;
        default:
            return autoColumns(count);
    }
}

function playerUrl(id: string, unmuted: boolean): string {
    // StartVideoMuted is set both here and by Chrome=0 inside the player, so the intent is
    // explicit in the URL the wall builds. AutoConnect means a tile starts itself.
    const params = new URLSearchParams({
        StreamerId: id,
        AutoConnect: 'true',
        AutoPlayVideo: 'true',
        StartVideoMuted: unmuted ? 'false' : 'true',
        Chrome: '0'
    });
    return `./player.html?${params.toString()}`;
}

function fullPlayerUrl(id: string): string {
    return `./player.html?StreamerId=${encodeURIComponent(id)}`;
}

function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 1) {
        return `${Math.max(0, Math.floor(ms / 1000))}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`;
}

function createTile(id: string, order: number): Tile {
    const root = document.createElement('article');
    root.className = 'tile';
    root.dataset['state'] = 'connecting';
    root.dataset['liveness'] = 'unknown';
    // Visual order rather than DOM order: appending an existing iframe would reload it, and the
    // feed list can be reordered by the server at any time.
    root.style.order = String(order);

    const frame = document.createElement('iframe');
    frame.className = 'tile-frame';
    frame.title = `Live stream ${id}`;
    frame.allow = 'autoplay; fullscreen';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = playerUrl(id, false);
    frame.addEventListener('load', () => {
        tile.loaded = true;
        syncVeil(tile);
    });

    const veil = document.createElement('div');
    veil.className = 'tile-veil';
    veil.textContent = 'Starting…';

    const label = document.createElement('div');
    label.className = 'tile-label';

    const index = document.createElement('span');
    index.className = 'tile-index';
    index.textContent = String(order + 1);
    index.title = `Feed ${order + 1}`;

    const dot = document.createElement('span');
    dot.className = 'tile-dot';

    const name = document.createElement('a');
    name.className = 'tile-name';
    name.textContent = id;
    name.title = `Open ${id} full size`;
    name.href = fullPlayerUrl(id);
    name.target = '_blank';
    name.rel = 'noopener';

    const meta = document.createElement('span');
    meta.className = 'tile-meta';

    label.append(index, dot, name, meta);

    const sound = document.createElement('button');
    sound.className = 'tile-sound';
    sound.type = 'button';
    sound.textContent = 'Muted';
    sound.title = `Unmute ${id} (reloads this tile)`;
    sound.setAttribute('aria-pressed', 'false');

    root.append(frame, veil, label, sound);

    const tile: Tile = {
        id,
        root,
        frame,
        veil,
        name,
        meta,
        index,
        dot,
        sound,
        unmuted: false,
        loaded: false,
        liveness: 'unknown',
        metaText: ''
    };

    sound.addEventListener('click', () => toggleSound(tile));

    return tile;
}

// Audio lives inside the tile's own document, and the wall has no channel into it, so the only
// way to change one tile's sound is to reload it with a different mute flag.
function toggleSound(tile: Tile): void {
    tile.unmuted = !tile.unmuted;
    tile.loaded = false;
    tile.sound.classList.toggle('is-on', tile.unmuted);
    tile.sound.classList.toggle('is-muted', !tile.unmuted);
    tile.sound.textContent = tile.unmuted ? 'Sound on' : 'Muted';
    tile.sound.setAttribute('aria-pressed', String(tile.unmuted));
    tile.sound.title = tile.unmuted ? `Mute ${tile.id}` : `Unmute ${tile.id} (reloads this tile)`;
    tile.root.dataset['state'] = 'connecting';
    tile.frame.src = playerUrl(tile.id, tile.unmuted);
}

function syncVeil(tile: Tile): void {
    // The index is the only thing that knows whether the feed is sending media. Without it, a
    // tile has to be judged by whether its player loaded at all.
    const live = tile.liveness === 'live' || (!indexAvailable && tile.loaded);
    tile.root.dataset['state'] = live ? 'live' : 'connecting';
}

function setLiveness(tile: Tile, next: Liveness): void {
    if (tile.liveness !== next) {
        tile.liveness = next;
        tile.root.dataset['liveness'] = next;
        tile.dot.title = next === 'live' ? 'Sending media' : next === 'idle' ? 'Not sending media' : 'State unknown';
        syncVeil(tile);
    }
}

function livenessOf(entry: SnapshotEntry | undefined): Liveness {
    if (!entry) {
        return 'idle';
    }
    if (typeof entry.sinceMs === 'number') {
        return 'live';
    }
    return entry.sinceMs === null ? 'idle' : 'unknown';
}

function updateFacts(tile: Tile, entry: SnapshotEntry | undefined, now: number): void {
    setLiveness(tile, livenessOf(entry));

    const since = entry && typeof entry.sinceMs === 'number' ? entry.sinceMs : null;
    const players = entry && typeof entry.players === 'number' ? entry.players : null;

    const parts: string[] = [];
    // A start time in the future means the two clocks disagree, so the duration is dropped.
    if (since !== null && since <= now) {
        parts.push(`Live ${formatDuration(now - since)}`);
    }
    if (players !== null) {
        parts.push(`${players} watching`);
    }
    const text = parts.join(' · ');
    if (text !== tile.metaText) {
        tile.metaText = text;
        tile.meta.textContent = text;
    }
}

function applyIndex(index: SnapshotIndex): void {
    indexAvailable = true;
    const now = Date.now();
    const entries = new Map<string, SnapshotEntry>();
    for (const entry of index.snapshots ?? []) {
        entries.set(entry.sfuId, entry);
    }
    for (const tile of tiles.values()) {
        updateFacts(tile, entries.get(tile.id), now);
    }
}

function refreshIndex(): void {
    fetch(INDEX_URL, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((index: SnapshotIndex) => applyIndex(index))
        .catch(() => {
            // Snapshot index unavailable (disabled, or an older SFU). Liveness is then left
            // unknown rather than guessed at, and each tile trusts its own player's load instead.
            indexAvailable = false;
            for (const tile of tiles.values()) {
                syncVeil(tile);
            }
        });
}

function render(ids: string[]): void {
    currentIds = ids;
    // Auto layout follows the feed count, so the column count is recomputed here rather than only
    // when the layout changes.
    const cols = columnsFor(layout, ids.length);
    wallEl.style.setProperty('--cols', String(cols));
    const limit = cols * cols;
    const wanted = ids.slice(0, limit);

    // Drop tiles that are no longer listed or no longer fit. Their iframes go with them, which
    // is exactly the point of the limit.
    for (const [id, tile] of Array.from(tiles)) {
        if (!wanted.includes(id)) {
            tile.frame.src = 'about:blank';
            tile.root.remove();
            tiles.delete(id);
        }
    }

    wanted.forEach((id, order) => {
        let tile = tiles.get(id);
        if (!tile) {
            tile = createTile(id, order);
            tiles.set(id, tile);
            wallEl.append(tile.root);
            // A new tile has no index entry yet, so it starts as unknown rather than idle.
            tile.root.dataset['liveness'] = 'unknown';
        } else {
            tile.root.style.order = String(order);
            tile.index.textContent = String(order + 1);
            tile.index.title = `Feed ${order + 1}`;
        }
    });

    emptyEl.hidden = ids.length > 0;
    wallEl.hidden = ids.length === 0;

    if (ids.length === 0) {
        countEl.hidden = true;
    } else {
        countEl.hidden = false;
        countEl.textContent = ids.length > wanted.length
            ? `Showing ${wanted.length} of ${ids.length} feeds`
            : `${ids.length} ${ids.length === 1 ? 'feed' : 'feeds'}`;
    }
}

function applyLayout(next: LayoutId, persist: boolean): void {
    layout = next;
    if (persist) {
        localStorage.setItem(LAYOUT_KEY, next);
    }
    for (const button of layoutButtons) {
        button.classList.toggle('is-active', button.dataset['layout'] === next);
    }
    render(currentIds);
}

function setStatus(message: string, warn: boolean): void {
    statusEl.textContent = message;
    statusEl.classList.toggle('is-warn', warn);
}

function connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    let pollTimer: number | undefined;
    let indexTimer: number | undefined;

    ws.onopen = () => {
        setStatus(`Live · ${location.host}`, false);
        // Players are never sent `identify`; ask immediately.
        const poll = () => ws.send(JSON.stringify({ type: 'listStreamers' }));
        poll();
        pollTimer = window.setInterval(poll, POLL_MS);
        refreshIndex();
        indexTimer = window.setInterval(refreshIndex, INDEX_POLL_MS);
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data as string) as { type?: string; ids?: unknown };
            if (msg.type === 'streamerList' && Array.isArray(msg.ids)) {
                render((msg.ids as string[]).filter((id) => id !== DISCOVERY_STREAMER_ID).sort());
            }
        } catch {
            // A malformed message is not worth tearing the wall down for.
        }
    };

    ws.onclose = () => {
        if (pollTimer !== undefined) {
            window.clearInterval(pollTimer);
        }
        if (indexTimer !== undefined) {
            window.clearInterval(indexTimer);
        }
        setStatus('Signalling server unreachable - the tiles keep retrying on their own', true);
        window.setTimeout(connect, RECONNECT_MS);
    };
}

function toggleFullscreen(): void {
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
            /* Nothing to leave. */
        });
    } else {
        // Fullscreen belongs to the wall, not the page: a wall display should show pictures and
        // nothing else.
        wallEl.requestFullscreen?.().catch(() => {
            /* Refused. */
        });
    }
}

document.addEventListener('fullscreenchange', () => {
    const active = !!document.fullscreenElement;
    fullscreenLabel.textContent = active ? 'Exit' : 'Fullscreen';
    fullscreenButton.title = active ? 'Leave fullscreen (F)' : 'Fullscreen (F)';
    fullscreenButton.classList.toggle('is-active', active);
});

fullscreenButton.addEventListener('click', toggleFullscreen);

for (const button of layoutButtons) {
    button.addEventListener('click', () => applyLayout(button.dataset['layout'] as LayoutId, true));
}

// Keys for a wall display with no mouse: 0 for auto, 1-4 for a column count, F for fullscreen.
window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.isContentEditable)) {
        return;
    }
    switch (event.key) {
        case '0':
            applyLayout('auto', true);
            break;
        case '1':
            applyLayout('1', true);
            break;
        case '2':
            applyLayout('4', true);
            break;
        case '3':
            applyLayout('9', true);
            break;
        case '4':
            applyLayout('16', true);
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            break;
        default:
            break;
    }
});

const tickClock = () => {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
};

tickClock();
window.setInterval(tickClock, 1000);

applyLayout(layout, false);
connect();

// Installable shell, as on the other pages: only in a secure context, and never load-bearing.
if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
        /* no cached shell: the wall is unaffected */
    });
}

// This file is bundled as a standalone entry, but the other page scripts are plain scripts, so
// without this marker everything above would sit in the global scope and collide with grid.ts.
export {};
