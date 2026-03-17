use crate::transfer::framing::{build_framed_message, FrameParser};
use if_addrs::get_if_addrs;
use log::{info, warn};
use tauri::Emitter;
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

// ---- Constants ----

const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MULTICAST_PORT: u16 = 9999;
const BROADCAST_PERIOD_MS: u64 = 500;
const CLEANUP_INTERVAL_MS: u64 = 1000;
const PEER_TIMEOUT_MS: u64 = 1500;

// ---- Data Structures ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryMessage {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "peerName")]
    pub peer_name: String,
    #[serde(rename = "tcpPort")]
    pub tcp_port: u16,
    #[serde(rename = "timestamp")]
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(rename = "peerName")]
    pub peer_name: String,
    #[serde(rename = "tcpPort")]
    pub tcp_port: u16,
    #[serde(rename = "timestamp")]
    pub timestamp: i64,
    #[serde(rename = "lastSeen")]
    pub last_seen_ms: u64,
    #[serde(rename = "ipAddress")]
    pub ip_address: String,
}

// ---- PeerDiscovery ----

pub struct PeerDiscovery {
    app_id: String,
    instance_id: String,
    peer_name: String,
    tcp_port: u16,
    pub peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
    stop_tx: broadcast::Sender<()>,
}

impl PeerDiscovery {
    pub fn new(app_id: impl Into<String>, peer_name: impl Into<String>) -> Result<Self, String> {
        let tcp_port = bind_random_port().map_err(|e| e.to_string())?;
        let instance_id = Uuid::new_v4().to_string();
        let (stop_tx, _) = broadcast::channel(1);

        Ok(Self {
            app_id: app_id.into(),
            instance_id,
            peer_name: peer_name.into(),
            tcp_port,
            peers: Arc::new(Mutex::new(HashMap::new())),
            stop_tx,
        })
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn tcp_port(&self) -> u16 {
        self.tcp_port
    }

    /// Start discovery: spawns broadcast, listen, and cleanup tasks.
    pub async fn start(
        &self,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        let recv_socket = create_recv_socket().map_err(|e| e.to_string())?;
        let recv_socket = Arc::new(recv_socket);

        let send_sockets = create_send_sockets().map_err(|e| e.to_string())?;
        let send_sockets = Arc::new(send_sockets);

        let peers = Arc::clone(&self.peers);
        let app_id = self.app_id.clone();
        let instance_id = self.instance_id.clone();
        let peer_name = self.peer_name.clone();
        let tcp_port = self.tcp_port;

        // ---- Broadcast loop ----
        {
            let send_sockets = Arc::clone(&send_sockets);
            let app_id = app_id.clone();
            let instance_id = instance_id.clone();
            let peer_name = peer_name.clone();
            let mut stop_rx = self.stop_tx.subscribe();

            tokio::spawn(async move {
                let mut ticker = interval(Duration::from_millis(BROADCAST_PERIOD_MS));
                loop {
                    tokio::select! {
                        _ = stop_rx.recv() => break,
                        _ = ticker.tick() => {
                            broadcast_presence(&send_sockets, &app_id, &instance_id, &peer_name, tcp_port);
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
            let app_handle = app_handle.clone();
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
                                                    peer_name: discovery_msg.peer_name,
                                                    tcp_port: discovery_msg.tcp_port,
                                                    timestamp: discovery_msg.timestamp,
                                                    last_seen_ms: now_ms,
                                                    ip_address: src_ip.clone(),
                                                };

                                                let peers_snapshot = {
                                                    let mut map = peers.lock().unwrap();
                                                    map.insert(discovery_msg.instance_id, peer);
                                                    map.values().cloned().collect::<Vec<_>>()
                                                };
                                                let _ = app_handle.emit("onPeerDiscoveryUpdate", &peers_snapshot);
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
            let app_handle = app_handle.clone();
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
                                map.retain(|_, p| now_ms.saturating_sub(p.last_seen_ms) < PEER_TIMEOUT_MS);
                                map.len() != before
                            };
                            if changed {
                                let snapshot = peers.lock().unwrap().values().cloned().collect::<Vec<_>>();
                                let _ = app_handle.emit("onPeerDiscoveryUpdate", &snapshot);
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

    // Join multicast group on all multicast-capable up interfaces
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
    peer_name: &str,
    tcp_port: u16,
) {
    let msg = DiscoveryMessage {
        app_id: app_id.to_string(),
        instance_id: instance_id.to_string(),
        peer_name: peer_name.to_string(),
        tcp_port,
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
        // try_send_to is non-blocking; ignore transient errors
        if let Err(e) = socket.try_send_to(&data, multicast_sock_addr) {
            warn!("[Discovery] broadcast error: {e}");
        }
    }
}

fn bind_random_port() -> Result<u16, std::io::Error> {
    let listener = std::net::TcpListener::bind("0.0.0.0:0")?;
    Ok(listener.local_addr()?.port())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---- Tauri-managed state wrapper ----

pub type DiscoveryState = Arc<Mutex<Option<PeerDiscovery>>>;

// ---- Tauri commands ----

#[tauri::command]
pub async fn start_peer_discovery(
    state: tauri::State<'_, DiscoveryState>,
    app_handle: tauri::AppHandle,
    peer_name: String,
) -> Result<(), String> {
    // Stop any previous session BEFORE starting the new one, so sockets don't
    // overlap. We must take the old value out while holding the lock, then drop
    // the lock before calling stop() (which itself is synchronous but we want
    // to keep the critical section short and avoid holding it across .await).
    let old = {
        let mut guard = state.lock().unwrap();
        guard.take()
    };
    if let Some(prev) = old {
        prev.stop();
    }

    let discovery = PeerDiscovery::new("BeemBridge", peer_name)?;
    discovery.start(app_handle).await?;

    let mut guard = state.lock().unwrap();
    *guard = Some(discovery);

    Ok(())
}

#[tauri::command]
pub async fn stop_peer_discovery(state: tauri::State<'_, DiscoveryState>) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    if let Some(discovery) = guard.take() {
        discovery.stop();
    }
    Ok(())
}

#[tauri::command]
pub async fn get_discovered_peers(
    state: tauri::State<'_, DiscoveryState>,
) -> Result<Vec<DiscoveredPeer>, String> {
    let guard = state.lock().unwrap();
    match guard.as_ref() {
        Some(d) => Ok(d.get_peers()),
        None => Ok(Vec::new()),
    }
}
