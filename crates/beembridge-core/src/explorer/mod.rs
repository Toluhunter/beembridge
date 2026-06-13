use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

/// Resolve filesystem stats for a path or `file://` URI.
/// Returns a fallback `SelectedItem` with size 0 on error.
///
/// `content://` URIs (Android) are not resolved here — the caller is expected
/// to handle them via the platform's content resolver and only fall back to
/// this function for ordinary paths.
pub fn resolve_item(raw: &str) -> SelectedItem {
    if raw.starts_with("content://") {
        return SelectedItem {
            name: percent_decode(raw.split('/').next_back().unwrap_or("File")),
            path: raw.to_string(),
            size: 0,
            is_directory: false,
        };
    }

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

/// Minimal percent-decoder for URI path segments.
/// Handles common encodings (`%3A` → `:`, `%2F` → `/`, `%20` → ` `, etc.).
pub fn percent_decode(s: &str) -> String {
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