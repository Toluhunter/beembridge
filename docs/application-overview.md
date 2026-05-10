# Beembridge Application Overview

This document walks through everything the application does and how each part of the codebase connects to the next.

---

## What Beembridge Is

Beembridge is a **peer-to-peer file transfer app** — like AirDrop, but cross-platform (Windows, macOS, Linux, Android, iOS). Two devices on the same network can discover each other and transfer files directly, with no server in between.

---

## Architecture

Beembridge is built with **Tauri v2**, which combines three layers:

```
┌─────────────────────────────────────────────┐
│  Frontend (React + TypeScript)              │  src/
│  What the user sees — built as a WebView    │
├─────────────────────────────────────────────┤
│  Backend (Rust)                             │  src-tauri/src/
│  Business logic, networking, file I/O       │
├─────────────────────────────────────────────┤
│  Native Android (Kotlin)                    │  src-tauri/gen/android/
│  Android-only APIs (ContentResolver, etc.)  │
└─────────────────────────────────────────────┘
```

The frontend and backend communicate via **IPC** (inter-process communication):
- **Frontend → Backend**: `invoke('command_name', { ...args })` — calls a Rust function
- **Backend → Frontend**: `app_handle.emit("eventName", data)` — pushes real-time updates

The Kotlin layer bridges Android-specific APIs that Rust cannot call directly.

---

## Module Map

```
src-tauri/src/
├── lib.rs                  — app entry point, registers all commands and plugins
├── identity/mod.rs         — user identity and storage preferences
├── explorer/mod.rs         — file and folder picker commands
├── file_metadata/mod.rs    — Android JNI plugin bridge for content:// URIs
└── transfer/
    ├── discovery/mod.rs    — UDP multicast peer discovery
    └── framing/mod.rs      — binary message framing protocol

src/
├── App.tsx                 — layout shell, event listeners
├── context/AppContext.tsx  — global state shared across all views
└── components/views/
    ├── peers.tsx           — peer discovery UI
    ├── explorer.tsx        — file selection UI
    ├── active-transfers.tsx — in-progress transfer UI
    ├── transfer-history.tsx — completed transfer log
    └── settings.tsx        — user preferences UI

src-tauri/gen/android/.../
├── MainActivity.kt         — Android entry point
└── FileMetadataPlugin.kt   — Android ContentResolver bridge
```

---

## 1. App Entry Point (`lib.rs`)

When the app starts, `run()` in `lib.rs` is called. It:
1. Initialises the logger
2. Creates shared state for peer discovery (`Arc<Mutex<Option<PeerDiscovery>>>`)
3. Loads all plugins (file dialog, OS detection, key-value store, file opener)
4. Registers every IPC command the frontend can call
5. Starts the Tauri event loop

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(file_metadata::init())      // registers Android Kotlin plugin
    .manage(discovery_state)            // shared peer discovery state
    .invoke_handler(tauri::generate_handler![
        start_peer_discovery,
        open_file_dialog,
        get_file_stats,
        // ...all commands listed here
    ])
    .run(tauri::generate_context!())
