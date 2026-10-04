const config = require('./config');
const WebSocket = require('ws');
const mediasoup = require('mediasoup');
const mediasoupSdp = require('@epicgames-ps/mediasoup-sdp-bridge');
const minimist = require('minimist');
const http = require('http');
const path = require('path');
const { SnapshotManager } = require('./snapshot_manager');

if (!config.retrySubscribeDelaySecs) {
    config.retrySubscribeDelaySecs = 10;
}

let mediasoupRouter;
let dataRouter;

// Every stream this process hosts, keyed by the streamer id it registers under
// on the signalling server.
//
// A single signalling connection can only ever be one streamer id and can only
// subscribe to one upstream streamer, so hosting N streams means holding N
// signalling connections. The mediasoup worker, router and data transport are
// shared between all of them.
const tenants = new Map();

// Auto-host mode: a dedicated signalling connection that only ever asks for the
// streamer list, so this process can discover and host streams that appear
// after startup. It never subscribes to anything, so it is deliberately kept
// out of `tenants` - it must not show up in the control API and must not be
// reaped when a streamer it saw disappears.
let discoveryTenant = null;
let discoveryPollTimer = null;
let autoHostCapWarned = false;

// Snapshot subsystem: decodes a JPEG preview per stream for the stream grid.
// Null when `config.snapshots.enabled` is false.
let snapshotManager = null;

// ---------------------------------------------------------------------------
// Data channel relay
// ---------------------------------------------------------------------------

async function createDataRouter() {
    const MULTIPLEX_MESSAGE_ID = 199; // ID | 2 byte length | PlayerId | Original message
    const CHANNEL_RELAY_STATUS_MESSAGE_ID = 198; // ID | 2 byte length | PlayerId | 1 byte flag

    if (!mediasoupRouter) {
        console.error('cannot initialize direct transport, router is undefined');
        throw new Error('mediasoupRouter is undefined');
    }
    const transport = await mediasoupRouter.createDirectTransport({ maxMessageSize: 262144 });

    // Streamer data producer per tenant, keyed by sfuId.
    const streamerProducers = new Map();
    // Player data producer, keyed by playerId.
    const playerProducers = new Map();

    function createMultiplexHeader(playerId) {
        const byteLength = 1 + 2 + playerId.length * 2;
        const buffer = Buffer.alloc(byteLength);
        let byteOffset = 0;
        buffer.writeUInt8(MULTIPLEX_MESSAGE_ID, byteOffset);
        byteOffset++;
        buffer.writeUInt16LE(playerId.length * 2, byteOffset);
        byteOffset += 2;
        for (let i = 0; i < playerId.length; i++) {
            buffer.writeUInt16LE(playerId.charCodeAt(i), byteOffset);
            byteOffset += 2;
        }
        return buffer;
    }

    function parseMultiplexHeader(message) {
        const type = message.readUInt8(0);
        if (type !== MULTIPLEX_MESSAGE_ID) {
            console.log("Received non multiplexed message type [%d]", type);
            return {
                playerId: ""
            };
        }
        const length = message.readUint16LE(1);
        const headerEnd = length + 3;
        return {
            playerId: new TextDecoder("utf-16").decode(message.subarray(3, headerEnd)),
            buffer: message.subarray(headerEnd, message.length)
        }
    }

    function createRelayStatusMessage(playerId, status) {
        const byteLength = 1 + 2 + playerId.length * 2 + 1;
        const buffer = Buffer.alloc(byteLength);
        let byteOffset = 0;
        buffer.writeUInt8(CHANNEL_RELAY_STATUS_MESSAGE_ID, byteOffset);
        byteOffset++;
        buffer.writeUInt16LE(playerId.length * 2, byteOffset);
        byteOffset += 2;
        for (let i = 0; i < playerId.length; i++) {
            buffer.writeUInt16LE(playerId.charCodeAt(i), byteOffset);
            byteOffset += 2;
        }
        buffer.writeUInt8(status, byteOffset);
        return buffer;
    }

    async function handleStreamer(tenant, dataProducer) {
        const consumer = await transport.consumeData({ dataProducerId: dataProducer.id });
        consumer.on('message', (message) => {
            const relayMessage = parseMultiplexHeader(message);
            if (relayMessage.playerId !== "" && playerProducers.has(relayMessage.playerId)) {
                playerProducers.get(relayMessage.playerId).send(relayMessage.buffer, 53);
            }
        });

        const previousProducer = streamerProducers.get(tenant.sfuId);
        if (previousProducer) {
            previousProducer.close();
        }

        const streamerProducer = await transport.produceData({ label: 'streamer-producer' });
        streamerProducers.set(tenant.sfuId, streamerProducer);

        dataProducer.on('close', () => {
            if (streamerProducers.get(tenant.sfuId) === streamerProducer) {
                streamerProducer.close();
                streamerProducers.delete(tenant.sfuId);
            }
        });

        return streamerProducer.id;
    }

    async function handlePlayer(tenant, dataProducer, playerId) {
        const streamerProducer = streamerProducers.get(tenant.sfuId);
        if (streamerProducer) {
            streamerProducer.send(createRelayStatusMessage(playerId, 1), 53);
        }

        const consumer = await transport.consumeData({ dataProducerId: dataProducer.id });
        consumer.on('message', (message) => {
            // Broadcast-only deployments keep the streamer send-only by dropping
            // anything a player tries to push upstream.
            if (config.blockPlayerToStreamerData) {
                return;
            }
            const producer = streamerProducers.get(tenant.sfuId);
            if (producer) {
                producer.send(Buffer.concat([createMultiplexHeader(playerId), message]), 53);
            }
        });

        const playerProducer = await transport.produceData({ label: 'player-producer' });
        playerProducers.set(playerId, playerProducer);

        dataProducer.on('close', () => {
            if (playerProducers.get(playerId) === playerProducer) {
                playerProducer.close();
                playerProducers.delete(playerId);
            }
            const producer = streamerProducers.get(tenant.sfuId);
            if (producer) {
                producer.send(createRelayStatusMessage(playerId, 0), 53);
            }
        });

        return playerProducer.id;
    }

    return {
        handleStreamer,
        handlePlayer
    };
}

