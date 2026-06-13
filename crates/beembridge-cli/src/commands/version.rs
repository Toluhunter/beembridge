use anyhow::Result;

pub fn run() -> Result<()> {
    println!("beem {}", env!("CARGO_PKG_VERSION"));
    Ok(())
}