```

Nothing in the app works unless its command is listed in `generate_handler![]`.

---

## 2. Identity System

**Files:** `src-tauri/src/identity/mod.rs`, `src/components/views/settings.tsx`

Every device has a persistent identity stored in `identity.json` (via `tauri-plugin-store`):
- **Username** — display name shown to other peers
- **User ID** — a 5-digit number generated from a UUID, used to distinguish devices with the same name
- **Storage path** — where received files are saved

### Platform defaults for storage path

| Platform | Default path |
|----------|-------------|
| Desktop  | `~/Downloads/BeemBridge` |
| Android  | App-specific external storage (visible in Files app) |
| iOS      | App Documents directory (requires UIFileSharingEnabled) |

### Exposed commands

| Command | What it does |
|---------|-------------|
| `get_identity` | Returns `{ userName, userId }` |
| `set_username` | Updates display name |
| `generate_user_id` | Creates a new random 5-digit ID |
| `get_storage_path` | Returns current save location |
| `set_storage_path` | Updates save location |
| `pick_storage_folder` | Opens a folder picker (desktop only) |

On first launch, `get_identity` creates the store file with default values. Subsequent calls read from the persisted file.

---

## 3. Peer Discovery

**Files:** `src-tauri/src/transfer/discovery/mod.rs`, `src/components/views/peers.tsx`

Peers are found using **UDP multicast** — a networking technique where one packet is delivered to all devices listening on the same multicast group, without knowing their addresses in advance.

### How it works

```
Your device                         Other device
──────────                         ────────────
Every 500ms:                        Every 500ms:
  broadcast to 224.0.0.251:9999       broadcast to 224.0.0.251:9999
  { appId, instanceId, peerName,      { appId, instanceId, peerName,
    tcpPort, timestamp }               tcpPort, timestamp }

        ←──────────────────────────────────
        receives their broadcast
        stores them in HashMap<instanceId, DiscoveredPeer>
        emits "onPeerDiscoveryUpdate" to frontend

Every 1000ms:
  remove peers not seen in >1500ms (they went offline)
  if any removed, emit "onPeerDiscoveryUpdate"
```

Three concurrent async tasks run while discovery is active:

1. **Broadcast task** — sends your presence every 500ms on all network interfaces
2. **Listen task** — receives packets, parses them, updates the peer map
3. **Cleanup task** — removes stale peers every 1 second

All three tasks share the same `Arc<Mutex<HashMap>>` peer map. They all subscribe to a `broadcast::channel` — when `stop()` is called, all three receive the signal and exit cleanly.

### Ignoring yourself

The listen task filters out packets where `instance_id == self.instance_id` — so you don't see yourself in the peer list. It also filters `app_id != "BeemBridge"` so other multicast traffic on port 9999 is ignored.

### Frontend integration

The frontend listens for the `onPeerDiscoveryUpdate` event:
```typescript
// src/App.tsx
await listen<DiscoveredPeer[]>('onPeerDiscoveryUpdate', (event) => {
    setDiscoveredPeers(event.payload);
});
```

The peers view calls `invoke('start_peer_discovery', { peerName })` when the user taps "Find Peers" and `invoke('stop_peer_discovery')` after 30 seconds or when they navigate away.

---

## 4. File Selection

**Files:** `src-tauri/src/explorer/mod.rs`, `src/components/views/explorer.tsx`

### Picking files

```
User taps "Add Files"
  → invoke('pick_files_and_get_stats')
    → Rust opens OS file picker (tauri-plugin-dialog)
    → user selects files
    → Rust receives URIs from OS
    → Rust resolves name + size for each URI
    → returns Vec<SelectedItem> to frontend
  → frontend adds files to selectedFiles list in AppContext
```

A single command `pick_files_and_get_stats` does the open + resolve in one IPC round-trip to avoid latency.

### URI types by platform

| Platform | URI format | How resolved |
|----------|-----------|-------------|
| Desktop | `/home/user/file.pdf` | `std::fs::metadata()` |
| iOS | `file:///var/mobile/.../file.pdf` | strip `file://`, then `std::fs::metadata()` |
| Android | `content://com.android.providers...` | Kotlin ContentResolver (see section 6) |

### Folder picker

The folder picker uses `open_directory_dialog`:
- **Desktop/iOS**: native folder picker via `pick_folder()`
- **Android**: not supported by SAF — the button is hidden on Android (detected via `platform()` from `@tauri-apps/plugin-os`)

### Exposed commands

| Command | What it does |
|---------|-------------|
| `pick_files_and_get_stats` | Open file picker + resolve metadata, one round-trip |
| `open_file_dialog` | Open file picker, returns raw URI strings |
| `open_directory_dialog` | Open folder picker |
| `get_file_stats` | Resolve metadata for a list of URIs |

---

