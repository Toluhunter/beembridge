// src/peerConnection.ts
import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import { MY_TCP_PORT, DiscoveredPeer, startDiscovery, stopDiscovery, getDiscoveredPeers } from './peerDiscovery';
import { hostname } from 'os';
import * as readline from 'readline';
import * as path from 'path';
import { buildFramedMessage, FrameParser } from './framingProtocol';
import { initiateFileTransfer, calculateFileHash } from './transfer/sender';
import { handleIncomingFileTransfer } from './transfer/receiver';

// --- Configuration ---
const APP_ID = "MyAwesomeFileTransferApp";
const MY_PEER_NAME = hostname() || 'Unknown Device';
const frameparser = new FrameParser();

// --- Message Protocol Interfaces ---
interface BaseMessage {
    type: string;
    senderInstanceId: string;
    senderPeerName: string;
    timestamp: number;
}

interface ConnectionRequestMessage extends BaseMessage {
    type: "CONNECTION_REQUEST";
    senderAppId: string;
    senderTcpPort: number;
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

        socket.once('data', (data) => {
            const messages = frameparser.feed(data);

            for (const data of messages) {
                try {
                    const message = data.header as PeerMessage;
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
        peerInfo.tcpPort = message.senderTcpPort;
        if (onConnectionRequestCallback) {
            const accept = () => {
                const response: ConnectionAcceptMessage = {
                    type: "CONNECTION_ACCEPT",
                    senderInstanceId: myInstanceId, // This needs to be the ID of this instance
                    senderPeerName: MY_PEER_NAME,
                    timestamp: Date.now()
                };

                socket.write(buildFramedMessage(response));
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
                socket.write(buildFramedMessage(response));
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
            socket.write(buildFramedMessage(response));
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
    peerName: string = MY_PEER_NAME,
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

    client.connect(peer.tcpPort, peer.ipAddress, () => {
        console.log(`[TCP Client] Connected to ${peer.peerName} (${peer.ipAddress}:${peer.tcpPort})`);
        const request: ConnectionRequestMessage = {
            type: "CONNECTION_REQUEST",
            senderInstanceId: myInstanceId, // Use local instance ID
            senderPeerName: peerName,
            senderAppId: APP_ID,
            senderTcpPort: MY_TCP_PORT,
            timestamp: Date.now()
        };
        client.write(buildFramedMessage(request));
    });

    client.on('data', (data) => {
        const messages = frameparser.feed(data);

        for (const message of messages) {
            try {
                const response: PeerMessage = message.header as PeerMessage;
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
// src/peerConnection.ts (inside the if (require.main === module) block)
// ... (imports and existing code up to the test block)

// --- Standalone Test Mode ---
if (require.main === module) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const MY_INSTANCE_ID = Math.random().toString(36).substring(2, 15);
    const TEST_FILE_PATHS = [path.join(__dirname, 'test.mp4'), path.join(__dirname, 'test1.mp4')]; // Path to a dummy file for testing
    let connectionAttemptTimer: NodeJS.Timeout | null = null;

    console.log("--- Peer Connection & File Transfer Test Mode ---");
    rl.question("Are you the sender or receiver? (s/r): ", async (answer) => { // Make async
        const role = answer.toLowerCase().trim();

        // Start discovery for both roles immediately
        startDiscovery(undefined, MY_PEER_NAME);

        if (role === 'r') {
            console.log("\n*** ROLE: RECEIVER ***");
            console.log("Starting TCP server and waiting for connection requests...");

            startTcpServer(
                (peer, accept, reject) => {
                    // Receiver's connection request handler
                    rl.question(`\nConnection request from ${peer.peerName} (${peer.ipAddress}). Accept (y) or Reject (n)? (y/n) `, (response) => {
                        if (response.toLowerCase().trim() === 'y') {
                            stopDiscovery();
                            accept();
                        } else {
                            reject("User denied connection.");
                        }
                    });
                },
                (peer, socket) => {
                    // This callback fires when a connection is ESTABLISHED (after handshake)
                    console.log(`\n[RECEIVER] Connection ESTABLISHED with ${peer.peerName}. Preparing to receive files.`);
                    const homeDir = os.homedir();

                    // Construct the path to the downloads folder
                    const downloadsDir = path.join(homeDir, 'Downloads');

                    // Construct the path to the beembridge-received folder inside downloads
                    const beembridgeReceivedDir = path.join(downloadsDir, 'beembridge-received');

                    // Ensure the directory exists
                    if (!fs.existsSync(beembridgeReceivedDir)) {
                        fs.mkdirSync(beembridgeReceivedDir, { recursive: true });
                    }

                    // Construct the final download path
                    const downloadDir = path.join(beembridgeReceivedDir, peer.instanceId);

                    // Now, tell the fileTransfer module to handle incoming messages on this socket
                    handleIncomingFileTransfer(
                        socket,
                        downloadDir, // Use a specific download directory for received files
                        peer,
                        MY_INSTANCE_ID,
                        MY_PEER_NAME,
                        (progress) => {
                            // Update UI progress in a real app
                            process.stdout.write(`\r[RECEIVER] Receiving ${progress.fileName}: ${progress.percentage.toFixed(2)}% (${(progress.transferredBytes / 1024).toFixed(0)}KB/${(progress.totalBytes / 1024).toFixed(0)}KB)`);
                        },
                        (result) => {
                            console.log(`\n[RECEIVER] Transfer ${result.fileName} ${result.status}. Path: ${result.receivedFilePath || 'N/A'}`);
                            // Cleanup UI/state in a real app
                        },
                        (fileId, message) => {
                            console.error(`
[RECEIVER] Transfer error for ${fileId}: ${message}`);
                        },
                        (progress) => {
                            process.stdout.write(`[RECEIVER] Hashing ${progress.filePath}: ${progress.percentage.toFixed(2)}%`);
                        },
                        (fileId, fileName, fileSize, senderPeerName, acceptFileCb) => {
                            acceptFileCb(fileId);

                        }
                    );
                },
                MY_INSTANCE_ID // Pass instance ID to server
            );

        } else if (role === 's') {
            console.log("\n*** ROLE: SENDER ***");
            console.log("Starting peer discovery. Will attempt to connect and send a test file to the first discovered peer.");

            let connectedPeer: DiscoveredPeer | null = null;

            // Wait for peers to be discovered before attempting to connect
            connectionAttemptTimer = setInterval(() => {
                const peers = getDiscoveredPeers();
                const connectablePeers = peers.filter(p => p.instanceId !== MY_INSTANCE_ID);

                if (connectablePeers.length > 0 && !connectedPeer) { // Only connect if not already connected
                    clearInterval(connectionAttemptTimer!);
                    const peerToConnect = connectablePeers[0];
                    console.log(`\n[SENDER] Found peer: ${peerToConnect.peerName} (${peerToConnect.ipAddress}:${peerToConnect.tcpPort}). Attempting to connect...`);

                    connectToPeer(
                        peerToConnect,
                        (peer, status, reason) => {
                            console.log(`[SENDER] Connection status with ${peer.peerName}: ${status}${reason ? ` (${reason})` : ''}`);
                            if (status === 'accepted') {
                                stopDiscovery();
                                connectedPeer = peer; // Mark as connected
                            } else if (status === 'rejected' || status === 'failed') {
                                console.log("[SENDER] Connection failed or rejected. Please try another peer.");
                                connectedPeer = null; // Reset to try again
                                // Optionally, restart the discovery attempt timer here if you want to retry
                            }
                        },
                        (peer, socket) => {
                            console.log(`[SENDER] Connection ESTABLISHED with ${peer.peerName}. Initiating file transfer.`);
                            // Connection is established, now initiate file transfer

                            TEST_FILE_PATHS.forEach(async (filePath) => {
                                const fileId = await calculateFileHash(filePath, (percentage) => {
                                    process.stdout.write(`\r[SENDER] Hashing ${path.basename(filePath)}: ${percentage.toFixed(2)}%`);
                                });
                                initiateFileTransfer(
                                    socket,
                                    fileId,
                                    filePath,
                                    MY_INSTANCE_ID,
                                    MY_PEER_NAME,
                                    (progress) => {
                                        // Update UI progress in a real app
                                        process.stdout.write(`\r[SENDER] Sending ${progress.fileName}: ${progress.percentage.toFixed(2)}% (${(progress.transferredBytes / 1024).toFixed(0)}KB/${(progress.totalBytes / 1024).toFixed(0)}KB)`);
                                    },
                                    (result) => {
                                        console.log(`\n[SENDER] Transfer ${result.fileName} ${result.status}.`);
                                        // Cleanup UI/state in a real app
                                        // socket.end(); // End connection after transfer
                                        // process.exit(0); // Exit sender after transfer
                                    },
                                    (fileId, message) => {
                                        console.error(`\n[SENDER] Transfer error for ${fileId}: ${message}`);
                                        socket.end();
                                        process.exit(1); // Exit sender on error
                                    }
                                );

                            })
                        },
                        MY_PEER_NAME, // Use the local peer name
                        MY_INSTANCE_ID
                    );
                } else if (!connectedPeer) {
                    console.log("[SENDER] Waiting for peers to be discovered...");
                }
            }, 3000); // Check for peers every 3 seconds

        } else {
            console.log("Invalid role. Please enter 's' for sender or 'r' for receiver.");
            rl.close();
            process.exit(1);
        }

        // Close readline interface and cleanup on process exit
        process.on('SIGINT', () => { // Ctrl+C
            console.log("\n--- Exiting test mode via SIGINT ---");
            if (connectionAttemptTimer) clearInterval(connectionAttemptTimer);
            rl.close();
            stopTcpServer();
            stopDiscovery();
            process.exit(0);
        });
        process.on('SIGTERM', () => { // Termination signal
            console.log("\n--- Exiting test mode via SIGTERM ---");
            if (connectionAttemptTimer) clearInterval(connectionAttemptTimer);
            rl.close();
            stopTcpServer();
            stopDiscovery();
            process.exit(0);
        });
    });
}
