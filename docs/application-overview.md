# Beembridge Application Overview

This document walks through what the application does and how each part of the codebase connects to the next.

---

## What Beembridge Is

Beembridge is a peer-to-peer file transfer app, similar to AirDrop but cross-platform (Windows, macOS, Linux, Android, iOS). Two devices on the same network discover each other and transfer files directly, with no server in between. A command-line client (`beem`) shares the same core logic as the desktop and mobile app, so there is one place to maintain the networking, discovery, identity, and configuration code.

---

## Workspace Layout

Everything lives in one Cargo workspace under `app/beembridge/`:

```
app/beembridge/
  Cargo.toml                  workspace manifest (members listed below)
  crates/
    beembridge-core/          shared logic, no UI, no Tauri, no clap
    beembridge-cli/           the `beem` command-line client
  src-tauri/                  the Tauri desktop and mobile app (thin adapter)
  src/                        the React + TypeScript frontend
```

Three things produce something runnable:

1. The Tauri app: `npm run tauri dev` (frontend in `src/`, Rust backend in `src-tauri/`).
2. The `beem` CLI: `cargo run -p beembridge-cli -- <subcommand>`.
3. Nothing else. `beembridge-core` is a library crate with no `main.rs`; it is a collection of modules that the other two link against.

---

## Crate Map

### beembridge-core

```
crates/beembridge-core/src/
  lib.rs                      module declarations
  config/mod.rs               ConfigStore: persistent JSON config with atomic writes
  events.rs                   CoreEvent enum and EventBus (a tokio broadcast channel)
  explorer/mod.rs             SelectedItem, resolve_item, percent_decode (pure path stat logic)
  identity/mod.rs             Identity struct, generate_id (5-digit user id)
  secrets/mod.rs              SecretStore trait, FileSecretStore (dev impl), TofuStatus enum
  transfer/
    framing/mod.rs            FrameParser, build_framed_message, the binary frame format
    discovery/mod.rs          DiscoveryMessage, DiscoveredPeer, PeerDiscovery (UDP multicast)
    session/mod.rs            Session: QUIC + TLS 1.3 with mutual Ed25519 authentication
```

Core depends only on ordinary crates (serde, serde_json, thiserror, tokio, socket2, if-addrs, uuid, log, ed25519-dalek, rand, base64, quinn, rustls, rcgen, x509-cert). No Tauri, no clap. It cross-compiles to desktop, Android, and iOS targets the same way.

### beembridge-cli

```
crates/beembridge-cli/src/
  main.rs                     clap parser and the subcommand dispatcher
  app.rs                      App struct: holds a ConfigStore and an EventBus; peer_name()
  paths.rs                    config_dir() resolution for the CLI
  commands/
    peers.rs                  list discovered peers (start discovery, wait, print, exit)
    whoami.rs                  print user_name and user_id (generates the id on first run)
    config.rs                 get and set config keys
    send.rs                   stub: file transfer logic does not exist in core yet
    receive.rs                stub: same reason
    version.rs                print the binary version
```

The binary is named `beem`. It is built with `cargo build -p beembridge-cli` and ends up at `target/debug/beem`.

### src-tauri

```
src-tauri/src/
  lib.rs                      app entry point: registers commands and plugins, manages
                              shared state (ConfigStore, EventBus), runs the event forwarder
  identity/mod.rs             #[tauri::command] wrappers over ConfigStore and core::identity,
                              plus the platform-specific default storage path and a folder picker
  explorer/mod.rs             file and folder picker commands; Android content:// resolution
  file_metadata/mod.rs        Android JNI plugin bridge (stays here, it is inherently Tauri)
  transfer/discovery/mod.rs   #[tauri::command] wrappers and the DiscoveryState type alias
```

### src (frontend)

