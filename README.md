# Beembridge

Cross-platform peer-to-peer file transfer, like AirDrop but for every device. Two machines on the same network discover each other and transfer files directly, with no server in the middle.

Supported platforms: **Windows, macOS, Linux, Android, iOS**

---

## Getting started

### Desktop app (Tauri)

```bash
npm install
npm run tauri dev
```

Build a production binary:

```bash
npm run tauri build
```

### Android

```bash
npm run tauri android dev
```

### CLI (`beem`)

```bash
cargo build -p beembridge-cli
./target/debug/beem --help
```

Common commands:

```
beem whoami              print your user name and id
beem peers               list peers discovered on the network
beem config get <key>    read a config value
beem config set <key>    write a config value
beem send <peer> <file>  send a file (not yet implemented)
beem receive             receive a file (not yet implemented)
```

---

## Project layout

```
app/beembridge/
  Cargo.toml              Cargo workspace manifest
  crates/
    beembridge-core/      shared logic (no UI, no Tauri, no clap)
    beembridge-cli/       the `beem` CLI
  src-tauri/              Tauri backend (thin adapter over core)
  src/                    React + TypeScript frontend
  .github/workflows/      CI (tests run on push and PR to dev)
  docs/                   design and architecture documentation
  LICENSE                 GNU General Public License v3
```

See [docs/application-overview.md](docs/application-overview.md) for a full walkthrough of how each layer works and how the pieces connect.

---

## Running tests

```bash
cargo test -p beembridge-core
cargo test -p beembridge-cli
```

Tests run automatically in CI on every push and pull request to the `dev` branch. Results are posted as a comment on the pull request.

---

## License

Beembridge is free software released under the [GNU General Public License v3](LICENSE).
