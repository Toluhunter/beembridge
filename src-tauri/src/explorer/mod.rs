use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

/// Folder picker.
/// Desktop + iOS: native folder picker via pick_folder().
/// Android: folder picker not supported in tauri-plugin-dialog — falls back to
///          picking a single file and returning its parent directory.
#[tauri::command]
pub async fn open_directory_dialog(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let (tx, rx) = oneshot::channel();
        app.dialog()
            .file()
            .pick_folder(move |path| {
                let _ = tx.send(path);
            });
        let path = rx.await.map_err(|e| e.to_string())?;
        return Ok(path.map(|p| p.to_string()));
    }

    #[cfg(target_os = "android")]
    {
        // Android's Storage Access Framework does not expose a folder-only picker
        // through tauri-plugin-dialog. Pick a file and return its parent directory.
        let (tx, rx) = oneshot::channel();
        app.dialog()
            .file()
            .pick_file(move |path| {
                let _ = tx.send(path);
            });
        let file_path = rx.await.map_err(|e| e.to_string())?;
        return Ok(file_path.and_then(|p| {
            let s = p.to_string();
            let clean = s.strip_prefix("file://").unwrap_or(&s);
            Path::new(clean)
                .parent()
                .map(|parent| parent.to_string_lossy().to_string())
        }));
    }
}

// ── File stats commands ───────────────────────────────────────────────────────

/// Opens the file picker and immediately resolves metadata for all picked files
/// in a single IPC round-trip. Uses run_mobile_plugin_async on Android so the
/// tokio executor is never blocked while waiting for the Kotlin ContentResolver.
#[tauri::command]
pub async fn pick_files_and_get_stats<R: tauri::Runtime>(app: AppHandle<R>) -> Result<Vec<SelectedItem>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .pick_files(move |paths| {
            let _ = tx.send(paths.unwrap_or_default());
        });
    let paths = rx.await.map_err(|e| e.to_string())?;

    let mut results = Vec::with_capacity(paths.len());
    for raw in &paths {
        results.push(resolve_item_async(&app, raw.to_string()).await);
    }
    Ok(results)
}

/// Resolve name, size, and type for a list of paths or URIs.
/// Kept for use by directory picker and other callers.
#[tauri::command]
pub async fn get_file_stats<R: tauri::Runtime>(app: AppHandle<R>, paths: Vec<String>) -> Result<Vec<SelectedItem>, String> {
    let mut results = Vec::with_capacity(paths.len());
    for raw in &paths {
        results.push(resolve_item_async(&app, raw.to_string()).await);
    }
    Ok(results)
}

/// Async resolution — never blocks the tokio executor.
async fn resolve_item_async<R: tauri::Runtime>(app: &AppHandle<R>, raw: String) -> SelectedItem {
    #[cfg(target_os = "android")]
    {
        if raw.starts_with("content://") {
            return resolve_content_uri_android_async(app, &raw).await;
        }
    }
    let _ = app;
    resolve_item(&raw)
}

/// On Android, query the FileMetadataPlugin (Kotlin) for the real display name and size.
/// Uses run_mobile_plugin_async so the tokio thread yields while waiting for the JNI response.
#[cfg(target_os = "android")]
async fn resolve_content_uri_android_async<R: tauri::Runtime>(app: &AppHandle<R>, uri: &str) -> SelectedItem {
    use crate::file_metadata::{FileMetadataHandle, FileMetaArgs, FileMeta};

    let make_fallback = || SelectedItem {
        name: percent_decode(uri.split('/').last().unwrap_or("File")),
        path: uri.to_string(),
        size: 0,
        is_directory: false,
    };

    let Some(state) = app.try_state::<FileMetadataHandle<R>>() else {
        return make_fallback();
    };

    match state.0.run_mobile_plugin_async::<FileMeta>(
        "getFileMetadata",
        FileMetaArgs { uri: uri.to_string() },
    ).await {
        Ok(meta) => SelectedItem {
            name: meta.name,
            path: uri.to_string(),
            size: meta.size,
            is_directory: false,
        },
        Err(_) => make_fallback(),
    }
}

fn resolve_item(raw: &str) -> SelectedItem {
    // content:// URIs are handled via the Android plugin bridge above — should not reach here
    if raw.starts_with("content://") {
        return SelectedItem {
            name: percent_decode(raw.split('/').last().unwrap_or("File")),
            path: raw.to_string(),
            size: 0,
            is_directory: false,
        };
    }

    // Normalise file:// URI (iOS) to a plain path for std::fs
    let path_str = raw.strip_prefix("file://").unwrap_or(raw);

    let name = Path::new(path_str)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.to_string());

    match std::fs::metadata(path_str) {
        Ok(meta) => SelectedItem {
            name,
            path: raw.to_string(),
            size: meta.len(),
            is_directory: meta.is_dir(),
        },
        Err(_) => SelectedItem {
            name,
            path: raw.to_string(),
            size: 0,
            is_directory: false,
        },
    }
}

/// Minimal percent-decoder for Android content URI path segments.
/// Handles the most common encodings (%3A → ':', %2F → '/', %20 → ' ', etc.)
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                    result.push(byte as char);
                    continue;
                }
            }
        }
        result.push(c);
    }
    result
}
