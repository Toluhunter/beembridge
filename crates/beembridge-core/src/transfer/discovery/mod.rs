use crate::events::{CoreEvent, EventBus};
use crate::transfer::framing::{build_framed_message, FrameParser};
use if_addrs::get_if_addrs;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket as StdUdpSocket},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::UdpSocket,
    sync::broadcast,
    time::interval,
};
use uuid::Uuid;

const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MULTICAST_PORT: u16 = 9999;
const BROADCAST_PERIOD_MS: u64 = 500;
const CLEANUP_INTERVAL_MS: u64 = 1000;
const PEER_TIMEOUT_MS: u64 = 1500;

/// Wire format for a discovery announcement broadcast over UDP multicast.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveryMessage {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "peerId")]
    pub peer_id: String,
    #[serde(rename = "peerName")]
    pub peer_name: String,
    #[serde(rename = "quicPort")]
    pub quic_port: u16,
    #[serde(rename = "timestamp")]
    pub timestamp: i64,
}

/// A peer observed via discovery, plus the local clock time of the last sighting
/// and the source IP from which the announcement arrived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "peerId")]
    pub peer_id: String,
    #[serde(rename = "peerName")]
    pub peer_name: String,
    #[serde(rename = "quicPort")]
    pub quic_port: u16,
    #[serde(rename = "timestamp")]
    pub timestamp: i64,
    #[serde(rename = "lastSeen")]
    pub last_seen_ms: u64,
    #[serde(rename = "ipAddress")]
    pub ip_address: String,
}

impl DiscoveredPeer {
    /// True if no announcement has been seen within `timeout_ms`.
    /// Clock skew (last_seen in the future) saturates to age 0 → not stale.
    pub fn is_stale(&self, now_ms: u64, timeout_ms: u64) -> bool {
        now_ms.saturating_sub(self.last_seen_ms) >= timeout_ms
    }
}

pub struct PeerDiscovery {
    app_id: String,
    instance_id: String,
    peer_id: String,
    peer_name: String,
    quic_port: u16,
    pub peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
    stop_tx: broadcast::Sender<()>,
}

