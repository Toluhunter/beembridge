import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto'; // For checksums
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

const RECEIVED_FILES_BASE_DIR = path.join(process.cwd(), 'received_files_chunks'); // Base directory for storing received chunks

interface ChunkDebugInfo {
    chunkActualSize: number; // Actual size of the chunk received
    chunkActualChecksum: string; // MD5 checksum of the chunk
    chunkFileName: string; // Name of the file where the chunk is stored
    wasInitiallySent: boolean; // Whether this chunk was sent by the sender
    receivedBytes: number; // Total bytes received so far for this file
}

interface WriteJob {
    chunkIndex: number;
    chunkBuffer: Buffer;
    chunkFileName: string;
    chunkActualSize: number;
    checksum: string; // The original checksum
    state: IncomingTransferState;
    wasInitiallySent: boolean;
}

const fileWriteQueues = new Map<string, { queue: WriteJob[], isWriting: boolean, currentMemoryUsage: number }>();

const activeReceivingTransfers = new Map<string, IncomingTransferState>(); // Maps fileId to its state
const chunkDebugList: Map<number, ChunkDebugInfo> = new Map(); // Maps fileId to chunk debug info
const MAX_QUEUE_MEMORY_PER_FILE = 256 * 1024 * 1024;

export function calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('md5');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => {
            hash.update(chunk);
        });

        stream.on('end', () => {
            const digest = hash.digest('hex');
            resolve(digest);
        });

        stream.on('error', (err) => {
            reject(err);
        });
    });
}

