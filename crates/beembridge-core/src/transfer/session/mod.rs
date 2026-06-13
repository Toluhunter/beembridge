use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{SigningKey, VerifyingKey};
use ed25519_dalek::pkcs8::EncodePrivateKey;
use log::warn;
use rcgen::KeyPair;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};
use thiserror::Error;
use tokio::sync::{broadcast, oneshot, Mutex as AsyncMutex};
use x509_cert::der::Decode as _;

use crate::events::CoreEvent;
use crate::secrets::{SecretStore, TofuStatus};
use crate::transfer::discovery::DiscoveredPeer;
use crate::transfer::framing::{build_framed_message, FrameParser, FramedMessage};

// ---- Error ----

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("secret store error: {0}")]
    Secret(String),
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("connection error: {0}")]
    Connect(String),
    #[error("peer did not present a key during handshake")]
    NoPeerKey,
    #[error("invalid certificate: {0}")]
    InvalidCertificate(String),
    #[error("framing error: {0}")]
    Framing(String),
    #[error("stream closed by peer")]
    StreamClosed,
    #[error("handshake timed out")]
    HandshakeTimeout,
    #[error("handshake message exceeded size limit")]
    HandshakeTooLarge,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
// 4 KiB is far more than enough for SessionOpen / SessionAccepted frames.
// TODO: add a separate global per-chunk payload size limit once chunking logic is designed.
const MAX_HANDSHAKE_BYTES: usize = 4 * 1024;

impl From<crate::secrets::SecretError> for SessionError {
    fn from(e: crate::secrets::SecretError) -> Self {
        SessionError::Secret(e.to_string())
    }
}

// ---- Pending connections ----

/// Tracks in-flight connection requests awaiting user accept/reject.
/// The accept loop registers each incoming connection; the UI layer calls
/// `respond` once the user has made a decision.
pub struct PendingConnections {
    inner: std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl PendingConnections {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Register a new pending connection and return the receiver to await on.
    pub fn register(&self, connection_id: String) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().unwrap().insert(connection_id, tx);
        rx
    }

    /// Resolve a pending connection. `accepted = true` allows it, `false` rejects.
    pub fn respond(&self, connection_id: &str, accepted: bool) -> Result<(), SessionError> {
        let tx = self
            .inner
            .lock()
            .unwrap()
            .remove(connection_id)
            .ok_or_else(|| SessionError::Connect(format!("no pending connection: {connection_id}")))?;
        let _ = tx.send(accepted);
        Ok(())
    }
}

impl Default for PendingConnections {
    fn default() -> Self {
        Self::new()
    }
}

// ---- Session ----

#[derive(Debug)]
pub struct Session {
    connection: quinn::Connection,
    // Kept alive so its UDP socket outlives the connection it drives.
    // Only set for the initiate (client) side; the accept side borrows
    // the caller-owned endpoint instead.
    _local_endpoint: Option<quinn::Endpoint>,
    send: AsyncMutex<quinn::SendStream>,
    recv: AsyncMutex<quinn::RecvStream>,
    parser: AsyncMutex<FrameParser>,
    peer_static_key: VerifyingKey,
}

impl Session {
    /// Initiate a QUIC connection to a known peer. Returns the session and the
    /// TOFU status of the peer's key so the caller can decide whether to proceed.
    pub async fn initiate(
        addr: SocketAddr,
        peer_id: &str,
        secret_store: &dyn SecretStore,
    ) -> Result<(Self, TofuStatus), SessionError> {
        let signing_key = secret_store.get_keypair()?;
        let (cert_der, key_der) = build_self_signed_cert(&signing_key)?;

        let tls_config = rustls::ClientConfig::builder_with_provider(
            Arc::new(rustls::crypto::ring::default_provider()),
        )
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| SessionError::Tls(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyEd25519CertVerifier))
        .with_client_auth_cert(vec![cert_der], key_der)
        .map_err(|e| SessionError::Tls(e.to_string()))?;

