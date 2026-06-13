use anyhow::Result;
use beembridge_core::transfer::discovery::PeerDiscovery;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::app::{App, APP_ID};

pub async fn run(app: &App, wait_secs: u64) -> Result<()> {
    let discovery = PeerDiscovery::new(APP_ID, app.peer_name(), app.peer_id(), 0);
    discovery
        .start(&app.events)
        .await
        .map_err(|e| anyhow::anyhow!("discovery start failed: {e}"))?;

    tokio::time::sleep(Duration::from_secs(wait_secs)).await;

    let peers = discovery.get_peers();
    discovery.stop();

    if peers.is_empty() {
        eprintln!("no peers found in {wait_secs}s");
        return Ok(());
    }

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut sorted = peers;
    sorted.sort_by(|a, b| a.peer_name.cmp(&b.peer_name));

    println!("NAME\tADDRESS\tAGE");
    for p in sorted {
        let age_ms = now_ms.saturating_sub(p.last_seen_ms);
        let age = format!("{}ms", age_ms);
        println!("{}\t{}:{}\t{}", p.peer_name, p.ip_address, p.quic_port, age);
    }
    Ok(())
}