// Multiviewer wall: one live player per feed, laid out as a single black surface.
//
// Every tile is the real player page loaded in bare mode (Chrome=0), so each tile is a full
// WebRTC subscription and a full decode. The wall only ever keeps tiles for the feeds that are
// on screen: a 2x2 layout with twelve streams connected subscribes to four of them, not twelve.
// Changing layout therefore tears down and rebuilds tiles, which is the point - the cost of the
// wall should follow what is being watched.
//
// Which feeds count as "on screen" is a choice rather than a fact: the picker in the top bar
// holds that choice, the wall renders it, and it is remembered per browser.

const POLL_MS = 5000;
const INDEX_POLL_MS = 5000;
const RECONNECT_MS = 2500;
const INDEX_URL = './snapshots';
// The SFU keeps a permanent discovery connection on the streamer port, so it appears in
// streamerList even though nothing can watch it. Must match `autoHost.discoveryId` in SFU/config.js.
const DISCOVERY_STREAMER_ID = 'SFU-Discovery';
const LAYOUT_KEY = 'ps.wall.layout';
const FEEDS_KEY = 'ps.wall.feeds';

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

/** One line in the picker. Kept for a chosen feed even while it is offline. */
interface FeedRow {
    id: string;
    root: HTMLLIElement;
    check: HTMLInputElement;
    name: HTMLElement;
    meta: HTMLElement;
    online: boolean;
}

const wallEl = document.getElementById('wall') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const emptyTitleEl = document.querySelector('.empty-title') as HTMLElement;
const emptyBodyEl = document.querySelector('.empty-body') as HTMLElement;
const statusEl = document.getElementById('wallStatus') as HTMLElement;
const countEl = document.getElementById('tileCount') as HTMLElement;
const clockEl = document.getElementById('clock') as HTMLElement;
const fullscreenButton = document.getElementById('wallFullscreen') as HTMLButtonElement;
const fullscreenLabel = document.getElementById('fullscreenLabel') as HTMLElement;
const layoutButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.layout button'));
const feedToggleEl = document.getElementById('feedToggle') as HTMLButtonElement;
const feedPanelEl = document.getElementById('feedPanel') as HTMLElement;
const feedCloseEl = document.getElementById('feedClose') as HTMLButtonElement;
const feedListEl = document.getElementById('feedList') as HTMLElement;
const feedNoteEl = document.getElementById('feedNote') as HTMLElement;
const feedAllEl = document.getElementById('feedAll') as HTMLButtonElement;
const feedLiveEl = document.getElementById('feedLive') as HTMLButtonElement;
const feedNoneEl = document.getElementById('feedNone') as HTMLButtonElement;

const tiles = new Map<string, Tile>();
const feedRows = new Map<string, FeedRow>();
/** Every id the signalling server last listed, in the order it listed them. */
let listedIds: string[] = [];
/**
 * Which feeds the wall should show. `null` means "everything the server lists, including
 * streams that connect later"; a set is an explicit choice, and an empty set is a valid one.
 */
let selected: Set<string> | null = readSelection();
let layout: LayoutId = readLayout();
let indexAvailable = false;
/** Last snapshot index answer, so a feed joining between two polls gets its facts at once. */
let latestEntries: Map<string, SnapshotEntry> | null = null;
let latestIndexNow = 0;
let shownCount = 0;

function readLayout(): LayoutId {
    const fromUrl = new URLSearchParams(location.search).get('layout') as LayoutId | null;
    if (fromUrl && ['auto', '1', '4', '9', '16'].includes(fromUrl)) {
        return fromUrl;
    }
    const saved = localStorage.getItem(LAYOUT_KEY) as LayoutId | null;
    return saved && ['auto', '1', '4', '9', '16'].includes(saved) ? saved : 'auto';
}

// A missing key and an empty array mean different things - "everything" and "nothing" - so the
// absence of the key is the thing that is read, not a default.
function readSelection(): Set<string> | null {
    const raw = localStorage.getItem(FEEDS_KEY);
    if (raw === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return null;
        }
        return new Set(parsed.filter((id): id is string => typeof id === 'string'));
    } catch {
        // A hand-edited or truncated value is treated as no choice having been made.
        return null;
    }
}