        let quinn_client_config = quinn::ClientConfig::new(Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(tls_config)
                .map_err(|e| SessionError::Tls(e.to_string()))?,
        ));

        let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().unwrap())?;
        endpoint.set_default_client_config(quinn_client_config);

        let connection = endpoint
            .connect(addr, "beembridge")
            .map_err(|e| SessionError::Connect(e.to_string()))?
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;

        let peer_key = extract_key_from_connection(&connection)?;
        let tofu_status = secret_store.verify_peer_key(peer_id, &peer_key)?;

        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;

        // quinn does not transmit a STREAM frame until the opener writes data.
        // Send a SessionOpen handshake frame so the acceptor's accept_bi() unblocks.
        let open_bytes = build_framed_message(
            &serde_json::json!({"type": "SessionOpen"}),
            None,
        )
        .map_err(|e| SessionError::Framing(e.to_string()))?;
        send.write_all(&open_bytes)
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;

        // Wait for the receiver to confirm the user accepted the connection.
        // Aborts after 2 minutes or if the sender pushes more than MAX_HANDSHAKE_BYTES.
        let parser = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            await_session_accepted(&mut recv),
        )
        .await
        .map_err(|_| SessionError::HandshakeTimeout)??;

        Ok((
            Self {
                connection,
                _local_endpoint: Some(endpoint),
                send: AsyncMutex::new(send),
                recv: AsyncMutex::new(recv),
                parser: AsyncMutex::new(parser),
                peer_static_key: peer_key,
            },
            tofu_status,
        ))
    }

    /// Accept one incoming QUIC connection on `endpoint`. The caller is
    /// responsible for the accept loop and for spawning tasks per connection.
    /// TOFU check is the caller's responsibility: use `remote_addr()` to look
    /// up the peer_id in the discovery table, then call
    /// `secret_store.verify_peer_key(peer_id, session.peer_static_key())`.
    pub async fn accept(endpoint: &quinn::Endpoint) -> Result<Self, SessionError> {
        let incoming = endpoint
            .accept()
            .await
            .ok_or_else(|| SessionError::Connect("endpoint closed".into()))?;

        let connection = incoming
            .accept()
            .map_err(|e| SessionError::Connect(e.to_string()))?
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;

        let peer_key = extract_key_from_connection(&connection)?;

        let (send, mut recv) = connection
            .accept_bi()
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;

        // Read the SessionOpen frame sent by the initiator.
        // Aborts after 2 minutes or if the sender pushes more than MAX_HANDSHAKE_BYTES.
        // The parser is passed into the Session so bytes buffered past the frame are not lost.
        let parser = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            await_session_open(&mut recv),
        )
        .await
        .map_err(|_| SessionError::HandshakeTimeout)??;

        Ok(Self {
            connection,
            _local_endpoint: None,
            send: AsyncMutex::new(send),
            recv: AsyncMutex::new(recv),
            parser: AsyncMutex::new(parser),
            peer_static_key: peer_key,
        })
    }

    /// Inform the initiator that the user accepted the connection.
    /// Call this after the user confirms; only then will the initiator's
    /// `Session::initiate` return and file transfer can begin.
    pub async fn send_session_accepted(&self) -> Result<(), SessionError> {
        self.send_message(&serde_json::json!({"type": "SessionAccepted"}), None).await
    }

    /// Send a framed message over the session stream.
    pub async fn send_message(
        &self,
        header: &impl serde::Serialize,
        payload: Option<&[u8]>,
    ) -> Result<(), SessionError> {
        let bytes = build_framed_message(header, payload)
            .map_err(|e| SessionError::Framing(e.to_string()))?;
        self.send
            .lock()
            .await
            .write_all(&bytes)
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?;
        Ok(())
    }

    /// Read the next complete framed message from the session stream.
    pub async fn recv_message(&self) -> Result<FramedMessage, SessionError> {
        let mut recv = self.recv.lock().await;
        let mut parser = self.parser.lock().await;
        let mut buf = vec![0u8; 8192];
        loop {
            let n = recv
                .read(&mut buf)
                .await
                .map_err(|e| SessionError::Connect(e.to_string()))?
                .ok_or(SessionError::StreamClosed)?;
            let messages = parser
                .feed(&buf[..n])
                .map_err(|e| SessionError::Framing(e.to_string()))?;
            if let Some(msg) = messages.into_iter().next() {
                return Ok(msg);
            }
        }
    }

    pub fn peer_static_key(&self) -> &VerifyingKey {
        &self.peer_static_key
    }

    pub fn remote_addr(&self) -> SocketAddr {
        self.connection.remote_address()
    }
}

// ---- Endpoint factory ----

