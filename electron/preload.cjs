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
  // Drift check: read a device's configuration (read-only, fixed command per
  // vendor chosen in the main process — the renderer cannot supply a command).
  sshPullConfig: (target) => ipcRenderer.invoke('ssh:pull-config', target),
  // Plan → device: write the generated script and open a terminal running
  // `rosconf apply … -f <file>` as a DRY RUN. The main process never adds
  // --apply; pushing to the device is the user's own step in that terminal.
  deployRosconf: (a) => ipcRenderer.invoke('deploy:rosconf', a),
  locateRosconf: () => ipcRenderer.invoke('deploy:locate-rosconf'),
  // Project files. The renderer never supplies a path to read; it may only
  // write back to a path the main process handed it after a native dialog
  // (enforced there — see projectFiles.cjs).
  projectOpen: () => ipcRenderer.invoke('project:open'),
  projectOpenRecent: (p) => ipcRenderer.invoke('project:open-recent', p),
  projectSave: (a) => ipcRenderer.invoke('project:save', a),
  projectSaveAs: (a) => ipcRenderer.invoke('project:save-as', a),
  projectRecents: () => ipcRenderer.invoke('project:recents'),
  // File-menu clicks from the app menu: {action, arg}.
  onMenu: (cb) => { ipcRenderer.on('menu:action', (_e, m) => cb(m)); },
});