// ---------------------------------------------------------------------------
// Tenant lifecycle
// ---------------------------------------------------------------------------

function createTenant(sfuId, subscribeStreamerId) {
    return {
        sfuId: sfuId,
        subscribeStreamerId: subscribeStreamerId || null,
        ws: null,
        streamer: null,
        peers: new Map(),
        scalabilityMode: "L1T1", // Scalability mode defaults to L1T1 and is set by the offer from the streamer
        reconnectTimer: null,
        subscribeRetryTimer: null,
        stopped: false,
        // Auto-host bookkeeping. `subscribeFailures` counts consecutive
        // listStreamers cycles where the target streamer was not present, so a
        // streamer that registers and then vanishes does not leave a tenant
        // retrying forever.
        subscribeFailures: 0,
        autoHosted: false,
        discoveryOnly: false
    };
}

function addTenant(sfuId, subscribeStreamerId, autoHosted) {
    if (tenants.has(sfuId)) {
        console.log("Tenant %s already exists, ignoring add.", sfuId);
        return tenants.get(sfuId);
    }

    const tenant = createTenant(sfuId, subscribeStreamerId);
    tenant.autoHosted = autoHosted === true;
    tenants.set(sfuId, tenant);
    console.log("Added tenant %s (subscribing to %s)", sfuId, tenant.subscribeStreamerId || "<first available streamer>");
    connectSignalling(tenant);
    return tenant;
}

function removeTenant(sfuId) {
    const tenant = tenants.get(sfuId);
    if (!tenant) {
        return false;
    }

    tenant.stopped = true;
    if (tenant.reconnectTimer) {
        clearTimeout(tenant.reconnectTimer);
        tenant.reconnectTimer = null;
    }
    if (tenant.subscribeRetryTimer) {
        clearTimeout(tenant.subscribeRetryTimer);
        tenant.subscribeRetryTimer = null;
    }

    disconnectAllPeers(tenant);
    closeStreamer(tenant);

    if (tenant.ws) {
        try {
            tenant.ws.close(1000, "Tenant removed");
        } catch (err) {
            console.error("Error closing websocket for tenant %s:", sfuId, err);
        }
        tenant.ws = null;
    }

    tenants.delete(sfuId);
    console.log("Removed tenant %s", sfuId);
    return true;
}