## 5. Android Metadata Bridge

**Files:** `src-tauri/src/file_metadata/mod.rs`, `FileMetadataPlugin.kt`

### Why this exists

Android's file picker returns `content://` URIs. These are opaque handles — not real paths. Rust cannot resolve a filename or size from them because that requires Android's Java `ContentResolver` API. The bridge connects Rust to Kotlin so Rust can ask Android for the information.

### How the bridge is set up

At app startup, `file_metadata::init()` runs as a Tauri plugin:

```rust
api.register_android_plugin("com.beembridge.www", "FileMetadataPlugin")
```

This uses JNI (Java Native Interface — the Rust↔Java interop layer) to:
1. Find the `FileMetadataPlugin` class in the Android runtime
2. Instantiate it
3. Register it with Tauri's plugin manager
4. Return a `PluginHandle` stored as app state

### How a URI gets resolved

```
Rust calls run_mobile_plugin_async("getFileMetadata", { uri })
  → serialized to JSON
  → sent to Kotlin via JNI
  → Kotlin's getFileMetadata() runs:
       contentResolver.query(uri)
       reads DISPLAY_NAME and SIZE columns
       invoke.resolve({ name: "photo.jpg", size: 2048000 })
  → response comes back via JNI callback
  → Rust tokio oneshot fires
  → deserialized into FileMeta { name, size }
  → returned as SelectedItem
```

`run_mobile_plugin_async` (not the sync variant) is used so the tokio thread yields while waiting — avoiding the ~5 second delay that would result from blocking.

---

## 6. Transfer Protocol: Message Framing

**File:** `src-tauri/src/transfer/framing/mod.rs`

Before files can be transferred over TCP, messages need a protocol — a way to know where one message ends and the next begins. Raw TCP is a stream of bytes with no built-in message boundaries.

### Frame format

```
┌────────────────┬──────────────────┬────────────────┬──────────────┐
│  header_len    │   JSON header    │  payload_len   │   payload    │
│   (4 bytes LE) │  (header_len b)  │  (4 bytes LE)  │ (payload_len)│
└────────────────┴──────────────────┴────────────────┴──────────────┘
```

- **Header**: JSON object (e.g., `{ "type": "file", "name": "photo.jpg", "size": 2048000 }`)
- **Payload**: raw bytes (the actual file data, optional)
- **Length prefix**: 4-byte little-endian integers tell the reader exactly how many bytes to read next

### FrameParser state machine

TCP data arrives in chunks — a single "frame" might be split across multiple network packets. `FrameParser` accumulates bytes and produces complete messages:

```
State: WaitingHeaderLength
  → read 4 bytes → know how long the header is
State: WaitingHeader
  → read N bytes → parse JSON header
State: WaitingPayloadLength
  → read 4 bytes → know how long the payload is
State: WaitingPayload
  → read M bytes → complete message ready
  → emit FramedMessage, back to WaitingHeaderLength
```

If the parser encounters corrupted data, `reset_on_error()` scans forward in the buffer looking for a valid JSON boundary to re-synchronise, rather than giving up entirely.

---

## 7. Active Transfers UI

**File:** `src/components/views/active-transfers.tsx`

Transfers happen in two phases:

1. **Hashing** — the file is read and checksummed (to verify integrity after transfer). Progress appears as `hashingProgress[filePath]` in `AppContext`.
2. **Transfer** — bytes flow over TCP. Progress appears as `activeTransfers` with `bytesTransferred`, `totalBytes`, and a speed calculation.

The backend emits events:
```
"onHashingProgress"  → { filePath, progress }   (0-100%)
"onProgressUpdate"   → { transferId, bytesTransferred, totalBytes, speedBytesPerSec, ... }
"onTransferComplete" → { transferId, status }    ('completed' | 'failed' | 'cancelled')
```

`App.tsx` listens for these and updates `AppContext` state. The active-transfers view reads from that state and renders progress bars.

