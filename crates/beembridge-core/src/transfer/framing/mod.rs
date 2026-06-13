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

#[derive(Debug)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Header used across tests: a single string field.
    fn sample_header() -> serde_json::Value {
        json!({ "k": "v" })
    }

    #[test]
    fn roundtrip_single() {
        let bytes = build_framed_message(&sample_header(), None).unwrap();
        let mut parser = FrameParser::new();
        let msgs = parser.feed(&bytes).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].header.get("k").and_then(|v| v.as_str()), Some("v"));
        assert!(msgs[0].payload.is_none());
    }

    #[test]
    fn roundtrip_with_payload() {
        let bytes = build_framed_message(&sample_header(), Some(b"hello")).unwrap();
        let mut parser = FrameParser::new();
        let msgs = parser.feed(&bytes).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].payload.as_deref(), Some(&b"hello"[..]));
    }

    #[test]
    fn zero_length_payload_is_none() {
        let bytes = build_framed_message(&sample_header(), Some(&[])).unwrap();
        let mut parser = FrameParser::new();
        let msgs = parser.feed(&bytes).unwrap();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].payload.is_none());
    }

    #[test]
    fn split_across_chunks() {
        let bytes = build_framed_message(&sample_header(), Some(b"abc")).unwrap();
        // Split somewhere inside the header bytes (after the 4-byte length prefix).
        let mid = 4 + 1;
        let (a, b) = bytes.split_at(mid);

        let mut parser = FrameParser::new();
        let first = parser.feed(a).unwrap();
        assert!(first.is_empty(), "no message should emerge from a partial header");
        let second = parser.feed(b).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].payload.as_deref(), Some(&b"abc"[..]));
    }

    #[test]
    fn two_messages_one_feed() {
        let mut bytes = build_framed_message(&json!({ "n": 1 }), None).unwrap();
        bytes.extend(build_framed_message(&json!({ "n": 2 }), Some(b"x")).unwrap());

        let mut parser = FrameParser::new();
        let msgs = parser.feed(&bytes).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].header.get("n").and_then(|v| v.as_u64()), Some(1));
        assert!(msgs[0].payload.is_none());
        assert_eq!(msgs[1].header.get("n").and_then(|v| v.as_u64()), Some(2));
        assert_eq!(msgs[1].payload.as_deref(), Some(&b"x"[..]));
    }

    #[test]
    fn bad_header_errors() {
        // 4-byte length = 3, followed by 3 bytes that are not valid JSON.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(b"@@@");

        let mut parser = FrameParser::new();
        assert!(parser.feed(&bytes).is_err());
    }

    #[test]
    fn resync_after_bad_header() {
        // A garbage frame (valid length prefix, invalid JSON body) immediately
        // followed by a well-formed frame. After the error, reset_on_error should
        // scan forward and lock onto the good frame.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(b"@@@");
        let good = build_framed_message(&json!({ "ok": true }), None).unwrap();
        bytes.extend_from_slice(&good);

        let mut parser = FrameParser::new();
        let err = parser.feed(&bytes);
        assert!(err.is_err());
        // feed() already called reset_on_error internally on the error path.
        // Feeding nothing more should now surface the recovered good frame.
        let recovered = parser.feed(&[]).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            recovered[0].header.get("ok").and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}