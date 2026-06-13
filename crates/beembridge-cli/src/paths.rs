use anyhow::{anyhow, Result};
use std::path::PathBuf;

/// Resolve the per-user config directory for the CLI.
///
/// Linux/Termux: `$XDG_CONFIG_HOME/beembridge` (typically `~/.config/beembridge`)
/// macOS:        `~/Library/Application Support/beembridge`
/// Windows:      `%APPDATA%/beembridge`
pub fn config_dir() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve a config directory for this platform"))?;
    Ok(base.join("beembridge"))
}