/// Create a QUIC server endpoint bound to `bind_addr`.
/// The returned endpoint is ready to accept incoming sessions via `Session::accept`.
/// The bound port (for broadcasting in discovery) is `endpoint.local_addr()?.port()`.
pub fn make_server_endpoint(
    bind_addr: SocketAddr,
    secret_store: &dyn SecretStore,
) -> Result<quinn::Endpoint, SessionError> {
    let signing_key = secret_store.get_keypair()?;
    let (cert_der, key_der) = build_self_signed_cert(&signing_key)?;

    let tls_config = rustls::ServerConfig::builder_with_provider(
        Arc::new(rustls::crypto::ring::default_provider()),
    )
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| SessionError::Tls(e.to_string()))?
    .with_client_cert_verifier(Arc::new(AnyEd25519ClientVerifier))
    .with_single_cert(vec![cert_der], key_der)
    .map_err(|e| SessionError::Tls(e.to_string()))?;

    let quinn_server_config = quinn::ServerConfig::with_crypto(Arc::new(
        quinn::crypto::rustls::QuicServerConfig::try_from(tls_config)
            .map_err(|e| SessionError::Tls(e.to_string()))?,
    ));

    quinn::Endpoint::server(quinn_server_config, bind_addr)
        .map_err(|e| SessionError::Connect(e.to_string()))
}

// ---- Accept loop ----

/// Runs forever, accepting one QUIC connection at a time and spawning a task
/// per peer. Each task runs the TOFU check, emits an `IncomingConnectionRequest`
/// event, and waits for the user's decision via `PendingConnections::respond`.
/// Only after the user accepts is `SessionAccepted` sent to the initiator.
pub async fn run_accept_loop(
    endpoint: quinn::Endpoint,
    secret_store: Arc<dyn SecretStore>,
    peers: Arc<std::sync::Mutex<HashMap<String, DiscoveredPeer>>>,
    events_tx: broadcast::Sender<CoreEvent>,
    pending: Arc<PendingConnections>,
) {
    loop {
        let session = match Session::accept(&endpoint).await {
            Ok(s) => s,
            Err(e) => {
                warn!("[Session] accept error: {e}");
                continue;
            }
        };

        let secret_store = Arc::clone(&secret_store);
        let peers = Arc::clone(&peers);
        let events_tx = events_tx.clone();
        let pending = Arc::clone(&pending);

        tokio::spawn(async move {
            handle_incoming(session, secret_store, peers, events_tx, pending).await;
        });
    }
}

async fn handle_incoming(
    session: Session,
    secret_store: Arc<dyn SecretStore>,
    peers: Arc<std::sync::Mutex<HashMap<String, DiscoveredPeer>>>,
    events_tx: broadcast::Sender<CoreEvent>,
    pending: Arc<PendingConnections>,
) {
    let remote_addr = session.remote_addr();
    let peer_key = *session.peer_static_key();
    let peer_key_b64 = STANDARD.encode(peer_key.as_bytes());

    // Best-effort lookup: find the peer in the discovery table by IP so we
    // have a stable peer_id for TOFU. If the peer is not in the table (e.g.
    // direct connection outside discovery) we fall back to the key itself as
    // the peer_id — TOFU will treat it as New.
    let (peer_id, peer_name) = {
        let map = peers.lock().unwrap();
        map.values()
            .find(|p| p.ip_address == remote_addr.ip().to_string())
            .map(|p| (p.peer_id.clone(), p.peer_name.clone()))
            .unwrap_or_else(|| (peer_key_b64.clone(), "Unknown".to_string()))
    };

    let tofu_status = match secret_store.verify_peer_key(&peer_id, &peer_key) {
        Ok(s) => s,
        Err(e) => {
            warn!("[Session] TOFU check failed for {remote_addr}: {e}");
            return;
        }
    };

    let connection_id = uuid::Uuid::new_v4().to_string();
    let decision = pending.register(connection_id.clone());

    let _ = events_tx.send(CoreEvent::IncomingConnectionRequest {
        connection_id,
        peer_id,
        peer_name,
        peer_key: peer_key_b64,
        tofu_status,
        remote_addr: remote_addr.to_string(),
    });

    // Block until the UI resolves the decision. If the sender is dropped
    // (e.g. the app is shutting down) we treat it as a rejection.
    let accepted = decision.await.unwrap_or(false);

    if !accepted {
        // Dropping the session closes the QUIC connection.
        return;
    }

    if let Err(e) = session.send_session_accepted().await {
        warn!("[Session] Failed to send SessionAccepted to {remote_addr}: {e}");
        return;
    }

    // Session is now live and confirmed. Hand off to the file transfer handler.
    // TODO: pass session to transfer::file_transfer when implemented.
}