```
src/
  App.tsx                     layout shell, Tauri event listeners
  context/AppContext.tsx      global state shared across all views
  components/views/
    peers.tsx                 peer discovery UI
    explorer.tsx              file selection UI
    active-transfers.tsx      in-progress transfer UI
    transfer-history.tsx      completed transfer log (currently mock data)
    settings.tsx              user preferences UI
```

---

## How the Pieces Talk

### Tauri app: frontend and backend

The React frontend and the Rust backend communicate over Tauri IPC:

- Frontend to backend: `invoke('command_name', { ...args })` calls a `#[tauri::command]` Rust function.
- Backend to frontend: `app_handle.emit("eventName", data)` pushes a real-time update that the frontend receives with `listen('eventName', ...)`.

Every Rust command must be registered in `tauri::generate_handler![]` in `lib.rs`. Tauri does not buffer events, so a frontend listener must be set up before the event fires.

### Core events: the EventBus

Core does not know about Tauri or clap, so it cannot call `app_handle.emit`. Instead it emits typed events into an `EventBus`, which is a wrapper around a `tokio::sync::broadcast` channel (capacity 256). The model is: core is the producer, and any number of consumers subscribe.

```
core (e.g. PeerDiscovery)  --send-->  EventBus  --subscribe-->  consumer 1
                                                --subscribe-->  consumer 2
```

- The frontend owns the bus. The `App` struct (CLI) creates one; the Tauri app creates one and manages it as state. Core never owns global state.
- Core is the sender. When you call `discovery.start(&bus)`, discovery pulls a sender out of the bus and its background tasks call `events_tx.send(CoreEvent::PeerDiscoveryUpdate { ... })`.
- Whoever wants updates subscribes. In the Tauri app, a spawned task subscribes and re-emits each event to the webview with `app.emit`. A future CLI TUI would subscribe and redraw. A `broadcast::Sender` with no receivers just drops events cheaply, which is why `beem peers` (which reads peer state directly instead of subscribing) works fine.

The bus is lossy on slow consumers: a receiver that falls behind by more than the channel capacity sees a `Lagged` error and skips events. That is acceptable because events are best-effort telemetry. The authoritative state lives in core's own data structures, which a consumer can read at any time to reconcile (for discovery, that is `PeerDiscovery::get_peers()`).

---

## Configuration: ConfigStore

`beembridge-core::config::ConfigStore` is a small JSON-backed key-value store. It replaced `tauri-plugin-store`, which only the Tauri app could use.

What it stores today:

- `user_name`: display name shown to other peers
- `user_id`: a 5-digit number (10000 to 99999) generated from UUID randomness, used to tell apart devices with the same name
- `storage_path`: where received files are saved (optional; if unset, each frontend computes a platform default)

Design points:

- The caller supplies the directory. Core never guesses a platform path. The CLI uses `dirs::config_dir().join("beembridge")`; the Tauri app uses `app.path().app_local_data_dir()`, which returns the correct sandboxed path on Android and iOS.
- Writes are atomic: the new contents are written to a temp file, fsynced, then renamed over the real file. A crash mid-write cannot corrupt the config.
- It exposes getters that return `Option`, and setters that persist immediately. Callers decide on fallbacks (the Tauri app and the CLI both fall back to `"Beembridge User"` for an unset username).

The Tauri app runs a one-time best-effort migration on startup: if an old `identity.json` (from `tauri-plugin-store`) exists and no `config.json` does, it reads the old file, writes the new one, and removes the old. The migration assumes the on-disk shape matched, which has not been verified against a real install.

---

## Secrets and TOFU Peer Authentication

File: `beembridge-core/src/secrets/mod.rs`.

`SecretStore` is a trait with three methods:

- `get_keypair()`: returns the device's long-term Ed25519 `SigningKey`, generating and persisting it on first call.
- `verify_peer_key(peer_id, key)`: checks a peer's `VerifyingKey` against the pinned store. Returns `TofuStatus::New` (first contact), `TofuStatus::Matches` (key is known and correct), or `TofuStatus::Mismatch` (key changed since last contact).
- `pin_peer_key(peer_id, key)`: writes a peer's public key into the pinned store.

