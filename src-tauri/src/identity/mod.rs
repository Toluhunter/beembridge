use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "identity.json";
const KEY_USERNAME: &str = "user_name";
const KEY_USER_ID: &str = "user_id";
const KEY_STORAGE_PATH: &str = "storage_path";
const DEFAULT_USERNAME: &str = "BeemBridge User";

#[derive(Debug, Serialize, Deserialize)]
pub struct Identity {
    pub user_name: String,
    pub user_id: u32,
}

/// Called on app start. Returns the stored identity, generating a new 5-digit ID if none exists.
#[tauri::command]
pub fn get_identity(app: AppHandle) -> Result<Identity, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    let user_name = store
        .get(KEY_USERNAME)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT_USERNAME.to_string());

    let user_id = match store.get(KEY_USER_ID).and_then(|v| v.as_u64()) {
        Some(id) => id as u32,
        None => {
            // First launch — generate and persist a new ID
            let new_id = generate_id();
            store.set(KEY_USER_ID, json!(new_id));
            store.save().map_err(|e| e.to_string())?;
            new_id
        }
    };

    Ok(Identity { user_name, user_id })
}

/// Updates the stored username. Returns the saved name on success.
#[tauri::command]
pub fn set_username(app: AppHandle, name: String) -> Result<String, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Username cannot be empty".to_string());
    }
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_USERNAME, json!(trimmed));
    store.save().map_err(|e| e.to_string())?;
    Ok(trimmed)
}

/// Generates a new random 5-digit user ID (10000–99999), persists it, and returns it.
#[tauri::command]
pub fn generate_user_id(app: AppHandle) -> Result<u32, String> {
    let new_id = generate_id();
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_USER_ID, json!(new_id));
    store.save().map_err(|e| e.to_string())?;
    Ok(new_id)
}

/// Returns stored download path, or a platform-appropriate accessible default.
#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;

    // Return explicitly stored path if one has been set (desktop only in practice)
    if let Some(path) = store.get(KEY_STORAGE_PATH).and_then(|v| v.as_str().map(String::from)) {
        return Ok(path);
    }

    #[cfg(desktop)]
    {
        let default_path = dirs::download_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("BeemBridge");
        return Ok(default_path.to_string_lossy().to_string());
    }

    #[cfg(target_os = "android")]
    {
        // App-specific external storage: visible in the device Files app under
        // "Internal Storage → Android → data → com.beembridge.app → files".
        // No permission declarations needed on any Android version.
        use tauri::Manager;
        let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        return Ok(base.join("BeemBridge").to_string_lossy().to_string());
    }

    #[cfg(target_os = "ios")]
    {
        // iOS Documents directory — visible in the Files app when
        // UIFileSharingEnabled = YES is set in Info.plist.
        use tauri::Manager;
        let base = app.path().document_dir().map_err(|e| e.to_string())?;
        return Ok(base.join("BeemBridge").to_string_lossy().to_string());
    }
}

/// Persists the chosen download path.
#[tauri::command]
pub fn set_storage_path(app: AppHandle, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let store = app.store(STORE_FILE).map_err(|e| e.to_string())?;
    store.set(KEY_STORAGE_PATH, json!(path.trim()));
    store.save().map_err(|e| e.to_string())?;
    Ok(path.trim().to_string())
}

/// Shows the OS native folder picker on desktop; returns None on mobile (unsupported).
#[tauri::command]
pub async fn pick_storage_folder(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_dialog::DialogExt;
        use tokio::sync::oneshot;

        let (tx, rx) = oneshot::channel();
        app.dialog().file().pick_folder(move |path: Option<tauri_plugin_dialog::FilePath>| {
            let _ = tx.send(path);
        });

        let path = rx.await.map_err(|e| e.to_string())?;
        return Ok(path.map(|p| p.to_string()));
    }

    #[cfg(mobile)]
    {
        let _ = app;
        Ok(None)
    }
}

/// Produces a uniformly-distributed 5-digit integer using UUID v4 randomness.
fn generate_id() -> u32 {
    (uuid::Uuid::new_v4().as_u128() % 90_000 + 10_000) as u32
}
