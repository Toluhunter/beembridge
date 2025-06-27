// src/fileTransfer.ts
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For unique file IDs
import { createHash } from 'crypto'; // For checksums

import { buildFramedMessage, FrameParser } from './framingProtocol';

// --- File Transfer Configuration ---
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// --- File Transfer Message Interfaces ---
interface BaseTransferMessage {
    type: string;
    fileId: string;
    senderInstanceId: string;
    senderPeerName: string;
    timestamp: number;
}

interface FileMetadataMessage extends BaseTransferMessage {
    type: "FILE_METADATA";
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunkSize: number; // Nominal chunk size used by sender
}

interface FileMetadataAckMessage extends BaseTransferMessage {
    type: "FILE_METADATA_ACK";
    accepted: boolean;
    reason?: string;
}

interface FileChunkMessage extends BaseTransferMessage {
    type: "FILE_CHUNK";
    chunkIndex: number;
    actualChunkSize: number; // The actual bytes in this specific chunk
    checksum: string; // MD5 checksum of this chunk
}

interface FileChunkAckMessage extends BaseTransferMessage {
    type: "FILE_CHUNK_ACK";
    chunkIndex: number;
    success: boolean;
    reason?: string;
}

interface FileEndMessage extends BaseTransferMessage {
    type: "FILE_END";
    status: "completed" | "cancelled" | "error";
    finalChecksum?: string; // Optional: overall file checksum
    reason?: string;
}

interface TransferErrorMessage extends BaseTransferMessage {
    type: "TRANSFER_ERROR";
    message: string; // Human-readable error message
    details?: unknown; // Optional: more specific error details (e.g., stack trace, error object)
}

type TransferMessage =
    FileMetadataMessage |
    FileMetadataAckMessage |
    FileChunkMessage |
    FileChunkAckMessage |
    FileEndMessage |
    TransferErrorMessage;

// --- Progress/Status Callbacks ---
export type TransferProgressCallback = (progress: {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number; // Optional: speed calculation
}) => void;

export type TransferCompleteCallback = (result: {
    fileId: string | null;
    fileName: string;
    status: "completed" | "cancelled" | "error";
    message?: string;
    receivedFilePath?: string;
}) => void;

