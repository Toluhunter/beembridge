use std::path::PathBuf;
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum SecretError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Cryptographic error: {0}")]
    Crypto(String),
}

pub type Result<T> = std::result::Result<T, SecretError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TofuStatus {
    /// No key pinned for this peer yet.
    New,
    /// Key matches the pinned key.
    Matches,
    /// Key does NOT match the pinned key! (Potential MITM or reinstall)
    Mismatch,
}

pub trait SecretStore: Send + Sync {
    /// Returns the local device's long-term signing key.
    /// Generates one if it doesn't exist.
    fn get_keypair(&self) -> Result<SigningKey>;

    /// Checks a peer's public key against the pinned store (TOFU).
    fn verify_peer_key(&self, peer_id: &str, key: &VerifyingKey) -> Result<TofuStatus>;

    /// Pins a peer's public key.
    fn pin_peer_key(&self, peer_id: &str, key: &VerifyingKey) -> Result<()>;
}

/// A development-only SecretStore that stores keys in plaintext files.
pub struct FileSecretStore {
    base_path: PathBuf,
}

impl FileSecretStore {
    pub fn new(base_path: PathBuf) -> Self {
        Self { base_path }
    }

    fn key_path(&self) -> PathBuf {
        self.base_path.join("identity.key")
    }

    fn known_peers_path(&self) -> PathBuf {
        self.base_path.join("known_peers.json")
    }
}

#[derive(Serialize, Deserialize, Default)]
struct KnownPeers {
    // Map of peer_id -> base64 encoded public key
    peers: std::collections::HashMap<String, String>,
}

impl SecretStore for FileSecretStore {
    fn get_keypair(&self) -> Result<SigningKey> {
        let path = self.key_path();
        if path.exists() {
            let bytes = std::fs::read(&path)?;
            if bytes.len() != 32 {
                return Err(SecretError::Crypto("Invalid key file length".to_string()));
            }
            let array: [u8; 32] = bytes.try_into().map_err(|_| SecretError::Crypto("Conversion failed".to_string()))?;
            Ok(SigningKey::from_bytes(&array))
        } else {
            // Generate new key
            use rand::RngExt;
            let seed: [u8; 32] = rand::rng().random();
            let key = SigningKey::from_bytes(&seed);
            
            // Ensure directory exists
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }

            // Write with 0o600 permissions on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                let mut file = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .mode(0o600)
                    .open(&path)?;
                use std::io::Write;
                file.write_all(&key.to_bytes())?;
            }

            #[cfg(not(unix))]
            {
                std::fs::write(&path, &key.to_bytes())?;
            }

            Ok(key)
        }
    }

    fn verify_peer_key(&self, peer_id: &str, key: &VerifyingKey) -> Result<TofuStatus> {
        let path = self.known_peers_path();
        if !path.exists() {
            return Ok(TofuStatus::New);
        }

        let content = std::fs::read_to_string(&path)?;
        let known: KnownPeers = serde_json::from_str(&content)?;

        match known.peers.get(peer_id) {
            Some(encoded) => {
                use base64::{engine::general_purpose::STANDARD, Engine as _};
                let decoded = STANDARD.decode(encoded)
                    .map_err(|e| SecretError::Crypto(format!("Base64 decode error: {}", e)))?;
                
                if decoded.len() != 32 {
                    return Err(SecretError::Crypto("Invalid pinned key length".to_string()));
                }

                let array: [u8; 32] = decoded.try_into().map_err(|_| SecretError::Crypto("Conversion failed".to_string()))?;
                let pinned_key = VerifyingKey::from_bytes(&array)
                    .map_err(|e| SecretError::Crypto(format!("Invalid pinned key: {}", e)))?;

                if &pinned_key == key {
                    Ok(TofuStatus::Matches)
                } else {
                    Ok(TofuStatus::Mismatch)
                }
            }
            None => Ok(TofuStatus::New),
        }
    }

    fn pin_peer_key(&self, peer_id: &str, key: &VerifyingKey) -> Result<()> {
        let path = self.known_peers_path();
        let mut known = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            serde_json::from_str(&content)?
        } else {
            KnownPeers::default()
        };

        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let encoded = STANDARD.encode(key.as_bytes());
        known.peers.insert(peer_id.to_string(), encoded);

        let content = serde_json::from_str::<serde_json::Value>(&serde_json::to_string(&known)?)?;
        std::fs::write(&path, serde_json::to_string_pretty(&content)?)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_file_secret_store_persistence() {
        let dir = tempdir().unwrap();
        let store = FileSecretStore::new(dir.path().to_path_buf());

        // 1. Generate key
        let key1 = store.get_keypair().unwrap();
        
        // 2. Re-open store and check it's the same
        let store2 = FileSecretStore::new(dir.path().to_path_buf());
        let key2 = store2.get_keypair().unwrap();
        
        assert_eq!(key1.to_bytes(), key2.to_bytes());
    }

    #[test]
    fn test_tofu_flow() {
        let dir = tempdir().unwrap();
        let store = FileSecretStore::new(dir.path().to_path_buf());
        
        let peer_id = "peer-123";
        
        // Generate a random key for the peer
        use rand::RngExt;
        let seed: [u8; 32] = rand::rng().random();
        let peer_key = SigningKey::from_bytes(&seed).verifying_key();

        // 1. Initially New
        assert_eq!(store.verify_peer_key(peer_id, &peer_key).unwrap(), TofuStatus::New);

        // 2. Pin the key
        store.pin_peer_key(peer_id, &peer_key).unwrap();

        // 3. Now Matches
        assert_eq!(store.verify_peer_key(peer_id, &peer_key).unwrap(), TofuStatus::Matches);

        // 4. Mismatch if key changes
        let seed2: [u8; 32] = rand::rng().random();
        let peer_key2 = SigningKey::from_bytes(&seed2).verifying_key();
        assert_eq!(store.verify_peer_key(peer_id, &peer_key2).unwrap(), TofuStatus::Mismatch);
    }
}
