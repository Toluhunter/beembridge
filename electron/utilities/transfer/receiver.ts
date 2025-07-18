/**
 * @file Manages the receiving end of a file transfer.
 * This module handles incoming file metadata, receives file chunks,
 * writes them to disk, manages backpressure, reconstructs the file,
 * and performs checksum validation.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto'; // For calculating checksums
import { DiscoveredPeer } from '../peerDiscovery'; // Used in both sender and receiver logic

import { buildFramedMessage, FrameParser } from '../framingProtocol';
import {
    TransferMessage,
    TransferProgressCallback,
    TransferCompleteCallback,
    IncomingTransferState,
    FileMetadataMessage,
    FileMetadataAckMessage,
    FileChunkMessage,
    FileChunkAckMessage,
    FileEndMessage,
    QueueFullMessage,
    QueueFreeMessage,
    TransferErrorMessage,
} from './types';


/**
 * @interface ChunkDebugInfo
 * @description Holds debugging information for a received chunk. Used during the file reconstruction phase to verify integrity.
 */
interface ChunkDebugInfo {
    chunkActualSize: number; // Actual size of the chunk received
    chunkActualChecksum: string; // MD5 checksum of the chunk
    chunkFileName: string; // Name of the file where the chunk is stored
    wasInitiallySent: boolean; // True if this chunk was part of the initial transfer, false if it was a re-request.
    receivedBytes: number; // Total bytes received so far for this file
}

/**
 * @interface WriteJob
 * @description Represents a chunk that is ready to be written to disk. This is used in the write queue.
 */
interface WriteJob {
    chunkIndex: number;
    chunkBuffer: Buffer;
    chunkFileName: string;
    chunkActualSize: number;
    checksum: string; // The original checksum
    state: IncomingTransferState; // The full state of the transfer this job belongs to.
    wasInitiallySent: boolean; // True if this chunk was part of the initial transfer, false if it was a re-request.
}

// --- State Management ---

// Manages write queues for each file to prevent overwhelming the disk.
// Key: fileId, Value: an object containing the queue of write jobs, a writing status flag, and current memory usage.
const fileWriteQueues = new Map<string, { queue: WriteJob[], isWriting: boolean, currentMemoryUsage: number }>();

// Tracks which file transfers have notified the sender that their queue is full to avoid sending redundant messages.
// Key: fileId, Value: boolean
const queueFullStates = new Map<string, boolean>();

// The main state map for all active incoming transfers.
// Key: fileId, Value: IncomingTransferState object.
const activeReceivingTransfers = new Map<string, IncomingTransferState>(); // Maps fileId to its state

// A temporary store for debugging information about each chunk, used during reconstruction.
// Key: chunkIndex, Value: ChunkDebugInfo
const chunkDebugList: Map<number, ChunkDebugInfo> = new Map(); // Maps fileId to chunk debug info

// The maximum amount of memory to buffer for a single file's write queue before signaling backpressure. (256MB)
const MAX_QUEUE_MEMORY_PER_FILE = 256 * 1024 * 1024; // 256 MB

/**
 * Calculates the MD5 hash of a file.
 * @param filePath The path to the file.
 * @returns A promise that resolves with the hex-encoded MD5 hash of the file.
 */
export function calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('md5');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => {
            const digest = hash.digest('hex');
            resolve(digest);
        });
        stream.on('error', (err) => reject(err));
    });
}

/**
 * Sets up and manages the receiver side of a file transfer for a given socket connection.
 * This function listens for transfer messages, handles file acceptance, receives chunks,
 * manages disk I/O, and reconstructs the final file.
 *
 * @param socket The TCP socket connection to the sender.
 * @param downloadDir The base directory where received files and temporary chunks will be stored.
 * @param remotePeer Information about the sending peer.
 * @param myInstanceId A unique identifier for the receiving application instance.
 * @param myPeerName The user-friendly name of the receiver.
 * @param onProgress A callback to report transfer progress.
 * @param onComplete A callback to signal transfer completion or failure.
 * @param onError A callback to report fatal errors during the transfer.
 * @param requestAcceptance A callback to ask the user/UI whether to accept an incoming file.
 */