function persistSelection(): void {
    if (selected === null) {
        localStorage.removeItem(FEEDS_KEY);
    } else {
        localStorage.setItem(FEEDS_KEY, JSON.stringify(Array.from(selected)));
    }
}

function isChosen(id: string): boolean {
    return selected === null || selected.has(id);
}

/** The listed feeds the wall should show, in the order the server listed them. */
function chosenIds(): string[] {
    return listedIds.filter(isChosen);
}

function setText(el: HTMLElement, text: string): void {
    if (el.textContent !== text) {
        el.textContent = text;
    }
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

    const text = feedFacts(entry, now);
    if (text !== tile.metaText) {
        tile.metaText = text;
        tile.meta.textContent = text;
    }
}

// The same sentence the tile labels get, so a feed reads the same in the picker as it does on
// the wall.
function feedFacts(entry: SnapshotEntry | undefined, now: number): string {
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
    return parts.join(' · ');
}

// --- Stream picker ---------------------------------------------------------
//
// The list is the server's feed list plus, deliberately, any chosen feed that has gone
// offline: silently dropping a name would take the reason for its absence with it, and the
// choice would look like it had been forgotten. Offline rows stay so they can be seen and,
// if wanted, un-ticked.

function createFeedRow(id: string): FeedRow {
    const root = document.createElement('li');
    root.className = 'feed-row';
    root.dataset['id'] = id;
    root.dataset['liveness'] = 'unknown';

    const pick = document.createElement('label');
    pick.className = 'feed-pick';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = isChosen(id);
    check.setAttribute('aria-label', `Show ${id} on the wall`);

    const dot = document.createElement('span');
    dot.className = 'feed-dot';
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'feed-name';
    name.textContent = id;
    name.title = id;

    const flag = document.createElement('span');
    flag.className = 'feed-flag';
    flag.textContent = 'On wall';

    pick.append(check, dot, name, flag);

    const meta = document.createElement('span');
    meta.className = 'feed-meta';

    root.append(pick, meta);

    const row: FeedRow = { id, root, check, name, meta, online: false };
    root.classList.add('is-offline');
    return row;
}

function updateFeedRow(row: FeedRow): void {
    if (!row.online) {
        row.root.dataset['liveness'] = 'offline';
        setText(row.meta, 'Offline');
        return;
    }
    const entry = latestEntries ? latestEntries.get(row.id) : undefined;
    // Without an index there is nothing to say about a feed except that it is connected, so
    // its state is left unknown rather than called idle.
    row.root.dataset['liveness'] = latestEntries ? livenessOf(entry) : 'unknown';
    setText(row.meta, feedFacts(entry, latestIndexNow));
}

function syncFeedList(): void {
    const online = new Set(listedIds);
    const ids = listedIds.slice();
    if (selected !== null) {
        for (const id of Array.from(selected)) {
            if (!online.has(id)) {
                ids.push(id);
            }
        }
    }
    ids.sort();

    const wanted = new Set(ids);
    for (const id of ids) {
        let row = feedRows.get(id);
        if (!row) {
            row = createFeedRow(id);
            feedRows.set(id, row);
            feedListEl.append(row.root);
        }
        const up = online.has(id);
        if (row.online !== up) {
            row.online = up;
            row.root.classList.toggle('is-offline', !up);
        }
        row.check.checked = isChosen(id);
        updateFeedRow(row);
    }
    for (const [id, row] of Array.from(feedRows)) {
        if (!wanted.has(id)) {
            row.root.remove();
            feedRows.delete(id);
        }
    }

    const oldEmpty = feedListEl.querySelector('.feed-none');
    if (ids.length === 0) {
        if (!oldEmpty) {
            const none = document.createElement('li');
            none.className = 'feed-none';
            none.textContent = 'No streams are connected yet.';
            feedListEl.append(none);
        }
    } else if (oldEmpty) {
        oldEmpty.remove();
    }

    syncFeedButtons();
}

