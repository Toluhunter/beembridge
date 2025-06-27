// src/framingProtocol.ts
import { Buffer } from 'buffer';

// Represents a complete framed message: a JSON header and an optional binary payload.
export interface FramedMessage {
    header: object;
    payload?: Buffer;
}

// Custom error for framing issues
export class FramingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FramingError";
    }
}

/**
 * Builds a framed message buffer from a JSON header and an optional binary payload.
 * Format: [4-byte header length][JSON header][4-byte payload length][binary payload]
 * @param header The JSON header object.
 * @param payload The optional binary payload Buffer.
 * @returns A Buffer containing the framed message.
 */
export function buildFramedMessage(header: object, payload?: Buffer): Buffer {
    const jsonBuffer = Buffer.from(JSON.stringify(header), 'utf8');
    const jsonLength = jsonBuffer.length;

    const payloadLength = payload ? payload.length : 0;

    // Allocate buffer for lengths (4+4 bytes) + json + payload
    const totalLength = 4 + jsonLength + 4 + payloadLength;
    const buffer = Buffer.alloc(totalLength);

    // Write header length (UInt32LE)
    buffer.writeUInt32LE(jsonLength, 0);
    // Write JSON header data
    jsonBuffer.copy(buffer, 4);

    // Write payload length (UInt32LE)
    buffer.writeUInt32LE(payloadLength, 4 + jsonLength);
    // Write payload data if exists
    if (payload) {
        payload.copy(buffer, 4 + jsonLength + 4);
    }

    return buffer;
}

/**
 * A parser for framed messages received from a TCP stream.
 * It accumulates data and emits 'message' events when a complete frame is received.
 */
export class FrameParser {
    private buffer: Buffer;
    private expectedHeaderLength: number;
    private expectedPayloadLength: number;
    private state: 'WAITING_HEADER_LENGTH' | 'WAITING_HEADER' | 'WAITING_PAYLOAD_LENGTH' | 'WAITING_PAYLOAD';

    constructor() {
        this.buffer = Buffer.alloc(0);
        this.expectedHeaderLength = 0;
        this.expectedPayloadLength = 0;
        this.state = 'WAITING_HEADER_LENGTH';
    }

    /**
     * Feeds new data into the parser.
     * @param chunk The incoming Buffer chunk from the TCP socket.
     * @returns An array of parsed FramedMessage objects if complete messages are found.
     */
    public feed(chunk: Buffer): FramedMessage[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: FramedMessage[] = [];

        while (true) { // Loop to process multiple messages if available in buffer
            const remainingBufferLength = this.buffer.length;

            switch (this.state) {
                case 'WAITING_HEADER_LENGTH':
                    if (remainingBufferLength >= 4) {
                        this.expectedHeaderLength = this.buffer.readUInt32LE(0);
                        this.buffer = this.buffer.slice(4);
                        this.state = 'WAITING_HEADER';
                    } else {
                        return messages; // Not enough data for length
                    }
                    break;

                case 'WAITING_HEADER':
                    if (remainingBufferLength >= this.expectedHeaderLength) {
                        const headerBuffer = this.buffer.slice(0, this.expectedHeaderLength);
                        this.buffer = this.buffer.slice(this.expectedHeaderLength);
                        try {
                            const header = JSON.parse(headerBuffer.toString('utf8'));
                            // Store header for current frame
                            // We need to move to WAITING_PAYLOAD_LENGTH for the *current* frame
                            this.currentHeader = header;
                            this.state = 'WAITING_PAYLOAD_LENGTH';
                        } catch (e) {
                            throw new FramingError(`Failed to parse JSON header: ${e}`);
                        }
                    } else {
                        return messages; // Not enough data for header
                    }
                    break;

                case 'WAITING_PAYLOAD_LENGTH':
                    if (remainingBufferLength >= 4) {
                        this.expectedPayloadLength = this.buffer.readUInt32LE(0);
                        this.buffer = this.buffer.slice(4);
                        this.state = 'WAITING_PAYLOAD';
                    } else {
                        return messages; // Not enough data for payload length
                    }
                    break;

                case 'WAITING_PAYLOAD':
                    if (remainingBufferLength >= this.expectedPayloadLength) {
                        const payload = this.expectedPayloadLength > 0 ? this.buffer.slice(0, this.expectedPayloadLength) : undefined;
                        this.buffer = this.buffer.slice(this.expectedPayloadLength);

                        messages.push({
                            header: this.currentHeader!, // currentHeader should be set from WAITING_HEADER
                            payload: payload
                        });

                        // Reset for next message
                        this.expectedHeaderLength = 0;
                        this.expectedPayloadLength = 0;
                        this.currentHeader = undefined;
                        this.state = 'WAITING_HEADER_LENGTH';

                        // Continue loop to process more messages from the buffer
                        if (this.buffer.length === 0) {
                            return messages;
                        }
                    } else {
                        return messages; // Not enough data for payload
                    }
                    break;
            }
        }
    }

    private currentHeader: object | undefined; // Stores header while waiting for payload

    // Helper to reset the parser (e.g., if connection drops or error occurs)
    public reset(): void {
        this.buffer = Buffer.alloc(0);
        this.expectedHeaderLength = 0;
        this.expectedPayloadLength = 0;
        this.state = 'WAITING_HEADER_LENGTH';
        this.currentHeader = undefined;
    }
}