// Import necessary Node.js modules for networking, file system, and cryptography.
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid'; // For generating unique file IDs.
import { createHash } from 'crypto'; // For calculating checksums to ensure data integrity.

// Import custom modules for framing messages and defining transfer-related types.
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
// Defines constants for managing the file transfer process.
const CHUNK_SIZE = 1024 * 1024; // The size of each file chunk in bytes (1MB).
const MAX_RETRIES = 5; // The maximum number of times to retry sending a failed chunk.
const RETRY_DELAY_MS = 1000; // The delay in milliseconds before retrying a chunk.
const MAX_OUTSTANDING_CHUNKS = 16; // The number of chunks to send concurrently without waiting for an ACK.

/**
 * Calculates the MD5 hash of a file.
 * @param filePath The path to the file.
 * @returns A promise that resolves with the hex-encoded MD5 hash of the file.
 */
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

/**
 * Initiates and manages the sending side of a file transfer.
 * This function handles file metadata exchange, chunking, sending, and error recovery.
 * @param socket The TCP socket connection to the receiver.
 * @param filePath The absolute path of the file to be sent.
 * @param senderInstanceId A unique identifier for the sending application instance.
 * @param senderPeerName The user-friendly name of the sender.
 * @param onProgress A callback function to report transfer progress.
 * @param onComplete A callback function to signal the completion of the transfer.
 * @param onError A callback function to report any errors during the transfer.
 */
