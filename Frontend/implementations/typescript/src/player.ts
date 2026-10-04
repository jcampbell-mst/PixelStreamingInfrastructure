// Copyright Epic Games, Inc. All Rights Reserved.

export * from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.5';
export * from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.5';

import { Config, PixelStreaming, Logger, LogLevel, Flags } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.5';
import { Application, PixelStreamingApplicationStyle, UIElementCreationMode } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.5';

// The palettes below mirror the stream grid so the player reads as part of the same app. They carry
// the studio tally theme to the parts of the player the ui-library owns, chiefly the Information
// panel, which paints itself from --color0/2/3/7 rather than from player.css.
const playerDarkPalette = {
    '--color0': '#211f1cf2',
    '--color1': '#0c0b0a',
    '--color2': '#eeedec',
    '--color3': '#f2332c',
    '--color4': '#25e455',
    '--color5': '#f0a93b',
    '--color6': '#292724',
    '--color7': '#37332f'
};

const playerLightPalette = {
    '--color0': '#fdfcfcf2',
    '--color1': '#f6f5f3',
    '--color2': '#231f1a',
    '--color3': '#c81e16',
    '--color4': '#0f8f34',
    '--color5': '#a86000',
    '--color6': '#efeeeb',
    '--color7': '#e1ded9'
};

const playerCustomStyles = {
    '#videoElementParent': {
        width: '100%',
        height: '100%',
        position: 'absolute',
        backgroundColor: 'var(--color1)'
    },
    '#uiFeatures': {
        width: '100%',
        height: '100%',
        zIndex: '30',
        position: 'relative',
        color: 'var(--color2)',
        pointerEvents: 'none',
        overflow: 'hidden',
        fontFamily: "'Montserrat', sans-serif"
    },
    '.UiTool .tooltiptext': {
        visibility: 'hidden',
        width: 'auto',
        color: 'var(--color2)',
        backgroundColor: 'var(--color0)',
        textAlign: 'center',
        borderRadius: '8px',
        padding: '2px 10px',
        fontFamily: "'Montserrat', sans-serif",
        fontSize: '0.75rem',
        letterSpacing: '0.02em',
        position: 'absolute',
        top: '0',
        transform: 'translateY(25%)',
        left: '125%',
        zIndex: '20'
    },
    '.UiTool:hover .tooltiptext': {
        visibility: 'visible',
        backgroundColor: 'var(--color0)'
    },
    '#controls': {
        position: 'absolute',
        bottom: '6%',
        left: '4%',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        pointerEvents: 'all'
    },
    '#controls:empty': {
        display: 'none'
    },
    '#uiFeatures button': {
        backgroundColor: 'var(--color6)',
        border: '1px solid var(--color7)',
        borderRadius: '0.85rem',
        color: 'var(--color2)',
        position: 'relative',
        width: '2.75rem',
        height: '2.75rem',
        padding: '0.6rem',
        textAlign: 'center',
        cursor: 'pointer',
        transition: 'background 0.15s ease, border-color 0.15s ease'
    },
    '#uiFeatures button:hover': {
        backgroundColor: 'var(--color7)',
        border: '1px solid var(--color3)',
        paddingLeft: '0.6rem',
        paddingTop: '0.6rem'
    },
    '#uiFeatures button:active': {
        border: '1px solid var(--color3)',
        backgroundColor: 'var(--color3)',
        paddingLeft: '0.6rem',
        paddingTop: '0.6rem'
    },
    '#uiFeatures img': {
        width: '100%',
        height: '100%'
    },
    '.btn-flat': {
        backgroundColor: 'transparent',
        color: 'var(--color2)',
        fontFamily: "'Montserrat', sans-serif",
        fontWeight: '600',
        border: '1px solid var(--color7)',
        borderRadius: '0.6rem',
        fontSize: '0.78rem',
        letterSpacing: '0.02em',
        padding: '0.35rem 0.75rem',
        cursor: 'pointer',
        textAlign: 'center',
        transition: 'background 0.15s ease, border-color 0.15s ease, color 0.15s ease'
    },
    '.btn-flat:hover': {
        backgroundColor: 'var(--color3)',
        borderColor: 'var(--color3)',
        color: '#ffffff'
    },
    '.btn-flat:disabled': {
        background: 'var(--color6)',
        borderColor: 'var(--color7)',
        color: 'var(--color7)',
        cursor: 'default'
    },
    '.btn-flat:active': {
        backgroundColor: 'var(--color3)',
        borderColor: 'var(--color3)'
    },
    '.btn-flat:focus': {
        outline: 'none'
    },
    '.panel-wrap': {
        position: 'absolute',
        top: '0',
        bottom: '0',
        right: '0',
        height: '100%',
        minWidth: '22vw',
        maxWidth: '90vw',
        transform: 'translateX(100%)',
        transition: 'transform 0.25s ease-out',
        pointerEvents: 'all',
        overflowY: 'auto',
        overflowX: 'hidden',
        backgroundColor: 'var(--color0)',
        borderLeft: '1px solid var(--color7)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        fontSize: '0.85rem'
    },
    '.panel-wrap-visible': {
        transform: 'translateX(0%)'
    },
    '.panel': {
        overflowY: 'auto',
        // Top padding clears the floating top bar so panel headings stay reachable.
        padding: '3.5rem 1.5rem 1.25rem'
    },
    '#settingsHeading, #statsHeading': {
        display: 'inline-block',
        fontSize: '1.1rem',
        fontWeight: '600',
        letterSpacing: '0.02em',
        marginBlockStart: '0',
        marginBlockEnd: '1rem',
        marginInlineStart: '0px',
        marginInlineEnd: '0px',
        position: 'relative',
        borderBottom: '1px solid var(--color7)',
        paddingBottom: '0.5rem'
    },
    '#settingsClose, #statsClose': {
        margin: '0',
        paddingTop: '0.2rem',
        paddingBottom: '0.2rem',
        paddingRight: '0.5rem',
        fontSize: '1.4rem',
        lineHeight: '1',
        float: 'right',
        cursor: 'pointer',
        color: 'var(--color2)',
        transition: 'color 0.15s ease'
    },
    '#settingsClose:after, #statsClose:after': {
        paddingLeft: '0.5rem',
        display: 'inline-block',
        content: '"\\00d7"'
    },
    '#settingsClose:hover, #statsClose:hover': {
        color: 'var(--color3)'
    },
    '#settingsContent, #statsContent': {
        marginLeft: '0',
        marginRight: '0'
    },
    '.setting': {
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.35rem 0'
    },
    '.settings-text': {
        color: 'var(--color2)',
        verticalAlign: 'middle',
        fontWeight: 'normal'
    },
    '.settings-option': {
        width: '100%',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
    },
    '#settings-panel .tooltiptext': {
        display: 'block',
        top: '125%',
        transform: 'translateX(-50%)',
        left: '0',
        zIndex: '20',
        padding: '4px 10px',
        border: '1px solid var(--color3)',
        backgroundColor: 'var(--color0)',
        width: 'max-content'
    },
    '#connectOverlay, #playOverlay, #infoOverlay, #errorOverlay, #afkOverlay, #disconnectOverlay': {
        zIndex: '30',
        position: 'absolute',
        color: 'var(--color2)',
        fontSize: '1.2rem',
        fontWeight: '600',
        letterSpacing: '0.03em',
        width: '100%',
        height: '100%',
        backgroundColor: 'var(--color1)',
        alignItems: 'center',
        justifyContent: 'center',
        textTransform: 'none'
    },
    '.clickableState': {
        alignItems: 'center',
        justifyContent: 'center',
        display: 'flex',
        cursor: 'pointer'
    },
    '.textDisplayState': {
        display: 'flex'
    },
    '.hiddenState': {
        display: 'none'
    },
    '#playButton, #connectButton': {
        display: 'inline-block',
        height: 'auto',
        zIndex: '30'
    },
    'img#playButton': {
        maxWidth: '180px',
        width: '10%',
        opacity: '0.9'
    },
    '.btn-overlay': {
        verticalAlign: 'middle',
        display: 'inline-block'
    },
    '.tgl+.tgl-slider': {
        display: 'inline-block',
        cursor: 'pointer',
        width: '40px',
        height: '22px',
        background: 'var(--color7)',
        borderRadius: '999px',
        padding: '2px',
        transition: 'background 0.2s ease',
        position: 'relative',
        verticalAlign: 'middle'
    },
    '.tgl+.tgl-slider:after': {
        left: '0',
        display: 'block',
        content: '""',
        borderRadius: '999px',
        background: '#ffffff',
        transition: 'left 0.2s ease',
        height: '18px',
        width: '18px'
    },
    '.tgl-flat+.tgl-slider': {
        background: 'var(--color7)',
        border: '0',
        transition: 'background 0.2s ease'
    },
    '.tgl-flat+.tgl-slider:after': {
        background: '#ffffff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.45)'
    },
    '.tgl-flat:checked+.tgl-slider': {
        background: 'var(--color3)'
    },
    '.tgl-flat:checked+.tgl-slider:after': {
        left: 'calc(100% - 18px)',
        background: '#ffffff'
    },
    '.form-control': {
        backgroundColor: 'var(--color6)',
        border: '1px solid var(--color7)',
        borderRadius: '0.6rem',
        color: 'var(--color2)',
        fontFamily: "'Montserrat', sans-serif",
        fontSize: '0.8rem',
        padding: '0.35rem 0.6rem'
    },
    '.form-control:hover': {
        border: '1px solid var(--color3)',
        cursor: 'pointer'
    },
    '.form-group': {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.35rem 0'
    },
    '.form-group label': {
        marginBlockEnd: '0',
        fontWeight: 'normal'
    },
    '.modal': {
        zIndex: '40',
        position: 'absolute',
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        alignItems: 'center',
        justifyContent: 'center'
    },
    '.innerModal': {
        backgroundColor: 'var(--color0)',
        border: '1px solid var(--color7)',
        borderRadius: '12px',
        padding: '1.5rem',
        width: '40vw'
    },
    '.modal .btn-flat': {
        border: '1px solid var(--color7)'
    },
    '.modal .btn-flat:hover': {
        backgroundColor: 'var(--color3)',
        borderColor: 'var(--color3)',
        color: '#ffffff'
    }
};