function syncFeedButtons(): void {
    const none = listedIds.length === 0;
    feedAllEl.disabled = none;
    feedNoneEl.disabled = none;
    // "Live only" is a promise the snapshot index has to keep.
    feedLiveEl.disabled = none || !latestEntries;
}

/** Marks which chosen feeds are actually on the wall, which a layout ceiling can cut short. */
function syncFeedMarks(wanted: string[]): void {
    const shown = new Set(wanted);
    for (const row of feedRows.values()) {
        row.root.classList.toggle('is-shown', shown.has(row.id));
    }
}

function syncFeedNote(): void {
    let text: string;
    if (listedIds.length === 0) {
        text = selected !== null && selected.size > 0
            ? `Waiting for ${selected.size === 1 ? 'your stream' : 'your streams'} to come back.`
            : 'No streams are connected yet.';
    } else if (selected === null) {
        text = `Everything is on the wall (${shownCount} of ${listedIds.length}).`;
    } else {
        const chosen = chosenIds().length;
        // Names that are chosen but not connected still account for the choice, so they are
        // reported rather than left to look like part of the count.
        const offline = selected.size - chosen;
        text = `${chosen} of ${listedIds.length} streams chosen`;
        if (offline > 0) {
            text += ` · ${offline} offline`;
        }
        text += shownCount < chosen ? ` · the layout has room for ${shownCount}.` : '.';
    }
    setText(feedNoteEl, text);

    // A filter is easy to leave behind, so the button says so for as long as one is on.
    const filtered = selected !== null;
    feedToggleEl.classList.toggle('is-filtered', filtered);
    feedToggleEl.title = filtered
        ? `Filtering: ${chosenIds().length} of ${listedIds.length} streams on the wall`
        : 'Choose which streams are on the wall';
}

function applySelection(next: Set<string> | null): void {
    selected = next;
    persistSelection();
    syncFeedList();
    render();
}

function toggleChosen(id: string, chosen: boolean): void {
    // The first edit is what turns "everything" into a list, and the list it starts from is
    // whatever is on the wall at that moment.
    const next = selected !== null ? new Set(selected) : new Set(listedIds);
    if (chosen) {
        next.add(id);
    } else {
        next.delete(id);
    }
    applySelection(next);
}

function selectLiveOnly(): void {
    const live = listedIds.filter((id) => {
        const entry = latestEntries ? latestEntries.get(id) : undefined;
        return livenessOf(entry) === 'live';
    });
    applySelection(new Set(live));
}

function setPanelOpen(open: boolean): void {
    feedToggleEl.setAttribute('aria-expanded', String(open));
    feedPanelEl.classList.toggle('is-open', open);
    feedPanelEl.setAttribute('aria-hidden', String(!open));
    if (open) {
        syncFeedList();
        syncFeedNote();
        // Opening the drawer is a request to pick something, so the keyboard lands on the list.
        const first = feedListEl.querySelector('input');
        if (first instanceof HTMLInputElement) {
            first.focus();
        }
    }
}

function panelIsOpen(): boolean {
    return feedPanelEl.classList.contains('is-open');
}

function applyIndex(index: SnapshotIndex): void {
    indexAvailable = true;
    const now = Date.now();
    const entries = new Map<string, SnapshotEntry>();
    for (const entry of index.snapshots ?? []) {
        entries.set(entry.sfuId, entry);
    }
    latestEntries = entries;
    latestIndexNow = now;
    for (const tile of tiles.values()) {
        updateFacts(tile, entries.get(tile.id), now);
    }
    for (const row of feedRows.values()) {
        updateFeedRow(row);
    }
    syncFeedButtons();
}

function refreshIndex(): void {
    fetch(INDEX_URL, { cache: 'no-store' })
        .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((index: SnapshotIndex) => applyIndex(index))
        .catch(() => {
            // Snapshot index unavailable (disabled, or an older SFU). Liveness is then left
            // unknown rather than guessed at, and each tile trusts its own player's load instead.
            indexAvailable = false;
            latestEntries = null;
            for (const tile of tiles.values()) {
                syncVeil(tile);
            }
            for (const row of feedRows.values()) {
                updateFeedRow(row);
            }
            // A stale "Live only" would select against a snapshot of the past.
            syncFeedButtons();
        });
}

