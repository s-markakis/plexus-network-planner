// Plexus — Electron preload. Exposes a minimal, promise-based native bridge
// to the renderer (contextIsolation stays on; no Node APIs leak through).
// The web build simply never sees window.plexusNative, and the renderer
// feature-detects it before showing any desktop-only UI.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plexusNative', {
  // UniFi controller sync (network access happens in the main process so we
  // can talk to self-signed controllers without loosening the renderer).
  unifiPull: (cfg) => ipcRenderer.invoke('unifi:pull', cfg),
  unifiPush: (cfg) => ipcRenderer.invoke('unifi:push', cfg),
  // One-shot WiFi RSSI sample of the machine's current connection, for the
  // live click-to-survey mode.
  wifiSample: () => ipcRenderer.invoke('survey:sample'),
  // Right-click → Connect via SSH: pop the OS terminal running `ssh` to a
  // device. Structured fields only ({host,user,port,key}); the main process
  // validates and rebuilds the argv (never a raw command string from here).
  openSshTerminal: (target) => ipcRenderer.invoke('ssh:open-terminal', target),
});