const PixelStreamingApplicationStyles = new PixelStreamingApplicationStyle({
    customStyles: playerCustomStyles,
    lightModePalette: playerLightPalette,
    darkModePalette: playerDarkPalette
});
PixelStreamingApplicationStyles.applyStyleSheet();

// expose the pixel streaming object for hooking into. tests etc.
declare global {
    interface Window {
        pixelStreaming: PixelStreaming;
        pixelStreamingApplication: Application;
    }
}

type LoaderStage = 'boot' | 'signalling' | 'negotiating' | 'waiting' | 'starting' | 'live' | 'reconnecting';

// Each connection stage gets its own animated indicator (see #stageLoader in player.css).
const LOADER_STAGES: Record<
    LoaderStage,
    { title: string; detail: string; status: string; step: number; stuck?: string }
> = {
    boot: {
        title: 'Preparing player',
        detail: 'Setting up the streaming client…',
        status: 'Starting…',
        step: 0,
        stuck: 'The player is taking longer than expected to start…'
    },
    signalling: {
        title: 'Connecting to server',
        detail: 'Reaching the signalling server…',
        status: 'Connecting…',
        step: 0,
        stuck: 'Still trying to reach the signalling server…'
    },
    negotiating: {
        title: 'Negotiating stream',
        detail: 'Agreeing on the video format over WebRTC…',
        status: 'Negotiating…',
        step: 1,
        stuck: 'The server has not answered the connection yet…'
    },
    waiting: {
        title: 'Connected, waiting for video',
        detail: 'The streamer has not sent frames yet…',
        status: 'Waiting for video',
        step: 2,
        stuck: 'Still waiting for the streamer to send frames…'
    },
    starting: {
        title: 'Starting video',
        detail: 'Receiving the stream and warming up playback…',
        status: 'Starting video…',
        step: 2,
        stuck: 'The stream is taking a while to warm up…'
    },
    live: {
        title: 'Live',
        detail: '',
        status: 'Live',
        step: 3
    },
    // A lost feed is put back on the loader rather than on a bare overlay, so the viewer keeps
    // the same staged feedback as the first connection. Its detail line is rewritten once a
    // second by the reconnect loop, so the copy here is only the first thing shown.
    reconnecting: {
        title: 'Reconnecting',
        detail: 'The stream dropped. Waiting for the server to answer…',
        status: 'Reconnecting…',
        step: 0,
        stuck: 'Still trying to reach the streamer…'
    }
};

// Stages only ever move forwards, so slightly out-of-order library events cannot rewind the UI.
// Reconnect shares the first step, which is where a fresh connection starts from too.
const LOADER_RANK: Record<LoaderStage, number> = {
    boot: 0,
    signalling: 1,
    reconnecting: 1,
    negotiating: 2,
    waiting: 3,
    starting: 4,
    live: 5
};