Folder transfers are **grouped** — if you send a folder with 5 files, the UI shows one expandable row with the folder name and the average progress across all child files.

---

## 8. Transfer History

**File:** `src/components/views/transfer-history.tsx`

Displays a log of completed transfers. Currently uses mock/hardcoded data — the database persistence layer has not been implemented yet.

The UI groups transfers by date (Today, Yesterday, day-of-week), supports search filtering by filename or peer name, and shows status badges (completed, failed, cancelled). Both a desktop table layout and a mobile list layout are implemented.

---

## 9. Global State (`AppContext` and `App.tsx`)

**Files:** `src/context/AppContext.tsx`, `src/App.tsx`

All views share state through React's Context API. `AppContext` holds:

| State | Type | Purpose |
|-------|------|---------|
| `userName` / `userId` | string | User identity loaded from Rust on mount |
| `storagePath` | string | Save location for received files |
| `mockMode` | boolean | Enables simulated peers/transfers (persisted to localStorage) |
| `isDiscovering` | boolean | Whether the discovery engine is running |
| `discoveredPeers` | `DiscoveredPeer[]` | Peers found via UDP multicast |
| `connectedPeers` | `DiscoveredPeer[]` | Peers with an active connection |
| `selectedFiles` | `SelectedItem[]` | Files queued in the file explorer |
| `activeTransfers` | map | In-progress transfers with progress data |
| `hashingProgress` | map | Per-file hashing progress (0-100%) |

On mount, `AppContext` calls:
```typescript
invoke('get_identity')      → sets userName, userId
invoke('get_storage_path')  → sets storagePath
```

`App.tsx` registers Tauri event listeners on mount and cleans them up on unmount:
```typescript
const unlisten = await listen('onProgressUpdate', (event) => {
    // update activeTransfers
});
return () => unlisten();  // cleanup when App unmounts
```

---

## 10. Mock Mode

**Files:** `src/utils/mockPeers.ts`, `src/utils/mockTransfers.ts`

Mock mode lets you test the UI without a second real device. It is toggled in Settings and persisted to `localStorage`.

### Mock peer discovery (`mockPeers.ts`)

When mock mode is on and the user clicks "Find Peers", `useMockPeerDiscovery` simulates:
1. A 5-second delay (realistic discovery feel)
2. Four fake peers appearing: Alice's Laptop, Bob's Desktop, Carol's Phone, Dave's Tablet
3. Clicking "Connect" on a mock peer: 2-second delay, then status changes to connected

### Mock transfer engine (`mockTransfers.ts`)

`useMockTransferEngine` simulates:
1. A hashing phase (800–2500ms per file) with progress events
2. A transfer phase (10–100 seconds depending on file size) with speed and progress updates
3. 5–10 concurrent transfers running simultaneously
4. 75% folder transfers, 25% single-file transfers (to test the grouping UI)
5. Random file names, sizes, and peer names

This lets the entire transfer UI — progress bars, speed display, grouping, status badges — be developed and tested without any real networking.

---

## 11. IPC Pattern Summary

```
Frontend                           Rust Backend
────────                           ────────────

// Calling Rust from frontend:
invoke('command_name', { arg })  →  #[tauri::command]
                                    pub async fn command_name(arg: Type) -> Result<T, String>

// Rust pushing events to frontend:
                           ←  app_handle.emit("eventName", &data)
await listen('eventName', (event) => {
    // event.payload is the data
})
```

Every Rust command must be registered in `generate_handler![]` in `lib.rs`. Every event emitted from Rust must be listened to in the frontend — Tauri does not buffer events, so the listener must be set up before the event fires.

The IPC layer automatically handles JSON serialization in both directions. Rust structs with `#[derive(Serialize)]` become JavaScript objects. JavaScript objects become Rust structs with `#[derive(Deserialize)]`. Field names are mapped using `#[serde(rename_all = "camelCase")]` so Rust's `snake_case` matches TypeScript's `camelCase`.
