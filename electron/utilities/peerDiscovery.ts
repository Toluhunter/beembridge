// src/peerDiscovery.ts

import * as dgram from 'dgram';
import { networkInterfaces, hostname } from 'os';
import { buildFramedMessage, FrameParser } from './framingProtocol';

// --- Configuration ---
const DISCOVERY_PORT: number = 55555; // UDP port for discovery messages
const BROADCAST_INTERVAL_MS: number = 2000; // How often to send broadcast beacons (2 seconds)
const PEER_TIMEOUT_MS: number = 6000; // How long before a peer is considered offline (6 seconds)

// Define the structure of a discovery message
interface DiscoveryMessage {
    appId: string;       // A unique ID for your application (e.g., "MyFileTransferApp_v1")
    instanceId: string;  // A unique ID for this specific running instance
    peerName: string;    // A user-friendly name for this peer (e.g., computer name or user-defined)
    tcpPort: number;     // The TCP port this instance is listening on for file transfers
    timestamp: number;   // To help detect stale messages
}

// Define the structure of a discovered peer for internal tracking
export interface DiscoveredPeer extends DiscoveryMessage { // Exported for use in renderer process types
    lastSeen: number; // Timestamp when the last beacon from this peer was received
    ipAddress: string; // The IP address of the peer (from the UDP packet)
}

// Global state
const discoveredPeers = new Map<string, DiscoveredPeer>(); // Key by instanceId
let discoverySocket: dgram.Socket | null = null;
let broadcastTimer: NodeJS.Timeout | null = null;
let peerCleanupTimer: NodeJS.Timeout | null = null;

// Callback function to send updates to the renderer process
// In Electron main process, this would be `event.sender.send`
type PeerUpdateSender = (channel: string, peers: DiscoveredPeer[]) => void;
let ipcPeerUpdateSender: PeerUpdateSender | null = null;
let currentPeerName: string = 'Unknown Device';

// --- Your App's Unique Identifiers ---
const APP_ID = "MyAwesomeFileTransferApp";
let instanceId = `UnkonwnInstance`; // Generate a random instance ID

function getRandomPort(min = 49152, max = 65535, excludedPorts: number[] = []) {
    let port: number;
    do {
        port = Math.floor(Math.random() * (max - min + 1)) + min;
    } while (excludedPorts.includes(port));
    return port;
}

// Example usage:
const excluded = [
    // Frequently-used ephemeral ports by apps or services
    49152, // Start of dynamic range - may be chosen often
    49153,
    49154,
    49155,
    49156,
    49157,
    49158,
    49159,
    49160,

    // Docker on Windows often uses these
    49664,
    49665,
    49666,
    49667,
    49668,
    49669,

    // Windows RPC services commonly use:
    49161, 49162, 49163, 49165, 49170,

    // Debug and local testing tools may bind to these
    50000, // Often used by Java debugging (JDWP)
    50001,
    50002,

    // Kubernetes / container platforms
    51000, // Some k8s components
    55000, // Common for Windows Defender / internal APIs

    // High ephemeral ports in use by testing tools or local frameworks
    60000,
    61000,
    62000,
    63000,
    64000
];
export const MY_TCP_PORT = getRandomPort(49152, 65535, excluded);
const frameparser = new FrameParser()

