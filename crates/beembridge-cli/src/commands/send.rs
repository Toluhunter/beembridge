use anyhow::{bail, Result};

pub fn run(_files: Vec<String>, _peer: String) -> Result<()> {
    bail!(
        "`beem send` is not yet implemented — file transfer logic still lives outside \
         beembridge-core. Once the transfer state machine lands in core, send/receive \
         become real in lockstep with the desktop app."
    );
}