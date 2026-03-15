// Stub Wails runtime — no-op implementations for Tauri context

export function EventsOn(_eventName, _callback) {
    // Returns an unsubscribe function matching the real API signature
    return () => {};
}

export function EventsOnMultiple(_eventName, _callback, _maxCallbacks) {
    return () => {};
}

export function EventsOnce(_eventName, _callback) {
    return () => {};
}

export function EventsOff(_eventName, ..._additionalEventNames) {}

export function EventsOffAll() {}

export function EventsEmit(_eventName, ..._data) {}

export function LogPrint(_message) {}
export function LogTrace(_message) {}
export function LogDebug(_message) {}
export function LogInfo(_message) {}
export function LogWarning(_message) {}
export function LogError(_message) {}
export function LogFatal(_message) {}

export function WindowReload() {}
export function WindowReloadApp() {}
export function WindowSetAlwaysOnTop(_b) {}
export function WindowSetSystemDefaultTheme() {}
export function WindowSetLightTheme() {}
export function WindowSetDarkTheme() {}
export function WindowCenter() {}
export function WindowSetTitle(_title) {}
export function WindowFullscreen() {}
export function WindowUnfullscreen() {}
export function WindowIsFullscreen() { return Promise.resolve(false); }
export function WindowGetSize() { return Promise.resolve({ w: 0, h: 0 }); }
export function WindowSetSize(_width, _height) {}
export function WindowSetMaxSize(_width, _height) {}
export function WindowSetMinSize(_width, _height) {}
export function WindowSetPosition(_x, _y) {}
export function WindowGetPosition() { return Promise.resolve({ x: 0, y: 0 }); }
export function WindowHide() {}
export function WindowShow() {}
export function WindowMaximise() {}
export function WindowToggleMaximise() {}
export function WindowUnmaximise() {}
export function WindowIsMaximised() { return Promise.resolve(false); }
export function WindowMinimise() {}
export function WindowUnminimise() {}
export function WindowIsMinimised() { return Promise.resolve(false); }
export function WindowIsNormal() { return Promise.resolve(true); }
export function WindowSetBackgroundColour(_R, _G, _B, _A) {}
export function ScreenGetAll() { return Promise.resolve([]); }
export function BrowserOpenURL(_url) {}
export function Environment() { return Promise.resolve({ buildType: 'dev', platform: 'linux', arch: 'amd64' }); }
export function Quit() {}
export function Hide() {}
export function Show() {}
export function ClipboardGetText() { return Promise.resolve(''); }
export function ClipboardSetText(_text) { return Promise.resolve(true); }
export function OnFileDrop(_callback, _useDropTarget) {}
export function OnFileDropOff() {}
export function CanResolveFilePaths() { return false; }
export function ResolveFilePaths(_files) {}
