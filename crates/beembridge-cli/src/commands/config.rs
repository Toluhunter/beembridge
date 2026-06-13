use anyhow::{anyhow, Result};

use crate::app::App;

pub fn get(app: &App, key: Option<String>) -> Result<()> {
    let cfg = app.config.lock().unwrap();
    match key.as_deref() {
        None => {
            if let Some(n) = cfg.user_name() {
                println!("user_name\t{}", n);
            }
            if let Some(id) = cfg.user_id() {
                println!("user_id\t{}", id);
            }
            if let Some(p) = cfg.storage_path() {
                println!("storage_path\t{}", p);
            }
        }
        Some("user_name") => println!("{}", cfg.user_name().unwrap_or("")),
        Some("user_id") => {
            println!("{}", cfg.user_id().map(|i| i.to_string()).unwrap_or_default())
        }
        Some("storage_path") => println!("{}", cfg.storage_path().unwrap_or("")),
        Some(k) => return Err(anyhow!("unknown key: {k}")),
    }
    Ok(())
}

pub fn set(app: &App, key: String, value: String) -> Result<()> {
    let mut cfg = app.config.lock().unwrap();
    match key.as_str() {
        "user_name" => cfg.set_user_name(value)?,
        "user_id" => {
            let id: u32 = value
                .parse()
                .map_err(|_| anyhow!("user_id must be a 5-digit integer"))?;
            cfg.set_user_id(id)?;
        }
        "storage_path" => cfg.set_storage_path(value)?,
        k => return Err(anyhow!("unknown key: {k}")),
    }
    Ok(())
}