export async function initiateFileTransfer(
    socket: net.Socket,
    filePath: string,
    senderInstanceId: string,
    senderPeerName: string,
    onProgress: TransferProgressCallback,
    onComplete: TransferCompleteCallback,
    onError: (fileId: string, message: string) => void
): Promise<void> {
    const fileId = uuidv4(); // Generate a unique ID for this transfer.
    const fileName = path.basename(filePath);
    let fileSize: number;

    // Get file stats to determine its size.
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

    // --- Transfer State Variables ---
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    let transferredBytes = 0;
    let currentChunkIndex = 0; // Tracks the next chunk to be sent.
    const outstandingChunks = new Set<number>(); // Stores indices of chunks sent but not yet acknowledged.
    let pausedDueToBackpressure = false; // Flag to pause sending if the socket's buffer is full.
    let pausedDueToQueueFull = false; // Flag to pause sending if the receiver's queue is full.
    const chunkRetryCounts = new Map<number, number>(); // Tracks retry attempts for each chunk.
    const frameParser = new FrameParser(); // Used to parse incoming framed messages from the receiver.

    /**
     * Sends a standardized error message to the receiver and invokes the onError callback.
     * @param msg The error message.
     * @param details Optional additional details about the error.
     */
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

    // This function will be defined later; declared here due to mutual dependency.
    /**
     * The core sending loop. It sends chunks as long as the number of outstanding
     * (unacknowledged) chunks is below the configured maximum and the connection is not paused.
     */
    const sendAvailableChunks = () => {
        if (pausedDueToQueueFull) {
            console.log(`[Sender] Paused due to receiver queue full. Will not send new chunks.`);
            return;
        }

        while (outstandingChunks.size < MAX_OUTSTANDING_CHUNKS && currentChunkIndex < totalChunks) {
            if (pausedDueToBackpressure) {
                console.log(`[Sender] Paused due to backpressure. Will not send new chunks.`);
                break; // Exit the loop; will be resumed on 'drain' event.
            }

            const chunkIndexToSend = currentChunkIndex;
            outstandingChunks.add(chunkIndexToSend);
            currentChunkIndex++;

            // Asynchronously read and send the chunk.
            (async () => {
                const start = chunkIndexToSend * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, fileSize);
                const length = end - start;
                const fd = await fs.promises.open(filePath, 'r');

                try {
                    const buffer = Buffer.alloc(length);
                    await fd.read(buffer, 0, length, start);

                    await sendFileChunk(buffer, chunkIndexToSend);

                    // Update and report progress.
                    transferredBytes += buffer.length;
                    onProgress({
                        fileId,
                        fileName,
                        totalBytes: fileSize,
                        transferredBytes: transferredBytes,
                        percentage: (transferredBytes / fileSize) * 100
                    });
                    console.log(`[Sender] Sent chunk ${chunkIndexToSend} for file ${fileName}.`);

                } catch (err) {
                    if (err instanceof Error) {
                        const errMsg = `[Sender] Error sending chunk ${chunkIndexToSend} for ${fileName}: ${err.message}`;
                        console.error(errMsg);
                        sendError(errMsg);
                        socket.end();
                    }
                    outstandingChunks.delete(chunkIndexToSend);
                } finally {
                    await fd.close();
                }
            })();
        }
    };

    /**
     * Sends a single file chunk to the receiver.
     * @param chunk The buffer containing the file chunk data.
     * @param chunkIndex The index of the chunk.
     * @returns A promise that resolves when the chunk is written to the socket.
     */
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

            // Write the message to the socket and handle backpressure.
            const canWrite = socket.write(fullMessage, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });

            if (!canWrite) {
                pausedDueToBackpressure = true;
                socket.once('drain', () => {
                    pausedDueToBackpressure = false;
                    if (!pausedDueToQueueFull) {
                        sendAvailableChunks(); // Resume sending when the buffer has drained.
                    }
                });
            }
        });
    };

    /**
     * Re-reads a specific chunk from the file and sends it again.
     * This is used when the receiver reports a missing or corrupted chunk.
     * @param chunkIndex The index of the chunk to resend.
     */
    const resendChunk = async (chunkIndex: number) => {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, fileSize);
        const length = end - start;
        const fd = await fs.promises.open(filePath, 'r');

        try {
            const buffer = Buffer.alloc(length);
            await fd.read(buffer, 0, length, start);
            console.log(`[Sender] Resending missing/corrupted chunk ${chunkIndex} for file ${fileName}.`);
            await sendFileChunk(buffer, chunkIndex);
        } catch (err: unknown) {
            if (err instanceof Error) {
                const errMsg = `[Sender] Error resending chunk ${chunkIndex} for ${fileName}: ${err.message}`;
                console.error(errMsg);
                sendError(errMsg);
            }
        } finally {
            await fd.close();
        }
    };

    /**
     * A temporary data handler to listen for retry requests after the file transfer is complete.
     * This ensures any late-arriving error reports from the receiver are handled.
     * @param data The raw data buffer received from the socket.
     */

    // --- Metadata Sending and Retry Logic ---
    let metadataRetryCount = 0;
    const MAX_METADATA_RETRIES = 5;
    const METADATA_RETRY_DELAY_MS = 5000;
    let metadataRetryTimer: NodeJS.Timeout | null = null;
    let metadataAckReceived = false;

    /**
     * Sends the file metadata message to the receiver.
     * @param metadata The metadata message to send.
     */
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

    /**
     * Schedules a retry for sending metadata if no acknowledgment is received.
     * @param metadata The metadata message to resend on timeout.
     */
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

    /**
     * Main handler for all incoming data from the receiver's socket.
     * It parses messages and routes them to the appropriate logic.
     * @param data The raw data buffer from the socket.
     */
    const handleSocketData = async (data: Buffer) => {
        try {
            const messages = frameParser.feed(data);
            for (const msg of messages) {
                const header = msg.header as TransferMessage;

                // Ignore messages for different files.
                if (header.fileId !== fileId) {
                    console.warn(`[Sender] Received message for unexpected fileId ${header.fileId}. Ignoring.`);
                    continue;
                }

                switch (header.type) {
                    case "FILE_METADATA_ACK":
                        // Stop the metadata retry timer upon receiving ACK.
                        if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
                        metadataAckReceived = true;

                        const ack = header as FileMetadataAckMessage;
                        if (ack.accepted) {
                            console.log(`[Sender] Receiver accepted metadata for ${fileName}. Starting transfer...`);
                            sendAvailableChunks(); // Start the chunk sending process.
                        } else {
                            const errMsg = `[Sender] Receiver rejected metadata for ${fileName}: ${ack.reason || 'Unknown reason'}`;
                            console.error(errMsg);
                            sendError(errMsg);
                            socket.end();
                        }
                        break;

                    case "FILE_CHUNK_ACK":
                        const chunkAck = header as FileChunkAckMessage;
                        if (!outstandingChunks.has(chunkAck.chunkIndex)) {
                            console.warn(`[Sender] Received ACK for unexpected chunk index ${chunkAck.chunkIndex}. Outstanding: ${[...outstandingChunks]}. Ignoring.`);
                            continue;
                        }

                        if (chunkAck.success) {
                            // On successful ACK, remove from outstanding set and reset retry count.
                            outstandingChunks.delete(chunkAck.chunkIndex);
                            chunkRetryCounts.delete(chunkAck.chunkIndex);

                            // If all chunks are sent and acknowledged, finalize the transfer.
                            if (currentChunkIndex >= totalChunks && outstandingChunks.size === 0) {
                                const finalMessage: FileEndMessage = {
                                    type: "FILE_END",
                                    fileId,
                                    senderInstanceId,
                                    senderPeerName,
                                    timestamp: Date.now(),
                                    status: "completed",
                                };
                                socket.write(buildFramedMessage(finalMessage));
                                onComplete({ fileId, fileName, status: "completed", message: "Transfer complete", receivedFilePath: filePath });
                            } else {
                                sendAvailableChunks(); // Send more chunks.
                            }
                        } else {
                            // If chunk ACK is negative, handle retry logic.
                            console.warn(`[Sender] Receiver requested resend for chunk ${chunkAck.chunkIndex} of ${fileName}: ${chunkAck.reason}`);
                            outstandingChunks.delete(chunkAck.chunkIndex);
                            const retries = (chunkRetryCounts.get(chunkAck.chunkIndex) || 0) + 1;

                            if (retries <= MAX_RETRIES) {
                                chunkRetryCounts.set(chunkAck.chunkIndex, retries);
                                console.log(`[Sender] Retrying chunk ${chunkAck.chunkIndex} (attempt ${retries}/${MAX_RETRIES})...`);
                                setTimeout(async () => {
                                    try {
                                        outstandingChunks.add(chunkAck.chunkIndex);
                                        await resendChunk(chunkAck.chunkIndex);
                                    } catch (err: unknown) {
                                        if (err instanceof Error) {
                                            const errMsg = `[Sender] Error during resend of chunk ${chunkAck.chunkIndex}: ${err.message}`;
                                            console.error(errMsg);
                                            sendError(errMsg);
                                            socket.end();
                                        }
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
                        // Pause sending if the receiver's buffer is full.
                        console.warn(`[Sender] Receiver queue full for file ${fileName}: ${(header as QueueFullMessage).message}`);
                        pausedDueToQueueFull = true;
                        break;

                    case "QUEUE_FREE":
                        // Resume sending when the receiver's buffer has space.
                        console.log(`[Sender] Receiver queue free for file ${fileName}: ${(header as QueueFreeMessage).message}`);
                        pausedDueToQueueFull = false;
                        sendAvailableChunks();
                        break;

                    case "TRANSFER_ERROR":
                        // Handle errors reported by the receiver.
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

    // --- Socket Event Listeners ---
    socket.on('data', handleSocketData);
    socket.on('error', (err: Error) => {
        sendError(`Connection error during transfer: ${err.message}`);
        socket.end();
    });
    socket.on('close', () => {
        console.log(`[Sender] Socket closed for file ${fileName}.`);
    });

    // --- Start the Transfer ---
    // Calculate file checksum and send the initial metadata message.
    try {
        console.log(`[Sender] Calculating checksum for file ${fileName}...`);
        const fileChecksum = await calculateFileHash(filePath);
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

        await sendMetadata(metadata);
        scheduleMetadataRetry(metadata); // Start the retry mechanism.
    } catch (err: unknown) {
        if (err instanceof Error) {
            const errMsg = `[Sender] Error during calculation of checksum for file ${fileName}: ${err.message}`;
            console.error(errMsg);
            socket.end();
        }
    }
}
