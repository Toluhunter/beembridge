
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
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunkSize: number; // Nominal chunk size used by sender
    fileChecksum: string; // MD5 checksum of the entire file
}

export interface FileMetadataAckMessage extends BaseTransferMessage {
    type: "FILE_METADATA_ACK";
    accepted: boolean;
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

export interface IncomingTransferState {
    fileId: string;
    fileName: string;
    fileSize: number;
    fileChecksum: string; // MD5 checksum of the entire file
    totalChunks: number;
    receivedBytes: number;
    // Map to store received chunk filenames for reconstruction
    receivedChunkMap: { [chunkIndex: number]: string };
    chunkStorageDir: string;
    metadataFilePath: string;
    timeoutTimer: NodeJS.Timeout | null;
    remotePeer: DiscoveredPeer;
    onProgress: TransferProgressCallback;
    onComplete: TransferCompleteCallback;
    onError: (fileId: string, message: string) => void;
    currentFrameParser: FrameParser;
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