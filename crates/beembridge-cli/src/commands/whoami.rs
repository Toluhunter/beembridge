use anyhow::Result;
use beembridge_core::identity::generate_id;

use crate::app::{App, DEFAULT_USERNAME};

pub fn run(app: &App) -> Result<()> {
    let mut cfg = app.config.lock().unwrap();
    let user_name = cfg.user_name().unwrap_or(DEFAULT_USERNAME).to_string();
    let user_id = match cfg.user_id() {
        Some(id) => id,
        None => {
            let id = generate_id();
            cfg.set_user_id(id)?;
            id
        }
    };
    println!("{}\t{}", user_name, user_id);
    Ok(())
}