The current implementation is `FileSecretStore`: a development-only plaintext store. It writes the raw 32-byte Ed25519 seed to `identity.key` (permissions `0o600` on Unix), and keeps a `known_peers.json` map of `peer_id -> base64-encoded public key`. This implementation is adequate for development but is replaced by platform-native key storage before v1 ships (Keychain on Apple platforms, DPAPI on Windows, Android Keystore on Android, Secret Service on Linux desktop, and a passphrase-derived Argon2id-wrapped key on Linux headless and Termux).

The trust model is TOFU: on first contact the peer's static key is unknown; the user sees a "new peer" prompt and accepts. After pinning, subsequent connections from the same `peer_id` either confirm the key or flag a mismatch, which the UI must surface prominently. A mismatch is indistinguishable from a reinstall or an active MITM; both require explicit user re-acceptance.

Static public keys are never put in discovery announcements. They are only exchanged during the TLS handshake of an explicit connection.

---

## App Entry Point (Tauri `lib.rs`)

When the app starts, `run()`:

1. Initialises the logger.
2. Creates the shared discovery state (`Arc<Mutex<Option<PeerDiscovery>>>`) and an `EventBus`.
3. Loads plugins (file dialog, OS detection, file opener, and the Android `file_metadata` plugin).
4. In `setup`: resolves the config directory, runs the legacy migration, opens the `ConfigStore`, manages it as state, then spawns the event forwarder task that subscribes to the `EventBus` and re-emits each `CoreEvent` to the webview.
5. Manages the `EventBus` and the discovery state.
6. Registers every IPC command and starts the Tauri event loop.

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(file_metadata::init())          // registers the Android Kotlin plugin
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
        let cfg_dir = app.path().app_local_data_dir()?;
        migrate_legacy_identity(&cfg_dir);
        let store = ConfigStore::open(cfg_dir)?;
        app.manage(Arc::new(Mutex::new(store)));

        let bus = app.state::<EventBus>();
        let mut rx = bus.subscribe();
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                // forward_event re-emits ev to the webview
            }
        });
        Ok(())
    })
    .manage(event_bus)
    .manage(discovery_state)
    .invoke_handler(tauri::generate_handler![
        start_peer_discovery, stop_peer_discovery, get_discovered_peers,
        get_identity, set_username, generate_user_id,
        get_storage_path, set_storage_path, pick_storage_folder,
        open_directory_dialog, get_file_stats, pick_files_and_get_stats,
    ])
    .run(tauri::generate_context!())
