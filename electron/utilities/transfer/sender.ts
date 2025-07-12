import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For unique file IDs
import { createHash } from 'crypto'; // For checksums

import { buildFramedMessage, FrameParser } from '../framingProtocol';
import {
    FileMetadataMessage,
    FileMetadataAckMessage,
    FileChunkMessage,
    FileChunkAckMessage,
    TransferMessage,
    FileEndMessage,
    QueueFullMessage,
    QueueFreeMessage,
    TransferProgressCallback,
    TransferCompleteCallback,
    TransferErrorMessage
} from './types';

// --- File Transfer Configuration ---
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
const MAX_RETRIES = 5; // Maximum number of retries for a chunk
const RETRY_DELAY_MS = 1000; // 1 second delay before retrying a chunk

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
        const stats = await fs.promises.stat(filePath);
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
    let currentChunkIndex = 0; // Represents the next chunk to be sent
    let outstandingChunkIndex: number | null = null; // Chunk index awaiting ACK
    let fileStream: fs.ReadStream | null = null;
    let pausedDueToBackpressure = false;
    let pausedDueToQueueFull = false;
    const chunkRetryCounts = new Map<number, number>(); // Map to store retry counts for each chunk
    const frameParser = new FrameParser();


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

    const sendFileChunk = (chunk: Buffer, chunkIndex: number): Promise<void> => {
        return new Promise((resolve, reject) => {
            const checksum = createHash('md5').update(chunk).digest('hex');
            const chunkMessage: FileChunkMessage = {
                type: "FILE_CHUNK",
                fileId,
                senderInstanceId,
                senderPeerName,
                timestamp: Date.now(),
                chunkIndex: chunkIndex,
                actualChunkSize: chunk.length,
                checksum: checksum,
            };

            const fullMessage = buildFramedMessage(chunkMessage, chunk);

            const canWrite = socket.write(fullMessage, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });

            if (!canWrite) {
                pausedDueToBackpressure = true;
                fileStream?.pause(); // Pause reading if socket buffer is full
                socket.once('drain', () => {
                    pausedDueToBackpressure = false;
                    // Only resume if not paused by queue full or awaiting ACK
                    if (outstandingChunkIndex === null && !pausedDueToQueueFull) {
                        fileStream?.resume();
                    }
                });
            }
        });
    };

    const resendChunk = async (chunkIndex: number) => {

        let chunkToResend: Buffer | null = null;

        // Try to re-read from disk if not in memory

        const start = chunkIndex * CHUNK_SIZE;

        const end = Math.min(start + CHUNK_SIZE, fileSize);

        const length = end - start;

        const fd = await fs.promises.open(filePath, 'r');

        try {

            const buffer = Buffer.alloc(length);

            await fd.read(buffer, 0, length, start);

            chunkToResend = buffer;

        } finally {

            await fd.close();

        }

        if (chunkToResend) {

            console.log(`[Sender] Resending missing/corrupted chunk ${chunkIndex} for file ${fileName}.`);

            try {

                await sendFileChunk(chunkToResend, chunkIndex);

            } catch (err: unknown) {

                if (err instanceof Error) {

                    const errMsg = `[Sender] Error resending chunk ${chunkIndex} for ${fileName}: ${err.message}`;

                    console.error(errMsg);

                    sendError(errMsg);

                }

            }

        } else {

            console.error(`[Sender] Attempted to resend unknown chunk ${chunkIndex} for file ${fileName}.`);

            sendError(`Attempted to resend unknown chunk ${chunkIndex}`);

        }

    };


    const awaitRetryRequests = async (data: Buffer) => {

        const frameParser = new FrameParser();

        try {

            const messages = frameParser.feed(data);

            for (const msg of messages) {

                const header = msg.header as TransferMessage;


                if (header.fileId !== fileId) {

                    console.warn(`[Sender] Received message for unexpected fileId ${header.fileId}. Ignoring.`);

                    continue;

                }


                if (header.type === "FILE_CHUNK_ACK") {

                    const ack = header as FileChunkAckMessage;

                    if (!ack.success && ack.reason) {

                        console.warn(`[Sender] Receiver requested resend for chunk ${ack.chunkIndex} of ${fileName}: ${ack.reason}`);

                        await resendChunk(ack.chunkIndex);

                    }

                }

            }

        } catch (e: unknown) {

            if (e instanceof Error) {

                console.error(`[Sender] Error parsing retry request data: ${e.message}`);

            }

        }

    }



    const sendNextChunk = async () => {
        if (outstandingChunkIndex !== null) {
            // Still waiting for ACK for the current outstanding chunk
            return;
        }

        if (currentChunkIndex >= totalChunks) {
            const finalMessage: FileEndMessage = {
                type: "FILE_END",
                fileId,
                senderInstanceId,
                senderPeerName,
                timestamp: Date.now(),
                status: "completed",
            };
            // socket.off('data', handleSocketData); // Stop listening for data
            socket.on('data', awaitRetryRequests); // Listen for retry requests
            socket.write(buildFramedMessage(finalMessage));
            onComplete({ fileId, fileName, status: "completed", message: "Transfer complete", receivedFilePath: filePath });
            return;
        }

        if (pausedDueToQueueFull) {
            console.log(`[Sender] Paused due to receiver queue full. Will try again when queue is free.`);
            return;
        }

        fileStream = fs.createReadStream(filePath, {
            start: currentChunkIndex * CHUNK_SIZE,
            end: Math.min((currentChunkIndex + 1) * CHUNK_SIZE, fileSize) - 1,
            highWaterMark: CHUNK_SIZE
        });

        fileStream.once('data', async (chunk: string | Buffer) => {
            fileStream!.destroy(); // Close the stream after reading one chunk
            if (typeof chunk === 'string') {

                console.error(`[Sender] Received string chunk instead of Buffer for file ${fileName}. Skipping chunk.`);

                return;

            }

            const chunkToProcess = currentChunkIndex;
            outstandingChunkIndex = chunkToProcess; // Mark this chunk as outstanding

            try {
                await sendFileChunk(chunk, chunkToProcess);
                transferredBytes = chunkToProcess * CHUNK_SIZE + chunk.length; // Approximate transferred bytes
                onProgress({
                    fileId,
                    fileName,
                    totalBytes: fileSize,
                    transferredBytes,
                    percentage: (transferredBytes / fileSize) * 100
                });
                console.log(`[Sender] Sent chunk ${chunkToProcess} for file ${fileName}. Awaiting ACK.`);
            } catch (err: unknown) {
                if (err instanceof Error) {
                    const errMsg = `[Sender] Error sending chunk ${chunkToProcess} for ${fileName}: ${err.message}`;
                    console.error(errMsg);
                    sendError(errMsg);
                    socket.end(); // Terminate transfer on critical send error
                }
            }
        });

        fileStream.on('error', (err: NodeJS.ErrnoException) => {
            const errMsg = `[Sender] File stream error for ${fileName} at chunk ${currentChunkIndex}: ${err.message}`;
            console.error(errMsg);
            sendError(errMsg);
            socket.end();
        });
    };

    let metadataRetryCount = 0;
    const MAX_METADATA_RETRIES = 5;
    const METADATA_RETRY_DELAY_MS = 5000;
    let metadataRetryTimer: NodeJS.Timeout | null = null;
    let metadataAckReceived = false;

    async function sendMetadata(metadata: FileMetadataMessage) {
        try {
            console.log(`[Sender] Sending metadata for file ${fileName} (attempt ${metadataRetryCount + 1}/${MAX_METADATA_RETRIES})...`);
            socket.write(buildFramedMessage(metadata));
        } catch (err: unknown) {
            if (err instanceof Error) {
                const errMsg = `[Sender] Error sending metadata for file ${fileName}: ${err.message}`;
                console.error(errMsg);
                socket.end();
            }
        }
    }

    function scheduleMetadataRetry(metadata: FileMetadataMessage) {
        if (metadataAckReceived) return;
        if (metadataRetryCount >= MAX_METADATA_RETRIES) {
            console.error(`[Sender] Error receiving file metadata acknowledgement for file ${fileName} after ${MAX_METADATA_RETRIES} attempts.`);
            socket.end();
            return;
        }
        metadataRetryTimer = setTimeout(async () => {
            metadataRetryCount++;
            await sendMetadata(metadata);
            scheduleMetadataRetry(metadata);
        }, METADATA_RETRY_DELAY_MS);
    }

    const handleSocketData = async (data: Buffer) => {
        try {
            const messages = frameParser.feed(data);
            for (const msg of messages) {
                const header = msg.header as TransferMessage;

                if (header.fileId !== fileId) {
                    console.warn(`[Sender] Received message for unexpected fileId ${header.fileId}. Ignoring.`);
                    continue;
                }

                switch (header.type) {
                    case "FILE_METADATA_ACK":
                        const ack = header as FileMetadataAckMessage;
                        if (metadataRetryTimer) {
                            clearTimeout(metadataRetryTimer);
                            metadataRetryTimer = null;
                        }
                        metadataAckReceived = true;
                        if (ack.accepted) {
                            console.log(`[Sender] Receiver accepted metadata for ${fileName}. Starting transfer...`);
                            // Start sending the first chunk
                            sendNextChunk();
                        } else {
                            const errMsg = `[Sender] Receiver rejected metadata for ${fileName}: ${ack.reason || 'Unknown reason'}`;
                            console.error(errMsg);
                            sendError(errMsg);
                            socket.end();
                        }
                        break;

                    case "FILE_CHUNK_ACK":
                        const chunkAck = header as FileChunkAckMessage;
                        if (outstandingChunkIndex === null || chunkAck.chunkIndex !== outstandingChunkIndex) {
                            console.warn(`[Sender] Received ACK for unexpected chunk index ${chunkAck.chunkIndex}. Expected ${outstandingChunkIndex}. Ignoring.`);
                            continue;
                        }

                        if (chunkAck.success) {
                            outstandingChunkIndex = null; // Clear outstanding chunk
                            chunkRetryCounts.delete(chunkAck.chunkIndex); // Clear retry count
                            currentChunkIndex++; // Move to the next chunk
                            sendNextChunk(); // Send the next chunk
                        } else {
                            console.warn(`[Sender] Receiver requested resend for chunk ${chunkAck.chunkIndex} of ${fileName}: ${chunkAck.reason}`);
                            const retries = (chunkRetryCounts.get(chunkAck.chunkIndex) || 0) + 1;

                            if (retries <= MAX_RETRIES) {
                                chunkRetryCounts.set(chunkAck.chunkIndex, retries);
                                console.log(`[Sender] Retrying chunk ${chunkAck.chunkIndex} (attempt ${retries}/${MAX_RETRIES})...`);
                                outstandingChunkIndex = null; // Allow re-sending of this chunk
                                // Re-read the chunk and send after a delay
                                setTimeout(async () => {
                                    const start = chunkAck.chunkIndex * CHUNK_SIZE;
                                    const end = Math.min(start + CHUNK_SIZE, fileSize);
                                    const length = end - start;
                                    const fd = await fs.promises.open(filePath, 'r');
                                    try {
                                        const buffer = Buffer.alloc(length);
                                        await fd.read(buffer, 0, length, start);
                                        outstandingChunkIndex = chunkAck.chunkIndex; // Mark as outstanding again
                                        await sendFileChunk(buffer, chunkAck.chunkIndex);
                                        console.log(`[Sender] Resent chunk ${chunkAck.chunkIndex}. Awaiting ACK.`);
                                    } catch (err: unknown) {
                                        if (err instanceof Error) {
                                            const errMsg = `[Sender] Error during resend of chunk ${chunkAck.chunkIndex}: ${err.message}`;
                                            console.error(errMsg);
                                            sendError(errMsg);
                                            socket.end();
                                        }
                                    } finally {
                                        await fd.close();
                                    }
                                }, RETRY_DELAY_MS);
                            } else {
                                const errMsg = `[Sender] Max retries reached for chunk ${chunkAck.chunkIndex} of ${fileName}. Aborting transfer.`;
                                console.error(errMsg);
                                sendError(errMsg);
                                socket.end();
                            }
                        }
                        break;

                    case "QUEUE_FULL":
                        const queueFullMessage = header as QueueFullMessage;
                        console.warn(`[Sender] Receiver queue full for file ${fileName}: ${queueFullMessage.message}`);
                        pausedDueToQueueFull = true;
                        // Don't resume fileStream here, it's handled by sendNextChunk or on drain
                        break;

                    case "QUEUE_FREE":
                        const queueFreeMessage = header as QueueFreeMessage;
                        console.log(`[Sender] Receiver queue free for file ${fileName}: ${queueFreeMessage.message}`);
                        pausedDueToQueueFull = false;
                        if (outstandingChunkIndex === null && !pausedDueToBackpressure) {
                            sendNextChunk(); // Attempt to send the next chunk now
                        }
                        break;

                    case "TRANSFER_ERROR":
                        const errorMessage = header as TransferErrorMessage;
                        console.error(`[Sender] Transfer Error from receiver for file ${errorMessage.fileId}: ${errorMessage.message}`);
                        sendError(`Receiver reported error: ${errorMessage.message}`);
                        socket.end();
                        break;

                    default:
                        console.warn(`[Sender] Received unknown message type: ${header.type}. Ignoring.`);
                }
            }
        } catch (e: unknown) {
            if (e instanceof Error) {
                console.error(`[Sender] Error parsing incoming data from receiver: ${e.message}`);
                sendError(`Error parsing receiver data: ${e.message}`);
                socket.end();
            }
        }
    };

    // socket.removeAllListeners('data'); // Clear any previous listeners
    socket.on('data', handleSocketData);
    socket.on('error', (err: Error) => {
        sendError(`Connection error during transfer: ${err.message}`);
        socket.end();
    });

    socket.on('close', () => {
        if (fileStream) {
            fileStream.destroy();
        }
        console.log(`[Sender] Socket closed for file ${fileName}.`);
    });

    try {
        console.log(`[Sender] Calculating checksum for file ${fileName}...`);
        const fileChecksum = await calculateFileHash(filePath)
        const metadata: FileMetadataMessage = {
            type: "FILE_METADATA",
            fileId,
            fileName,
            fileSize,
            totalChunks,
            chunkSize: CHUNK_SIZE,
            senderInstanceId,
            fileChecksum: fileChecksum,
            senderPeerName,
            timestamp: Date.now(),
        };

        metadataRetryCount = 0;
        metadataAckReceived = false;
        await sendMetadata(metadata);
        scheduleMetadataRetry(metadata);
    } catch (err: unknown) {
        if (err instanceof Error) {
            const errMsg = `[Sender] Error during calculation of checksum for file ${fileName}: ${err.message}`;
            console.error(errMsg);
            socket.end();
        }
    }
}