function closeStreamer(tenant) {
    if (tenant.streamer == null) {
        return;
    }
    if (snapshotManager) {
        snapshotManager.removeStream(tenant.sfuId);
    }
    for (const mediaProducer of tenant.streamer.producers) {
        mediaProducer.close();
    }
    tenant.streamer.transport.close();
    tenant.streamer = null;
}

function sendToSignalling(tenant, message) {
    if (tenant.ws && tenant.ws.readyState === WebSocket.OPEN) {
        tenant.ws.send(JSON.stringify(message));
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------

function connectSignalling(tenant) {
    if (tenant.stopped) {
        return;
    }

    console.log("[%s] Connecting to Signalling Server at %s", tenant.sfuId, config.signallingURL);
    const ws = new WebSocket(config.signallingURL);
    tenant.ws = ws;

    ws.addEventListener("open", _ => { console.log("[%s] Connected to signalling server", tenant.sfuId); });
    ws.addEventListener("error", result => { console.log("[%s] Error: %s", tenant.sfuId, result.message); });
    ws.addEventListener("message", result => {
        onSignallingMessage(tenant, result.data).catch(err => {
            console.error("[%s] Failed to handle signalling message:", tenant.sfuId, err);
        });
    });
    ws.addEventListener("close", result => {
        onStreamerDisconnected(tenant);
        console.log("[%s] Disconnected from signalling server: %s %s", tenant.sfuId, result.code, result.reason);
        if (tenant.stopped) {
            return;
        }
        console.log("[%s] Attempting reconnect to signalling server...", tenant.sfuId);
        tenant.reconnectTimer = setTimeout(() => {
            connectSignalling(tenant);
        }, 2000);
    });
}

async function onStreamerList(tenant, msg) {
    let success = false;

    // Remove every id this process registers under. With more than one tenant
    // the list also contains our sibling tenants, and subscribing to one of
    // those would create a loop. The discovery connection is not in `tenants`
    // but is registered under its own id, so it has to be added explicitly.
    const ownIds = new Set(tenants.keys());
    if (discoveryTenant) {
        ownIds.add(discoveryTenant.sfuId);
    }
    const ids = msg.ids.filter(id => !ownIds.has(id));

    // The discovery connection never subscribes. It only feeds the auto-host
    // logic with the current streamer list.
    if (tenant.discoveryOnly) {
        autoHostFromList(ids);
        return;
    }

    // subscribe to either the configured streamer, or if not configured, just grab the first id
    if (ids.length > 0) {
        if (tenant.subscribeStreamerId) {
            if (ids.includes(tenant.subscribeStreamerId)) {
                sendToSignalling(tenant, { type: 'subscribe', streamerId: tenant.subscribeStreamerId });
                success = true;
            }
        } else {
            sendToSignalling(tenant, { type: 'subscribe', streamerId: ids[0] });
            success = true;
        }
    }

    if (success) {
        tenant.subscribeFailures = 0;
        return;
    }

    // Auto-hosted tenants are reaped once their streamer has been missing for
    // long enough. Explicitly configured tenants keep retrying forever, which
    // is the pre-existing behaviour.
    if (tenant.autoHosted) {
        tenant.subscribeFailures += 1;
        const maxFailures = config.autoHost ? config.autoHost.maxSubscribeFailures : 0;
        if (maxFailures > 0 && tenant.subscribeFailures >= maxFailures) {
            console.log(
                "Auto-hosted tenant %s: streamer %s not seen for %d attempts, removing.",
                tenant.sfuId,
                tenant.subscribeStreamerId,
                tenant.subscribeFailures
            );
            removeTenant(tenant.sfuId);
            return;
        }
    }

    // did not subscribe to anything
    tenant.subscribeRetryTimer = setTimeout(function() {
        sendToSignalling(tenant, { type: 'listStreamers' });
    }, config.retrySubscribeDelaySecs * 1000);
}

// ---------------------------------------------------------------------------
// Auto-host
// ---------------------------------------------------------------------------

// Compile an optional regex from config, returning null when unset or invalid.
function compileOptionalRegex(pattern, label) {
    if (!pattern) {
        return null;
    }
    try {
        return new RegExp(pattern);
    } catch (err) {
        console.error("Invalid autoHost.%s regex %o: %s", label, pattern, err.message);
        return null;
    }
}

// Create a tenant for every streamer in the list that we are not already
// hosting and that passes the include/exclude filters.
function autoHostFromList(ids) {
    const autoHost = config.autoHost;
    if (!autoHost || !autoHost.enabled) {
        return;
    }

    const include = compileOptionalRegex(autoHost.include, "include");
    const exclude = compileOptionalRegex(autoHost.exclude, "exclude");
    const prefix = autoHost.sfuIdPrefix || "";
    const maxStreams = autoHost.maxStreams || 0;

    for (const streamerId of ids) {
        if (include && !include.test(streamerId)) {
            continue;
        }
        if (exclude && exclude.test(streamerId)) {
            continue;
        }

        const sfuId = prefix + streamerId;
        if (tenants.has(sfuId)) {
            continue;
        }

        if (maxStreams > 0 && tenants.size >= maxStreams) {
            if (!autoHostCapWarned) {
                console.log(
                    "Auto-host: maxStreams (%d) reached, not hosting %s or any further streamers.",
                    maxStreams,
                    streamerId
                );
                autoHostCapWarned = true;
            }
            return;
        }

        addTenant(sfuId, streamerId, true);
    }
}

// Start the dedicated discovery connection. It identifies under its own id and
// polls the streamer list, which is what drives autoHostFromList.
function startDiscovery() {
    const autoHost = config.autoHost;
    if (!autoHost || !autoHost.enabled) {
        return;
    }
    if (discoveryTenant) {
        return;
    }

    const discoveryId = autoHost.discoveryId || "SFU-Discovery";
    if (tenants.has(discoveryId)) {
        console.error("autoHost.discoveryId %s collides with a configured stream, not starting discovery.", discoveryId);
        return;
    }

    discoveryTenant = createTenant(discoveryId, null);
    discoveryTenant.discoveryOnly = true;

    console.log(
        "Auto-host enabled: discovery id %s, include %o, exclude %o, prefix %o, every %ds",
        discoveryId,
        autoHost.include || "<all>",
        autoHost.exclude || "<none>",
        autoHost.sfuIdPrefix || "",
        autoHost.discoveryIntervalSecs || 10
    );

    connectSignalling(discoveryTenant);

    const intervalSecs = Math.max(2, autoHost.discoveryIntervalSecs || 10);
    discoveryPollTimer = setInterval(function() {
        sendToSignalling(discoveryTenant, { type: 'listStreamers' });
    }, intervalSecs * 1000);
}

async function onIdentify(tenant) {
    sendToSignalling(tenant, { type: 'endpointId', id: tenant.sfuId });
    sendToSignalling(tenant, { type: 'listStreamers' });
}

async function onStreamerOffer(tenant, msg) {
    console.log("[%s] Got offer from streamer", tenant.sfuId);

    if (tenant.discoveryOnly) {
        console.error("[%s] Discovery connection received an offer, ignoring.", tenant.sfuId);
        return;
    }

    if (tenant.streamer != null) {
        tenant.ws.close(1013 /* Try again later */, 'Producer is already connected');
        return;
    }

    if (msg.scalabilityMode) {
        tenant.scalabilityMode = msg.scalabilityMode;
    }

    const transport = await createWebRtcTransport(tenant, "Streamer");
    const sdpEndpoint = mediasoupSdp.createSdpEndpoint(transport, mediasoupRouter.rtpCapabilities);
    const { producers, dataEnabled } = await sdpEndpoint.processOffer(msg.sdp, tenant.scalabilityMode);
    const multiplex = msg.multiplex;
    const sdpAnswer = sdpEndpoint.createAnswer();
    const answer = { type: "answer", sdp: sdpAnswer };

    console.log("[%s] Sending answer to streamer.", tenant.sfuId);
    sendToSignalling(tenant, answer);
    tenant.streamer = { transport: transport, producers: producers, dataEnabled: dataEnabled, multiplexChannels: multiplex };
    tenant.streamerSinceMs = Date.now();
}

function getNextStreamerSCTPId(tenant) {
    return tenant.streamer.transport.getNextSctpStreamId();
}

function onStreamerDisconnected(tenant) {
    if (tenant.stopped) {
        return;
    }

    console.log("[%s] Streamer disconnected", tenant.sfuId);
    disconnectAllPeers(tenant);

    if (tenant.streamer != null) {
        closeStreamer(tenant);
        sendToSignalling(tenant, { type: 'stopStreaming' });
    }

    // Always re-check the streamer list. A tenant whose streamer vanished must
    // be able to recover, and an auto-hosted tenant must be able to notice that
    // its streamer is gone so it can be reaped.
    tenant.subscribeRetryTimer = setTimeout(function() {
        sendToSignalling(tenant, { type: 'listStreamers' });
    }, config.retrySubscribeDelaySecs * 1000);
}

async function onPeerConnected(tenant, peerId) {
    console.log("[%s] Player %s joined", tenant.sfuId, peerId);

    if (tenant.streamer == null) {
        console.log("[%s] No streamer connected, ignoring player.", tenant.sfuId);
        return;
    }

    const transport = await createWebRtcTransport(tenant, "Peer " + peerId);
    const sdpEndpoint = mediasoupSdp.createSdpEndpoint(transport, mediasoupRouter.rtpCapabilities);

    // media consumers
    let consumers = [];
    try {
        for (const mediaProducer of tenant.streamer.producers) {
            const consumer = await transport.consume({ producerId: mediaProducer.id, rtpCapabilities: mediasoupRouter.rtpCapabilities });
            consumer.observer.on("layerschange", function() { console.log("[%s] layer changed! %s", tenant.sfuId, JSON.stringify(consumer.currentLayers)); });
            sdpEndpoint.addConsumer(consumer);
            consumers.push(consumer);
        }
    } catch (err) {
        console.error("[%s] transport.consume() failed:", tenant.sfuId, err);
        transport.close();
        return;
    }

    // data
    if (tenant.streamer.dataEnabled) {
        sdpEndpoint.receiveData();
    }

    const offerSignal = {
        type: "offer",
        playerId: peerId,
        sdp: sdpEndpoint.createOffer(),
        sfu: true, // indicate we're offering from sfu
        scalabilityMode: tenant.scalabilityMode
    };

    // send offer to peer
    sendToSignalling(tenant, offerSignal);

    const newPeer = {
        id: peerId,
        transport: transport,
        sdpEndpoint: sdpEndpoint,
        consumers: consumers
    };

    // add the new peer
    tenant.peers.set(peerId, newPeer);
}

async function setupPeerDataChannels(tenant, peerId) {
    const peer = tenant.peers.get(peerId);
    if (!peer) {
        console.error("[%s] Could not send browser any datachannels for peer=%s because peer was not found.", tenant.sfuId, peerId);
        return;
    }

    if (tenant.streamer == null) {
        console.error("[%s] No streamer connected, cannot set up datachannels for peer=%s.", tenant.sfuId, peerId);
        return;
    }

    if (tenant.streamer.multiplexChannels) {
        await setupMultiplexPeerDataChannels(tenant, peer);
        return;
    }

    const nextStreamerSCTPStreamId = getNextStreamerSCTPId(tenant);
    const nextPeerSCTPStreamId = getNextStreamerSCTPId(tenant);

    console.log("[%s] Attempting streamer SCTP id=%s", tenant.sfuId, nextStreamerSCTPStreamId);

    // streamer data producer (produces data for the peer)
    peer.streamerDataProducer = await tenant.streamer.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextStreamerSCTPStreamId, ordered: true } });

    console.log("[%s] Attempting peer SCTP id=%s", tenant.sfuId, nextPeerSCTPStreamId);

    // peer data producer (produces data for the streamer)
    peer.peerDataProducer = await peer.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextPeerSCTPStreamId, ordered: true } });

    // peer data consumer (consumes streamer data)
    peer.peerDataConsumer = await peer.transport.consumeData({ dataProducerId: peer.streamerDataProducer.id });

    // streamer data consumer (consumes peer data)
    peer.streamerDataConsumer = await tenant.streamer.transport.consumeData({ dataProducerId: peer.peerDataProducer.id });

    const peerSignal = {
        type: 'peerDataChannels',
        playerId: peerId,
        sendStreamId: peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.peerDataConsumer.sctpStreamParameters.streamId
    };

    // Send browser a message with a send/recv data channel SCTP stream id
    sendToSignalling(tenant, peerSignal);

}