// --- Sender Logic ---
import { DiscoveredPeer } from './peerDiscovery'; // Used in both sender and receiver logic
export async function initiateFileTransfer(
    socket: net.Socket,
    filePath: string,
    senderInstanceId: string,
    senderPeerName: string,
    onProgress: TransferProgressCallback,
    onComplete: TransferCompleteCallback,
    onError: (fileId: string, message: string) => void
): Promise<void> {
    const fileId = uuidv4();
    const fileName = path.basename(filePath);
    let fileSize: number;

    try {
        const stats = await fs.promises.stat(filePath); // Use fs.promises.stat for async stat
        fileSize = stats.size;
    } catch (err: unknown) {
        if (err instanceof Error) {
            const errMsg = `[Sender] Failed to get file stats for ${filePath}: ${err.message}`;
            console.error(errMsg);
            onError(fileId, errMsg);
        }
        return;
    }

    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    let transferredBytes = 0;
    let currentChunkIndex = 0;
    let fileStream: fs.ReadStream | null = null;
    let paused = false;

    // Function to send error message to receiver
    const sendError = (msg: string, details?: unknown) => {
        const errorMessage: TransferErrorMessage = {
            type: "TRANSFER_ERROR",
            fileId,
            senderInstanceId,
            senderPeerName,
            timestamp: Date.now(),
            message: msg,
            details: details
        };
        socket.write(buildFramedMessage(errorMessage));
        onError(fileId, msg);
    };

    // --- Sender State & Control ---
    const sendFileChunk = (chunk: Buffer) => {
        return new Promise<void>((resolve, reject) => {
            const checksum = createHash('md5').update(chunk).digest('hex');
            const chunkMessage: FileChunkMessage = {
                type: "FILE_CHUNK",
                fileId,
                senderInstanceId,
                senderPeerName,
                timestamp: Date.now(),
                chunkIndex: currentChunkIndex,
                actualChunkSize: chunk.length,
                checksum: checksum,
            };

            const fullMessage = buildFramedMessage(chunkMessage, chunk);

            // Handle backpressure
            const canWrite = socket.write(fullMessage, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });

            if (!canWrite) {
                paused = true;
                console.log(`[Sender] Socket buffer full, pausing stream for file ${fileName}...`);
                fileStream?.pause();
                socket.once('drain', () => {
                    console.log(`[Sender] Socket drained, resuming stream for file ${fileName}.`);
                    paused = false;
                    fileStream?.resume();
                });
            }
        });
    };

    // --- Main Transfer Loop ---
    const startStreaming = async () => {
        fileStream = fs.createReadStream(filePath, { highWaterMark: CHUNK_SIZE });
        fileStream.on('data', (chunk: string | Buffer) => {
            if (typeof chunk === 'string') {
                // Should not happen since we are reading a file as Buffer, but guard just in case
                console.error(`[Sender] Received string chunk instead of Buffer for file ${fileName}. Skipping chunk.`);
                return;
            }
            fileStream!.pause(); // Pause stream immediately to manually control flow
            sendFileChunk(chunk)
                .then(() => {
                    transferredBytes += chunk.length; // Accumulate transferred bytes
                    currentChunkIndex++;
                    onProgress({
                        fileId,
                        fileName,
                        totalBytes: fileSize,
                        transferredBytes,
                        percentage: (transferredBytes / fileSize) * 100
                    });
                    if (!paused) { // Only resume if socket didn't signal backpressure
                        fileStream!.resume();
                    }
                })
                .catch((err: unknown) => {
                    if (err instanceof Error) {
                        const errMsg = `[Sender] Error sending chunk ${currentChunkIndex} for ${fileName}: ${err.message}`;
                        console.error(errMsg); // err is typically an Error object
                        fileStream?.destroy(); // Stop reading
                        sendError(errMsg);
                    }
                });
        });

        fileStream.on('end', () => {
            console.log(`[Sender] File stream for ${fileName} ended.`);
            const finalMessage: FileEndMessage = {
                type: "FILE_END",
                fileId,
                senderInstanceId,
                senderPeerName,
                timestamp: Date.now(),
                status: "completed",
            };
            socket.write(buildFramedMessage(finalMessage));
            onComplete({ fileId, fileName, status: "completed" });
            console.log(`[Sender] File ${fileName} transfer completed.`);
        });

        fileStream.on('error', (err: NodeJS.ErrnoException) => {
            const errMsg = `[Sender] File stream error for ${fileName}: ${err.message}`;
            console.error(errMsg);
            sendError(errMsg);
        });

        // Start processing the stream
        fileStream.resume();
    };


    // --- Handshake to start transfer ---
    const metadata: FileMetadataMessage = {
        type: "FILE_METADATA",
        fileId,
        fileName,
        fileSize,
        totalChunks,
        chunkSize: CHUNK_SIZE,
        senderInstanceId,
        senderPeerName,
        timestamp: Date.now(),
    };

    console.log(`[Sender] Sending metadata for file ${fileName} (${fileSize} bytes)...`);
    socket.write(buildFramedMessage(metadata));

    // Wait for metadata ACK from receiver
    const frameParser = new FrameParser();
    const handleMetadataAck = (data: Buffer) => {
        try {
            const messages = frameParser.feed(data);
            for (const msg of messages) {
                const header = msg.header as TransferMessage;
                if (header.type === "FILE_METADATA_ACK" && header.fileId === fileId) {
                    const ack = header as FileMetadataAckMessage;
                    if (ack.accepted) {
                        console.log(`[Sender] Receiver accepted metadata for ${fileName}. Starting transfer...`);
                        socket.off('data', handleMetadataAck); // Stop listening for ACK on this connection
                        startStreaming();
                    } else {
                        const errMsg = `[Sender] Receiver rejected metadata for ${fileName}: ${ack.reason || 'Unknown reason'}`;
                        console.error(errMsg);
                        sendError(errMsg);
                        socket.end(); // End connection or handle rejection
                    }
                    return; // Processed ACK, can stop
                }
            } // e is unknown from JSON.parse
        } catch (e: unknown) {
            if (e instanceof Error) {
                console.error(`[Sender] Error parsing metadata ACK from receiver: ${e.message}`);
                sendError(`Error parsing ACK: ${e.message}`);
                socket.end();
            }
        }
    };

    socket.on('data', handleMetadataAck); // Temporarily listen for ACK for metadata
    socket.on('error', (err: Error) => {
        if (socket.listenerCount('data') > 0) { // If we're still waiting for ACK
            sendError(`Connection error during metadata exchange: ${err.message}`);
            socket.end();
        }
    });
}

