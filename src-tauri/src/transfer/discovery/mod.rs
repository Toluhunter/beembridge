use beembridge_core::events::EventBus;
pub use beembridge_core::transfer::discovery::{DiscoveredPeer, PeerDiscovery};
use std::sync::{Arc, Mutex};

use crate::identity::ConfigState;

pub type DiscoveryState = Arc<Mutex<Option<PeerDiscovery>>>;

#[tauri::command]
pub async fn start_peer_discovery(
    state: tauri::State<'_, DiscoveryState>,
    bus: tauri::State<'_, EventBus>,
    config: tauri::State<'_, ConfigState>,
    peer_name: String,
) -> Result<(), String> {
    // Stop any previous session BEFORE starting the new one, so sockets don't overlap.
    let old = {
        let mut guard = state.lock().unwrap();
        guard.take()
    };
    if let Some(prev) = old {
        prev.stop();
    }

    let peer_id = config.lock().unwrap().user_id().map(|id| id.to_string()).unwrap_or_default();
    let discovery = PeerDiscovery::new("BeemBridge", peer_name, peer_id, 0);
    discovery.start(&bus).await?;

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