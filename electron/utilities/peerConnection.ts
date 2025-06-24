// src/peerConnection.ts
import * as net from 'net';
import { MY_TCP_PORT, DiscoveredPeer, startDiscovery, stopDiscovery, getDiscoveredPeers } from './peerDiscovery';
import { hostname } from 'os';
import * as readline from 'readline'; // Import readline

// --- Configuration ---
const APP_ID = "MyAwesomeFileTransferApp";
const MY_PEER_NAME = hostname() || 'Unknown Device';

// --- Message Protocol Interfaces ---
interface BaseMessage {
    type: string;
    senderInstanceId: string;
    senderPeerName: string;
    timestamp: number;
}

interface ConnectionRequestMessage extends BaseMessage {
    type: "CONNECTION_REQUEST";
}

interface ConnectionAcceptMessage extends BaseMessage {
    type: "CONNECTION_ACCEPT";
}

interface ConnectionRejectMessage extends BaseMessage {
    type: "CONNECTION_REJECT";
    reason: string;
}

interface MessageData extends BaseMessage {
    type: "MESSAGE";
}

type PeerMessage = ConnectionRequestMessage | ConnectionAcceptMessage | ConnectionRejectMessage | MessageData;

// --- Callbacks for external logic (e.g., UI/Electron Main) ---
type ConnectionRequestListener = (peer: DiscoveredPeer, acceptCallback: () => void, rejectCallback: (reason: string) => void) => void;
type ConnectionStatusListener = (peer: DiscoveredPeer, status: 'accepted' | 'rejected' | 'failed', reason?: string) => void;
type PeerConnectedListener = (peer: DiscoveredPeer, socket: net.Socket) => void;

let onConnectionRequestCallback: ConnectionRequestListener | null = null;
let onConnectionStatusCallback: ConnectionStatusListener | null = null;
let onPeerConnectedCallback: PeerConnectedListener | null = null;

// --- TCP Server (Listener) ---
let server: net.Server | null = null;
const activeConnections = new Map<string, net.Socket>();

export function startTcpServer(
    onRequest: ConnectionRequestListener,
    onConnected: PeerConnectedListener,
    instanceId: string // Need instance ID to handle self-referencing
): void {
    if (server) {
        console.warn("[TCP Server] Server already running.");
        return;
    }

    onConnectionRequestCallback = onRequest;
    onPeerConnectedCallback = onConnected;

    server = net.createServer((socket) => {
        console.log(`[TCP Server] Incoming connection from ${socket.remoteAddress}:${socket.remotePort}`);

        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString();
            const messages = buffer.split('\n');
            buffer = messages.pop() || '';

            for (const msgString of messages) {
                if (msgString.trim() === '') continue;
                try {
                    const message: PeerMessage = JSON.parse(msgString);
                    // Ensure the senderInstanceId is the correct one for the peer, not our own APP_ID
                    if (message.type === "CONNECTION_REQUEST") {
                        handleIncomingMessage(socket, message, instanceId); // Pass instanceId
                    } else {
                        // Other messages are unexpected on the server after handshake, or handled by specific data handlers
                        console.warn(`[TCP Server] Unexpected message type after handshake attempt: ${message.type}`);
                    }

                } catch (e: unknown) {
                    let errorMessage = 'Unknown error parsing message';
                    if (e instanceof Error) errorMessage = e.message;
                    console.error(`[TCP Server] Error parsing incoming message from ${socket.remoteAddress}: ${errorMessage}`);
                }
            }
        });

        socket.on('end', () => {
            console.log(`[TCP Server] Connection ended from ${socket.remoteAddress}`);
            activeConnections.forEach((s, id) => {
                if (s === socket) {
                    activeConnections.delete(id);
                    console.log(`[TCP Server] Removed disconnected peer: ${id}`);
                }
            });
        });

        socket.on('error', (err: unknown) => {
            let errorMessage = 'Unknown error';
            if (err instanceof Error) errorMessage = err.message;
            console.error(`[TCP Server] Socket error for ${socket.remoteAddress}: ${errorMessage}`);
        });
    });

    server.listen(MY_TCP_PORT, () => {
        console.log(`[TCP Server] Listening for connections on port ${MY_TCP_PORT}`);
    });

    server.on('error', (err: unknown) => {
        let errorMessage = 'Unknown error';
        if (err instanceof Error) errorMessage = err.message;
        console.error(`[TCP Server] Server error: ${errorMessage}`);
        stopTcpServer();
    });
}