async function setupMultiplexPeerDataChannels(tenant, peer) {
    //this will be always 0 as we are using only one producer
    const nextPeerSCTPStreamId = peer.transport.getNextSctpStreamId();
    peer.peerDataProducer = await peer.transport.produceData({ label: 'send-datachannel', sctpStreamParameters: { streamId: nextPeerSCTPStreamId, ordered: true } });

    const dataProducerId = await dataRouter.handlePlayer(tenant, peer.peerDataProducer, peer.id);
    peer.peerDataConsumer = await peer.transport.consumeData({ dataProducerId });
    console.log("[%s] peerProducerId %s, peerConsumerId %s", tenant.sfuId, peer.peerDataProducer.id, peer.peerDataConsumer.id);

    const peerSignal = {
        type: 'peerDataChannels',
        playerId: peer.id,
        sendStreamId: peer.peerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.peerDataConsumer.sctpStreamParameters.streamId
    };
    sendToSignalling(tenant, peerSignal);
}

async function setupStreamerDataChannelsForPeer(tenant, peerId) {
    if (tenant.streamer == null || tenant.streamer.multiplexChannels) {
        return;
    }

    const peer = tenant.peers.get(peerId);
    if (!peer) {
        console.error("[%s] Could not send streamer any datachannels for peer=%s because peer was not found.", tenant.sfuId, peerId);
        return;
    }

    if (!peer.streamerDataProducer || !peer.streamerDataConsumer) {
        console.error("[%s] There was no streamer data producer/consumer setup for peer=%s. Did you make sure to send \"dataChannelRequest\" first?", tenant.sfuId, peerId);
        return;
    }

    const streamerSignal = {
        type: "streamerDataChannels",
        playerId: peerId,
        sendStreamId: peer.streamerDataProducer.sctpStreamParameters.streamId,
        recvStreamId: peer.streamerDataConsumer.sctpStreamParameters.streamId
    };

    // send streamer a message with a send/recv data channel SCTP stream id
    sendToSignalling(tenant, streamerSignal);
}