```

Nothing in the app works unless its command is listed in `generate_handler![]`.

---

## Identity

Files: `beembridge-core/src/identity/mod.rs`, `src-tauri/src/identity/mod.rs`, `src/components/views/settings.tsx`.

Core provides the `Identity` struct (`{ user_name, user_id }`) and `generate_id()`. The persistence and the UI live in the frontend layers. The Tauri commands are thin wrappers that read and write the `ConfigStore`:

| Command | What it does |
|---|---|
| `get_identity` | Returns `{ userName, userId }`, generating the id on first call |
| `set_username` | Updates the display name |
| `generate_user_id` | Creates a new random 5-digit id |
| `get_storage_path` | Returns the saved path, or a platform default if unset |
| `set_storage_path` | Updates the save location |
| `pick_storage_folder` | Opens a folder picker (desktop only; returns nothing on mobile) |

The CLI exposes the same identity through `beem whoami` and `beem config get` / `beem config set`.

Platform defaults for the storage path (computed by the Tauri layer when no path is stored):

| Platform | Default path |
|---|---|
| Desktop | `~/Downloads/BeemBridge` |
| Android | App-specific local data directory (visible in the Files app) |
| iOS | App Documents directory (requires `UIFileSharingEnabled`) |

---

## Peer Discovery
instance
Files: `beembridge-core/src/transfer/discovery/mod.rs`, `src-tauri/src/transfer/discovery/mod.rs`, `src/components/views/peers.tsx`, and `beembridge-cli/src/commands/peers.rs`.

Peers are found with UDP multicast: one packet is delivered to every device listening on the same multicast group, without knowing their addresses in advance.

### The wire message

`DiscoveryMessage` is broadcast as the JSON header of a framed packet (see the framing section). On the wire its fields are camelCase:

```
{ appId, instanceId, peerId, peerName, quicPort, timestamp }
```

- `appId`: constant `"BeemBridge"`. Lets the listener ignore other multicast traffic on the same port.
- `instanceId`: a UUID generated fresh each time `PeerDiscovery::new` runs, so it identifies a running process, not a persistent identity. It is used for self-filtering (ignoring your own echoed packets) and as the key in the peer table. Two instances of the app under the same identity get different `instanceId`s and so can see each other.
- `peerId`: the user's stable 5-digit `user_id` (from `ConfigStore`), as a string. Stable across restarts. Used to disambiguate two devices with the same `peerName`. Not a trust signal; authentication happens during the transfer handshake.
- `peerName`: the user-chosen display name. It is a label, not an identity; two peers can share a name.
- `quicPort`: the UDP port of this peer's QUIC server endpoint, as opened by `make_server_endpoint`. A remote peer uses this port to call `Session::initiate`. Currently broadcast as `0` because the session endpoint is not yet wired into application startup; it will carry the real port once that wiring is done.
- `timestamp`: seconds since the Unix epoch when the announcement was built.

The receiver enriches each sighting into a `DiscoveredPeer`, which adds `lastSeen` (local clock time of the last sighting, in milliseconds) and `ipAddress` (taken from the UDP packet source).

### How it runs

```
Your device                          Other device
Every 500ms:                          Every 500ms:
  broadcast to 224.0.0.251:9999         broadcast to 224.0.0.251:9999
  { appId, instanceId, peerName,        { appId, instanceId, peerName,
    quicPort, timestamp }                 quicPort, timestamp }

       <----------------------------------
       receives their broadcast
       stores it in HashMap<instanceId, DiscoveredPeer>
       emits CoreEvent::PeerDiscoveryUpdate on the EventBus

Every 1000ms:
  remove peers not seen in more than 1500ms (they went offline)
  if any were removed, emit CoreEvent::PeerDiscoveryUpdate
```

`PeerDiscovery::start` spawns three async tasks that share an `Arc<Mutex<HashMap<String, DiscoveredPeer>>>`:

1. Broadcast task: sends your presence every 500ms on all non-loopback interfaces.
2. Listen task: receives packets, feeds them through a `FrameParser`, parses each header as a `DiscoveryMessage`, drops self and wrong-app messages, updates the peer map, and emits a `PeerDiscoveryUpdate`.
3. Cleanup task: every second, removes peers where `DiscoveredPeer::is_stale(now_ms, 1500)` is true, and emits a `PeerDiscoveryUpdate` if anything changed.

All three subscribe to an internal stop channel; calling `stop()` makes all three exit cleanly and clears the peer map.

`DiscoveredPeer::is_stale(now_ms, timeout_ms)` returns true when `now_ms.saturating_sub(last_seen_ms) >= timeout_ms`. The saturating subtraction means a peer whose `lastSeen` is in the future (clock skew) reads as age zero, not stale.

### Frontend integration

The Tauri forwarder turns each `CoreEvent::PeerDiscoveryUpdate` into an `onPeerDiscoveryUpdate` emit, so the React code is unchanged:

```typescript
await listen<DiscoveredPeer[]>('onPeerDiscoveryUpdate', (event) => {
    setDiscoveredPeers(event.payload);
});
```

The peers view calls `invoke('start_peer_discovery', { peerName })` and `invoke('stop_peer_discovery')`.

### CLI integration

`beem peers [--wait N]` starts a `PeerDiscovery`, sleeps for `N` seconds (default 2), reads `discovery.get_peers()` directly, prints a tab-separated table sorted by name, and exits. It is intentionally non-interactive and scriptable. It does not subscribe to the `EventBus`; the live event path will be exercised by the future TUI.

---

## File Selection (Tauri only)

Files: `beembridge-core/src/explorer/mod.rs`, `src-tauri/src/explorer/mod.rs`, `src/components/views/explorer.tsx`.

Core owns the pure parts: `SelectedItem` (`{ name, path, size, isDirectory }`), `resolve_item` (stat a path or `file://` URI), and `percent_decode` (a minimal URI segment decoder). Picking a file is inherently a UI action, so the dialogs stay in the Tauri layer.