// --- Receiver Logic ---
interface IncomingTransferState {
    fileId: string;
    fileStream: fs.WriteStream | null;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    receivedBytes: number;
    expectedChunkIndex: number;
    // For out-of-order or duplicate detection (advanced)
    // receivedChunks: Set<number>;
    timeoutTimer: NodeJS.Timeout | null;
    remotePeer: DiscoveredPeer;
    onProgress: TransferProgressCallback;
    onComplete: TransferCompleteCallback;
    onError: (fileId: string, message: string) => void;
    currentFrameParser: FrameParser; // Each active transfer needs its own parser
}

const activeReceivingTransfers = new Map<string, IncomingTransferState>(); // Maps fileId to its state

export function handleIncomingFileTransfer(
    socket: net.Socket,
    remotePeer: DiscoveredPeer,
    myInstanceId: string,
    myPeerName: string,
    onProgress: TransferProgressCallback,
    onComplete: TransferCompleteCallback,
    onError: (fileId: string, message: string) => void,
    // Callback to request acceptance from main process (Electron specific)
    requestAcceptance: (
        fileId: string,
        fileName: string,
        fileSize: number,
        senderPeerName: string,
        acceptCallback: (fileId: string) => void,
        rejectCallback: (fileId: string, reason: string) => void
    ) => void
): void {
    const frameParser = new FrameParser();
    let currentFileId: string | null = null; // To link data to correct transfer state

    const sendMetadataAck = (fileId: string, accepted: boolean, reason?: string): void => {
        const ack: FileMetadataAckMessage = {
            type: "FILE_METADATA_ACK",
            fileId: fileId,
            senderInstanceId: myInstanceId,
            senderPeerName: myPeerName,
            timestamp: Date.now(),
            accepted: accepted,
            reason: reason
        };
        socket.write(buildFramedMessage(ack));
    };

    const sendChunkAck = (fileId: string, chunkIndex: number, success: boolean, reason?: string): void => {
        const ack: FileChunkAckMessage = {
            type: "FILE_CHUNK_ACK",
            fileId: fileId,
            chunkIndex: chunkIndex,
            senderInstanceId: myInstanceId,
            senderPeerName: myPeerName,
            timestamp: Date.now(),
            success: success,
            reason: reason
        };
        socket.write(buildFramedMessage(ack));
    };

    socket.on('data', (data) => {
        try {
            const messages = frameParser.feed(data);
            for (const msg of messages) {
                const header = msg.header as TransferMessage;
                const payload = msg.payload;

                if (currentFileId && header.fileId !== currentFileId) {
                    // This socket is already handling a transfer with currentFileId, but got message for another.
                    // This scenario needs robust error handling or multi-file transfer logic (multiple sockets or strict sequencing).
                    console.warn(`[Receiver] Received message for unexpected fileId ${header.fileId} on socket for ${currentFileId}`);
                    // Send error or close socket
                    socket.end(); // For now, just end
                    return;
                }

                if (header.type === "FILE_METADATA") {
                    const metadata = header as FileMetadataMessage;
                    if (activeReceivingTransfers.has(metadata.fileId)) {
                        console.warn(`[Receiver] Duplicate metadata for file ID ${metadata.fileId}. Rejecting.`);
                        sendMetadataAck(metadata.fileId, false, "Duplicate transfer request");
                        return;
                    }

                    console.log(`[Receiver] Received metadata for file ${metadata.fileName} (${metadata.fileSize} bytes) from ${remotePeer.peerName}.`);
                    currentFileId = metadata.fileId; // Set current file ID for this socket

                    requestAcceptance(
                        metadata.fileId,
                        metadata.fileName,
                        metadata.fileSize,
                        remotePeer.peerName,
                        (fileIdToAccept) => { // User accepted
                            const initialState: IncomingTransferState = {
                                fileId: fileIdToAccept,
                                fileStream: null,
                                fileName: metadata.fileName,
                                fileSize: metadata.fileSize,
                                totalChunks: metadata.totalChunks,
                                receivedBytes: 0,
                                expectedChunkIndex: 0,
                                timeoutTimer: null,
                                remotePeer,
                                onProgress,
                                onComplete,
                                onError,
                                currentFrameParser: frameParser // Pass parser so it can be reset
                            };
                            activeReceivingTransfers.set(fileIdToAccept, initialState);
                            setupReceiverStream(initialState); // Setup the write stream
                            sendMetadataAck(fileIdToAccept, true);
                        },
                        (fileIdToReject, reason) => { // User rejected
                            sendMetadataAck(fileIdToReject, false, reason);
                            currentFileId = null; // Clear state for this socket
                            // socket.end(); // Optionally end connection on reject
                        }
                    );
                } else if (header.type === "FILE_CHUNK") {
                    if (!currentFileId || !activeReceivingTransfers.has(currentFileId)) {
                        console.warn(`[Receiver] Received chunk for unknown/unaccepted file ID ${header.fileId}. Ignoring.`);
                        // Send error back, or close socket as this is an invalid state
                        return;
                    }
                    const state = activeReceivingTransfers.get(currentFileId)!;
                    const chunk = payload;
                    const chunkMsg = header as FileChunkMessage;

                    if (!chunk || chunk.length !== chunkMsg.actualChunkSize) {
                        console.error(`[Receiver] Mismatched chunk size for ${chunkMsg.fileId} chunk ${chunkMsg.chunkIndex}.`);
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Mismatched size");
                        onError(chunkMsg.fileId, "Chunk size mismatch");
                        return;
                    }

                    // Validate checksum
                    const calculatedChecksum = createHash('md5').update(chunk).digest('hex');
                    if (calculatedChecksum !== chunkMsg.checksum) {
                        console.error(`[Receiver] Checksum mismatch for ${chunkMsg.fileId} chunk ${chunkMsg.chunkIndex}.`);
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Checksum mismatch");
                        onError(chunkMsg.fileId, "Checksum mismatch");
                        return;
                    }

                    // Validate chunk index (simple sequential check)
                    if (chunkMsg.chunkIndex !== state.expectedChunkIndex) {
                        console.error(`[Receiver] Out of order chunk for ${chunkMsg.fileId}: Expected ${state.expectedChunkIndex}, got ${chunkMsg.chunkIndex}`);
                        // For simplicity, we just reject out-of-order chunks.
                        // In a real system, you'd buffer out-of-order chunks.
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Out of order chunk");
                        onError(chunkMsg.fileId, "Out of order chunk");
                        return;
                    }

                    // Write chunk to file
                    const canWrite = state.fileStream!.write(chunk);
                    state.receivedBytes += chunk.length;
                    state.expectedChunkIndex++;

                    state.onProgress({
                        fileId: state.fileId,
                        fileName: state.fileName,
                        totalBytes: state.fileSize,
                        transferredBytes: state.receivedBytes,
                        percentage: (state.receivedBytes / state.fileSize) * 100
                    });

                    sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, true);

                    // Handle backpressure from the file write stream
                    if (!canWrite) {
                        console.log(`[Receiver] File stream buffer full, pausing for file ${state.fileName}...`);
                        // This would typically involve pausing the *sender*, but our simple protocol doesn't support that yet.
                        // For now, it just means our write buffer is full.
                        state.fileStream!.once('drain', () => {
                            console.log(`[Receiver] File stream drained for ${state.fileName}.`);
                        });
                    }

                    // Reset timeout for this transfer
                    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                    state.timeoutTimer = setTimeout(() => {
                        console.warn(`[Receiver] Transfer ${state.fileName} timed out (no new chunks).`);
                        state.fileStream?.end();
                        state.onComplete({ fileId: currentFileId, fileName: state.fileName, status: "error", message: "Transfer timeout" });
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null; // Clear active transfer
                    }, 30000); // 30 seconds timeout
                } else if (header.type === "FILE_END") {
                    const endMessage = header as FileEndMessage;
                    if (!currentFileId || !activeReceivingTransfers.has(currentFileId) || endMessage.fileId !== currentFileId) {
                        console.warn(`[Receiver] Received FILE_END for unknown/unaccepted file ID ${header.fileId}. Ignoring.`);
                        return;
                    }
                    const state = activeReceivingTransfers.get(currentFileId)!;
                    state.fileStream?.end(() => {
                        console.log(`[Receiver] File ${state.fileName} transfer ended by sender. Status: ${endMessage.status}`);
                        if (endMessage.status === "completed") {
                            state.onComplete({
                                fileId: currentFileId,
                                fileName: state.fileName,
                                status: "completed",
                                receivedFilePath: state.fileStream!.path as string
                            });
                        } else {
                            state.onComplete({
                                fileId: currentFileId,
                                fileName: state.fileName,
                                status: endMessage.status,
                                message: endMessage.reason
                            });
                        }
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null; // Clear active transfer
                    });
                } else if (header.type === "TRANSFER_ERROR") {
                    const errorMessage = header as TransferErrorMessage;
                    console.error(`[Receiver] Transfer Error from sender for file ${errorMessage.fileId}: ${errorMessage.message}`);
                    if (activeReceivingTransfers.has(errorMessage.fileId)) {
                        const state = activeReceivingTransfers.get(errorMessage.fileId)!;
                        state.fileStream?.end();
                        state.onComplete({
                            fileId: errorMessage.fileId,
                            fileName: state.fileName,
                            status: "error",
                            message: `Sender reported error: ${errorMessage.message}`
                        });
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        activeReceivingTransfers.delete(errorMessage.fileId);
                    }
                    currentFileId = null; // Clear active transfer for this socket
                }
            }
        } catch (e: unknown) {
            let errorMessage = 'Unknown error parsing data';
            if (e instanceof Error) errorMessage = e.message;
            console.error(`[Receiver] Error processing incoming data from ${remotePeer.peerName}: ${errorMessage}`);
            // This might indicate a corrupted stream, so potentially close socket
            socket.end();
        }
    });

    socket.on('end', () => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            console.warn(`[Receiver] Socket disconnected for file ${state.fileName} unexpectedly during transfer.`);
            state.fileStream?.end(); // Close file stream
            state.onComplete({
                fileId: currentFileId,
                fileName: state.fileName,
                status: "error",
                message: "Socket disconnected unexpectedly"
            });
            if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
            activeReceivingTransfers.delete(currentFileId);
        }
        currentFileId = null;
        frameParser.reset(); // Reset parser state
    });

    socket.on('error', (err: Error) => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            console.error(`[Receiver] Socket error for file ${state.fileName}: ${err.message}`);
            state.fileStream?.end();
            state.onComplete({
                fileId: currentFileId,
                fileName: state.fileName,
                status: "error",
                message: `Socket error: ${err.message}`
            });
            if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
            activeReceivingTransfers.delete(currentFileId);
        }
        currentFileId = null;
        frameParser.reset();
    });
}

function setupReceiverStream(state: IncomingTransferState): void {
    // Determine the save path. For testing, saving to a 'received_files' subdirectory.
    const saveDir = path.join(process.cwd(), 'received_files');
    if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
    }
    const savePath = path.join(saveDir, state.fileName);

    state.fileStream = fs.createWriteStream(savePath);
    state.fileStream.on('error', (err) => {
        const errMsg = `[Receiver] File stream write error for ${state.fileName}: ${err.message}`;
        console.error(errMsg);
        state.onError(state.fileId, errMsg);
        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
        activeReceivingTransfers.delete(state.fileId);
    });
    console.log(`[Receiver] Ready to write file to: ${savePath}`);
}