export function stopTcpServer(): void {
    if (server) {
        server.close(() => {
            console.log("[TCP Server] Server stopped.");
        });
        server = null;
    }
    activeConnections.forEach(socket => socket.destroy());
    activeConnections.clear();
    onConnectionRequestCallback = null;
    onPeerConnectedCallback = null;
}

function handleIncomingMessage(socket: net.Socket, message: PeerMessage, myInstanceId: string): void {
    const peerInfo: DiscoveredPeer = {
        appId: APP_ID,
        instanceId: message.senderInstanceId,
        peerName: message.senderPeerName,
        tcpPort: 0, // Not explicitly available in request, will get from discovery if needed
        timestamp: message.timestamp,
        lastSeen: Date.now(),
        ipAddress: socket.remoteAddress || 'unknown'
    };

    if (message.type === "CONNECTION_REQUEST") {
        console.log(`[TCP Server] Received connection request from ${message.senderPeerName} (${message.senderInstanceId}) at ${socket.remoteAddress}`);
        if (onConnectionRequestCallback) {
            const accept = () => {
                const response: ConnectionAcceptMessage = {
                    type: "CONNECTION_ACCEPT",
                    senderInstanceId: myInstanceId, // This needs to be the ID of this instance
                    senderPeerName: MY_PEER_NAME,
                    timestamp: Date.now()
                };
                socket.write(JSON.stringify(response) + '\n');
                activeConnections.set(peerInfo.instanceId, socket);
                onPeerConnectedCallback?.(peerInfo, socket);
                console.log(`[TCP Server] Accepted connection from ${peerInfo.peerName}`);
            };
            const reject = (reason: string) => {
                const response: ConnectionRejectMessage = {
                    type: "CONNECTION_REJECT",
                    senderInstanceId: myInstanceId, // This needs to be the ID of this instance
                    senderPeerName: MY_PEER_NAME,
                    reason: reason,
                    timestamp: Date.now()
                };
                socket.write(JSON.stringify(response) + '\n');
                socket.end();
                console.log(`[TCP Server] Rejected connection from ${peerInfo.peerName}. Reason: ${reason}`);
            };
            onConnectionRequestCallback(peerInfo, accept, reject);
        } else {
            const response: ConnectionRejectMessage = {
                type: "CONNECTION_REJECT",
                senderInstanceId: myInstanceId,
                senderPeerName: MY_PEER_NAME,
                reason: "No handler registered",
                timestamp: Date.now()
            };
            socket.write(JSON.stringify(response) + '\n');
            socket.end();
            console.warn(`[TCP Server] Auto-rejected connection from ${peerInfo.peerName}. No handler registered.`);
        }
    } else {
        console.warn(`[TCP Server] Unexpected message type: ${message.type}`);
    }
}