async function onPeerAnswer(tenant, peerId, sdp) {
    console.log("[%s] Got answer from player %s", tenant.sfuId, peerId);

    const peer = tenant.peers.get(peerId);
    if (!peer) {
        console.error("[%s] Unable to find player %s", tenant.sfuId, peerId);
    }
    else {
        peer.sdpEndpoint.processAnswer(sdp);
    }
}

function onPeerDisconnected(tenant, peerId) {
    console.log("[%s] Player %s disconnected", tenant.sfuId, peerId);
    const peer = tenant.peers.get(peerId);
    if (peer != null) {
        for (const consumer of peer.consumers) {
            consumer.close();
        }
        if (peer.peerDataConsumer) {
            peer.peerDataConsumer.close();
            peer.peerDataProducer.close();
        }
        if (peer.streamerDataConsumer) {
            peer.streamerDataConsumer.close();
            peer.streamerDataProducer.close();
        }
        peer.transport.close();
    }
    tenant.peers.delete(peerId);
}

function disconnectAllPeers(tenant) {
    console.log("[%s] Disconnected all players", tenant.sfuId);
    for (const peerId of Array.from(tenant.peers.keys())) {
        onPeerDisconnected(tenant, peerId);
    }
}

function onLayerPreference(tenant, msg) {
    console.log("[%s] onLayerPreference: %s", tenant.sfuId, JSON.stringify(msg));
    const peer = tenant.peers.get(`${msg.playerId}`);
    if (peer != null) {
        for (const consumer of peer.consumers) {
            consumer.setPreferredLayers({ spatialLayer: msg.spatialLayer, temporalLayer: msg.temporalLayer });
        }
    }
}