impl PeerDiscovery {
    pub fn new(
        app_id: impl Into<String>,
        peer_name: impl Into<String>,
        peer_id: impl Into<String>,
        quic_port: u16,
    ) -> Self {
        let instance_id = Uuid::new_v4().to_string();
        let (stop_tx, _) = broadcast::channel(1);

        Self {
            app_id: app_id.into(),
            instance_id,
            peer_id: peer_id.into(),
            peer_name: peer_name.into(),
            quic_port,
            peers: Arc::new(Mutex::new(HashMap::new())),
            stop_tx,
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn quic_port(&self) -> u16 {
        self.quic_port
    }

    /// Convenience: start with the bus's sender. See `start_with_sender` if
    /// you only have a `broadcast::Sender<CoreEvent>` in hand.
    pub async fn start(&self, bus: &EventBus) -> Result<(), String> {
        self.start_with_sender(bus.sender()).await
    }

    /// Start discovery: spawns broadcast, listen, and cleanup tasks.
    /// Peer updates are emitted as `CoreEvent::PeerDiscoveryUpdate` on `events_tx`.
    pub async fn start_with_sender(
        &self,
        events_tx: broadcast::Sender<CoreEvent>,
    ) -> Result<(), String> {
        let recv_socket = create_recv_socket().map_err(|e| e.to_string())?;
        let recv_socket = Arc::new(recv_socket);

        let send_sockets = create_send_sockets().map_err(|e| e.to_string())?;
        let send_sockets = Arc::new(send_sockets);

        let peers = Arc::clone(&self.peers);
        let app_id = self.app_id.clone();
        let instance_id = self.instance_id.clone();
        let peer_id = self.peer_id.clone();
        let peer_name = self.peer_name.clone();
        let quic_port = self.quic_port;

        // ---- Broadcast loop ----
        {
            let send_sockets = Arc::clone(&send_sockets);
            let app_id = app_id.clone();
            let instance_id = instance_id.clone();
            let peer_id = peer_id.clone();
            let peer_name = peer_name.clone();
            let mut stop_rx = self.stop_tx.subscribe();

            tokio::spawn(async move {
                let mut ticker = interval(Duration::from_millis(BROADCAST_PERIOD_MS));
                loop {
                    tokio::select! {
                        _ = stop_rx.recv() => break,
                        _ = ticker.tick() => {
                            broadcast_presence(&send_sockets, &app_id, &instance_id, &peer_id, &peer_name, quic_port);
                        }
                    }
                }
            });
        }

        // ---- Listen loop ----
        {
            let recv_socket = Arc::clone(&recv_socket);
            let peers = Arc::clone(&peers);
            let app_id = app_id.clone();
            let instance_id = instance_id.clone();
            let events_tx = events_tx.clone();
            let mut stop_rx = self.stop_tx.subscribe();

            tokio::spawn(async move {
                let mut buf = vec![0u8; 2048];
                let mut parser = FrameParser::new();

                loop {
                    tokio::select! {
                        _ = stop_rx.recv() => break,
                        result = recv_socket.recv_from(&mut buf) => {
                            match result {
                                Err(e) => { warn!("[Discovery] recv_from error: {e}"); }
                                Ok((n, src_addr)) => {
                                    let src_ip = match src_addr.ip() {
                                        IpAddr::V4(ip) => ip.to_string(),
                                        IpAddr::V6(ip) => ip.to_string(),
                                    };

                                    match parser.feed(&buf[..n]) {
                                        Err(e) => {
                                            warn!("[Discovery] parse error: {e}");
                                            parser.reset();
                                        }
                                        Ok(messages) => {
                                            for msg in messages {
                                                let json_bytes = match serde_json::to_vec(&msg.header) {
                                                    Ok(b) => b,
                                                    Err(_) => continue,
                                                };
                                                let discovery_msg: DiscoveryMessage = match serde_json::from_slice(&json_bytes) {
                                                    Ok(m) => m,
                                                    Err(_) => continue,
                                                };

                                                if discovery_msg.instance_id == instance_id
                                                    || discovery_msg.app_id != app_id
                                                {
                                                    continue;
                                                }

                                                let now_ms = now_millis();
                                                let peer = DiscoveredPeer {
                                                    app_id: discovery_msg.app_id,
                                                    instance_id: discovery_msg.instance_id.clone(),
                                                    peer_id: discovery_msg.peer_id,
                                                    peer_name: discovery_msg.peer_name,
                                                    quic_port: discovery_msg.quic_port,
                                                    timestamp: discovery_msg.timestamp,
                                                    last_seen_ms: now_ms,
                                                    ip_address: src_ip.clone(),
                                                };

                                                let peers_snapshot = {
                                                    let mut map = peers.lock().unwrap();
                                                    map.insert(discovery_msg.instance_id, peer);
                                                    map.values().cloned().collect::<Vec<_>>()
                                                };
                                                let _ = events_tx.send(CoreEvent::PeerDiscoveryUpdate { peers: peers_snapshot });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }

        // ---- Cleanup loop ----
        {
            let peers = Arc::clone(&peers);
            let events_tx = events_tx.clone();
            let mut stop_rx = self.stop_tx.subscribe();

            tokio::spawn(async move {
                let mut ticker = interval(Duration::from_millis(CLEANUP_INTERVAL_MS));
                loop {
                    tokio::select! {
                        _ = stop_rx.recv() => break,
                        _ = ticker.tick() => {
                            let now_ms = now_millis();
                            let changed = {
                                let mut map = peers.lock().unwrap();
                                let before = map.len();
                                map.retain(|_, p| !p.is_stale(now_ms, PEER_TIMEOUT_MS));
                                map.len() != before
                            };
                            if changed {
                                let snapshot = peers.lock().unwrap().values().cloned().collect::<Vec<_>>();
                                let _ = events_tx.send(CoreEvent::PeerDiscoveryUpdate { peers: snapshot });
                            }
                        }
                    }
                }
            });
        }

        info!("[Discovery] Started on {}:{}", MULTICAST_ADDR, MULTICAST_PORT);
        Ok(())
    }

    /// Stop all background tasks by signaling through the broadcast channel.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(());
        let mut map = self.peers.lock().unwrap();
        map.clear();
        info!("[Discovery] Stopped");
    }

    pub fn get_peers(&self) -> Vec<DiscoveredPeer> {
        self.peers.lock().unwrap().values().cloned().collect()
    }
}

// ---- Socket helpers ----

fn create_recv_socket() -> Result<UdpSocket, Box<dyn std::error::Error>> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    #[cfg(not(target_os = "windows"))]
    socket.set_reuse_port(true)?;

    let bind_addr = SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, MULTICAST_PORT);
    socket.bind(&SockAddr::from(bind_addr))?;
    socket.set_read_timeout(None)?;

    if let Ok(ifaces) = get_if_addrs() {
        for iface in &ifaces {
            if let IpAddr::V4(ip) = iface.ip() {
                if ip.is_loopback() {
                    continue;
                }
                match socket.join_multicast_v4(&MULTICAST_ADDR, &ip) {
                    Ok(_) => info!("[Discovery] Joined multicast on {}", iface.name),
                    Err(e) => warn!("[Discovery] Failed to join multicast on {}: {e}", iface.name),
                }
            }
        }
    }

    socket.set_multicast_loop_v4(true)?;

    let std_socket: StdUdpSocket = socket.into();
    std_socket.set_nonblocking(true)?;
    Ok(UdpSocket::from_std(std_socket)?)
}

fn create_send_sockets() -> Result<Vec<Arc<UdpSocket>>, Box<dyn std::error::Error>> {
    let mut sockets = Vec::new();

    if let Ok(ifaces) = get_if_addrs() {
        for iface in &ifaces {
            if let IpAddr::V4(ip) = iface.ip() {
                if ip.is_loopback() {
                    continue;
                }

                let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
                let bind_addr = SocketAddrV4::new(ip, 0);
                if socket.bind(&SockAddr::from(bind_addr)).is_err() {
                    continue;
                }
                socket.set_multicast_ttl_v4(1)?;

                let std_socket: StdUdpSocket = socket.into();
                if std_socket.set_nonblocking(true).is_err() {
                    continue;
                }
                match UdpSocket::from_std(std_socket) {
                    Ok(s) => {
                        info!("[Discovery] Send socket on {} ({})", iface.name, ip);
                        sockets.push(Arc::new(s));
                    }
                    Err(e) => warn!("[Discovery] Send socket error on {}: {e}", iface.name),
                }
            }
        }
    }

    Ok(sockets)
}

fn broadcast_presence(
    send_sockets: &[Arc<UdpSocket>],
    app_id: &str,
    instance_id: &str,
    peer_id: &str,
    peer_name: &str,
    quic_port: u16,
) {
    let msg = DiscoveryMessage {
        app_id: app_id.to_string(),
        instance_id: instance_id.to_string(),
        peer_id: peer_id.to_string(),
        peer_name: peer_name.to_string(),
        quic_port,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    };

    let data = match build_framed_message(&msg, None) {
        Ok(d) => d,
        Err(e) => {
            warn!("[Discovery] Failed to build framed message: {e}");
            return;
        }
    };

    let multicast_sock_addr = SocketAddr::V4(SocketAddrV4::new(MULTICAST_ADDR, MULTICAST_PORT));

    for socket in send_sockets {
        if let Err(e) = socket.try_send_to(&data, multicast_sock_addr) {
            warn!("[Discovery] broadcast error: {e}");
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_message() -> DiscoveryMessage {
        DiscoveryMessage {
            app_id: "BeemBridge".into(),
            instance_id: "11111111-1111-1111-1111-111111111111".into(),
            peer_id: "12345".into(),
            peer_name: "alice".into(),
            quic_port: 43521,
            timestamp: 1_700_000_000,
        }
    }

    fn sample_peer() -> DiscoveredPeer {
        DiscoveredPeer {
            app_id: "BeemBridge".into(),
            instance_id: "22222222-2222-2222-2222-222222222222".into(),
            peer_id: "67890".into(),
            peer_name: "bob".into(),
            quic_port: 51000,
            timestamp: 1_700_000_000,
            last_seen_ms: 5_000,
            ip_address: "192.168.1.42".into(),
        }
    }

    #[test]
    fn discovery_message_wire_keys() {
        let v = serde_json::to_value(sample_message()).unwrap();
        let obj = v.as_object().unwrap();
        for key in ["appId", "instanceId", "peerId", "peerName", "quicPort", "timestamp"] {
            assert!(obj.contains_key(key), "missing wire key {key}");
        }
    }

    #[test]
    fn discovery_message_roundtrip() {
        let original = sample_message();
        let s = serde_json::to_string(&original).unwrap();
        let back: DiscoveryMessage = serde_json::from_str(&s).unwrap();
        assert_eq!(original, back);
    }

    #[test]
    fn discovered_peer_wire_keys() {
        let v = serde_json::to_value(sample_peer()).unwrap();
        let obj = v.as_object().unwrap();
        for key in [
            "appId",
            "instanceId",
            "peerId",
            "peerName",
            "quicPort",
            "timestamp",
            "lastSeen",
            "ipAddress",
        ] {
            assert!(obj.contains_key(key), "missing wire key {key}");
        }
    }

    #[test]
    fn wire_path_message_survives_framing() {
        // Exactly the byte path used by broadcast_presence -> listen loop:
        // DiscoveryMessage -> framed bytes -> FrameParser -> header map ->
        // re-serialize -> DiscoveryMessage.
        let original = sample_message();
        let framed = build_framed_message(&original, None).unwrap();

        let mut parser = FrameParser::new();
        let msgs = parser.feed(&framed).unwrap();
        assert_eq!(msgs.len(), 1);

        let header_bytes = serde_json::to_vec(&msgs[0].header).unwrap();
        let recovered: DiscoveryMessage = serde_json::from_slice(&header_bytes).unwrap();
        assert_eq!(original, recovered);
    }

    #[test]
    fn new_invariants() {
        let a = PeerDiscovery::new("BeemBridge", "alice", "11111", 43521);
        let b = PeerDiscovery::new("BeemBridge", "bob", "22222", 51000);
        assert_eq!(a.quic_port(), 43521);
        assert_eq!(b.quic_port(), 51000);
        assert_ne!(a.instance_id(), b.instance_id());
        assert!(a.get_peers().is_empty());
    }

    #[test]
    fn is_stale_fresh() {
        let mut p = sample_peer();
        p.last_seen_ms = 10_000;
        assert!(!p.is_stale(10_000, 1_500));
    }

    #[test]
    fn is_stale_at_timeout_boundary() {
        let mut p = sample_peer();
        p.last_seen_ms = 10_000 - 1_500;
        assert!(p.is_stale(10_000, 1_500));
    }

    #[test]
    fn is_stale_just_under_timeout() {
        let mut p = sample_peer();
        p.last_seen_ms = 10_000 - 1_499;
        assert!(!p.is_stale(10_000, 1_500));
    }

    #[test]
    fn is_stale_future_clock_skew() {
        let mut p = sample_peer();
        p.last_seen_ms = 10_000 + 500;
        assert!(!p.is_stale(10_000, 1_500));
    }
}