export function handleIncomingFileTransfer(
    socket: net.Socket,
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



    async function processWriteQueue(fileId: string) {
        const fileQueueState = fileWriteQueues.get(fileId);
        if (!fileQueueState || fileQueueState.isWriting || fileQueueState.queue.length === 0) {
            return;
        }

        fileQueueState.isWriting = true;
        const { queue } = fileQueueState; // Destructure for easier access
        const state = activeReceivingTransfers.get(fileId)!; // Get the overall transfer state

        while (queue.length > 0) {
            const job = queue.shift();
            if (!job) continue;

            const { chunkIndex, chunkBuffer, chunkFileName, chunkActualSize, checksum, wasInitiallySent } = job;
            const chunkFilePath = path.join(state.chunkStorageDir, chunkFileName);

            try {
                await fs.promises.writeFile(chunkFilePath, chunkBuffer);
                fileQueueState.currentMemoryUsage -= chunkBuffer.length; // Decrement memory usage after successful write

                sendChunkAck(fileId, chunkIndex, true);

                // Update state and debug list *after* successful write
                chunkDebugList.set(chunkIndex, {
                    chunkActualSize: chunkActualSize,
                    chunkActualChecksum: checksum,
                    chunkFileName: chunkFileName,
                    wasInitiallySent: wasInitiallySent,
                    receivedBytes: state.receivedBytes // This might be slightly off if multiple chunks arrive before writes complete
                });

                // Update received bytes and map *only if it's a new chunk*
                if (!state.receivedChunkMap[chunkIndex]) {
                    state.receivedBytes += chunkBuffer.length;
                }
                state.receivedChunkMap[chunkIndex] = chunkFileName;
                await fs.promises.writeFile(state.metadataFilePath, JSON.stringify(state.receivedChunkMap, null, 2));

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
                throw new Error(`[Receiver] Failed to write chunk ${chunkIndex} for file ${state.fileName}: ${(error as Error).message}`);
                // This chunk failed to write, you might want to add it back to the queue or mark it as needing retransmission.
                // For simplicity here, we just log and continue.
            }
        }
        fileQueueState.isWriting = false;
    }

    const sendAckAwaitChunks = (state: IncomingTransferState, fileId: string, chunkIndex: number, success: boolean, reason?: string): Promise<IncomingTransferState> => {
        return new Promise((resolve, reject) => {
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

            let retries = 0;
            const maxRetries = 5;
            const timeoutMs = 2000;
            let fileQueueState = fileWriteQueues.get(state.fileId);
            if (!fileQueueState) {
                fileQueueState = { queue: [], isWriting: false, currentMemoryUsage: 0 };
                fileWriteQueues.set(state.fileId, fileQueueState);
            }
            // const frameParser = new FrameParser();

            const cleanup = () => {
                socket.off('data', onData);
                if (timeout) clearTimeout(timeout);
            };

            const resend = () => {
                if (retries >= maxRetries) {
                    cleanup();
                    return reject(new Error(`[Receiver] Max retries reached for chunk ${chunkIndex} of file ${fileId}`));
                }
                retries++;
                socket.write(buildFramedMessage(ack));
                timeout = setTimeout(resend, timeoutMs);
            };

            let timeout: NodeJS.Timeout = setTimeout(resend, timeoutMs);

            const onData = async (data: Buffer) => {
                try {
                    const messages = frameParser.feed(data);
                    for (const msg of messages) {
                        const header = msg.header as TransferMessage;
                        const chunk = msg.payload;
                        if (
                            header.type === "FILE_CHUNK" &&
                            header.fileId === fileId &&
                            (header as FileChunkMessage).chunkIndex === chunkIndex
                        ) {
                            // Validate chunk
                            const chunkMsg = header as FileChunkMessage;
                            if (!chunk || chunk.length !== chunkMsg.actualChunkSize) {
                                continue; // Wait for correct chunk
                            }
                            const calculatedChecksum = createHash('md5').update(chunk).digest('hex');
                            if (calculatedChecksum !== chunkMsg.checksum) {
                                continue; // Wait for correct chunk
                            }
                            if (fileQueueState.currentMemoryUsage + chunk.length > MAX_QUEUE_MEMORY_PER_FILE) {
                                console.warn(`[Receiver] Queue for file ${state.fileName} is full. Applying backpressure.`);

                                await waitForQueueDrain(state.fileId);
                            }

                            // Store chunk
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

                            processWriteQueue(state.fileId);
                            cleanup();

                            return resolve(state);
                        }
                    }
                } catch (e) {
                    cleanup();
                    return reject(e);
                }
            };

            socket.on('data', onData);
            // Initial send
            socket.write(buildFramedMessage(ack));
        });
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

    const waitForQueueDrain = async (fileId: string) => {
        const fileQueueState = fileWriteQueues.get(fileId);
        if (fileQueueState) {
            while (fileQueueState.queue.length > 0 || fileQueueState.isWriting) {
                // console.log(`[Receiver] Waiting for write queue to drain for file ${fileId}. Chunks remaining: ${fileQueueState.queue.length}`);
                await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit
            }
        }
        fileWriteQueues.delete(fileId); // Clean up the queue state for this file
    };


    const reconstructFile = async (state: IncomingTransferState) => {
        console.log(`Reconstructing ${state.fileName} from received chunks...`);
        const missingChunks: number[] = [];
        for (let i = 0; i < state.totalChunks; i++) {
            if (!state.receivedChunkMap[i]) {
                missingChunks.push(i);
            }
        }

        frameParser.reset();
        if (missingChunks.length > 0) {
            // Request missing chunks
            for (const chunkIndex of missingChunks) {
                state = await sendAckAwaitChunks(state, state.fileId, chunkIndex, false, "Missing chunk, please retransmit");
                // state.receivedChunkMap[chunkIndex] = chunkFileName;
            }
            console.log(`\n[Receiver] All Requested retransmission for missing chunks: ${missingChunks.join(', ')} for file ${state.fileName} Completed.`);
        }
        await waitForQueueDrain(state.fileId);

        console.log(`\n\n[Receiver] All chunks for file ${state.fileName} received. Reconstructing file.`);
        const outputFilePath = path.join(RECEIVED_FILES_BASE_DIR, state.fileId, `${state.fileName}`); // Final reconstructed file path

        try {
            const writeStream = fs.createWriteStream(outputFilePath, { flags: 'w', mode: 0o666 });
            console.log(`[Receiver] Created write stream for ${outputFilePath}`);

            // Handle stream errors
            writeStream.on('error', (err) => {
                console.error(`[Receiver] Write stream error for file ${state.fileName}: ${err.message}`);
                // Re-throw the error to be caught by the outer try-catch block
                throw new Error(`Write stream error: ${err.message}`);
            });

            for (let i = 0; i < state.totalChunks; i++) {
                const chunkFileName = state.receivedChunkMap[i];
                const chunkFilePath = path.join(state.chunkStorageDir, chunkFileName);

                let chunkBuffer;
                const debugInfo = chunkDebugList.get(i);

                if (!debugInfo) {
                    console.error(`[Receiver] Missing debug info for chunk ${i}`);
                    throw new Error(`Missing debug info for chunk ${i}`);
                }
                try {
                    // Read each chunk file asynchronously
                    chunkBuffer = await fs.promises.readFile(chunkFilePath, { flag: 'r' });
                    const checksumChunk = createHash('md5').update(chunkBuffer).digest('hex');
                    // process.stdout.write(`\rVerifying chunk ${i + 1}/${state.totalChunks}... \t\t ${state.fileName} `);

                    if (
                        checksumChunk !== debugInfo.chunkActualChecksum ||
                        chunkBuffer.length !== debugInfo.chunkActualSize
                    ) {
                        console.error(`\nChunk IDx: ${i}, File: ${chunkFileName}`);
                        console.error(`Chunk size: ${chunkBuffer.length}, Expected size: ${debugInfo.chunkActualSize}`);
                        console.error(`Checksum mismatch. Expected ${debugInfo.chunkActualChecksum}, got ${checksumChunk}.`);
                        console.error(`This was initially sent as part of blitz: ${debugInfo.wasInitiallySent}`);
                        throw new Error(`Integrity mismatch during reconstruction for chunk ${i}`);
                    }
                } catch (err: unknown) {
                    if (err instanceof Error) {
                        console.error(`[Receiver] Error reading chunk file ${chunkFilePath}: ${err.message}`);
                        throw new Error(`Failed to read chunk file ${chunkFilePath}`);
                    }
                }

                // checksumCounter++;

                const canWriteMore = writeStream.write(chunkBuffer);
                if (!canWriteMore) {
                    // If writeStream.write() returns false, it means the internal buffer is full.
                    // We need to wait for the 'drain' event before writing more data to avoid memory issues.
                    await new Promise<void>(resolve => writeStream.once('drain', resolve));
                }
            }

            // End the write stream to signal that no more data will be written
            await new Promise<void>((resolve, reject) => {
                writeStream.end(() => {
                    resolve();
                });
                writeStream.on('error', reject); // Catch any errors during the ending process
            });
            const fileChecksum = await calculateFileHash(outputFilePath);
            if (fileChecksum !== state.fileChecksum) {
                console.error(`\n\n[Receiver] Final file checksum mismatch for ${state.fileName}. Expected ${state.fileChecksum}, got ${fileChecksum}.`);
                throw new Error(`Final file checksum mismatch for ${state.fileName}`);
            }

            console.log(`\n\n[Receiver] File ${state.fileName} reconstructed successfully to ${outputFilePath}.`);
            console.log(`[Receiver] Total chunks received: ${state.totalChunks}, Received bytes: ${state.receivedBytes}`);

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


    socket.on('data', async (data) => {
        try {
            const messages = frameParser.feed(data);

            for (const msg of messages) {
                const header = msg.header as TransferMessage;
                const payload = msg.payload;

                // if (currentFileId && header.fileId !== currentFileId) {
                //     console.warn(`[Receiver] Received message for unexpected fileId ${header.fileId} on socket for ${currentFileId}. Ignoring.`);
                //     continue;
                // }
                currentFileId = header.fileId;

                if (header.type === "FILE_METADATA") {
                    const metadata = header as FileMetadataMessage;
                    if (activeReceivingTransfers.has(currentFileId)) {
                        console.warn(`[Receiver] Duplicate metadata for file ID ${metadata.fileId}. Rejecting.`);
                        sendMetadataAck(metadata.fileId, false, "Duplicate transfer request");
                        return;
                    }

                    console.log(`[Receiver] Received metadata for file ${metadata.fileName} (${metadata.fileSize} bytes) from ${remotePeer.peerName}.`);

                    requestAcceptance(
                        metadata.fileId,
                        metadata.fileName,
                        metadata.fileSize,
                        remotePeer.peerName,
                        async (fileIdToAccept) => {
                            const chunkStorageDir = path.join(RECEIVED_FILES_BASE_DIR, fileIdToAccept);
                            const metadataFilePath = path.join(chunkStorageDir, 'metadata.json');

                            // Ensure chunk storage directory exists
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

                            // Load existing metadata if any (for resuming interrupted transfers)
                            try {
                                if (fs.existsSync(metadataFilePath)) {
                                    const metadataContent = await fs.promises.readFile(metadataFilePath, 'utf8');
                                    initialState.receivedChunkMap = JSON.parse(metadataContent);
                                    initialState.receivedBytes = Object.keys(initialState.receivedChunkMap).reduce((acc, chunkIndexStr) => {
                                        const chunkFilePath = path.join(initialState.chunkStorageDir, initialState.receivedChunkMap[parseInt(chunkIndexStr)]);
                                        if (fs.existsSync(chunkFilePath)) {
                                            return acc + fs.statSync(chunkFilePath).size;
                                        }
                                        return acc;
                                    }, 0);
                                    console.log(`[Receiver] Resuming transfer for ${metadata.fileName}. Already received ${initialState.receivedBytes} bytes.`);
                                }
                            } catch (e) {
                                console.warn(`[Receiver] Could not load existing metadata for ${fileIdToAccept}: ${e}`);
                            }

                            sendMetadataAck(fileIdToAccept, true);
                            // Set initial timeout
                            initialState.timeoutTimer = setTimeout(() => {
                                console.warn(`[Receiver] Transfer ${initialState.fileName} timed out (no initial chunks).`);
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

                    // Reset timeout for this transfer
                    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                    state.timeoutTimer = setTimeout(() => {
                        console.warn(`[Receiver] Transfer ${state.fileName} timed out (no new chunks).`);
                        state.onComplete({ fileId: currentFileId, fileName: state.fileName, status: "error", message: "Transfer timeout" });
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null;
                    }, 30000); // 30 seconds timeout

                    if (!chunk || chunk.length !== chunkMsg.actualChunkSize) {
                        console.error(`[Receiver] Mismatched chunk size for ${chunkMsg.fileId} chunk ${chunkMsg.chunkIndex}.`);
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Mismatched size");
                        onError(chunkMsg.fileId, "Chunk size mismatch");
                        return;
                    }

                    const calculatedChecksum = createHash('md5').update(chunk).digest('hex');
                    if (calculatedChecksum !== chunkMsg.checksum) {
                        console.error(`[Receiver] Checksum mismatch for ${chunkMsg.fileId} chunk ${chunkMsg.chunkIndex}.`);
                        sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, false, "Checksum mismatch");
                        onError(chunkMsg.fileId, "Checksum mismatch");
                        throw new Error(`Checksum mismatch for chunk ${chunkMsg.chunkIndex} of file ${chunkMsg.fileId}`);
                    }
                    if (fileQueueState.currentMemoryUsage + chunk.length > MAX_QUEUE_MEMORY_PER_FILE) {
                        console.warn(`[Receiver] Queue for file ${state.fileName} is full. Applying backpressure.`);

                        sendQueueFullError(chunkMsg.fileId);
                        await waitForQueueDrain(state.fileId);
                        sendQueueFreeMessage(chunkMsg.fileId);
                    }

                    // Store chunk
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

                    // sendChunkAck(chunkMsg.fileId, chunkMsg.chunkIndex, true); // ACK immediately once in memory
                    processWriteQueue(state.fileId);
                } else if (header.type === "FILE_END") {
                    const endMessage = header as FileEndMessage;
                    if (!currentFileId || !activeReceivingTransfers.has(currentFileId) || endMessage.fileId !== currentFileId) {
                        console.warn(`[Receiver] Received FILE_END for unknown/unaccepted file ID ${header.fileId}. Ignoring.`);
                        return;
                    }
                    const state = activeReceivingTransfers.get(currentFileId)!;
                    console.log(`[Receiver] File ${state.fileName} transfer ended by sender. Status: ${endMessage.status}`);

                    if (endMessage.status === "completed") {
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        state.timeoutTimer = null
                        // socket.removeAllListeners('data'); // Stop listening for further data
                        await waitForQueueDrain(state.fileId);
                        reconstructFile(state);
                        console.log(`Started Reconstruct file process for file: ${state.fileName} ........................................................................................................`);
                    } else {
                        state.onComplete({
                            fileId: currentFileId,
                            fileName: state.fileName,
                            status: endMessage.status,
                            message: endMessage.reason
                        });
                        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
                        activeReceivingTransfers.delete(currentFileId as string);
                        currentFileId = null;
                        // Clean up partial chunks if transfer cancelled/errored
                        await fs.promises.rm(state.chunkStorageDir, { recursive: true, force: true });
                    }
                } else if (header.type === "TRANSFER_ERROR") {
                    const errorMessage = header as TransferErrorMessage;
                    console.error(`[Receiver] Transfer Error from sender for file ${errorMessage.fileId}: ${errorMessage.message}`);
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

    socket.on('end', async () => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            console.warn(`[Receiver] Socket disconnected for file ${state.fileName} unexpectedly during transfer.`);
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

    socket.on('error', async (err: Error) => {
        if (currentFileId && activeReceivingTransfers.has(currentFileId)) {
            const state = activeReceivingTransfers.get(currentFileId)!;
            console.error(`[Receiver] Socket error for file ${state.fileName}: ${err.message}`);
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