```
User taps "Add Files"
  invoke('pick_files_and_get_stats')
    Rust opens the OS file picker (tauri-plugin-dialog)
    user selects files; Rust receives URIs
    for each URI: resolve name and size
      content:// URIs (Android) go through the Kotlin ContentResolver bridge
      everything else goes through core::resolve_item
    returns Vec<SelectedItem>
  frontend adds them to selectedFiles in AppContext
```

`pick_files_and_get_stats` does the open and the resolve in one IPC round-trip to avoid latency.

URI handling by platform:

| Platform | URI format | How resolved |
|---|---|---|
| Desktop | `/home/user/file.pdf` | `core::resolve_item` (uses `std::fs::metadata`) |
| iOS | `file:///var/mobile/.../file.pdf` | `core::resolve_item` strips `file://` then stats |
| Android | `content://...` | Kotlin ContentResolver via the `file_metadata` plugin |

The folder picker (`open_directory_dialog`) uses the native folder picker on desktop and iOS; on Android, SAF has no folder-only picker, so it picks a file and returns the parent directory.

The CLI does not have file pickers. A future TUI will offer a ratatui file browser, and one-shot commands take paths as arguments. A Termux user is limited to paths in their Termux home or shared storage.

---

## Android Metadata Bridge

Files: `src-tauri/src/file_metadata/mod.rs`, `FileMetadataPlugin.kt`.

Android's file picker returns `content://` URIs, which are opaque handles, not real paths. Resolving a name or size from one requires Android's Java `ContentResolver`, which Rust cannot call. The bridge connects Rust to Kotlin so Rust can ask Android.

At startup, `file_metadata::init()` runs as a Tauri plugin and calls `api.register_android_plugin("com.beembridge.www", "FileMetadataPlugin")`. This uses JNI to find the Kotlin plugin class, instantiate it, register it with Tauri, and return a `PluginHandle` stored as app state.

Resolving a URI:

```
Rust calls run_mobile_plugin_async("getFileMetadata", { uri })
  serialized to JSON, sent to Kotlin via JNI
  Kotlin: contentResolver.query(uri), reads DISPLAY_NAME and SIZE,
          invoke.resolve({ name, size })
  response returns via the JNI callback
  the tokio oneshot fires; Rust deserializes into FileMeta { name, size }
  returned as a SelectedItem
```

The async variant is used so the tokio thread yields while waiting, avoiding a multi-second stall that would result from blocking.

This module is inherently Tauri-coupled (it uses `tauri::plugin::Builder` and `PluginHandle`), so it stays in `src-tauri` rather than moving to core.

---

## Transfer Protocol: Message Framing

File: `beembridge-core/src/transfer/framing/mod.rs`.

TCP is a byte stream with no message boundaries, so transferred messages need a frame format. Discovery already uses this format for its multicast packets.

### Frame format

```
[ header_len: 4 bytes LE ][ JSON header: header_len bytes ][ payload_len: 4 bytes LE ][ payload: payload_len bytes ]
```