function setStreamers(ids: string[]): void {
    listedIds = ids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    syncFeedList();
    render();
}

function render(): void {
    const ids = chosenIds();
    // Auto layout follows the feed count, so the column count is recomputed here rather than only
    // when the layout changes.
    const cols = columnsFor(layout, ids.length);
    wallEl.style.setProperty('--cols', String(cols));
    const limit = cols * cols;
    const wanted = ids.slice(0, limit);
    shownCount = wanted.length;

    // Drop tiles that are no longer chosen or no longer fit. Their iframes go with them, which
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
            // A feed that joins between two index polls is still described now.
            if (indexAvailable && latestEntries) {
                updateFacts(tile, latestEntries.get(id), latestIndexNow);
            }
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
        // Three different kinds of nothing, which want three different explanations.
        const nothingSelected = listedIds.length > 0 && selected !== null;
        const allOffline = listedIds.length === 0 && selected !== null && selected.size > 0;
        if (nothingSelected) {
            setText(emptyTitleEl, 'Nothing selected');
            setText(emptyBodyEl, 'Every stream is switched off. Open Feeds in the top bar and pick what belongs on the wall.');
        } else if (allOffline) {
            setText(emptyTitleEl, 'Your streams are offline');
            setText(emptyBodyEl, 'None of the streams you picked are connected right now. The wall fills in as they come back.');
        } else {
            setText(emptyTitleEl, 'No streams yet');
            setText(emptyBodyEl, 'Waiting for a streamer to connect…');
        }
    } else {
        countEl.hidden = false;
        countEl.textContent = ids.length > wanted.length
            ? `Showing ${wanted.length} of ${ids.length} feeds`
            : `${ids.length} ${ids.length === 1 ? 'feed' : 'feeds'}`;
    }

    syncFeedMarks(wanted);
    syncFeedNote();
}

function applyLayout(next: LayoutId, persist: boolean): void {
    layout = next;
    if (persist) {
        localStorage.setItem(LAYOUT_KEY, next);
    }
    for (const button of layoutButtons) {
        button.classList.toggle('is-active', button.dataset['layout'] === next);
    }
    render();
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
                setStreamers((msg.ids as string[]).filter((id) => id !== DISCOVERY_STREAMER_ID));
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
    if (active) {
        // Fullscreen covers the wall element, so the drawer would be stranded behind it.
        setPanelOpen(false);
    }
});

fullscreenButton.addEventListener('click', toggleFullscreen);

feedToggleEl.addEventListener('click', () => setPanelOpen(!panelIsOpen()));
feedCloseEl.addEventListener('click', () => setPanelOpen(false));
feedAllEl.addEventListener('click', () => applySelection(null));
feedNoneEl.addEventListener('click', () => applySelection(new Set<string>()));
feedLiveEl.addEventListener('click', selectLiveOnly);

// Delegated so rows that appear later need no listeners of their own.
feedListEl.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const row = input.closest('.feed-row') as HTMLElement | null;
    const id = row ? row.dataset['id'] : undefined;
    if (input.type === 'checkbox' && id) {
        toggleChosen(id, input.checked);
    }
});

// Clicking the wall behind an open drawer means "done".
document.addEventListener('click', (event) => {
    if (!panelIsOpen()) {
        return;
    }
    const target = event.target as Node | null;
    if (target && (feedPanelEl.contains(target) || feedToggleEl.contains(target))) {
        return;
    }
    setPanelOpen(false);
});

for (const button of layoutButtons) {
    button.addEventListener('click', () => applyLayout(button.dataset['layout'] as LayoutId, true));
}

// Keys for a wall display with no mouse: 0 for auto, 1-4 for a column count, F for fullscreen.
window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }
    const target = event.target as HTMLElement | null;
    if (event.key === 'Escape' && panelIsOpen()) {
        // Escape has to work from inside the drawer too, where focus is on a checkbox.
        setPanelOpen(false);
        feedToggleEl.focus();
        return;
    }
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

// The picker is built from the stored choice before the first streamer list arrives, so a
// reload shows the right feeds the moment the wall connects.
syncFeedList();
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