// ---- Handshake read helpers ----

/// Read bytes from `recv` until the FrameParser yields a SessionOpen frame.
/// Enforces a byte cap and a 2-minute timeout so a malicious or stalled sender
/// cannot hold the connection open indefinitely.
async fn await_session_open(recv: &mut quinn::RecvStream) -> Result<FrameParser, SessionError> {
    let mut parser = FrameParser::new();
    let mut buf = vec![0u8; 8192];
    let mut bytes_read = 0usize;
    loop {
        let n = recv
            .read(&mut buf)
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?
            .ok_or(SessionError::StreamClosed)?;
        bytes_read += n;
        if bytes_read > MAX_HANDSHAKE_BYTES {
            return Err(SessionError::HandshakeTooLarge);
        }
        let messages = parser
            .feed(&buf[..n])
            .map_err(|e| SessionError::Framing(e.to_string()))?;
        if let Some(msg) = messages.into_iter().next() {
            if msg.header.get("type").and_then(|v| v.as_str()) != Some("SessionOpen") {
                return Err(SessionError::Framing(format!(
                    "expected SessionOpen, got: {:?}",
                    msg.header.get("type")
                )));
            }
            return Ok(parser);
        }
    }
}

/// Read bytes from `recv` until the FrameParser yields a SessionAccepted frame.
/// Enforces a byte cap and a 2-minute timeout so a malicious or stalled receiver
/// cannot block the initiator indefinitely.
async fn await_session_accepted(recv: &mut quinn::RecvStream) -> Result<FrameParser, SessionError> {
    let mut parser = FrameParser::new();
    let mut buf = vec![0u8; 8192];
    let mut bytes_read = 0usize;
    loop {
        let n = recv
            .read(&mut buf)
            .await
            .map_err(|e| SessionError::Connect(e.to_string()))?
            .ok_or(SessionError::StreamClosed)?;
        bytes_read += n;
        if bytes_read > MAX_HANDSHAKE_BYTES {
            return Err(SessionError::HandshakeTooLarge);
        }
        let messages = parser
            .feed(&buf[..n])
            .map_err(|e| SessionError::Framing(e.to_string()))?;
        if let Some(msg) = messages.into_iter().next() {
            if msg.header.get("type").and_then(|v| v.as_str()) != Some("SessionAccepted") {
                return Err(SessionError::Connect(format!(
                    "expected SessionAccepted, got: {:?}",
                    msg.header.get("type")
                )));
            }
            return Ok(parser);
        }
    }
}

// ---- Certificate builder ----

fn pkcs8_to_pem(der: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let encoded = STANDARD.encode(der);
    let mut pem = String::from("-----BEGIN PRIVATE KEY-----\n");
    for chunk in encoded.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap());
        pem.push('\n');
    }
    pem.push_str("-----END PRIVATE KEY-----");
    pem
}

fn build_self_signed_cert(
    signing_key: &SigningKey,
) -> Result<(CertificateDer<'static>, PrivateKeyDer<'static>), SessionError> {
    let pkcs8_doc = signing_key
        .to_pkcs8_der()
        .map_err(|e| SessionError::Tls(e.to_string()))?;
    let pkcs8_bytes = pkcs8_doc.as_bytes().to_vec();

    let pem = pkcs8_to_pem(&pkcs8_bytes);
    let key_pair = KeyPair::from_pem(&pem)
        .map_err(|e| SessionError::Tls(e.to_string()))?;

    let params = rcgen::CertificateParams::default();
    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| SessionError::Tls(e.to_string()))?;

    let cert_der = CertificateDer::from(cert.der().to_vec());
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8_bytes));

    Ok((cert_der, key_der))
}

// ---- Key extraction ----

fn extract_key_from_connection(connection: &quinn::Connection) -> Result<VerifyingKey, SessionError> {
    let identity = connection.peer_identity().ok_or(SessionError::NoPeerKey)?;
    let certs = identity
        .downcast::<Vec<CertificateDer<'static>>>()
        .map_err(|_| SessionError::NoPeerKey)?;
    let cert = certs.first().ok_or(SessionError::NoPeerKey)?;
    extract_ed25519_key(cert)
}

