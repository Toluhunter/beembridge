use beembridge_core::config::ConfigStore;
use beembridge_core::identity::{generate_id, Identity};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

const DEFAULT_USERNAME: &str = "BeemBridge User";

pub type ConfigState = Arc<Mutex<ConfigStore>>;

#[tauri::command]
pub fn get_identity(state: State<'_, ConfigState>) -> Result<Identity, String> {
    let mut cfg = state.lock().unwrap();
    let user_name = cfg.user_name().unwrap_or(DEFAULT_USERNAME).to_string();
    let user_id = match cfg.user_id() {
        Some(id) => id,
        None => {
            let new_id = generate_id();
            cfg.set_user_id(new_id).map_err(|e| e.to_string())?;
            new_id
        }
    };
    Ok(Identity { user_name, user_id })
}

#[tauri::command]
pub fn set_username(state: State<'_, ConfigState>, name: String) -> Result<String, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Username cannot be empty".to_string());
    }
    let mut cfg = state.lock().unwrap();
    cfg.set_user_name(trimmed.clone())
        .map_err(|e| e.to_string())?;
    Ok(trimmed)
}

#[tauri::command]
pub fn generate_user_id(state: State<'_, ConfigState>) -> Result<u32, String> {
    let new_id = generate_id();
    let mut cfg = state.lock().unwrap();
    cfg.set_user_id(new_id).map_err(|e| e.to_string())?;
    Ok(new_id)
}

#[tauri::command]
pub fn get_storage_path(
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<String, String> {
    {
        let cfg = state.lock().unwrap();
        if let Some(p) = cfg.storage_path() {
            return Ok(p.to_string());
        }
    }
    default_storage_path(&app)
}

#[tauri::command]
pub fn set_storage_path(
    state: State<'_, ConfigState>,
    path: String,
) -> Result<String, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let mut cfg = state.lock().unwrap();
    cfg.set_storage_path(trimmed.clone())
        .map_err(|e| e.to_string())?;
    Ok(trimmed)
}

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

#[cfg(desktop)]
fn default_storage_path(_app: &AppHandle) -> Result<String, String> {
    let p = dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    Ok(p.join("BeemBridge").to_string_lossy().to_string())
}

#[cfg(target_os = "android")]
fn default_storage_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("BeemBridge").to_string_lossy().to_string())
}

#[cfg(target_os = "ios")]
fn default_storage_path(app: &AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let base = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(base.join("BeemBridge").to_string_lossy().to_string())
}