mod explorer;
mod file_metadata;
mod identity;
mod transfer;

use std::sync::{Arc, Mutex};

use beembridge_core::config::{ConfigData, ConfigStore};
use beembridge_core::events::{CoreEvent, EventBus};
use tauri::{Emitter, Manager};

use explorer::{get_file_stats, open_directory_dialog, pick_files_and_get_stats};
use identity::{
    generate_user_id, get_identity, get_storage_path, pick_storage_folder, set_storage_path,
    set_username, ConfigState,
};
use transfer::discovery::{
    get_discovered_peers, start_peer_discovery, stop_peer_discovery, DiscoveryState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let discovery_state: DiscoveryState = Arc::new(Mutex::new(None));
    let event_bus = EventBus::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(file_metadata::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Open ConfigStore in the platform-appropriate app data dir.
            let cfg_dir = app.path().app_local_data_dir()?;
            migrate_legacy_identity(&cfg_dir);
            let store = ConfigStore::open(cfg_dir)?;
            let state: ConfigState = Arc::new(Mutex::new(store));
            app.manage(state);

            // Bridge core events → Tauri webview via app.emit.
            let bus = app.state::<EventBus>();
            let mut rx = bus.subscribe();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => forward_event(&app_handle, ev),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            Ok(())
        })
        .manage(event_bus)
        .manage(discovery_state)
        .invoke_handler(tauri::generate_handler![
            start_peer_discovery,
            stop_peer_discovery,
            get_discovered_peers,
            get_identity,
            set_username,
            generate_user_id,
            get_storage_path,
            set_storage_path,
            pick_storage_folder,
            open_directory_dialog,
            get_file_stats,
            pick_files_and_get_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn forward_event(app: &tauri::AppHandle, ev: CoreEvent) {
    match ev {
        CoreEvent::PeerDiscoveryUpdate { peers } => {
            let _ = app.emit("onPeerDiscoveryUpdate", &peers);
        }
    }
}

/// One-time migration from tauri-plugin-store's `identity.json` to `config.json`.
/// Best-effort: silently skips if anything fails.
fn migrate_legacy_identity(cfg_dir: &std::path::Path) {
    let new_path = cfg_dir.join("config.json");
    let old_path = cfg_dir.join("identity.json");
    if new_path.exists() || !old_path.exists() {
        return;
    }
    let Ok(bytes) = std::fs::read(&old_path) else { return; };
    let Ok(data) = serde_json::from_slice::<ConfigData>(&bytes) else { return; };
    let Ok(mut store) = ConfigStore::open(cfg_dir.to_path_buf()) else { return; };
    if store.replace(data).is_ok() {
        let _ = std::fs::remove_file(&old_path);
    }
}