fn extract_ed25519_key(cert_der: &CertificateDer<'_>) -> Result<VerifyingKey, SessionError> {
    let cert = x509_cert::Certificate::from_der(cert_der.as_ref())
        .map_err(|e| SessionError::InvalidCertificate(e.to_string()))?;
    let key_bytes = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .raw_bytes();
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| SessionError::InvalidCertificate("expected 32-byte Ed25519 key".into()))?;
    VerifyingKey::from_bytes(&key_array)
        .map_err(|e| SessionError::InvalidCertificate(e.to_string()))
}

// ---- Custom rustls verifiers ----

/// Used by the initiator (client) to verify the receiver's certificate.
/// Accepts any syntactically valid Ed25519 cert; TOFU is checked post-handshake.
#[derive(Debug)]
struct AnyEd25519CertVerifier;

impl ServerCertVerifier for AnyEd25519CertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        extract_ed25519_key(end_entity)
            .map_err(|e| rustls::Error::General(e.to_string()))?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 not supported".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_ed25519_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

/// Used by the receiver (server) to verify the initiator's certificate.
/// Accepts any syntactically valid Ed25519 cert; the caller does the TOFU
/// check after `Session::accept` returns using `remote_addr()` + `peer_static_key()`.
#[derive(Debug)]
struct AnyEd25519ClientVerifier;

impl ClientCertVerifier for AnyEd25519ClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        extract_ed25519_key(end_entity)
            .map_err(|e| rustls::Error::General(e.to_string()))?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 not supported".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_ed25519_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

