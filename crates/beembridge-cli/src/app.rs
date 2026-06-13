use anyhow::Result;
use beembridge_core::config::ConfigStore;
use beembridge_core::events::EventBus;
use std::sync::{Arc, Mutex};

use crate::paths;

pub const APP_ID: &str = "BeemBridge";
pub const DEFAULT_USERNAME: &str = "Beembridge User";

pub struct App {
    pub config: Arc<Mutex<ConfigStore>>,
    pub events: EventBus,
}

impl App {
    pub fn new() -> Result<Self> {
        let dir = paths::config_dir()?;
        let store = ConfigStore::open(dir)?;
        Ok(Self {
            config: Arc::new(Mutex::new(store)),
            events: EventBus::new(),
        })
    }

    pub fn peer_name(&self) -> String {
        let cfg = self.config.lock().unwrap();
        cfg.user_name().unwrap_or(DEFAULT_USERNAME).to_string()
    }

    pub fn peer_id(&self) -> String {
        let cfg = self.config.lock().unwrap();
        cfg.user_id().map(|id| id.to_string()).unwrap_or_default()
    }
}