// --- Helper to get local IP addresses for broadcasting ---
function getLocalIpAddresses(): string[] {
    const interfaces = networkInterfaces();
    const addresses: string[] = [];
    for (const name in interfaces) {
        for (const iface of interfaces[name]!) {
            // Filter out non-IPv4, internal (loopback) addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    return addresses;
}

// --- Helper to send updates to renderer or console ---
function sendPeerUpdate(): void {
    const currentPeers = getDiscoveredPeers();
    if (ipcPeerUpdateSender) {
        // Send via IPC if the sender function is provided (e.g., in Electron main process)
        ipcPeerUpdateSender('peer-update', currentPeers);
    } else {
        // Default to console.log for testing or if no IPC sender is provided
        console.log(`[Discovery] Peer list updated (${currentPeers.length} active peers):`);
        currentPeers.forEach(peer => {
            console.log(`  - ${peer.peerName} (${peer.ipAddress}:${peer.tcpPort})`);
        });
    }
}

// --- Discovery Logic ---

export function startDiscovery(ipcSender?: PeerUpdateSender, peerName?: string, peerId?: string): void {
    if (discoverySocket) {
        console.warn("[Discovery] Discovery already running.");
        return;
    }

    if (ipcSender) {
        ipcPeerUpdateSender = ipcSender;
    }
    currentPeerName = peerName || hostname() || 'Unknown Device';
    instanceId = peerId || `${APP_ID}_${Math.random().toString(36).substring(2, 15)}`; // Generate a new instance ID if not provided

    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    discoverySocket.on('error', (err: unknown) => { // Use 'unknown' for catch clause variable
        let errorMessage = 'Unknown error';
        if (err instanceof Error) {
            errorMessage = err.message;
        } else if (typeof err === 'string') {
            errorMessage = err;
        }
        console.error(`[Discovery] UDP Socket Error: ${errorMessage}`);
        discoverySocket?.close();
        discoverySocket = null; // Mark as closed
    });

    discoverySocket.on('listening', () => {
        const address = discoverySocket!.address();
        console.log(`[Discovery] UDP listening on ${address.address}:${address.port}`);
        discoverySocket!.setBroadcast(true);
        startBroadcasting();
        startPeerCleanup();
        sendPeerUpdate(); // Initial update when discovery starts
    });

    discoverySocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        try {
            const messages = frameparser.feed(msg);

            for (const data of messages) {
                const message: DiscoveryMessage = data.header as DiscoveryMessage;

                if (message.instanceId === instanceId || message.appId !== APP_ID) {
                    return; // Ignore messages from myself or other apps
                }

                const peer: DiscoveredPeer = {
                    ...message,
                    lastSeen: Date.now(),
                    ipAddress: rinfo.address
                };

                if (!discoveredPeers.has(peer.instanceId)) {
                    console.log(`[Discovery] New peer UP: ${peer.peerName} (${peer.ipAddress}:${peer.tcpPort})`);
                    discoveredPeers.set(peer.instanceId, peer);
                    sendPeerUpdate(); // Send update when a new peer is discovered
                } else {
                    // Just update lastSeen for existing peer
                    discoveredPeers.get(peer.instanceId)!.lastSeen = Date.now();
                }

            }

        } catch (e: unknown) { // Use 'unknown' for catch clause variable
            let errorMessage = 'Unknown error parsing message';
            if (e instanceof Error) {
                errorMessage = e.message;
            } else if (typeof e === 'string') {
                errorMessage = e;
            }
            console.warn(`[Discovery] Failed to parse discovery message from ${rinfo.address}: ${errorMessage}`);
        }
    });

    discoverySocket.bind(DISCOVERY_PORT);
}

export function stopDiscovery(): void {
    if (broadcastTimer) {
        clearInterval(broadcastTimer);
        broadcastTimer = null;
    }
    if (peerCleanupTimer) {
        clearInterval(peerCleanupTimer);
        peerCleanupTimer = null;
    }
    if (discoverySocket) {
        console.log("[Discovery] Stopping UDP discovery...");
        discoverySocket.close();
        discoverySocket = null;
    }
    discoveredPeers.clear();
    sendPeerUpdate(); // Send final update when discovery stops (list is empty)
}

// --- Broadcasting (Advertising) Logic ---
function startBroadcasting(): void {
    const localIp = getLocalIpAddresses();
    if (localIp.length === 0) {
        console.warn("[Discovery] No active IPv4 network interfaces found to broadcast on.");
        return;
    }

    broadcastTimer = setInterval(() => {
        const message: DiscoveryMessage = {
            appId: APP_ID,
            instanceId: instanceId,
            peerName: currentPeerName,
            tcpPort: MY_TCP_PORT,
            timestamp: Date.now()
        };
        const buffer = buildFramedMessage(message);

        discoverySocket!.send(buffer, DISCOVERY_PORT, '255.255.255.255', (err: Error | null) => {
            if (err) {
                console.error(`[Discovery] Error sending broadcast: ${err.message}`);
            }
        });
    }, BROADCAST_INTERVAL_MS);
    console.log(`[Discovery] Broadcasting own presence every ${BROADCAST_INTERVAL_MS / 1000}s.`);
}

// --- Peer Cleanup Logic ---
function startPeerCleanup(): void {
    peerCleanupTimer = setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [instanceId, peer] of discoveredPeers.entries()) {
            if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
                console.log(`[Discovery] Peer DOWN (timeout): ${peer.peerName} (${peer.ipAddress})`);
                discoveredPeers.delete(instanceId);
                changed = true;
            }
        }
        if (changed) {
            sendPeerUpdate(); // Send update when peers are removed due to timeout
        }
    }, PEER_TIMEOUT_MS / 2); // Check half as frequently as timeout
}

export function getDiscoveredPeers(): DiscoveredPeer[] {
    return Array.from(discoveredPeers.values());
}

// --- Standalone Test Mode ---
// This block will only run if the file is executed directly (e.g., `node dist/peerDiscovery.js`)
// and not when imported as a module.
if (require.main === module) {
    console.log("Running Peer Discovery in standalone test mode.");
    startDiscovery(undefined, hostname() || 'TestDevice'); // No IPC sender provided, so it will use console.log

    // Simulate stopping discovery after some time for testing
    setTimeout(() => {
        stopDiscovery();
        console.log("Discovery stopped after 30 seconds for testing.");
        process.exit(0);
    }, 30000); // Stop after 30 seconds
}