fn verify_ed25519_signature(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    if dss.scheme != SignatureScheme::ED25519 {
        return Err(rustls::Error::General(format!(
            "expected ED25519, got {:?}",
            dss.scheme
        )));
    }
    let key = extract_ed25519_key(cert).map_err(|e| rustls::Error::General(e.to_string()))?;
    let sig_bytes: [u8; 64] = dss
        .signature()
        .try_into()
        .map_err(|_| rustls::Error::General("invalid Ed25519 signature length".into()))?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_bytes);
    key.verify_strict(message, &signature)
        .map_err(|_| rustls::Error::General("Ed25519 signature verification failed".into()))?;
    Ok(HandshakeSignatureValid::assertion())
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;
    use super::{
        await_session_accepted, await_session_open, build_self_signed_cert,
        AnyEd25519CertVerifier, MAX_HANDSHAKE_BYTES,
    };
    use crate::secrets::FileSecretStore;
    use std::time::Duration;
    use tempfile::TempDir;

    const TEST_TIMEOUT: Duration = Duration::from_millis(200);

    fn make_store() -> (FileSecretStore, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSecretStore::new(dir.path().to_path_buf());
        (store, dir)
    }

    fn server_endpoint(store: &dyn SecretStore) -> quinn::Endpoint {
        make_server_endpoint("127.0.0.1:0".parse().unwrap(), store).unwrap()
    }

    #[tokio::test]
    async fn handshake_new_peer() {
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();

        // Use a oneshot channel to retrieve the server session from the
        // fire-and-forget accept task. The accept task must run freely as an
        // independent task so quinn can drive both sides of the QUIC handshake.
        let (tx, rx) = tokio::sync::oneshot::channel();
        let ep = endpoint.clone();
        tokio::spawn(async move {
            let session = Session::accept(&ep).await.unwrap();
            session.send_session_accepted().await.unwrap();
            tx.send(session).ok();
        });

        let (client_session, status) =
            Session::initiate(server_addr, "server-001", &client_store)
                .await
                .unwrap();
        let server_session = rx.await.unwrap();

        assert_eq!(status, TofuStatus::New);

        // Each side extracted the other's key correctly
        let expected_server_key = server_store.get_keypair().unwrap().verifying_key();
        let expected_client_key = client_store.get_keypair().unwrap().verifying_key();
        assert_eq!(client_session.peer_static_key(), &expected_server_key);
        assert_eq!(server_session.peer_static_key(), &expected_client_key);
    }

    #[tokio::test]
    async fn handshake_known_peer_matches() {
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();
        let server_key = server_store.get_keypair().unwrap().verifying_key();

        let (client_store, _cd) = make_store();
        let peer_id = "server-001";

        // First connection: New
        let (tx1, rx1) = tokio::sync::oneshot::channel();
        let ep = endpoint.clone();
        tokio::spawn(async move {
            let s = Session::accept(&ep).await.unwrap();
            s.send_session_accepted().await.unwrap();
            tx1.send(s).ok();
        });
        let (_, status1) = Session::initiate(server_addr, peer_id, &client_store)
            .await
            .unwrap();
        let _s1 = rx1.await.unwrap();
        assert_eq!(status1, TofuStatus::New);

        // Pin the server's key
        client_store.pin_peer_key(peer_id, &server_key).unwrap();

        // Second connection: Matches
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        let ep2 = endpoint.clone();
        tokio::spawn(async move {
            let s = Session::accept(&ep2).await.unwrap();
            s.send_session_accepted().await.unwrap();
            tx2.send(s).ok();
        });
        let (_, status2) = Session::initiate(server_addr, peer_id, &client_store)
            .await
            .unwrap();
        let _s2 = rx2.await.unwrap();
        assert_eq!(status2, TofuStatus::Matches);
    }

    #[tokio::test]
    async fn handshake_key_mismatch() {
        let (client_store, _cd) = make_store();
        let peer_id = "server-001";

        // Connect to server A and pin its key
        let (server_a_store, _sad) = make_store();
        let endpoint_a = server_endpoint(&server_a_store);
        let addr_a = endpoint_a.local_addr().unwrap();
        let key_a = server_a_store.get_keypair().unwrap().verifying_key();

        let (txa, rxa) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let s = Session::accept(&endpoint_a).await.unwrap();
            s.send_session_accepted().await.unwrap();
            txa.send(s).ok();
        });
        Session::initiate(addr_a, peer_id, &client_store).await.unwrap();
        let _sa = rxa.await.unwrap();
        client_store.pin_peer_key(peer_id, &key_a).unwrap();

        // Connect to server B (different key) under the same peer_id
        let (server_b_store, _sbd) = make_store();
        let endpoint_b = server_endpoint(&server_b_store);
        let addr_b = endpoint_b.local_addr().unwrap();

        let (txb, rxb) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let s = Session::accept(&endpoint_b).await.unwrap();
            s.send_session_accepted().await.unwrap();
            txb.send(s).ok();
        });
        let (_, status) = Session::initiate(addr_b, peer_id, &client_store)
            .await
            .unwrap();
        let _sb = rxb.await.unwrap();
        assert_eq!(status, TofuStatus::Mismatch);
    }

    #[tokio::test]
    async fn send_recv_message() {
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();

        let (tx, rx) = tokio::sync::oneshot::channel();
        let ep = endpoint.clone();
        tokio::spawn(async move {
            let session = Session::accept(&ep).await.unwrap();
            session.send_session_accepted().await.unwrap();
            tx.send(session).ok();
        });

        let (client_session, _) =
            Session::initiate(server_addr, "server-001", &client_store)
                .await
                .unwrap();
        let server_session = rx.await.unwrap();

        let sent = serde_json::json!({
            "type": "FileOffer",
            "name": "photo.jpg",
            "size": 1024
        });

        client_session.send_message(&sent, None).await.unwrap();
        let received = server_session.recv_message().await.unwrap();

        assert_eq!(received.header["type"], "FileOffer");
        assert_eq!(received.header["name"], "photo.jpg");
        assert_eq!(received.header["size"], 1024);
    }

    // ---- Raw client helper ----

    /// A Quinn endpoint configured identically to Session::initiate but returned
    /// unwrapped so tests can open streams and write arbitrary bytes, bypassing
    /// the normal SessionOpen / SessionAccepted protocol.
    fn make_raw_client(store: &dyn SecretStore) -> quinn::Endpoint {
        let signing_key = store.get_keypair().unwrap();
        let (cert_der, key_der) = build_self_signed_cert(&signing_key).unwrap();

        let tls_config = rustls::ClientConfig::builder_with_provider(
            std::sync::Arc::new(rustls::crypto::ring::default_provider()),
        )
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(AnyEd25519CertVerifier))
        .with_client_auth_cert(vec![cert_der], key_der)
        .unwrap();

        let quinn_config = quinn::ClientConfig::new(std::sync::Arc::new(
            quinn::crypto::rustls::QuicClientConfig::try_from(tls_config).unwrap(),
        ));

        let mut endpoint = quinn::Endpoint::client("0.0.0.0:0".parse().unwrap()).unwrap();
        endpoint.set_default_client_config(quinn_config);
        endpoint
    }

    // ---- Large packet rejection ----

    #[tokio::test]
    async fn large_packet_rejected_on_acceptor_side() {
        // A raw initiator sends a properly framed message whose total byte count
        // exceeds MAX_HANDSHAKE_BYTES before a valid SessionOpen arrives.
        // Session::accept must reject it (HandshakeTooLarge or Framing depending
        // on which check fires first).
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();
        let raw_client = make_raw_client(&client_store);

        tokio::spawn(async move {
            let conn = raw_client
                .connect(server_addr, "beembridge")
                .unwrap()
                .await
                .unwrap();
            let (mut send, _recv) = conn.open_bi().await.unwrap();
            let payload = vec![0u8; MAX_HANDSHAKE_BYTES + 100];
            let frame =
                build_framed_message(&serde_json::json!({"type": "malicious"}), Some(&payload))
                    .unwrap();
            send.write_all(&frame).await.ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let result = Session::accept(&endpoint).await;
        assert!(
            matches!(
                result,
                Err(SessionError::HandshakeTooLarge) | Err(SessionError::Framing(_))
            ),
            "expected HandshakeTooLarge or Framing, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn large_packet_rejected_on_initiator_side() {
        // A raw acceptor drains SessionOpen then sends an oversized frame instead
        // of SessionAccepted. Session::initiate must reject it.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();

        tokio::spawn(async move {
            let incoming = endpoint.accept().await.unwrap();
            let conn = incoming.accept().unwrap().await.unwrap();
            // accept_bi returns after the initiator writes SessionOpen.
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let mut buf = vec![0u8; 8192];
            recv.read(&mut buf).await.ok();
            // Write an oversized frame back onto the initiator's recv stream.
            let payload = vec![0u8; MAX_HANDSHAKE_BYTES + 100];
            let frame =
                build_framed_message(&serde_json::json!({"type": "malicious"}), Some(&payload))
                    .unwrap();
            send.write_all(&frame).await.ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let result = Session::initiate(server_addr, "server-001", &client_store).await;
        assert!(
            matches!(
                result,
                Err(SessionError::HandshakeTooLarge) | Err(SessionError::Framing(_))
            ),
            "expected HandshakeTooLarge or Framing, got: {result:?}"
        );
    }

    // ---- Timeout ----

    #[tokio::test]
    async fn acceptor_times_out_when_no_session_open_arrives() {
        // A raw initiator opens a stream but never writes. await_session_open
        // wrapped in TEST_TIMEOUT must time out rather than block forever.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();
        let raw_client = make_raw_client(&client_store);

        tokio::spawn(async move {
            let conn = raw_client
                .connect(server_addr, "beembridge")
                .unwrap()
                .await
                .unwrap();
            let (mut send, _recv) = conn.open_bi().await.unwrap();
            // Write one byte so Quinn sends the STREAM frame — accept_bi on the
            // server blocks until it receives one. The single byte is not a
            // complete frame so await_session_open will block for more data.
            send.write_all(&[0u8]).await.ok();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        let incoming = endpoint.accept().await.unwrap();
        let conn = incoming.accept().unwrap().await.unwrap();
        let (_send, mut recv) = conn.accept_bi().await.unwrap();

        let result = tokio::time::timeout(TEST_TIMEOUT, await_session_open(&mut recv)).await;
        assert!(result.is_err(), "expected timeout to fire, got: {result:?}");
    }

    #[tokio::test]
    async fn initiator_times_out_when_no_session_accepted_arrives() {
        // A raw acceptor drains SessionOpen but never replies. await_session_accepted
        // wrapped in TEST_TIMEOUT must time out rather than block forever.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();
        let raw_client = make_raw_client(&client_store);

        tokio::spawn(async move {
            let incoming = endpoint.accept().await.unwrap();
            let conn = incoming.accept().unwrap().await.unwrap();
            let (_send, mut recv) = conn.accept_bi().await.unwrap();
            let mut buf = vec![0u8; 8192];
            recv.read(&mut buf).await.ok();
            // Hold the connection open so the initiator times out rather than
            // receiving a stream-closed error.
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        let conn = raw_client
            .connect(server_addr, "beembridge")
            .unwrap()
            .await
            .unwrap();
        let (mut send, mut recv) = conn.open_bi().await.unwrap();
        let open_bytes =
            build_framed_message(&serde_json::json!({"type": "SessionOpen"}), None).unwrap();
        send.write_all(&open_bytes).await.unwrap();

        let result = tokio::time::timeout(TEST_TIMEOUT, await_session_accepted(&mut recv)).await;
        assert!(result.is_err(), "expected timeout to fire, got: {result:?}");
    }

    // ---- Multiple concurrent connections ----

    #[tokio::test]
    async fn multiple_concurrent_connections() {
        const N: usize = 5;

        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        // Accept loop handles N connections. Each session is forwarded through a
        // channel so it stays alive until all clients have completed initiation.
        let (session_tx, mut session_rx) = tokio::sync::mpsc::channel::<Session>(N);
        let ep = endpoint.clone();
        tokio::spawn(async move {
            for _ in 0..N {
                let session = Session::accept(&ep).await.unwrap();
                let tx = session_tx.clone();
                tokio::spawn(async move {
                    session.send_session_accepted().await.unwrap();
                    tx.send(session).await.ok();
                });
            }
        });

        // Connect N clients concurrently.
        let mut handles = Vec::new();
        for i in 0..N {
            let (client_store, _cd) = make_store();
            let handle = tokio::spawn(async move {
                let peer_id = format!("peer-{i:03}");
                Session::initiate(server_addr, &peer_id, &client_store).await
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap().expect("client session failed");
        }

        for _ in 0..N {
            session_rx.recv().await.expect("server session missing");
        }
    }

    // ---- Rejection path ----

    #[tokio::test]
    async fn rejected_connection_surfaces_error_to_initiator() {
        // The acceptor drops the session without calling send_session_accepted.
        // The initiator must receive a connection or stream error, not hang.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();

        tokio::spawn(async move {
            let _session = Session::accept(&endpoint).await.unwrap();
            // Drop immediately — no SessionAccepted sent.
        });

        let result = Session::initiate(server_addr, "server-001", &client_store).await;
        assert!(
            matches!(
                result,
                Err(SessionError::StreamClosed) | Err(SessionError::Connect(_))
            ),
            "expected StreamClosed or Connect error, got: {result:?}"
        );
    }

    // ---- Wrong frame type ----

    #[tokio::test]
    async fn wrong_frame_type_on_session_open_rejected() {
        // A raw initiator sends a valid frame with type "FileOffer" instead of
        // "SessionOpen". Session::accept must return a Framing error.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();
        let raw_client = make_raw_client(&client_store);

        tokio::spawn(async move {
            let conn = raw_client
                .connect(server_addr, "beembridge")
                .unwrap()
                .await
                .unwrap();
            let (mut send, _recv) = conn.open_bi().await.unwrap();
            let frame =
                build_framed_message(&serde_json::json!({"type": "FileOffer"}), None).unwrap();
            send.write_all(&frame).await.ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let result = Session::accept(&endpoint).await;
        assert!(
            matches!(result, Err(SessionError::Framing(_))),
            "expected Framing error, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn wrong_frame_type_on_session_accepted_rejected() {
        // A raw acceptor drains SessionOpen then sends type "FileReject" instead
        // of "SessionAccepted". Session::initiate must return a Connect error.
        let (server_store, _sd) = make_store();
        let endpoint = server_endpoint(&server_store);
        let server_addr = endpoint.local_addr().unwrap();

        let (client_store, _cd) = make_store();

        tokio::spawn(async move {
            let incoming = endpoint.accept().await.unwrap();
            let conn = incoming.accept().unwrap().await.unwrap();
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let mut buf = vec![0u8; 8192];
            recv.read(&mut buf).await.ok();
            let frame =
                build_framed_message(&serde_json::json!({"type": "FileReject"}), None).unwrap();
            send.write_all(&frame).await.ok();
            tokio::time::sleep(Duration::from_secs(2)).await;
        });

        let result = Session::initiate(server_addr, "server-001", &client_store).await;
        assert!(
            matches!(result, Err(SessionError::Connect(_))),
            "expected Connect error, got: {result:?}"
        );
    }

    // ---- PendingConnections unit tests ----

    #[test]
    fn pending_connections_unknown_id_errors() {
        let pending = PendingConnections::new();
        let result = pending.respond("nonexistent-id", true);
        assert!(
            matches!(result, Err(SessionError::Connect(_))),
            "expected Connect error for unknown id"
        );
    }

    #[test]
    fn pending_connections_duplicate_respond_errors() {
        let pending = PendingConnections::new();
        let _rx = pending.register("conn-1".to_string());
        pending.respond("conn-1", true).unwrap();
        // Second respond: id was removed on first call, should error.
        let result = pending.respond("conn-1", false);
        assert!(
            matches!(result, Err(SessionError::Connect(_))),
            "expected Connect error on second respond"
        );
    }
}