document.body.onload = function () {
    Logger.InitLogging(LogLevel.Warning, true);

    // Streams are opened from the grid, so start the selected feed straight away instead of
    // waiting for a click. Explicit URL parameters still win, e.g. ?AutoConnect=false.
    const urlParams = new URLSearchParams(window.location.search);
    // The multiviewer embeds the player with Chrome=0: no top bar, no sound, no shortcuts. The
    // tile around it carries the feed's name, its state and the way out, so a second set of
    // controls inside every tile would only add clutter and confusion.
    const bareMode = urlParams.get('Chrome') === '0';

    // Clicking the picture must not capture the cursor. The library's default control scheme locks
    // the pointer to the video (and hides it) on click; hovering mode leaves the pointer usable and
    // still forwards every mouse event to the app. URL parameters are read after these initial
    // settings, so ?HoveringMouse=false restores the locked pointer for a relative-input experience.
    const config = new Config({
        useUrlParams: true,
        initialSettings: {
            [Flags.AutoConnect]: true,
            [Flags.AutoPlayVideo]: true,
            [Flags.HoveringMouseMode]: true
        }
    });

    if (bareMode) {
        config.setFlagEnabled(Flags.StartVideoMuted, true);
    }

    // Create the main Pixel Streaming object for interfacing with the web-API of Pixel Streaming
    const stream = new PixelStreaming(config);

    // The player chrome is deliberately minimal: no connection indicator, no settings panel, and
    // the two remaining triggers live in our own top bar rather than the library's floating controls.
    // Stream quality follows what the server sends, so nothing here lets a viewer retune it.
    const fullscreenButton = document.getElementById('fullscreenToggle');
    const statsButton = document.getElementById('statsToggle');

    const application = new Application({
        stream,
        onColorModeChanged: (isLightMode) => PixelStreamingApplicationStyles.setColorMode(isLightMode),
        fullScreenControlsConfig: fullscreenButton
            ? { creationMode: UIElementCreationMode.UseCustomElement, customElement: fullscreenButton }
            : undefined,
        statsPanelConfig: statsButton
            ? {
                  isEnabled: true,
                  // The library reads section visibility with an unguarded hasOwnProperty call, so a
                  // panel config without this key throws while the panel is being built. Only the two
                  // read-only sections survive: the latency tests inject traffic into a live feed and
                  // their "Run Test" buttons do not belong in a production readout.
                  sectionVisibility: {
                      'Latency Test': false,
                      'Data Channel Latency Test': false
                  },
                  visibilityButtonConfig: {
                      creationMode: UIElementCreationMode.UseCustomElement,
                      customElement: statsButton
                  }
              }
            : { isEnabled: false, visibilityButtonConfig: { creationMode: UIElementCreationMode.Disable } },
        settingsPanelConfig: {
            isEnabled: false,
            visibilityButtonConfig: { creationMode: UIElementCreationMode.Disable }
        },
        videoQpIndicatorConfig: { disableIndicator: true }
    });

    // Mount into the stage element rather than the body so the top bar stays visible above the video.
    const stage = document.getElementById('stage') ?? document.body;
    stage.appendChild(application.rootElement);

    const requestedFeed = urlParams.get('StreamerId') ?? '';
    const streamName = requestedFeed || 'Pixel Streaming';
    document.title = streamName;

    const nameLabel = document.getElementById('streamName');
    if (nameLabel) {
        nameLabel.textContent = streamName;
    }

    const loader = document.getElementById('stageLoader');
    const loaderTitle = document.getElementById('loaderTitle');
    const loaderDetail = document.getElementById('loaderDetail');
    const loaderRetry = document.getElementById('loaderRetry');
    const loaderSteps = Array.from(document.querySelectorAll<HTMLLIElement>('#loaderSteps li'));
    const connState = document.getElementById('connState');
    const soundToggle = document.getElementById('soundToggle');
    const soundLabel = document.getElementById('soundLabel');
    const pipToggle = document.getElementById('pipToggle');
    const helpToggle = document.getElementById('helpToggle');
    const helpCard = document.getElementById('helpCard');
    const helpClose = document.getElementById('helpClose');
    const qpChip = document.getElementById('qpChip');
    const qpValueEl = document.getElementById('qpValue');
    const stallChip = document.getElementById('stallChip');
    const stallText = document.getElementById('stallText');
    const stallRetry = document.getElementById('stallRetry');
    const keyHint = document.getElementById('keyHint');

    let currentStage: LoaderStage = 'boot';
    let loaderFinished = false;
    let slowHintTimer = 0;
    // The feed this page was opened for, kept while it is absent from the signaller so the loader
    // can name it instead of leaving the viewer on a black stage with no explanation.
    let missingFeed = '';
    let playbackPoller = 0;
    let audioMuted = bareMode || config.isFlagEnabled(Flags.StartVideoMuted);
    let mutedRetryUsed = false;
    // Reported by the streamer over the data channel; 0 means "not reported" (the library also
    // zeroes it on disconnect), so it is never shown.
    let qpValue = 0;

    // --- Self-hiding chrome ---------------------------------------------------
    // The top bar slides away after a few idle seconds and returns on any input, so the picture is
    // unobstructed until the viewer reaches for a control. It stays up until the stream is handed
    // over and whenever a panel is open.
    const chrome = document.getElementById('shell');
    const topbar = document.getElementById('topbar');
    const CHROME_IDLE_MS = 3000;
    let chromeTimer = 0;
    let pointerOverChrome = false;

    if (bareMode) {
        chrome?.classList.add('is-bare');
    }

    const panelIsOpen = () => !!document.querySelector('#uiFeatures .panel-wrap-visible');

    const hideChrome = () => {
        if (!loaderFinished || pointerOverChrome || panelIsOpen() || (helpCard && !helpCard.hidden)) {
            return;
        }
        chrome?.classList.add('is-chrome-hidden');
    };

    const armChromeHide = () => {
        if (chromeTimer) {
            window.clearTimeout(chromeTimer);
        }
        chromeTimer = window.setTimeout(hideChrome, CHROME_IDLE_MS);
    };

    const wakeChrome = () => {
        chrome?.classList.remove('is-chrome-hidden');
        armChromeHide();
    };

    // The library owns the panel's open state, so mirror it onto our own toggle button.
    const syncStatsToggle = () => {
        const open = !!document.querySelector('#stats-panel.panel-wrap-visible');
        statsButton?.classList.toggle('is-active', open);
        statsButton?.setAttribute('aria-pressed', String(open));
    };

    window.addEventListener('pointermove', wakeChrome, { passive: true });
    window.addEventListener('pointerdown', wakeChrome, { passive: true });
    window.addEventListener('keydown', wakeChrome);
    document.addEventListener('focusin', wakeChrome);

    // Hovering the bar itself must not let the idle timer pull it out from under the pointer.
    topbar?.addEventListener('pointerenter', () => {
        pointerOverChrome = true;
        wakeChrome();
    });
    topbar?.addEventListener('pointerleave', () => {
        pointerOverChrome = false;
        armChromeHide();
    });

    const uiFeatures = document.getElementById('uiFeatures');
    if (uiFeatures) {
        // A panel being shown or hidden is a class change on the panel, which is our cue to
        // re-check the toggle button and restart the idle countdown.
        new MutationObserver(() => {
            syncStatsToggle();
            wakeChrome();
        }).observe(uiFeatures, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    syncStatsToggle();

    // --- Information panel ---------------------------------------------------
    // The ui-library builds this panel and rewrites a row every stats tick, always as the bare text
    // "Label: value" in an unclassed div. This pass gives those rows structure - a key, a value, a
    // unit, and a state colour where the number actually means something - and drops the rows that
    // carry no usable information, so the panel reads as a readout rather than a debug dump. Each
    // pass rebuilds a row from the text the library just wrote, so it is idempotent by construction
    // and never has to fight the library for the DOM.
    type StatState = 'good' | 'warn' | 'bad';

    interface StatSpec {
        id: string;
        label: string;
        order: number;
        unit?: string;
        state?: (value: number) => StatState;
        /** Rows that are true but tell a viewer nothing, e.g. cumulative counters. */
        drop?: boolean;
    }

    const rttState = (value: number): StatState => (value < 80 ? 'good' : value < 160 ? 'warn' : 'bad');
    const lossState = (value: number): StatState => (value === 0 ? 'good' : value <= 50 ? 'warn' : 'bad');
    const jitterState = (value: number): StatState => (value < 25 ? 'good' : value < 60 ? 'warn' : 'bad');
    const latencyState = (value: number): StatState => (value < 90 ? 'good' : value < 180 ? 'warn' : 'bad');
    // Matches the bands the top bar's QP chip uses, so the two never disagree.
    const qpState = (value: number): StatState => (value <= 24 ? 'good' : value <= 40 ? 'warn' : 'bad');

    // Keyed by the label the library writes, because that is the only stable handle the row has.
    const statSpecs: Record<string, StatSpec> = {
        'Video codec': { id: 'video-codec', label: 'Video codec', order: 10 },
        'Video resolution': { id: 'resolution', label: 'Resolution', order: 20 },
        'Video Bitrate (kbps)': { id: 'video-bitrate', label: 'Video', order: 30, unit: 'kbps' },
        'Framerate': { id: 'framerate', label: 'Framerate', order: 40 },
        'Video quantization parameter': { id: 'video-qp', label: 'Encoder QP', order: 50, state: qpState },
        'Audio codec': { id: 'audio-codec', label: 'Audio codec', order: 60 },
        'Audio Bitrate (kbps)': { id: 'audio-bitrate', label: 'Audio', order: 70, unit: 'kbps' },
        'Net RTT (ms)': { id: 'rtt', label: 'Network RTT', order: 80, unit: 'ms', state: rttState },
        'Packets Lost': { id: 'packets-lost', label: 'Packets lost', order: 90, state: lossState },
        'Frames dropped': { id: 'frames-dropped', label: 'Frames dropped', order: 100, state: lossState },
        'Duration': { id: 'duration', label: 'Uptime', order: 110 },
        'Players': { id: 'players', label: 'Viewers', order: 120 },
        'Controls stream input': { id: 'control-input', label: 'Control input', order: 130 },
        // Cumulative counters: bitrate, dropped frames and uptime already cover what they say.
        'Received': { id: 'received', label: 'Received', order: 900, drop: true },
        'Frames Decoded': { id: 'frames-decoded', label: 'Frames decoded', order: 900, drop: true },

        'Encode latency (ms)': { id: 'latency-encode', label: 'Encode', order: 10, unit: 'ms' },
        'Packetizer latency (ms)': { id: 'latency-packetize', label: 'Packetize', order: 20, unit: 'ms' },
        'Pacer latency (ms)': { id: 'latency-pacer', label: 'Pacer', order: 30, unit: 'ms' },
        'Post-capture to send latency (ms)': { id: 'latency-capture', label: 'Capture to send', order: 40, unit: 'ms' },
        'Assembly delay (ms)': { id: 'latency-assembly', label: 'Assembly', order: 50, unit: 'ms' },
        'Decode time (ms)': { id: 'latency-decode', label: 'Decode', order: 60, unit: 'ms' },
        'Jitter buffer (ms)': { id: 'latency-jitter', label: 'Jitter buffer', order: 70, unit: 'ms', state: jitterState },
        'Processing delay (ms)': { id: 'latency-processing', label: 'Processing', order: 80, unit: 'ms' },
        'Total latency (ms)': { id: 'latency-total', label: 'Total', order: 90, unit: 'ms', state: latencyState },
        // The same hop measured a second way, which only adds a second number to compare.
        'Post-capture (abs-ct) to send latency (ms)': { id: 'latency-capture-abs', label: 'Capture to send (abs)', order: 900, drop: true }
    };

    /** Values the library writes when there is nothing to report. */
    const unreadableValues = new Set(['', 'unknown', "can't calculate", 'n/a', 'nan', '-1']);
    /** Values that only mean "this browser does not expose it", which for our browsers is noise. */
    const hiddenValues = new Set(['chrome only']);

    const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    // What we last wrote into a row, so a mutation we caused ourselves can be told apart from the
    // library writing a new value. Without this the observer would loop on its own work.
    const lastRendered = new WeakMap<HTMLElement, string>();

    const enhanceStatRow = (row: HTMLElement) => {
        const text = (row.textContent ?? '').trim();
        const separator = text.indexOf(':');
        if (separator < 0) {
            return;
        }
        const libraryLabel = text.slice(0, separator).trim();
        const raw = text.slice(separator + 1).trim();
        const spec: StatSpec = statSpecs[libraryLabel] ?? {
            id: slugify(libraryLabel) || 'stat',
            label: libraryLabel,
            order: 500
        };
        const unreadable = unreadableValues.has(raw.toLowerCase());
        const readable = !unreadable;
        const number = parseFloat(raw.replace(/[^0-9.+-]/g, ''));

        row.dataset['stat'] = spec.id;
        row.classList.toggle('is-hidden', spec.drop === true || hiddenValues.has(raw.toLowerCase()));
        row.style.order = String(spec.order);

        const state = readable && spec.state && Number.isFinite(number) ? spec.state(number) : undefined;
        if (state) {
            row.dataset['state'] = state;
        } else {
            delete row.dataset['state'];
        }

        const key = document.createElement('span');
        key.className = 'stat-key';
        key.textContent = spec.label;

        const value = document.createElement('span');
        value.className = 'stat-value';
        value.textContent = readable ? raw : '—';
        if (readable && spec.unit) {
            const unit = document.createElement('span');
            unit.className = 'stat-unit';
            unit.textContent = spec.unit;
            value.appendChild(unit);
        }

        row.replaceChildren(key, value);
        lastRendered.set(row, (key.textContent ?? '') + (value.textContent ?? ''));
    };

    /** Rebuilds a row only when the library has actually written something new. */
    const enhanceIfChanged = (row: HTMLElement) => {
        if (lastRendered.get(row) === (row.textContent ?? '').trim()) {
            return;
        }
        enhanceStatRow(row);
    };

    const statsPanel = document.getElementById('stats-panel');
    const statsHeading = document.getElementById('statsHeading');
    const statsContent = document.getElementById('statsContent');

    // A tally light in the panel's heading: green while the picture is up, dark otherwise.
    if (statsHeading && !statsHeading.querySelector('.panel-dot')) {
        const dot = document.createElement('span');
        dot.className = 'panel-dot';
        statsHeading.prepend(dot);
    }
    const panelDot = statsHeading?.querySelector('.panel-dot') ?? null;

    // Shown only while neither section has a single usable number to report.
    const statsNote = document.createElement('p');
    statsNote.className = 'stats-note';
    statsNote.textContent = 'Waiting for the streamer to report stats…';
    if (statsContent && !statsContent.querySelector('.stats-note')) {
        statsContent.prepend(statsNote);
    }

    const setSectionTitle = (selector: string, title: string) => {
        const text = document.querySelector<HTMLElement>(`#stats-panel ${selector} > div`);
        if (text && text.textContent !== title) {
            text.textContent = title;
        }
    };

    const refreshStatsPanel = () => {
        if (!statsPanel) {
            return;
        }
        setSectionTitle('#statisticsHeader', 'Session');
        setSectionTitle('#latencyStatsHeader', 'Streamer latency');
        panelDot?.classList.toggle('is-live', currentStage === 'live');

        let readableRows = 0;
        statsPanel.querySelectorAll<HTMLElement>('.StatsResult > div').forEach((row) => {
            enhanceIfChanged(row);
            if (!row.classList.contains('is-hidden')) {
                readableRows += 1;
            }
        });

        // A section header with nothing under it is just a promise the streamer has not kept yet.
        statsPanel.querySelectorAll<HTMLElement>('section.settingsContainer').forEach((section) => {
            const rows = Array.from(section.querySelectorAll<HTMLElement>('.StatsResult > div'));
            section.classList.toggle('is-empty', !rows.some((row) => !row.classList.contains('is-hidden')));
        });

        statsNote.classList.toggle('is-hidden', readableRows > 0);
    };

    // The library rewrites a row's innerHTML on every stats tick, so an observer is the only way to
    // land our structure before the browser paints it - a timer would leave the plain text on screen
    // until its next turn. The diff guard in enhanceIfChanged keeps that from looping on our own
    // writes, and the slow pass behind it covers the readouts that change without touching the DOM.
    if (statsPanel) {
        new MutationObserver(() => refreshStatsPanel())
            .observe(statsPanel, { childList: true, subtree: true, characterData: true });
    }
    window.setInterval(refreshStatsPanel, 1000);
    refreshStatsPanel();

    const setStatus = (text: string) => {
        if (connState) {
            connState.textContent = text;
        }
    };

    const clearSlowHint = () => {
        if (slowHintTimer) {
            window.clearTimeout(slowHintTimer);
            slowHintTimer = 0;
        }
    };

    // Any stage before the picture is up can stall on something outside our control, so after a
    // while every one of them offers a line of reassurance plus an escape hatch.
    const armSlowHint = (stageName: LoaderStage) => {
        clearSlowHint();
        // The reconnect stage owns its own escape hatch and shows it from the first second.
        if (loaderRetry && stageName !== 'reconnecting') {
            loaderRetry.hidden = true;
        }
        const stuck = LOADER_STAGES[stageName].stuck;
        if (!stuck) {
            return;
        }
        slowHintTimer = window.setTimeout(() => {
            if (loaderFinished || currentStage !== stageName) {
                return;
            }
            if (loaderDetail) {
                loaderDetail.textContent = stuck;
            }
            if (loaderRetry) {
                loaderRetry.hidden = false;
            }
        }, 15000);
    };

    // Used for terminal or needs-a-click states: our loader steps aside and the library's own
    // overlay takes over, because those overlays carry the click action that recovers the stream.
    const yieldToLibraryUI = () => {
        loaderFinished = true;
        clearSlowHint();
        loader?.classList.add('is-hidden');
        armChromeHide();
    };

    const finishLoader = () => {
        loaderFinished = true;
        clearSlowHint();
        if (loaderRetry) {
            loaderRetry.hidden = true;
        }
        loader?.classList.add('is-done', 'is-hidden');
        // The library can still be showing its click-to-play overlay over a running video when a
        // freeze frame arrives early, so make sure it is not left covering the live picture.
        document.getElementById('playOverlay')?.classList.add('hiddenState');
        armChromeHide();
    };

    const setStage = (next: LoaderStage, force = false) => {
        if (loaderFinished && !force) {
            return;
        }
        if (!force) {
            if (next === currentStage) {
                return;
            }
            // Equal ranks never displace each other either: 'signalling' and 'reconnecting' share
            // a rank so a reconnect cannot be pushed back to a plain "Connecting…" by the library
            // announcing the next attempt.
            if (LOADER_RANK[next] <= LOADER_RANK[currentStage]) {
                return;
            }
        }
        const info = LOADER_STAGES[next];
        currentStage = next;
        loader?.setAttribute('data-stage', next);
        if (loaderTitle) {
            loaderTitle.textContent = info.title;
        }
        if (loaderDetail) {
            loaderDetail.textContent = info.detail;
        }
        setStatus(info.status);
        loaderSteps.forEach((step, index) => {
            // Once the loader is live every step has completed, including the final one it is
            // handing over on, so the rail finishes its ramp instead of leaving a dark dot.
            step.classList.toggle('is-done', index < info.step || next === 'live');
            step.classList.toggle('is-current', index === info.step && next !== 'live');
        });
        if (next === 'live') {
            finishLoader();
        } else {
            armSlowHint(next);
        }
    };

    const videoElement = () => document.querySelector<HTMLVideoElement>('#stage video');

    // Bring the loader back after it has been dismissed: a feed that drops goes through exactly
    // the same staged feedback as a first connection, which means reopening the surface it was
    // hidden with and letting the stage guard start fresh from there.
    const showLoaderAgain = (stage: LoaderStage) => {
        loaderFinished = false;
        clearSlowHint();
        loader?.classList.remove('is-hidden', 'is-done');
        currentStage = 'boot';
        setStage(stage, true);
    };

    // --- Self-healing reconnect ----------------------------------------------
    // The library retries a dropped connection a few times on its own. Once it gives up, this
    // loop takes over and keeps trying, with a growing gap between attempts, until the picture
    // is back - a wall display or a control room should never need a person to click anything.
    const RECONNECT_BACKOFF_MS = [3000, 5000, 10000, 20000, 30000];
    // How long the library's own retry gets before we start driving reconnects ourselves.
    const LIBRARY_GRACE_MS = 8000;
    // A transport that comes back but never delivers a first frame is a failure too, just a
    // slower one: it gets this long before we take it down and start the attempt again.
    const TRANSPORT_GRACE_MS = 20000;
    // A live picture whose frame counter stops advancing is a dropped feed too, just a quieter
    // one: the transport stays up while the streamer goes away.
    const STALL_MS = 6000;
    const STALL_FORCE_MS = 15000;
    const STALL_FORCE_COOLDOWN_MS = 45000;

    let reconnectTimer = 0;
    let reconnectStartedAt = 0;
    let reconnectAttempts = 0;
    let reconnectNextAt = 0;
    let reconnectActive = false;
    // Set while a reconnected transport is up but has not yet produced a picture.
    let transportUpAt = 0;
    // When the library's own retry stops getting the benefit of the doubt. It is re-armed by
    // every fresh fault, so a library that keeps retrying keeps the wheel.
    let libraryGraceUntil = 0;
    let lastStallForceAt = 0;
    let lastFrameAt = 0;
    let lastFrameCount = -1;
    let lastFrameTime = -1;
    let cue: '' | 'stall' | 'offline' = '';

    const showCue = (kind: 'stall' | 'offline', text: string) => {
        if (!stallChip) {
            return;
        }
        if (cue !== kind) {
            cue = kind;
            stallChip.dataset['cue'] = kind;
        }
        if (stallText) {
            stallText.textContent = text;
        }
        stallChip.hidden = false;
    };

    const hideCue = () => {
        cue = '';
        if (stallChip) {
            stallChip.hidden = true;
        }
    };

    const reconnectDelay = (attempt: number) =>
        RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];

    const reconnectDetail = () => {
        if (missingFeed) {
            return `“${missingFeed}” is not on air right now. It will play here as soon as the streamer publishes it.`;
        }
        if (transportUpAt) {
            return 'The connection is back. Waiting for the first frame…';
        }
        if (!reconnectActive) {
            return 'The stream dropped. Waiting for the server to answer…';
        }
        const wait = Math.ceil((reconnectNextAt - Date.now()) / 1000);
        return wait > 0 ? `The stream dropped. Trying again in ${wait}s…` : 'Reconnecting to the streamer…';
    };

    const endReconnect = () => {
        if (reconnectTimer) {
            window.clearInterval(reconnectTimer);
        }
        reconnectTimer = 0;
        reconnectStartedAt = 0;
        reconnectAttempts = 0;
        reconnectNextAt = 0;
        reconnectActive = false;
        transportUpAt = 0;
        libraryGraceUntil = 0;
        missingFeed = '';
        hideCue();
        if (loaderRetry) {
            loaderRetry.hidden = true;
            loaderRetry.textContent = 'Reconnect';
        }
    };

    const reconnectTick = () => {
        if (
            reconnectStartedAt &&
            !reconnectActive &&
            !transportUpAt &&
            !stream.isReconnecting() &&
            Date.now() >= libraryGraceUntil
        ) {
            // The library has stopped retrying; every attempt from here is ours.
            reconnectActive = true;
            reconnectNextAt = Date.now();
        }
        if (transportUpAt && Date.now() - transportUpAt >= TRANSPORT_GRACE_MS) {
            // The transport is up but never delivered a first frame, so the attempt is a dud:
            // take it down and start the next one rather than waiting on it forever.
            transportUpAt = 0;
            reconnectActive = true;
            reconnectNextAt = Date.now();
            libraryGraceUntil = Date.now() + LIBRARY_GRACE_MS;
        }
        if (reconnectActive && Date.now() >= reconnectNextAt) {
            if (stream.isReconnecting()) {
                // An attempt is already in flight - check back in a moment rather than stacking one.
                reconnectNextAt = Date.now() + 1000;
            } else {
                if (currentStage !== 'reconnecting') {
                    // The library got as far as a live transport before this attempt, so the loader
                    // has to be told the feed is being taken down again instead of being left on a
                    // stage that suggests the picture is about to arrive.
                    showLoaderAgain('reconnecting');
                }
                stream.reconnect();
                reconnectNextAt = Date.now() + reconnectDelay(reconnectAttempts);
                reconnectAttempts++;
            }
        }
        if (currentStage === 'reconnecting' && loaderDetail) {
            loaderDetail.textContent = reconnectDetail();
        }
        if (loaderRetry) {
            loaderRetry.hidden = false;
        }
    };

    const startReconnect = (mode: 'passive' | 'active') => {
        // Whatever transport was up before, it is gone now, and the library's retry earns a fresh
        // grace so a library that is still actively retrying keeps driving.
        transportUpAt = 0;
        libraryGraceUntil = Date.now() + LIBRARY_GRACE_MS;
        if (reconnectStartedAt) {
            // Already reconnecting. A later, more certain fault escalates the mode but never
            // restarts the attempt countdown.
            if (mode === 'active') {
                reconnectActive = true;
                reconnectNextAt = Math.min(reconnectNextAt || Number.MAX_SAFE_INTEGER, Date.now());
            }
            return;
        }
        hideCue();
        reconnectStartedAt = Date.now();
        reconnectActive = mode === 'active';
        reconnectAttempts = 0;
        reconnectNextAt = reconnectActive ? Date.now() : libraryGraceUntil;
        if (loaderRetry) {
            loaderRetry.textContent = 'Reconnect now';
        }
        showLoaderAgain('reconnecting');
        if (loaderDetail) {
            loaderDetail.textContent = reconnectDetail();
        }
        reconnectTimer = window.setInterval(reconnectTick, 1000);
    };

    const frameCount = (video: HTMLVideoElement): number => {
        const quality = video.getVideoPlaybackQuality?.();
        if (quality) {
            return quality.totalVideoFrames;
        }
        const legacy = (video as HTMLVideoElement & { webkitDecodedFrameCount?: number }).webkitDecodedFrameCount;
        return typeof legacy === 'number' ? legacy : -1;
    };

    // One second granularity is plenty: the cue is reassurance, and the forced reconnect behind
    // it is a last resort that must not be able to fire in a loop.
    const stallTick = () => {
        if (!loaderFinished || reconnectStartedAt || document.visibilityState !== 'visible') {
            return;
        }
        const video = videoElement();
        if (!video || video.paused || video.readyState < 2) {
            return;
        }
        const now = Date.now();
        const frames = frameCount(video);
        if (lastFrameCount < 0 || frames !== lastFrameCount || video.currentTime !== lastFrameTime) {
            lastFrameCount = frames;
            lastFrameTime = video.currentTime;
            lastFrameAt = now;
            if (cue === 'stall') {
                hideCue();
            }
            return;
        }
        const stalledFor = now - lastFrameAt;
        if (stalledFor >= STALL_MS) {
            showCue('stall', `Picture stalled for ${Math.round(stalledFor / 1000)}s`);
        }
        if (stalledFor >= STALL_FORCE_MS && now - lastStallForceAt >= STALL_FORCE_COOLDOWN_MS) {
            lastStallForceAt = now;
            startReconnect('active');
        }
    };

    // --- Screen wake lock ----------------------------------------------------
    // A control-room display is watched, not touched, so the screen must not sleep under it.
    // Unavailable on plain HTTP, where the browser withholds the API; that is not an error.
    interface WakeLockLike {
        release: () => Promise<void>;
        addEventListener: (type: 'release', listener: () => void) => void;
    }

    const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: string) => Promise<WakeLockLike> } })
        .wakeLock;
    let wakeLock: WakeLockLike | null = null;

    const acquireWakeLock = () => {
        if (!wakeLockApi || wakeLock || !loaderFinished || document.visibilityState !== 'visible') {
            return;
        }
        wakeLockApi
            .request('screen')
            .then((sentinel) => {
                wakeLock = sentinel;
                sentinel.addEventListener('release', () => {
                    wakeLock = null;
                });
            })
            .catch(() => {
                /* Refused, e.g. over plain HTTP, or the tab is not in the foreground. */
            });
    };

    const releaseWakeLock = () => {
        const held = wakeLock;
        wakeLock = null;
        held?.release().catch(() => {
            /* Already gone; releasing twice is harmless. */
        });
    };

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            acquireWakeLock();
            wakeChrome();
        } else {
            releaseWakeLock();
        }
    });

    const stopPlaybackPoll = () => {
        if (playbackPoller) {
            window.clearInterval(playbackPoller);
            playbackPoller = 0;
        }
    };

    const markLive = () => {
        stopPlaybackPoll();
        // The picture is back: stand the reconnect loop and any stall cue down before the loader
        // is dismissed, so nothing can overwrite the live stage underneath finishLoader.
        endReconnect();
        lastFrameAt = Date.now();
        lastFrameCount = -1;
        setStage('live');
        const video = videoElement();
        if (video) {
            audioMuted = video.muted;
        }
        renderSoundState();
        if (soundToggle && !bareMode) {
            soundToggle.hidden = false;
        }
        acquireWakeLock();
    };

    // 'playStream' fires before the media actually starts, so watch for real playback.
    const listenForPlaying = () => {
        const video = videoElement();
        if (!video || video.dataset['playingWatched'] === '1') {
            return;
        }
        video.dataset['playingWatched'] = '1';
        video.addEventListener('playing', markLive);
    };

    const watchForPlayback = () => {
        if (playbackPoller || loaderFinished) {
            return;
        }
        let tries = 0;
        playbackPoller = window.setInterval(() => {
            const video = videoElement();
            if (video && !video.paused && video.readyState >= 2) {
                listenForPlaying();
                markLive();
                return;
            }
            if (++tries > 240) {
                stopPlaybackPoll();
            }
        }, 250);
    };

    const renderSoundState = () => {
        if (!soundToggle) {
            return;
        }
        soundToggle.classList.toggle('is-muted', audioMuted);
        soundToggle.setAttribute('aria-pressed', String(!audioMuted));
        soundToggle.title = audioMuted ? 'Unmute stream audio' : 'Mute stream audio';
        if (soundLabel) {
            soundLabel.textContent = audioMuted ? 'Muted' : 'Sound on';
        }
    };

    // The ui-library has no audio control of its own and the SFU plays audio through a detached
    // element, so the mute flag has to be flipped before replaying the stream.
    const setAudioMuted = (muted: boolean, replay: boolean) => {
        audioMuted = muted;
        config.setFlagEnabled(Flags.StartVideoMuted, muted);
        renderSoundState();
        if (replay) {
            stream.play();
        }
    };

    soundToggle?.addEventListener('click', () => setAudioMuted(!audioMuted, true));

    // The escape hatch is now a "hurry up" for the reconnect loop, and only a plain reconnect
    // during a first connection.
    loaderRetry?.addEventListener('click', () => {
        if (reconnectStartedAt) {
            reconnectActive = true;
            reconnectNextAt = Date.now();
            reconnectTick();
            return;
        }
        if (loaderRetry) {
            loaderRetry.hidden = true;
        }
        setStage('signalling', true);
        stream.reconnect();
    });

    stream.addEventListener('webRtcAutoConnect', () => setStage('signalling'));
    stream.addEventListener('webRtcConnecting', () => setStage('signalling'));
    stream.addEventListener('webRtcSdp', () => setStage('negotiating'));
    stream.addEventListener('webRtcConnected', () => {
        // The transport is back, so this reconnect episode is over: the library is in charge of
        // bringing the picture up from here, and calling reconnect() again would tear down a
        // working connection before it ever got the chance to play. A transport that connects but
        // never delivers a frame is caught by the grace in reconnectTick instead.
        if (reconnectStartedAt) {
            transportUpAt = Date.now();
            libraryGraceUntil = Date.now() + LIBRARY_GRACE_MS;
            reconnectActive = false;
            reconnectNextAt = 0;
            reconnectAttempts = 0;
        }
        setStage('waiting');
    });

    stream.addEventListener('streamLoading', () => setStage('starting'));
    stream.addEventListener('videoInitialized', () => {
        listenForPlaying();
        setStage('starting');
    });
    stream.addEventListener('playStream', () => {
        setStage('starting');
        watchForPlayback();
    });

    stream.addEventListener('playStreamRejected', () => {
        // Browsers block autoplay with sound until the page has been interacted with. Muted
        // autoplay is always allowed, so retry once and let the sound button bring it back.
        if (mutedRetryUsed || currentStage === 'live') {
            return;
        }
        mutedRetryUsed = true;
        setAudioMuted(true, false);
        setStage('starting');
        stream.play();
    });

    stream.addEventListener('streamerListMessage', (event) => {
        if (event.data.autoSelectedStreamerId) {
            missingFeed = '';
            setStage('starting');
            return;
        }
        const listed = event.data.messageStreamerList?.ids ?? [];
        if (requestedFeed && !listed.includes(requestedFeed)) {
            // Opened for a named feed that the signaller does not have yet: name it and keep
            // waiting, rather than handing over to a library screen that never appears.
            missingFeed = requestedFeed;
            startReconnect('passive');
            return;
        }
        yieldToLibraryUI();
    });

    stream.addEventListener('webRtcDisconnected', (event) => {
        // allowClickToReconnect false means the library has stopped retrying on its own, so this
        // has to be an active reconnect; true means it is already retrying and we only watch it.
        startReconnect(event.data.allowClickToReconnect === false ? 'active' : 'passive');
    });
    stream.addEventListener('webRtcFailed', () => startReconnect('active'));
    stream.addEventListener('playStreamError', () => startReconnect('active'));
    stream.addEventListener('subscribeFailed', () => startReconnect('active'));

    // --- Picture quality -----------------------------------------------------
    // The streamer reports the encoder's average quantisation parameter over the data channel.
    // 0 means "nothing reported" (the library also zeroes it on disconnect), so the chip stays
    // out of the way rather than showing a meaningless number.
    const qpBand = (qp: number) => (qp <= 24 ? 'good' : qp <= 40 ? 'fair' : 'low');

    const renderQp = () => {
        if (!qpChip || !qpValueEl) {
            return;
        }
        if (qpValue <= 0 || !loaderFinished) {
            qpChip.hidden = true;
            return;
        }
        qpValueEl.textContent = String(qpValue);
        qpChip.dataset['qp'] = qpBand(qpValue);
        qpChip.title = `Video quantization parameter: ${qpValue} (lower means crisper)`;
        qpChip.hidden = false;
    };

    stream.addEventListener('videoEncoderAvgQP', (event) => {
        qpValue = typeof event.data?.avgQP === 'number' ? event.data.avgQP : 0;
        renderQp();
    });

    // --- Picture in picture --------------------------------------------------
    const pipSupported = document.pictureInPictureEnabled === true && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';

    const syncPipState = () => {
        const active = !!document.pictureInPictureElement;
        pipToggle?.classList.toggle('is-active', active);
        if (pipToggle) {
            pipToggle.title = active ? 'Leave picture in picture (P)' : 'Open in a floating window (P)';
        }
    };

    const togglePip = () => {
        const video = videoElement();
        if (!video) {
            return;
        }
        const request = document.pictureInPictureElement
            ? document.exitPictureInPicture()
            : video.requestPictureInPicture();
        request
            .then(syncPipState)
            .catch(() => {
                /* The browser refused, e.g. the video is not ready yet. */
            });
    };

    if (pipToggle && pipSupported) {
        pipToggle.hidden = false;
        pipToggle.addEventListener('click', togglePip);
        document.addEventListener('enterpictureinpicture', syncPipState);
        document.addEventListener('leavepictureinpicture', syncPipState);
    }

    // --- Shortcuts and help --------------------------------------------------
    const setHelpOpen = (open: boolean) => {
        if (!helpCard) {
            return;
        }
        helpCard.hidden = !open;
        helpToggle?.classList.toggle('is-active', open);
        helpToggle?.setAttribute('aria-pressed', String(open));
        if (open) {
            wakeChrome();
            if (keyHint) {
                keyHint.hidden = true;
            }
        } else {
            armChromeHide();
        }
    };

    helpToggle?.addEventListener('click', () => setHelpOpen(!!helpCard?.hidden));
    helpClose?.addEventListener('click', () => setHelpOpen(false));

    const isTypingTarget = (target: EventTarget | null) => {
        const element = target as HTMLElement | null;
        if (!element) {
            return false;
        }
        return (
            element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.tagName === 'SELECT' ||
            element.isContentEditable
        );
    };

    // Deliberately no preventDefault: the library binds its own keys (e.g. 'm' for mute in some
    // builds) and a shortcut that swallows them would be worse than one that does nothing.
    window.addEventListener('keydown', (event) => {
        if (bareMode || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
            return;
        }
        switch (event.key) {
            case 'm':
            case 'M':
                setAudioMuted(!audioMuted, true);
                wakeChrome();
                break;
            case 'f':
            case 'F':
                document.getElementById('fullscreenToggle')?.click();
                break;
            case 'p':
            case 'P':
                if (pipSupported) {
                    togglePip();
                }
                break;
            case 's':
            case 'S':
                document.getElementById('statsToggle')?.click();
                break;
            case '?':
            case 'h':
                setHelpOpen(!!helpCard?.hidden);
                break;
            case 'Escape':
                if (helpCard && !helpCard.hidden) {
                    setHelpOpen(false);
                } else if (document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(() => {
                        /* Nothing to leave. */
                    });
                } else if (document.fullscreenElement) {
                    document.exitFullscreen().catch(() => {
                        /* Nothing to leave. */
                    });
                }
                break;
            default:
                return;
        }
        wakeChrome();
    });

    // Shown once per tab: after this it is a hint nobody reads, and the help card still lists
    // every shortcut.
    if (!bareMode && keyHint && !sessionStorage.getItem('ps.player.hint')) {
        sessionStorage.setItem('ps.player.hint', '1');
        window.setTimeout(() => {
            if (currentStage === 'live' && document.visibilityState === 'visible') {
                keyHint.hidden = false;
                window.setTimeout(() => {
                    keyHint.hidden = true;
                }, 8000);
            }
        }, 4000);
    }

    stallRetry?.addEventListener('click', () => startReconnect('active'));

    // Both loops run for the life of the page and each guards its own preconditions, so the
    // player never has to start and stop timers as the stream comes and goes.
    window.setInterval(stallTick, 1000);
    window.setInterval(() => {
        if (qpValue > 0 && loaderFinished) {
            renderQp();
        }
    }, 2000);

    renderSoundState();
    setStage('boot', true);

    // Installable shell. A service worker only exists in a secure context (https, or localhost),
    // so on a plain-HTTP LAN address this is simply skipped - the player must never depend on it.
    if (window.isSecureContext && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {
            /* no cached shell: the page is unaffected */
        });
    }

    window.pixelStreaming = stream;
    window.pixelStreamingApplication = application;
};
