# Changelog

All notable changes to Beembridge are recorded here.

---

## [Unreleased]

### Added
- `run_accept_loop`: spawns one task per incoming QUIC connection so slow or stalled peers cannot block others.
- `PendingConnections`: thread-safe map that holds a `oneshot::Sender<bool>` per in-flight connection request; the UI calls `respond(id, accepted)` to resolve each prompt.
- User consent gate: `Session::initiate` blocks in `await_session_accepted` after sending `SessionOpen`; the acceptor only sends `SessionAccepted` after the user confirms. No file transfer traffic can flow before the user accepts.
- Handshake timeout (`HANDSHAKE_TIMEOUT = 120 s`) and byte cap (`MAX_HANDSHAKE_BYTES = 4 KiB`) on both sides of the application handshake; `SessionError::HandshakeTimeout` and `SessionError::HandshakeTooLarge` returned on violation.
- `IncomingConnectionRequest` variant on `CoreEvent`, carrying `connection_id`, `peer_id`, `peer_name`, `peer_key`, `tofu_status`, and `remote_addr`, so the UI can display the consent prompt.
- `TofuStatus` derives `Serialize` and `#[serde(rename_all = "camelCase")]` so it can travel over the EventBus to the frontend.
- 10 new session tests: large packet rejection, acceptor timeout, initiator timeout, multiple concurrent connections, rejection path, wrong frame type, and `PendingConnections` unit tests.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`): triggers on push and pull request to the `dev` branch, runs `cargo test -p beembridge-core -p beembridge-cli`, posts a pass or fail comment on the pull request using `GITHUB_TOKEN`.
- GNU General Public License v3 (`LICENSE`).
- `/target/` added to `.gitignore` so workspace build artefacts are not tracked.

---

## Core and CLI split

All platform-agnostic logic that previously lived inside `src-tauri/` was extracted into a new `beembridge-core` library crate. `src-tauri/` and `beembridge-cli/` became thin adapters that each own their own UI concerns (Tauri IPC and dialogs, or clap subcommands) and call into core for everything shared. New shared functionality added to core is available to both frontends automatically.

---

## ConfigStore (replaced tauri-plugin-store)

`beembridge-core::config::ConfigStore` replaced `tauri-plugin-store`. The old plugin was Tauri-only; the new store is a plain JSON file with atomic writes (write to temp, fsync, rename) that any binary can use. It holds `user_name`, `user_id`, and `storage_path`. A one-time migration on Tauri app startup reads any existing `identity.json` from the old plugin format and writes `config.json`.

---

## Session layer

`transfer::session` provides the encrypted, authenticated QUIC channel that all file transfer messages will travel over. Key points:

- QUIC (via `quinn`) over UDP, TLS 1.3 built in.
- Both peers present self-signed Ed25519 certificates. Each peer extracts the other's static public key from the certificate after the handshake.
- TOFU (`TofuStatus::New / Matches / Mismatch`) is informational. Accept or reject is always required regardless of TOFU result.
- `make_server_endpoint` binds a QUIC server socket. The OS assigns the port; the caller reads it back to pass to `PeerDiscovery`. This wiring into application startup is not yet done; callers pass `0` as a placeholder.

---

## Discovery wire format

`DiscoveryMessage` is serialised as the JSON header of a framed packet (the same binary frame format used by the transfer protocol). Fields use camelCase on the wire: `appId`, `instanceId`, `peerId`, `peerName`, `quicPort`, `timestamp`. Self-broadcast packets are filtered by comparing `instanceId` against the local instance.
