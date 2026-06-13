use serde::{Deserialize, Serialize};

/// User-facing identity returned to UIs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub user_name: String,
    pub user_id: u32,
}

/// Generate a uniformly-distributed 5-digit ID (10000–99999) using UUID v4 randomness.
pub fn generate_id() -> u32 {
    (uuid::Uuid::new_v4().as_u128() % 90_000 + 10_000) as u32
}