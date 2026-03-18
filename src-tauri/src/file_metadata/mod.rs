use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Serialize)]
pub(crate) struct FileMetaArgs {
    pub uri: String,
}

#[derive(Deserialize)]
pub(crate) struct FileMeta {
    pub name: String,
    pub size: u64,
}

/// Wraps the PluginHandle so it can be stored as Tauri app state.
#[cfg(target_os = "android")]
pub(crate) struct FileMetadataHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

/// Builds and returns the fileMetadata Tauri plugin.
///
/// On Android this registers the Kotlin FileMetadataPlugin via JNI and stores
/// the resulting PluginHandle as app state so that explorer commands can use it.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("fileMetadata")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(
                    "com.beembridge.www",
                    "FileMetadataPlugin",
                )?;
                app.manage(FileMetadataHandle(handle));
            }
            // suppress unused-variable warnings on non-Android builds
            let _ = (app, api);
            Ok(())
        })
        .build()
}