// --- TCP Client (Initiator) ---
export function connectToPeer(
    peer: DiscoveredPeer,
    onStatus: ConnectionStatusListener,
    onConnected: PeerConnectedListener,
    myInstanceId: string // Pass local instance ID for client
): void {
    if (activeConnections.has(peer.instanceId)) {
        console.log(`[TCP Client] Already connected to ${peer.peerName}.`);
        onStatus(peer, 'accepted');
        onConnected(peer, activeConnections.get(peer.instanceId)!);
        return;
    }

    onConnectionStatusCallback = onStatus;
    onPeerConnectedCallback = onConnected;

    const client = new net.Socket();
    let isHandshakeComplete = false;
    let buffer = '';

    client.connect(peer.tcpPort, peer.ipAddress, () => {
        console.log(`[TCP Client] Connected to ${peer.peerName} (${peer.ipAddress}:${peer.tcpPort})`);
        const request: ConnectionRequestMessage = {
            type: "CONNECTION_REQUEST",
            senderInstanceId: myInstanceId, // Use local instance ID
            senderPeerName: MY_PEER_NAME,
            timestamp: Date.now()
        };
        client.write(JSON.stringify(request) + '\n');
    });

    client.on('data', (data) => {
        buffer += data.toString();
        const messages = buffer.split('\n');
        buffer = messages.pop() || '';

        for (const msgString of messages) {
            if (msgString.trim() === '') continue;
            try {
                const response: PeerMessage = JSON.parse(msgString);
                if (response.type === "CONNECTION_ACCEPT" || response.type === "CONNECTION_REJECT") {
                    if (!isHandshakeComplete) {
                        handleConnectionResponse(peer, client, response);
                        isHandshakeComplete = true;
                    } else {
                        console.log(`[TCP Client] Received unexpected handshake response from ${peer.peerName} after handshake completed:`, response);
                    }
                } else {
                    if (response.type == "MESSAGE") {
                        console.log(`[TCP Client] Received data from ${peer.peerName} after handshake:`, response);
                    }
                    // This is where you'd handle file data chunks or other messages
                }
            } catch (e: unknown) {
                let errorMessage = 'Unknown error parsing data';
                if (e instanceof Error) errorMessage = e.message;
                console.error(`[TCP Client] Error parsing incoming data from ${peer.peerName}: ${errorMessage}`);
            }
        }
    });

    client.on('end', () => {
        console.log(`[TCP Client] Disconnected from ${peer.peerName}`);
        if (!isHandshakeComplete) {
            onConnectionStatusCallback?.(peer, 'failed', 'Connection closed before handshake completion.');
        }
    });

    client.on('error', (err: unknown) => {
        let errorMessage = 'Unknown error';
        if (err instanceof Error) errorMessage = err.message;
        console.error(`[TCP Client] Connection error with ${peer.peerName}: ${errorMessage}`);
        if (!isHandshakeComplete) {
            onConnectionStatusCallback?.(peer, 'failed', errorMessage);
        }
        client.destroy();
    });
}

function handleConnectionResponse(peer: DiscoveredPeer, socket: net.Socket, response: PeerMessage): void {
    if (response.type === "CONNECTION_ACCEPT") {
        console.log(`[TCP Client] Connection accepted by ${peer.peerName}`);
        activeConnections.set(peer.instanceId, socket);
        onConnectionStatusCallback?.(peer, 'accepted');
        onPeerConnectedCallback?.(peer, socket);
    } else if (response.type === "CONNECTION_REJECT") {
        console.log(`[TCP Client] Connection rejected by ${peer.peerName}. Reason: ${response.reason}`);
        onConnectionStatusCallback?.(peer, 'rejected', response.reason);
        socket.end();
    } else {
        console.warn(`[TCP Client] Unexpected response type during handshake: ${response.type}`);
        onConnectionStatusCallback?.(peer, 'failed', 'Unexpected handshake response');
        socket.end();
    }
}

export function getConnectedPeers(): DiscoveredPeer[] {
    // Return an array of DiscoveredPeer objects for active connections.
    // This would require storing more info with the socket in activeConnections map.
    // For now, just return placeholder or iterate based on instanceId if it maps to DiscoveredPeer.
    return Array.from(activeConnections.keys()).map(id => {
        const peer = getDiscoveredPeers().find(p => p.instanceId === id);
        return peer || { // Fallback if peer not found in discovery list (shouldn't happen often)
            appId: APP_ID, instanceId: id, peerName: `Connected Peer (${id.substring(0, 5)})`,
            tcpPort: 0, timestamp: 0, lastSeen: Date.now(), ipAddress: 'unknown'
        };
    });
}