async function onSignallingMessage(tenant, message) {
    //console.log(`Got MSG: ${message}`);
    const msg = JSON.parse(message);

    if (msg.type == 'offer') {
        await onStreamerOffer(tenant, msg);
    }
    else if (msg.type == 'answer') {
        await onPeerAnswer(tenant, msg.playerId, msg.sdp);
    }
    else if (msg.type == 'playerConnected') {
        await onPeerConnected(tenant, msg.playerId);
    }
    else if (msg.type == 'playerDisconnected') {
        onPeerDisconnected(tenant, msg.playerId);
    }
    else if (msg.type == 'streamerDisconnected') {
        onStreamerDisconnected(tenant);
    }
    else if (msg.type == 'dataChannelRequest') {
        await setupPeerDataChannels(tenant, msg.playerId);
    }
    else if (msg.type == 'peerDataChannelsReady') {
        await setupStreamerDataChannelsForPeer(tenant, msg.playerId);
    }
    else if (msg.type == 'layerPreference') {
        onLayerPreference(tenant, msg);
    }
    else if (msg.type == 'streamerList') {
        await onStreamerList(tenant, msg);
    }
    else if (msg.type == 'identify') {
        await onIdentify(tenant);
    }
}

async function startMediasoup() {
    const worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
    });

    worker.on('died', () => {
        console.error('mediasoup worker died (this should never happen)');
        process.exit(1);
    });

    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    return await worker.createRouter({ mediaCodecs });
}

