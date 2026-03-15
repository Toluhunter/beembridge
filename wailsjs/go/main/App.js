// Stub implementations — no Wails runtime present in Tauri context

export function ConnectToPeer(_arg1) {
    return Promise.resolve();
}

export function DisconnectFromPeer(_arg1) {
    return Promise.resolve();
}

export function GetConnectedPeers() {
    return Promise.resolve([]);
}

export function GetDiscoveredPeers() {
    return Promise.resolve([]);
}

export function GetFileStats(_arg1) {
    return Promise.resolve([]);
}

export function InitiateFileTransfer(_arg1, _arg2) {
    return Promise.resolve();
}

export function OpenDirectoryDialog() {
    return Promise.resolve('');
}

export function OpenFileDialog() {
    return Promise.resolve([]);
}

export function RespondToPeerConnectionRequest(_arg1, _arg2) {
    return Promise.resolve();
}

export function StartPeerDiscovery() {
    return Promise.resolve();
}

export function StopPeerDiscovery() {
    return Promise.resolve();
}