// --- Standalone Test Mode ---
// This block will run when you execute this file directly.
if (require.main === module) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const MY_INSTANCE_ID = Math.random().toString(36).substring(2, 15); // Local instance ID for test

    console.log("--- Peer Connection Test Mode ---");
    rl.question("Are you the sender or receiver? (s/r): ", (answer) => {
        const role = answer.toLowerCase().trim();

        if (role === 'r') {
            console.log("\n*** ROLE: RECEIVER ***");
            console.log("Starting peer discovery and TCP server...");

            startDiscovery(undefined, MY_PEER_NAME); // Start broadcasting presence

            startTcpServer(
                (peer, accept, reject) => {
                    // Receiver's connection request handler
                    rl.question(`\nConnection request from ${peer.peerName} (${peer.ipAddress}). Accept (y) or Reject (n)? `, (response) => {
                        if (response.toLowerCase().trim() === 'y') {
                            accept();
                        } else {
                            reject("User denied connection.");
                        }
                    });
                },
                (peer, socket) => {
                    console.log(`\n[RECEIVER] Connection ESTABLISHED with ${peer.peerName}. You can now send/receive data.`);
                    socket.on('data', (data) => {
                        try {
                            const message = JSON.parse(data.toString());
                            console.log(`[RECEIVER] Received message from ${peer.peerName}:`, message);
                            if (message.type === "MESSAGE" && message.content === "Hello from client!") {
                                socket.write(JSON.stringify({ type: "MESSAGE", content: "Receiver says: Hello back!" }) + '\n');
                            }
                        } catch (e) {
                            console.error("[RECEIVER] Error parsing data:", e);
                        }
                    });
                },
                MY_INSTANCE_ID // Pass instance ID to server
            );

        } else if (role === 's') {
            console.log("\n*** ROLE: SENDER ***");
            console.log("Starting peer discovery. Will attempt to connect to the first discovered peer.");

            startDiscovery(undefined, MY_PEER_NAME); // Start broadcasting presence

            // Wait for peers to be discovered before attempting to connect
            const discoveryAttemptTimer = setInterval(() => {
                const peers = getDiscoveredPeers();
                const connectablePeers = peers.filter(p => p.instanceId !== MY_INSTANCE_ID); // Exclude self

                if (connectablePeers.length > 0) {
                    clearInterval(discoveryAttemptTimer);
                    const peerToConnect = connectablePeers[0];
                    console.log(`\n[SENDER] Found peer: ${peerToConnect.peerName} (${peerToConnect.ipAddress}:${peerToConnect.tcpPort}). Attempting to connect...`);

                    connectToPeer(
                        peerToConnect,
                        (peer, status, reason) => {
                            console.log(`[SENDER] Connection status with ${peer.peerName}: ${status}${reason ? ` (${reason})` : ''}`);
                            if (status === 'accepted') {
                                // Once connected, you could prompt the sender to send a file here.
                                console.log("[SENDER] Connection ready! You can send data now.");
                            } else if (status === 'rejected' || status === 'failed') {
                                console.log("[SENDER] Connection failed or rejected. Please try another peer.");
                            }
                        },
                        (peer, socket) => {
                            console.log(`[SENDER] Connection ESTABLISHED with ${peer.peerName}.`);
                            socket.on('data', (data) => {
                                try {
                                    const message = JSON.parse(data.toString());
                                    console.log(`[SENDER] Received message from ${peer.peerName}:`, message);
                                } catch (e) {
                                    console.error("[SENDER] Error parsing data:", e);
                                }
                            });
                            // For testing, send a greeting message after connection
                            setTimeout(() => {
                                socket.write(JSON.stringify({ type: "MESSAGE", content: "Hello from client!" }) + '\n');
                            }, 1000);
                        },
                        MY_INSTANCE_ID // Pass instance ID to client
                    );
                } else {
                    console.log("[SENDER] Waiting for peers to be discovered...");
                }
            }, 3000); // Check for peers every 3 seconds

        } else {
            console.log("Invalid role. Please enter 's' for sender or 'r' for receiver.");
            rl.close();
            process.exit(1);
        }

        // Close readline interface after initial question, but keep process alive
        rl.on('close', () => {
            console.log("\n--- Exiting test mode ---");
            stopTcpServer();
            stopDiscovery();
            process.exit(0);
        });
    });
}