async function onICEStateChange(tenant, identifier, iceState) {
    console.log("[%s] %s ICE state changed to %s", tenant.sfuId, identifier, iceState);

    if (identifier == 'Streamer' && iceState == 'completed') {
        if (tenant.streamer == null) {
            return;
        }

        // Media is flowing now, so the snapshot worker can consume the video
        // producer. Failure here must not take down the tenant.
        if (snapshotManager) {
            snapshotManager.addStream(tenant.sfuId, tenant.streamer.producers).catch(err => {
                console.error("[%s] Failed to start snapshot worker:", tenant.sfuId, err);
            });
        }

        if (tenant.streamer.multiplexChannels) {
            const nextStreamerSCTPStreamId = tenant.streamer.transport.getNextSctpStreamId();
            //this will always be 0 since we are using one producer only
            console.log("[%s] Attempting streamer SCTP id=%s", tenant.sfuId, nextStreamerSCTPStreamId);

            const producer = await tenant.streamer.transport.produceData({
                label: 'send-datachannel',
                sctpStreamParameters: { streamId: nextStreamerSCTPStreamId, ordered: true }
            });
            const dataProducerId = await dataRouter.handleStreamer(tenant, producer);
            const streamerDataConsumer = await tenant.streamer.transport.consumeData({ dataProducerId });
            console.log("[%s] Setting up sctp for the streamer, producer sctp id %s, consumer sctp id %s", tenant.sfuId, producer.sctpStreamParameters.streamId, streamerDataConsumer.sctpStreamParameters.streamId);
        }
        sendToSignalling(tenant, { type: 'startStreaming' });
    }
}

async function createWebRtcTransport(tenant, identifier) {
    const {
        listenIps,
        initialAvailableOutgoingBitrate
    } = config.mediasoup.webRtcTransport;

    const transport = await mediasoupRouter.createWebRtcTransport({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: false,
        preferUdp: true,
        enableSctp: true, // datachannels
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate
    });

    transport.on("icestatechange", (iceState) => {
        onICEStateChange(tenant, identifier, iceState).catch(err => {
            console.error("[%s] Failed to handle ICE state change:", tenant.sfuId, err);
        });
    });
    transport.on("iceselectedtuplechange", (iceTuple) => { console.log("[%s] %s ICE selected tuple %s", tenant.sfuId, identifier, JSON.stringify(iceTuple)); });
    transport.on("sctpstatechange", (sctpState) => { console.log("[%s] %s SCTP state changed to %s", tenant.sfuId, identifier, sctpState); });

    return transport;
}

// ---------------------------------------------------------------------------
// Control API
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    });
    res.end(payload);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 64 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (chunks.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (err) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function describeTenant(tenant) {
    return {
        sfuId: tenant.sfuId,
        subscribeStreamerId: tenant.subscribeStreamerId,
        connected: tenant.ws != null && tenant.ws.readyState === WebSocket.OPEN,
        streaming: tenant.streamer != null,
        players: tenant.peers.size,
        autoHosted: tenant.autoHosted === true
    };
}

async function handleControlRequest(req, res) {
    const controlConfig = config.controlApi;

    if (controlConfig.token) {
        const auth = req.headers['authorization'] || '';
        if (auth !== `Bearer ${controlConfig.token}`) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
        }
    }

    const url = new URL(req.url, 'http://localhost');
    const segments = url.pathname.split('/').filter(segment => segment.length > 0);

    if (req.method === 'GET' && url.pathname === '/streams') {
        sendJson(res, 200, { streams: Array.from(tenants.values()).map(describeTenant) });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/streams') {
        const body = await readJsonBody(req);
        if (!body.sfuId || typeof body.sfuId !== 'string') {
            sendJson(res, 400, { error: 'sfuId is required' });
            return;
        }
        if (tenants.has(body.sfuId)) {
            sendJson(res, 409, { error: `Stream ${body.sfuId} is already hosted by this SFU` });
            return;
        }
        const tenant = addTenant(body.sfuId, body.subscribeStreamerId);
        sendJson(res, 201, describeTenant(tenant));
        return;
    }

    if (req.method === 'DELETE' && segments.length === 2 && segments[0] === 'streams') {
        const sfuId = decodeURIComponent(segments[1]);
        if (!removeTenant(sfuId)) {
            sendJson(res, 404, { error: `Stream ${sfuId} is not hosted by this SFU` });
            return;
        }
        sendJson(res, 200, { removed: sfuId });
        return;
    }

    sendJson(res, 404, { error: 'Not found' });
}

