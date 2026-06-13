pub use beembridge_core::explorer::{resolve_item, SelectedItem};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

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
            std::path::Path::new(clean)
                .parent()
                .map(|parent| parent.to_string_lossy().to_string())
        }));
    }
}

/// Opens the file picker and immediately resolves metadata for all picked files
/// in a single IPC round-trip. Uses run_mobile_plugin_async on Android so the
/// tokio executor is never blocked while waiting for the Kotlin ContentResolver.
#[tauri::command]
pub async fn pick_files_and_get_stats<R: tauri::Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<SelectedItem>, String> {
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

#[tauri::command]
pub async fn get_file_stats<R: tauri::Runtime>(
    app: AppHandle<R>,
    paths: Vec<String>,
) -> Result<Vec<SelectedItem>, String> {
    let mut results = Vec::with_capacity(paths.len());
    for raw in &paths {
        results.push(resolve_item_async(&app, raw.to_string()).await);
    }
    Ok(results)
}

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

#[cfg(target_os = "android")]
async fn resolve_content_uri_android_async<R: tauri::Runtime>(
    app: &AppHandle<R>,
    uri: &str,
) -> SelectedItem {
    use crate::file_metadata::{FileMeta, FileMetaArgs, FileMetadataHandle};
    use tauri::Manager;
    use beembridge_core::explorer::percent_decode;

    let make_fallback = || SelectedItem {
        name: percent_decode(uri.split('/').next_back().unwrap_or("File")),
        path: uri.to_string(),
        size: 0,
        is_directory: false,
    };

    let Some(state) = app.try_state::<FileMetadataHandle<R>>() else {
        return make_fallback();
    };

    match state
        .0
        .run_mobile_plugin_async::<FileMeta>(
            "getFileMetadata",
            FileMetaArgs {
                uri: uri.to_string(),
            },
        )
        .await
    {
        Ok(meta) => SelectedItem {
            name: meta.name,
            path: uri.to_string(),
            size: meta.size,
            is_directory: false,
        },
        Err(_) => make_fallback(),
    }
}