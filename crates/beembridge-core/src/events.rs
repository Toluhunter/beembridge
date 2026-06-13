use serde::Serialize;
use tokio::sync::broadcast;

use crate::secrets::TofuStatus;
use crate::transfer::discovery::DiscoveredPeer;

const DEFAULT_CAPACITY: usize = 256;

/// Events emitted by core. Frontends subscribe via `EventBus::subscribe` and
/// render however they like (Tauri `emit`, CLI stdout, TUI redraw, etc.).
///
/// `Serialize` is implemented so frontends can pass events straight through to
/// their own wire format (Tauri IPC, JSON-lines, etc.) without re-mapping.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CoreEvent {
    PeerDiscoveryUpdate { peers: Vec<DiscoveredPeer> },
    IncomingConnectionRequest {
        connection_id: String,
        peer_id: String,
        peer_name: String,
        peer_key: String,
        tofu_status: TofuStatus,
        remote_addr: String,
    },
}

/// Fan-out event channel. One producer (core), many consumers (any frontend
/// or test). Lossy on slow consumers — events are best-effort telemetry,
/// not durable state. Authoritative state lives in core's own data structures.
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    pub fn with_capacity(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Subscribe to all future events. Receivers that fall behind by more than
    /// the channel capacity will see `RecvError::Lagged(n)` and skip events.
    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }

    /// Hand out a cloned sender so spawned tasks can emit without holding the bus.
    pub fn sender(&self) -> broadcast::Sender<CoreEvent> {
        self.tx.clone()
    }

    /// Emit an event. No-op if there are no subscribers.
    pub fn emit(&self, ev: CoreEvent) {
        let _ = self.tx.send(ev);
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}