export function handleIncomingFileTransfer(
    socket: net.Socket,
    downloadDir: string,
    remotePeer: DiscoveredPeer,
    myInstanceId: string,
    myPeerName: string,
    onProgress: TransferProgressCallback,
    onComplete: TransferCompleteCallback,
    onError: (fileId: string, message: string) => void,
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
    let currentFileId: string | null = null;

    /**
     * Sends a metadata acknowledgement message to the sender.
     * @param fileId The ID of the file transfer.
     * @param accepted Whether the file transfer was accepted.
     * @param reason An optional reason for rejection.
     */
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

    /**
     * Informs the sender that the receiver's write queue is full (backpressure).
     * @param fileId The ID of the file transfer.
     */
    const sendQueueFullError = (fileId: string): void => {
        const queueFull: QueueFullMessage = {
            type: "QUEUE_FULL",
            message: `Write queue for file ${fileId} is full. Please wait.`,
            fileId: fileId,
            senderInstanceId: myInstanceId,
            senderPeerName: myPeerName,
            timestamp: Date.now(),
        }
        socket.write(buildFramedMessage(queueFull));
    }

    /**
     * Informs the sender that the receiver's write queue has space again.
     * @param fileId The ID of the file transfer.
     */
    const sendQueueFreeMessage = (fileId: string): void => {
        const queueFree: QueueFreeMessage = {
            type: "QUEUE_FREE",
            message: `Write queue for file ${fileId} is now free.`,
            fileId: fileId,
            senderInstanceId: myInstanceId,
            senderPeerName: myPeerName,
            timestamp: Date.now(),
        }
        socket.write(buildFramedMessage(queueFree));
    }

    /**
     * Processes the queue of chunks waiting to be written to disk for a specific file.
     * This runs asynchronously to avoid blocking the network stream and to manage disk I/O.
     * It ensures only one write operation happens at a time per file.
     * @param fileId The ID of the file whose write queue should be processed.
     */
    async function processWriteQueue(fileId: string) {
        const fileQueueState = fileWriteQueues.get(fileId);
        if (!fileQueueState || fileQueueState.isWriting || fileQueueState.queue.length === 0) {
            return;
        }

        fileQueueState.isWriting = true;
        const { queue } = fileQueueState;
        const state = activeReceivingTransfers.get(fileId)!;

        while (queue.length > 0) {
            const job = queue.shift();
            if (!job) continue;

            const { chunkIndex, chunkBuffer, chunkFileName, chunkActualSize, checksum, wasInitiallySent } = job;
            const chunkFilePath = path.join(state.chunkStorageDir, chunkFileName);

            try {
                await fs.promises.writeFile(chunkFilePath, chunkBuffer);
                fileQueueState.currentMemoryUsage -= chunkBuffer.length;

                // If the queue was full, check if it's now drained enough to signal 'free'.
                if (queueFullStates.get(fileId) && fileQueueState.currentMemoryUsage < MAX_QUEUE_MEMORY_PER_FILE * 0.5) {
                    sendQueueFreeMessage(fileId);
                    queueFullStates.delete(fileId);
                }

                // Acknowledge the successful write.
                sendChunkAck(fileId, chunkIndex, true);

                chunkDebugList.set(chunkIndex, {

                    chunkActualSize: chunkActualSize,
                    chunkActualChecksum: checksum,
                    chunkFileName: chunkFileName,
                    wasInitiallySent: wasInitiallySent,
                    receivedBytes: state.receivedBytes
                });

                // Update progress only if this is a new chunk.
                if (!state.receivedChunkMap[chunkIndex]) {
                    state.receivedBytes += chunkBuffer.length;
                }
                state.receivedChunkMap[chunkIndex] = chunkFileName;
                await fs.promises.writeFile(state.metadataFilePath, JSON.stringify(state.receivedChunkMap, null, 2));

                // Report progress.
                state.onProgress({
                    fileId: state.fileId,
                    fileName: state.fileName,
                    totalBytes: state.fileSize,
                    transferredBytes: state.receivedBytes,
                    percentage: (state.receivedBytes / state.fileSize) * 100
                });

            } catch (error: unknown) {
                if (error instanceof Error) {
                    console.error(`[Receiver] Error writing chunk ${chunkIndex} to disk for file ${state.fileName}: ${error.message}`);
                    state.onError(state.fileId, `Error writing chunk ${chunkIndex} to disk: ${error.message}`);
                }
                sendChunkAck(fileId, chunkIndex, false, "Failed to write chunk to disk");
            }
        }
        fileQueueState.isWriting = false;
    }

    /**
     * Sends a chunk acknowledgement message to the sender.
     * @param fileId The ID of the file transfer.
     * @param chunkIndex The index of the chunk being acknowledged.
     * @param success Whether the chunk was received and processed successfully.
     * @param reason An optional reason for failure.
     */
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

    /**
     * Waits until the write queue for a specific file is empty and the current write operation is finished.
     * This is crucial before starting the file reconstruction process.
     * @param fileId The ID of the file transfer to wait for.
     */
    const waitForQueueDrain = async (fileId: string) => {
        const fileQueueState = fileWriteQueues.get(fileId);
        if (fileQueueState) {
            while (fileQueueState.queue.length > 0 || fileQueueState.isWriting) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    };

    /**
     * Reconstructs the final file from all the received chunk parts.
     * This function is called after a FILE_END message is received.
     * It handles re-requesting missing chunks before assembly.
     * @param state The state object for the incoming transfer.
     */
    const reconstructFile = async (state: IncomingTransferState) => {
        console.log(`[Receiver] Reconstructing ${state.fileName} from received chunks...`);
        await waitForQueueDrain(state.fileId);

        // Helper to find which chunks haven't been received yet.
        const getMissingChunks = () => {
            const missing: number[] = [];
            for (let i = 0; i < state.totalChunks; i++) {
                if (!state.receivedChunkMap[i]) {
                    missing.push(i);
                }
            }
            return missing;
        };

        let missingChunks = getMissingChunks();

        // --- Missing Chunk Retransmission Logic ---
        if (missingChunks.length > 0) {
            console.log(`[Receiver] Missing ${missingChunks.length} chunks for ${state.fileName}. Requesting retransmission...`);
            frameParser.reset();

            for (const chunkIndex of missingChunks) {
                sendChunkAck(state.fileId, chunkIndex, false, "Missing chunk, please retransmit");
            }

            // Wait for the sender to retransmit the missing chunks.
            const maxWaitTime = 30000;
            const waitInterval = 200;
            let waitedTime = 0;

            while (missingChunks.length > 0 && waitedTime < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, waitInterval));
                waitedTime += waitInterval;
                missingChunks = getMissingChunks();
            }

            // If chunks are still missing after waiting, abort the transfer.
            if (missingChunks.length > 0) {
                const errorMsg = `[Receiver] Failed to receive all missing chunks for ${state.fileName}. Missing: ${missingChunks.join(', ')}. Aborting.`;
                console.error(errorMsg);
                state.onError(state.fileId, errorMsg);
                if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                activeReceivingTransfers.delete(state.fileId);
                currentFileId = null;
                await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
                return;
            }

            console.log(`[Receiver] All missing chunks for ${state.fileName} have been received.`);
            await waitForQueueDrain(state.fileId);
        }

        // --- File Assembly Logic ---
        console.log(`[Receiver] All chunks for file ${state.fileName} received. Reconstructing file.`);
        const outputFilePath = path.join(downloadDir, state.fileId, `${state.fileName}`); // Final reconstructed file path

        try {
            // Create a write stream for the final file.
            const writeStream = fs.createWriteStream(outputFilePath, { flags: 'w', mode: 0o666 });
            writeStream.on('error', (err) => {
                console.error(`[Receiver] Write stream error for file ${state.fileName}: ${err.message}`);
                throw new Error(`Write stream error: ${err.message}`);
            });

            for (let i = 0; i < state.totalChunks; i++) {
                const chunkFileName = state.receivedChunkMap[i];
                const chunkFilePath = path.join(state.chunkStorageDir, chunkFileName);
                const debugInfo = chunkDebugList.get(i);

                // This should not happen, but it's a safeguard.
                if (!debugInfo) {
                    throw new Error(`Missing debug info for chunk ${i}`);
                }

                const chunkBuffer = await fs.promises.readFile(chunkFilePath, { flag: 'r' });
                const checksumChunk = createHash('md5').update(chunkBuffer).digest('hex');

                // Final integrity check before writing the chunk to the final file.
                if (checksumChunk !== debugInfo.chunkActualChecksum || chunkBuffer.length !== debugInfo.chunkActualSize) {
                    console.log(`Integrity mismatch during reconstruction for chunk ${i}`);
                    sendChunkAck(state.fileId, i, false, "Missing chunk, please retransmit");
                    i--;
                    continue;
                }

                const canWriteMore = writeStream.write(chunkBuffer);
                // Handle stream backpressure if the buffer is full.
                if (!canWriteMore) {
                    await new Promise<void>(resolve => writeStream.once('drain', resolve));
                }
                await fs.promises.unlink(chunkFilePath)
            }

            await new Promise<void>((resolve, reject) => {
                writeStream.end(() => resolve());
                writeStream.on('error', reject);
            });

            // Verify the checksum of the fully reconstructed file.
            const fileChecksum = await calculateFileHash(outputFilePath);
            if (fileChecksum !== state.fileChecksum) {
                throw new Error(`Final file checksum mismatch for ${state.fileName}`);
            }

            console.log(`[Receiver] File ${state.fileName} reconstructed successfully to ${outputFilePath}.`);
            state.onComplete({
                fileId: state.fileId,
                fileName: state.fileName,
                status: "completed",
                receivedFilePath: outputFilePath
            });

        } catch (err: unknown) {
            if (err instanceof Error) {
                console.error(`[Receiver] Failed to reconstruct file ${state.fileName}: ${err.message}`);
                state.onError(state.fileId, `Failed to reconstruct file: ${err.message}`);
            }
        } finally {
            if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
            activeReceivingTransfers.delete(state.fileId);
            currentFileId = null;
        }
    };

    // --- Main Socket Event Listeners ---
    socket.on('data', async (data) => {
        try {
            const messages = frameParser.feed(data);

            for (const msg of messages) {
                const header = msg.header as TransferMessage;
                const payload = msg.payload;
                currentFileId = header.fileId;

                if (header.type === "FILE_METADATA") {
                    // --- Handle Initial Transfer Request ---
                    const metadata = header as FileMetadataMessage;
                    if (activeReceivingTransfers.has(currentFileId)) {
                        sendMetadataAck(metadata.fileId, false, "Duplicate transfer request");
                        return;
                    }

                    console.log(`[Receiver] Received metadata for file ${metadata.fileName} (${metadata.fileSize} bytes) from ${remotePeer.peerName}.`);
                    // Ask the application/UI layer for permission to accept the file.
                    requestAcceptance(
                        metadata.fileId,
                        metadata.fileName,
                        metadata.fileSize,
                        remotePeer.peerName,
                        async (fileIdToAccept) => {
                            const chunkStorageDir = path.join(downloadDir, fileIdToAccept);
                            const metadataFilePath = path.join(chunkStorageDir, 'metadata.json');
                            // Create a dedicated directory for this transfer's chunks.
                            await fs.promises.mkdir(chunkStorageDir, { recursive: true });

                            const initialState: IncomingTransferState = {

                                fileId: fileIdToAccept,
                                fileName: metadata.fileName,
                                fileSize: metadata.fileSize,
                                fileChecksum: metadata.fileChecksum,
                                totalChunks: metadata.totalChunks,
                                receivedBytes: 0,
                                receivedChunkMap: new Array(metadata.totalChunks),
                                chunkStorageDir,
                                metadataFilePath,
                                timeoutTimer: null,
                                remotePeer,
                                onProgress,
                                onComplete,
                                onError,
                                currentFrameParser: frameParser
                            };
                            activeReceivingTransfers.set(fileIdToAccept, initialState);

                            try {
                                // Check for existing metadata to resume a partial transfer.
                                if (fs.existsSync(metadataFilePath)) {
                                    const metadataContent = await fs.promises.readFile(metadataFilePath, 'utf8');
                                    initialState.receivedChunkMap = JSON.parse(metadataContent);
                                    initialState.receivedBytes = Object.keys(initialState.receivedChunkMap).reduce((acc, chunkIndexStr) => {
                                        const chunkFilePath = path.join(initialState.chunkStorageDir, initialState.receivedChunkMap[parseInt(chunkIndexStr)]);
                                        return fs.existsSync(chunkFilePath) ? acc + fs.statSync(chunkFilePath).size : acc;
                                    }, 0);
                                    console.log(`[Receiver] Resuming transfer for ${metadata.fileName}. Already received ${initialState.receivedBytes} bytes.`);
                                }
                            } catch (e) {
                                console.warn(`[Receiver] Could not load existing metadata for ${fileIdToAccept}: ${e}`);
                            }

                            // Acknowledge acceptance and start a timeout timer.
                            sendMetadataAck(fileIdToAccept, true);
                            initialState.timeoutTimer = setTimeout(() => {
                                console.warn(`[Receiver] Transfer ${initialState.fileName} timed out.`);
                                initialState.onComplete({ fileId: currentFileId, fileName: initialState.fileName, status: "error", message: "Transfer timeout" });
                                activeReceivingTransfers.delete(currentFileId as string);
                                currentFileId = null;
                            }, 30000);
                        },
                        (fileIdToReject, reason) => {
                            sendMetadataAck(fileIdToReject, false, reason);
                            currentFileId = null;
                        }
                    );
                } else if (header.type === "FILE_CHUNK") {
                    // --- Handle Incoming File Chunk ---
                    if (!currentFileId || !activeReceivingTransfers.has(currentFileId)) {
                        console.warn(`[Receiver] Received chunk for unknown/unaccepted file ID ${header.fileId}. Ignoring.`);
                        return;
                    }
                    const state = activeReceivingTransfers.get(currentFileId)!;
                    let fileQueueState = fileWriteQueues.get(state.fileId);
                    if (!fileQueueState) {
                        fileQueueState = { queue: [], isWriting: false, currentMemoryUsage: 0 };
                        fileWriteQueues.set(state.fileId, fileQueueState);
                    }
                    const chunk = payload;
                    const chunkMsg = header as FileChunkMessage;

                    // Reset the inactivity timeout since we received data.
                    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                    state.timeoutTimer = setTimeout(() => {
                        console.warn(`[Receiver] Transfer ${state.fileName} timed out.`);
                        state.onComplete({ fileId: currentFileId, fileName: state.fileName, status: "error", message: "Transfer timeout" });
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null;
                    }, 30000);

                    // Validate the chunk payload against the header.
                    if (!chunk || chunk.length !== chunkMsg.actualChunkSize) {
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Mismatched size");
                        return;
                    }

                    // Validate the chunk's checksum.
                    const calculatedChecksum = createHash('md5').update(chunk).digest('hex');
                    if (calculatedChecksum !== chunkMsg.checksum) {
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Checksum mismatch");
                        return;
                    }

                    // Check if the write queue is full (backpressure).
                    if (fileQueueState.currentMemoryUsage + chunk.length > MAX_QUEUE_MEMORY_PER_FILE) {
                        if (!queueFullStates.get(currentFileId)) {
                            sendQueueFullError(chunkMsg.fileId);
                            queueFullStates.set(currentFileId, true);
                        }
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Receiver queue full");
                        return;
                    }

                    // Add the valid chunk to the write queue.
                    const chunkFileName = `chunk_${chunkMsg.chunkIndex}.part`;
                    fileQueueState.queue.push({
                        chunkIndex: chunkMsg.chunkIndex,
                        chunkBuffer: chunk,
                        chunkFileName: chunkFileName,
                        chunkActualSize: chunkMsg.actualChunkSize,
                        checksum: chunkMsg.checksum,
                        state: state,
                        wasInitiallySent: true
                    });
                    fileQueueState.currentMemoryUsage += chunk.length;

                    // Start processing the write queue (this will run in the background).
                    processWriteQueue(state.fileId);
                } else if (header.type === "FILE_END") {
                    // --- Handle End of Transfer ---
                    const endMessage = header as FileEndMessage;
                    if (!currentFileId || !activeReceivingTransfers.has(currentFileId) || endMessage.fileId !== currentFileId) {
                        return;
                    }
                    const state = activeReceivingTransfers.get(currentFileId)!;
                    console.log(`[Receiver] File ${state.fileName} transfer ended by sender. Status: ${endMessage.status}`);

                    if (endMessage.status === "completed") {
                        // If completed, clear the timeout and start file reconstruction.
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        state.timeoutTimer = null;
                        reconstructFile(state);
                    } else {
                        // If cancelled or errored, clean up and notify the application.
                        state.onComplete({
                            fileId: currentFileId,
                            fileName: state.fileName,
                            status: endMessage.status,
                            message: endMessage.reason
                        });
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null;
                        await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
                    }
                } else if (header.type === "TRANSFER_ERROR") {
                    // --- Handle Error from Sender ---
                    const errorMessage = header as TransferErrorMessage;
                    if (activeReceivingTransfers.has(errorMessage.fileId)) {
                        const state = activeReceivingTransfers.get(errorMessage.fileId)!;
                        state.onComplete({
                            fileId: errorMessage.fileId,
                            fileName: state.fileName,
                            status: "error",
                            message: `Sender reported error: ${errorMessage.message}`
                        });
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        activeReceivingTransfers.delete(errorMessage.fileId);
                        await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
                    }
                    currentFileId = null;
                }
            }
        } catch (e: unknown) {
            let errorMessage = 'Unknown error parsing data';
            if (e instanceof Error) errorMessage = e.message;
            console.error(`[Receiver] Error processing incoming data from ${remotePeer.peerName}: ${errorMessage}`);
            socket.end();
        }
    });

    /**
     * Handles the socket ending unexpectedly.
     * Cleans up the state for the current transfer if one is active.
     */
    socket.on('end', async () => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            state.onComplete({
                fileId: currentFileId,
                fileName: state.fileName,
                status: "error",
                message: "Socket disconnected unexpectedly"
            });
            if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
            activeReceivingTransfers.delete(currentFileId);
            await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
        }
        currentFileId = null;
        frameParser.reset();
    });

    /**
     * Handles socket errors.
     * Cleans up the state for the current transfer if one is active.
     */
    socket.on('error', async (err: Error) => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            state.onComplete({
                fileId: currentFileId,
                fileName: state.fileName,
                status: "error",
                message: `Socket error: ${err.message}`
            });
            if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
            activeReceivingTransfers.delete(currentFileId);
            await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
        }
        currentFileId = null;
        frameParser.reset();
    });
}
