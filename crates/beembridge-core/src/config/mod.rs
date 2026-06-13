use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("malformed config at {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("serialize error: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ConfigError>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_path: Option<String>,
}

/// Persistent configuration store backed by a JSON file.
///
/// Frontends supply the directory; core never guesses platform paths.
/// Writes are atomic (tmp file + rename).
pub struct ConfigStore {
    path: PathBuf,
    data: ConfigData,
}

impl ConfigStore {
    /// Open (or create) the config store in the given directory.
    /// Creates the directory if it does not exist.
    pub fn open(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).map_err(|e| ConfigError::Io {
            path: dir.clone(),
            source: e,
        })?;
        let path = dir.join(CONFIG_FILE);
        let data = if path.exists() {
            let bytes = fs::read(&path).map_err(|e| ConfigError::Io {
                path: path.clone(),
                source: e,
            })?;
            serde_json::from_slice(&bytes).map_err(|e| ConfigError::Parse {
                path: path.clone(),
                source: e,
            })?
        } else {
            ConfigData::default()
        };
        Ok(Self { path, data })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn user_name(&self) -> Option<&str> {
        self.data.user_name.as_deref()
    }

    pub fn set_user_name(&mut self, name: String) -> Result<()> {
        self.data.user_name = Some(name);
        self.save()
    }

    pub fn user_id(&self) -> Option<u32> {
        self.data.user_id
    }

    pub fn set_user_id(&mut self, id: u32) -> Result<()> {
        self.data.user_id = Some(id);
        self.save()
    }

    pub fn storage_path(&self) -> Option<&str> {
        self.data.storage_path.as_deref()
    }

    pub fn set_storage_path(&mut self, path: String) -> Result<()> {
        self.data.storage_path = Some(path);
        self.save()
    }

    /// Replace the entire data set. Used by migrations.
    pub fn replace(&mut self, data: ConfigData) -> Result<()> {
        self.data = data;
        self.save()
    }

    /// Snapshot of current data.
    pub fn data(&self) -> &ConfigData {
        &self.data
    }

    fn save(&self) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.data)?;
        {
            let mut f = fs::File::create(&tmp).map_err(|e| ConfigError::Io {
                path: tmp.clone(),
                source: e,
            })?;
            f.write_all(&bytes).map_err(|e| ConfigError::Io {
                path: tmp.clone(),
                source: e,
            })?;
            f.sync_all().map_err(|e| ConfigError::Io {
                path: tmp.clone(),
                source: e,
            })?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| ConfigError::Io {
            path: self.path.clone(),
            source: e,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = ConfigStore::open(dir.path().to_path_buf()).unwrap();
        assert!(s.user_name().is_none());
        s.set_user_name("alice".into()).unwrap();
        s.set_user_id(12345).unwrap();

        let s2 = ConfigStore::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(s2.user_name(), Some("alice"));
        assert_eq!(s2.user_id(), Some(12345));
    }
}