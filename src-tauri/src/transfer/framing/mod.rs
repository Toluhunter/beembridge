use serde_json::Value;
use std::collections::HashMap;

pub const MAX_HEADER_SIZE: u32 = 1 << 20; // 1 MiB
pub const MAX_PAYLOAD_SIZE: u32 = 1 << 30; // 1 GiB

/// A parsed framed message with a JSON header and optional binary payload.
pub struct FramedMessage {
    pub header: HashMap<String, Value>,
    pub payload: Option<Vec<u8>>,
}

/// Builds a framed message as bytes.
/// Format: [4-byte header_len LE][JSON header bytes][4-byte payload_len LE][payload bytes]
pub fn build_framed_message(
    header: &impl serde::Serialize,
    payload: Option<&[u8]>,
) -> Result<Vec<u8>, serde_json::Error> {
    let header_bytes = serde_json::to_vec(header)?;
    let header_len = header_bytes.len() as u32;
    let payload_len = payload.map(|p| p.len() as u32).unwrap_or(0);

    let total = 4 + header_bytes.len() + 4 + payload_len as usize;
    let mut buf = Vec::with_capacity(total);

    buf.extend_from_slice(&header_len.to_le_bytes());
    buf.extend_from_slice(&header_bytes);
    buf.extend_from_slice(&payload_len.to_le_bytes());
    if let Some(p) = payload {
        buf.extend_from_slice(p);
    }

    Ok(buf)
}

// ---- FrameParser ----

#[derive(Debug, PartialEq)]
enum ParserState {
    WaitingHeaderLength,
    WaitingHeader,
    WaitingPayloadLength,
    WaitingPayload,
}

pub struct FrameParser {
    buffer: Vec<u8>,
    expected_header_len: u32,
    expected_payload_len: u32,
    state: ParserState,
    current_header: Option<HashMap<String, Value>>,
}

impl FrameParser {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            expected_header_len: 0,
            expected_payload_len: 0,
            state: ParserState::WaitingHeaderLength,
            current_header: None,
        }
    }

    /// Feed new bytes in. Returns any fully-parsed messages.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<FramedMessage>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut messages = Vec::new();

        loop {
            match self.state {
                ParserState::WaitingHeaderLength => {
                    if self.buffer.len() < 4 {
                        return Ok(messages);
                    }
                    self.expected_header_len =
                        u32::from_le_bytes(self.buffer[..4].try_into().unwrap());
                    self.buffer.drain(..4);
                    self.state = ParserState::WaitingHeader;
                }

                ParserState::WaitingHeader => {
                    let needed = self.expected_header_len as usize;
                    if self.buffer.len() < needed {
                        return Ok(messages);
                    }
                    let header_bytes = self.buffer[..needed].to_vec();
                    self.buffer.drain(..needed);

                    match serde_json::from_slice::<HashMap<String, Value>>(&header_bytes) {
                        Ok(h) => {
                            self.current_header = Some(h);
                            self.state = ParserState::WaitingPayloadLength;
                        }
                        Err(_) => {
                            self.reset_on_error();
                            return Err("FramingError: Failed to parse JSON header".to_string());
                        }
                    }
                }

                ParserState::WaitingPayloadLength => {
                    if self.buffer.len() < 4 {
                        return Ok(messages);
                    }
                    self.expected_payload_len =
                        u32::from_le_bytes(self.buffer[..4].try_into().unwrap());
                    self.buffer.drain(..4);
                    self.state = ParserState::WaitingPayload;
                }

                ParserState::WaitingPayload => {
                    let needed = self.expected_payload_len as usize;
                    if self.buffer.len() < needed {
                        return Ok(messages);
                    }

                    let payload = if needed > 0 {
                        let p = self.buffer[..needed].to_vec();
                        self.buffer.drain(..needed);
                        Some(p)
                    } else {
                        None
                    };

                    let header = self.current_header.take().unwrap_or_default();
                    messages.push(FramedMessage { header, payload });

                    self.expected_header_len = 0;
                    self.expected_payload_len = 0;
                    self.state = ParserState::WaitingHeaderLength;

                    if self.buffer.is_empty() {
                        return Ok(messages);
                    }
                }
            }
        }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
        self.expected_header_len = 0;
        self.expected_payload_len = 0;
        self.state = ParserState::WaitingHeaderLength;
        self.current_header = None;
    }

    /// Try to resynchronise by scanning for a plausible header-length + valid JSON boundary.
    /// Falls back to a hard reset if nothing is found.
    pub fn reset_on_error(&mut self) {
        let buf = self.buffer.clone();
        let n = buf.len();

        if n < 4 {
            self.reset();
            return;
        }

        for i in 0..=(n.saturating_sub(4)) {
            let candidate_len =
                u32::from_le_bytes(buf[i..i + 4].try_into().unwrap());

            if candidate_len == 0 || candidate_len > MAX_HEADER_SIZE {
                continue;
            }

            let header_start = i + 4;
            let header_end = header_start + candidate_len as usize;

            if header_end > n {
                // Keep from i onwards; wait for more data
                self.buffer = buf[i..].to_vec();
                self.state = ParserState::WaitingHeaderLength;
                self.expected_header_len = 0;
                self.expected_payload_len = 0;
                self.current_header = None;
                return;
            }

            if serde_json::from_slice::<HashMap<String, Value>>(&buf[header_start..header_end])
                .is_ok()
            {
                self.buffer = buf[i..].to_vec();
                self.state = ParserState::WaitingHeaderLength;
                self.expected_header_len = 0;
                self.expected_payload_len = 0;
                self.current_header = None;
                return;
            }
        }

        self.reset();
    }
}