- Header: a JSON object, for example `{ "type": "file", "name": "photo.jpg", "size": 2048000 }`.
- Payload: raw bytes (optional; zero-length payloads are reported as none).
- Length prefixes: 4-byte little-endian integers telling the reader exactly how many bytes to read next.

`build_framed_message(header, payload)` produces the bytes. `MAX_HEADER_SIZE` (1 MiB) and `MAX_PAYLOAD_SIZE` (1 GiB) bound the sizes.

### FrameParser state machine

TCP data arrives in chunks, so a frame may be split across packets. `FrameParser` accumulates bytes and yields complete `FramedMessage`s:

```
WaitingHeaderLength  -> read 4 bytes  -> know the header length
WaitingHeader        -> read N bytes  -> parse the JSON header
WaitingPayloadLength -> read 4 bytes  -> know the payload length
WaitingPayload       -> read M bytes  -> emit a FramedMessage, back to WaitingHeaderLength
```

On a corrupt header, `reset_on_error()` scans forward in the buffer for a plausible length prefix followed by a valid JSON object, so the parser resynchronises rather than giving up.

### Tests

`beembridge-core` carries unit tests for this module: single-frame round-trip, payload round-trip, zero-length payload, a frame split across two `feed` calls, two frames in one `feed`, a bad header producing an error, and recovery onto a following valid frame after a bad header. The discovery module adds tests for the camelCase wire keys, message round-trip, the full discovery-message-through-framing path, `PeerDiscovery::new` invariants, and four `is_stale` boundary cases. The session module tests cover: new-peer handshake (`TofuStatus::New`), known-peer handshake (pinning then `Matches`), key-mismatch detection, full framed message round-trip, large packet rejection (byte cap), handshake timeouts on both acceptor and initiator sides, multiple concurrent incoming connections, the rejection path (user declines), wrong-frame-type handling, and `PendingConnections` unit tests. All 33 tests run with `cargo test -p beembridge-core` (or `cargo test --workspace`).

---

## Transfer Logic Status

### Session layer (complete)

`transfer::session` is built and tested. It provides the encrypted, authenticated channel that all file transfer messages will travel over.

`make_server_endpoint(bind_addr, secret_store)` creates a QUIC server endpoint bound to a UDP socket. The OS assigns the port when `0` is passed; the caller reads it back with `endpoint.local_addr().port()` and will pass it to `PeerDiscovery::new` so the port is broadcast in discovery. This wiring into application startup has not been done yet; callers currently pass `0` to discovery as a placeholder.

`Session::initiate(addr, peer_id, secret_store)` is called by the sender. It connects to the remote QUIC endpoint, completes a mutually authenticated TLS 1.3 handshake where both sides present self-signed Ed25519 certificates, extracts the peer's static public key from their certificate, runs the TOFU check via `SecretStore::verify_peer_key`, opens a bidirectional QUIC stream, and writes a `SessionOpen` frame to trigger the STREAM packet (quinn does not transmit stream frames until the opener writes). It returns the `Session` and a `TofuStatus` so the caller can decide whether to proceed, prompt the user, or abort.

`Session::accept(endpoint)` is called by the receiver. It dequeues the next incoming connection from the endpoint, completes the handshake, extracts the sender's key, accepts the bidi stream, reads and validates the `SessionOpen` frame, and returns the `Session`. The TOFU check is the caller's responsibility: after accept returns, the caller uses `session.remote_addr()` and `session.peer_static_key()` to look up the peer in the discovery table and call `SecretStore::verify_peer_key`.

`send_message` and `recv_message` send and receive framed messages (JSON header plus optional binary payload) over the established stream, using the same `build_framed_message` / `FrameParser` format as discovery.

### File transfer state machine (not yet built)

`transfer::file_transfer` does not exist yet. Until it does:

- The Tauri frontend's active-transfers and transfer-history views run on mock data (see the mock mode section).
- `beem send` and `beem receive` are stubs that print an explanatory error.

When the file transfer module lands, both the desktop app and the CLI gain real send and receive together. The planned protocol:

```
sender   -> FileOffer    { name, size, content_hash, chunk_size }
receiver -> FileAccept   { resume_from_offset }      // 0 = fresh, N = resume
            or FileReject { reason }
sender   -> Chunk        { offset, blake3 } + <payload bytes>
receiver -> TransferAck  { ok, reason? }             // after full-file hash verification
```

File content is hashed with BLAKE3 per chunk for incremental verification plus a running full-file hash for end-to-end integrity. Interrupted transfers resume from a `.partial` sparse file plus a small JSON manifest. Discovery stays unencrypted; static keys are never broadcast and are only exchanged during the TLS handshake.

---

## Frontend State and Views

Files: `src/context/AppContext.tsx`, `src/App.tsx`, `src/components/views/`.

All views share state through React Context. `AppContext` holds:

| State | Type | Purpose |
|---|---|---|
| `userName` / `userId` | string | User identity loaded from Rust on mount |
| `storagePath` | string | Save location for received files |
| `mockMode` | boolean | Enables simulated peers and transfers (persisted to localStorage) |
| `isDiscovering` | boolean | Whether the discovery engine is running |
| `discoveredPeers` | `DiscoveredPeer[]` | Peers found via UDP multicast |
| `connectedPeers` | `DiscoveredPeer[]` | Peers with an active connection |
| `selectedFiles` | `SelectedItem[]` | Files queued in the file explorer |
| `activeTransfers` | map | In-progress transfers with progress data (mock for now) |
| `hashingProgress` | map | Per-file hashing progress, 0 to 100 (mock for now) |

On mount, `AppContext` calls `invoke('get_identity')` and `invoke('get_storage_path')`. `App.tsx` registers Tauri event listeners on mount (`onPeerDiscoveryUpdate` today, transfer events when the backend implements them) and cleans them up on unmount.

The active-transfers view groups folder transfers into one expandable row showing the average progress across child files. The transfer-history view groups by date, supports search by filename or peer name, shows status badges, and has both a desktop table layout and a mobile list layout; it currently renders mock data because the persistence layer is not implemented.

---

## Mock Mode (frontend)

Files: `src/utils/mockPeers.ts`, `src/utils/mockTransfers.ts`.

Mock mode lets the UI be developed without a second real device or a working transfer backend. It is toggled in Settings and persisted to localStorage.

- `useMockPeerDiscovery`: after a 5-second delay, four fake peers appear (Alice's Laptop, Bob's Desktop, Carol's Phone, Dave's Tablet); clicking Connect on one takes 2 seconds, then it shows as connected.
- `useMockTransferEngine`: simulates a hashing phase (800 to 2500 ms per file) and a transfer phase (10 to 100 seconds depending on size) with speed and progress updates, 5 to 10 concurrent transfers, mostly folder transfers, with random names, sizes, and peers, so progress bars, speed display, grouping, and status badges can be exercised without networking.

---

## Adding New Shared Functionality

The rule for deciding where code goes: if removing the GUI would break it, it belongs in a frontend crate; otherwise it belongs in core.

- New networking, protocol, identity, or config logic goes in `beembridge-core`.
- A new Tauri command is a thin `#[tauri::command]` wrapper in `src-tauri` that calls into core.
- A new CLI subcommand is a function in `beembridge-cli/src/commands/` that calls into core, wired into the clap dispatcher in `main.rs`.
- New cross-frontend notifications become a new `CoreEvent` variant; the Tauri forwarder maps it to an `emit`, and CLI consumers subscribe to the bus.
- Anything UI-shaped (a dialog handle, an `AppHandle`, a `Window`) must stay out of core. If a core function signature needs one, it is in the wrong layer.