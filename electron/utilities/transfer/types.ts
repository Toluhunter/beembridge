
import { DiscoveredPeer } from '../peerDiscovery'; // Used in both sender and receiver logic
import { FrameParser } from '../framingProtocol';
// --- File Transfer Message Interfaces ---
export interface BaseTransferMessage {
    type: string;
    fileId: string;
    senderInstanceId: string;
    senderPeerName: string;
    timestamp: number;
}

export interface FileMetadataMessage extends BaseTransferMessage {
    type: "FILE_METADATA";
    prefix?: string;
    parentId?: string;
    totalItems?: number; // Optional: used for directory transfers
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunkSize: number; // Nominal chunk size used by sender
}

export interface FileMetadataAckMessage extends BaseTransferMessage {
    type: "FILE_METADATA_ACK";
    accepted: boolean;
    existingTransfer: boolean;
    continueIndex?: number;
    reason?: string;
}

export interface FileChunkMessage extends BaseTransferMessage {
    type: "FILE_CHUNK";
    chunkIndex: number;
    actualChunkSize: number; // The actual bytes in this specific chunk
    checksum: string; // MD5 checksum of this chunk
}

export interface FileChunkAckMessage extends BaseTransferMessage {
    type: "FILE_CHUNK_ACK";
    chunkIndex: number;
    success: boolean;
    reason?: string;
}

export interface QueueFullMessage extends BaseTransferMessage {
    type: "QUEUE_FULL";
    message: string; // Human-readable message about the queue being full
}

export interface QueueFreeMessage extends BaseTransferMessage {
    type: "QUEUE_FREE";
    message: string; // Human-readable message about the queue being free again
}

export interface FileEndMessage extends BaseTransferMessage {
    type: "FILE_END";
    status: "completed" | "cancelled" | "error";
    finalChecksum?: string; // Optional: overall file checksum
    reason?: string;
}

export interface TransferErrorMessage extends BaseTransferMessage {
    type: "TRANSFER_ERROR";
    message: string; // Human-readable error message
    details?: unknown; // Optional: more specific error details (e.g., stack trace, error object)
}

/**
 * @interface ChunkDebugInfo
 * @description Holds debugging information for a received chunk. Used during the file reconstruction phase to verify integrity.
 */
export interface ChunkDebugInfo {
    chunkActualSize: number; // Actual size of the chunk received
    chunkActualChecksum: string; // MD5 checksum of the chunk
    chunkFileName: string; // Name of the file where the chunk is stored
}

export interface IncomingTransferState {
    fileId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    receivedBytes: number;
    // Map to store received chunk info (path and checksum) for reconstruction
    receivedChunkMap: { [chunkIndex: number]: ChunkDebugInfo };
    chunkStorageDir: string;
    metadataFilePath: string;
    timeoutTimer: NodeJS.Timeout | null;
    remotePeer: DiscoveredPeer;
    onProgress: TransferProgressCallback;
    onComplete: TransferCompleteCallback;
    onError: (fileId: string, message: string) => void;
    currentFrameParser: FrameParser;
    parentId?: string; // Optional: parent transfer ID for nested transfers
    prefix?: string; // Optional: prefix for file paths, used in directory transfers
}

export type TransferMessage =
    FileMetadataMessage |
    FileMetadataAckMessage |
    FileChunkMessage |
    FileChunkAckMessage |
    FileEndMessage |
    QueueFullMessage |
    QueueFreeMessage |
    TransferErrorMessage;
export type Progress = {
    fileId: string;
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    percentage: number;
    speedKbps?: number; // Optional: speed calculation
    parentId?: string;
    rootDir?: string;
}
// --- Progress/Status Callbacks ---
export type TransferProgressCallback = (progress: Progress) => void;

export type Result = {
    fileId: string | null;
    fileName: string;
    status: "completed" | "cancelled" | "error";
    message?: string;
    receivedFilePath?: string;
}
export type TransferCompleteCallback = (result: Result) => void;