function startControlApi() {
    const controlConfig = config.controlApi;
    if (!controlConfig || !controlConfig.enabled) {
        return;
    }

    const server = http.createServer((req, res) => {
        handleControlRequest(req, res).catch(err => {
            console.error('Control API error:', err);
            sendJson(res, 500, { error: String(err) });
        });
    });

    server.on('error', err => {
        console.error('Control API server error:', err);
    });

    server.listen(controlConfig.port, controlConfig.host, () => {
        console.log('Control API listening on %s:%s', controlConfig.host, controlConfig.port);
    });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function resolveSnapshotOptions() {
    const raw = config.snapshots || {};
    const baseDir = raw.outputDir
        ? path.resolve(raw.outputDir)
        : path.resolve(__dirname, 'snapshots');

    return {
        outputDir: baseDir,
        httpHost: raw.httpHost || '0.0.0.0',
        httpPort: raw.httpPort || 8891,
        maxConcurrent: raw.maxConcurrent || 8,
        width: raw.width || 320,
        quality: raw.quality || 5,
        refreshSeconds: raw.refreshSeconds || 60,
        ffmpegLogLevel: raw.ffmpegLogLevel || 'error',
        portRangeStart: raw.portRangeStart || 51000,
        ffmpegPath: raw.ffmpegPath || null
    };
}

function resolveStreamConfigs() {
    if (Array.isArray(config.streams) && config.streams.length > 0) {
        return config.streams.map(stream => ({
            sfuId: stream.sfuId,
            subscribeStreamerId: stream.subscribeStreamerId || null
        }));
    }

    // Legacy single-stream configuration. Skipped when auto-host is enabled and
    // no streams are listed, otherwise an auto-host-only deployment would also
    // create a useless tenant subscribing to `subscribeStreamerId`. List the
    // stream in `streams` above if you want a fixed tenant as well.
    if (config.autoHost && config.autoHost.enabled) {
        return [];
    }

    return [
        {
            sfuId: config.SFUId,
            subscribeStreamerId: config.subscribeStreamerId || null
        }
    ];
}

async function main() {
    var argv = minimist(process.argv.slice(2));

    if ('signallingURL' in argv) {
        config.signallingURL = argv['signallingURL'];
    }

    console.log('Starting Mediasoup...');
    console.log("Config = ");
    console.log(config);

    mediasoupRouter = await startMediasoup();
    dataRouter = await createDataRouter();

    for (const stream of resolveStreamConfigs()) {
        addTenant(stream.sfuId, stream.subscribeStreamerId);
    }

    startDiscovery();

    startControlApi();

    if (config.snapshots && config.snapshots.enabled) {
        snapshotManager = new SnapshotManager(mediasoupRouter, resolveSnapshotOptions());
        // The grid shows how long a feed has been up and how many people are
        // watching it, neither of which the snapshot subsystem can know on its
        // own. It is offered as a hook rather than pushed in so the snapshot
        // index stays the single place that describes a preview.
        snapshotManager.setStreamInfoProvider(sfuId => {
            const tenant = tenants.get(sfuId);
            if (tenant == null) {
                return null;
            }
            return {
                players: tenant.peers.size,
                sinceMs: tenant.streamer ? tenant.streamerSinceMs : null
            };
        });
        snapshotManager.startHttp();
    }
}

main().catch(err => {
    console.error('Fatal error during startup:', err);
    process.exit(1);
});
