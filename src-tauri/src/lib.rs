mod explorer;
mod file_metadata;
mod identity;
mod transfer;

use std::sync::{Arc, Mutex};
use explorer::{open_directory_dialog, get_file_stats, pick_files_and_get_stats};
use transfer::discovery::{
    get_discovered_peers, start_peer_discovery, stop_peer_discovery, DiscoveryState,
};
use identity::{get_identity, set_username, generate_user_id, get_storage_path, set_storage_path, pick_storage_folder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let discovery_state: DiscoveryState = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(file_metadata::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
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
