mod app;
mod commands;
mod paths;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::app::App;

#[derive(Parser)]
#[command(name = "beem", version, about = "Beembridge command-line interface")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// List discovered peers on the local network.
    Peers {
        /// How long to listen before printing results.
        #[arg(long, default_value_t = 2)]
        wait: u64,
    },
    /// Print this device's identity (user_name, user_id).
    Whoami,
    /// View or modify configuration values.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Send files to a peer (not yet implemented).
    Send {
        /// One or more files to send.
        #[arg(required = true)]
        files: Vec<String>,
        /// Target peer name or instance id.
        peer: String,
    },
    /// Receive incoming transfers (not yet implemented).
    Receive,
    /// Print the binary version.
    Version,
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print all config, or a single key's value.
    Get { key: Option<String> },
    /// Set a config key to a value.
    Set { key: String, value: String },
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();
    let cli = Cli::parse();

    let Some(cmd) = cli.command else {
        // TUI will live here once built. For now, print help.
        Cli::parse_from(["beem", "--help"]);
        return Ok(());
    };

    let app = App::new()?;

    match cmd {
        Command::Peers { wait } => commands::peers::run(&app, wait).await,
        Command::Whoami => commands::whoami::run(&app),
        Command::Config { action } => match action {
            ConfigAction::Get { key } => commands::config::get(&app, key),
            ConfigAction::Set { key, value } => commands::config::set(&app, key, value),
        },
        Command::Send { files, peer } => commands::send::run(files, peer),
        Command::Receive => commands::receive::run(),
        Command::Version => commands::version::run(),
    }
}