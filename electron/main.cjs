// Plexus — Network Site Planner — Electron main process.
// Wraps the same self-contained web build (dist/index.html, produced by
// `npm run package:web`) in a desktop window. The renderer is the unmodified
// app; this process only owns the window lifecycle and routes external links
// to the system browser.
//
// CommonJS (.cjs) so it runs regardless of the package's "type":"module".

const { app, BrowserWindow, shell, Menu, ipcMain } = require('electron');
const path = require('node:path');
const { pinnedRequest, peekFingerprint } = require('./pinnedFetch.cjs');
const { pinKey, loadPins, savePins, decide } = require('./unifiPin.cjs');
const { execFile, spawn } = require('node:child_process');

// Self-update from GitHub Releases (electron-updater reads the publish config
// baked into app-update.yml). Guarded so a failure can never crash the app.
function setupAutoUpdate() {
  if (!app.isPackaged) return;            // dev runs have no update feed
  // macOS Squirrel requires a code-signed app to apply updates; ours is
  // unsigned, so skip there until signing is set up (Win/Linux work unsigned).
  if (process.platform === 'darwin') return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('error', () => {});    // network/feed errors are non-fatal
    autoUpdater.checkForUpdatesAndNotify();
  } catch { /* updater unavailable — ignore */ }
}

// The built, inlined single-file app lives at <appRoot>/dist/index.html both in
// development (repo root) and when packaged (electron-builder keeps the dist/
// tree alongside electron/).
const INDEX = path.join(__dirname, '..', 'dist', 'index.html');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0e0e0e',
    title: 'Plexus',
    show: false,
    // Explicit window icon on every platform. On Windows the taskbar/title-bar
    // icon comes from here (and from the AppUserModelID set below) — without it
    // the running window falls back to the generic Electron logo even though
    // the packaged .exe has the icon embedded.
    icon: path.join(
      __dirname, 'resources',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png',
    ),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Avoid a white flash: reveal only once the first paint is ready.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(INDEX);

  // http(s) links (e.g. "Open management UI", external docs) go to the user's
  // real browser. The only child windows the app opens itself are the blank
  // popups the PDF/print export writes into; every other scheme (file:, data:,
  // javascript:, custom protocols) is denied — a child window inherits the
  // preload bridge, so it must never load arbitrary content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    if (url === '' || url === 'about:blank') return { action: 'allow' };
    return { action: 'deny' };
  });

  // Harden against navigating the app frame away from the bundled file://
  // app (e.g. a stray link or injected redirect). The app is a single page —
  // it should never navigate. External http(s) targets open in the browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// A minimal app menu: keep the standard edit/view/window roles (copy-paste,
// zoom, reload, fullscreen, devtools) without app-specific clutter.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── UniFi controller bridge ────────────────────────────────────────────────
// All controller traffic runs here (not in the renderer) so self-signed
// certificates — the norm on UDM/Cloud Key controllers — can be accepted
// without weakening the app's web security. They are accepted by pin, not
// blindly: the first certificate a controller presents has to be approved by
// the user (trust on first use) and every later call must present the same one.
// Credentials are passed per call and never persisted by the main process.

function unifiFetch(base, pathName, { method = 'GET', body, headers = {}, fp = null } = {}) {
  let u;
  try { u = new URL(pathName, base); } catch (e) { return Promise.reject(new Error('Bad controller URL')); }
  const data = body ? JSON.stringify(body) : null;
  // https is pinned to the fingerprint the user trusted for this controller
  // (see unifiTrust below); the request is only written after it matches.
  return pinnedRequest(u, { method, body: data, expectedFp: fp, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Resolve the certificate fingerprint to pin this call to, or an answer for
// the renderer when the user has to decide first. First contact and a changed
// certificate both need an explicit approval of the exact fingerprint shown.
async function unifiTrust(url, approved) {
  let u;
  try { u = new URL(url); } catch { throw new Error('Bad controller URL'); }
  if (u.protocol === 'http:') return { fp: null };       // plaintext: nothing to pin
  if (u.protocol !== 'https:') throw new Error('Bad controller URL');
  const file = path.join(app.getPath('userData'), 'controller-pins.json');
  const pins = loadPins(file);
  const key = pinKey(u);
  const seen = await peekFingerprint(u);
  const d = decide(pins, key, seen, approved);
  if (d.action === 'use') return { fp: seen };
  if (d.action === 'store') { pins[key] = seen; savePins(file, pins); return { fp: seen }; }
  return { ask: { ok: false, needsTrust: true, changed: d.action === 'ask-changed', host: key, fingerprint: seen, pinned: d.pinned || '',
    error: d.action === 'ask-changed' ? 'Controller certificate changed — not connecting' : 'Controller certificate is not trusted yet' } };
}

// Login handles both flavours: UniFi OS consoles (UDM/UDR/CK Gen2 —
// /api/auth/login, APIs proxied under /proxy/network) and the legacy
// software controller (/api/login, APIs at the root).
async function unifiLogin(base, username, password, fp) {
  const capture = (res) => ({
    cookie: (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; '),
    csrf: res.headers['x-csrf-token'] || '',
  });
  let res = await unifiFetch(base, '/api/auth/login', { method: 'POST', body: { username, password }, fp });
  if (res.status === 200) return { ...capture(res), unifiOs: true, fp };
  res = await unifiFetch(base, '/api/login', { method: 'POST', body: { username, password }, fp });
  if (res.status === 200) return { ...capture(res), unifiOs: false, fp };
  throw new Error(res.status === 400 || res.status === 401
    ? 'UniFi login rejected — check username/password'
    : `UniFi login failed (HTTP ${res.status})`);
}
// The site name comes from the project file: encode it so it stays one path
// segment and can't steer the authenticated request to another API path.
const unifiSitePath = (session, site, p) => {
  const s = encodeURIComponent(String(site || 'default'));
  return session.unifiOs ? `/proxy/network/api/s/${s}${p}` : `/api/s/${s}${p}`;
};

async function unifiListDevices(base, session, site) {
  const res = await unifiFetch(base, unifiSitePath(session, site, '/stat/device'), {
    headers: { Cookie: session.cookie },
    fp: session.fp,
  });
  if (res.status !== 200) throw new Error(`Device list failed (HTTP ${res.status})`);
  const parsed = JSON.parse(res.text);
  return Array.isArray(parsed.data) ? parsed.data : [];
}

ipcMain.handle('unifi:pull', async (_e, cfg) => {
  try {
    const { url, site = 'default', user, pass, trust } = cfg || {};
    if (!url || !user) throw new Error('Controller URL and username are required');
    const t = await unifiTrust(url, trust);
    if (t.ask) return t.ask;
    const session = await unifiLogin(url, user, pass || '', t.fp);
    const raw = await unifiListDevices(url, session, site);
    // Ship only the fields the renderer needs — not the whole device blob.
    const devices = raw.map((d) => ({
      name: d.name || d.hostname || '',
      model: d.model || '',
      mac: d.mac || '',
      ip: d.ip || '',
      version: d.version || '',
      serial: d.serial || '',
      type: d.type || '',            // 'uap' | 'usw' | 'ugw' | …
      state: d.state,                // 1 = connected
    }));
    return { ok: true, devices };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Push a channel/width/tx plan to matching APs. Matching is by MAC first,
// then case-insensitive name. Only radio_table fields we own are touched.
ipcMain.handle('unifi:push', async (_e, cfg) => {
  try {
    const { url, site = 'default', user, pass, changes, trust } = cfg || {};
    if (!url || !user) throw new Error('Controller URL and username are required');
    if (!Array.isArray(changes) || !changes.length) throw new Error('No channel plan to push');
    const t = await unifiTrust(url, trust);
    if (t.ask) return t.ask;
    const session = await unifiLogin(url, user, pass || '', t.fp);
    const devices = await unifiListDevices(url, session, site);
    const norm = (m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    const bandRadio = { '2.4': 'ng', '5': 'na', '6': '6e' };
    const results = [];
    for (const ch of changes) {
      const dev = devices.find((d) => norm(d.mac) === norm(ch.mac) && norm(ch.mac))
        || devices.find((d) => (d.name || '').toLowerCase() === (ch.name || '').toLowerCase() && ch.name);
      if (!dev) { results.push({ name: ch.name, ok: false, error: 'no matching device on controller' }); continue; }
      if (!Array.isArray(dev.radio_table)) { results.push({ name: ch.name, ok: false, error: 'device has no radios' }); continue; }
      // Fail the AP rather than guess: an unknown band must not retune the 5 GHz
      // radio, and a missing radio must not be reported as a successful push.
      const radioName = bandRadio[String(ch.band)];
      if (!radioName) { results.push({ name: ch.name, ok: false, error: `unknown band "${ch.band}"` }); continue; }
      if (!dev.radio_table.some((r) => r.radio === radioName)) { results.push({ name: ch.name, ok: false, error: `device has no ${ch.band} GHz radio` }); continue; }
      const radio_table = dev.radio_table.map((r) => {
        if (r.radio !== radioName) return r;
        const upd = { ...r, channel: ch.channel };
        if (ch.width) upd.ht = String(ch.width);
        if (Number.isFinite(ch.txPowerDbm)) { upd.tx_power_mode = 'custom'; upd.tx_power = String(ch.txPowerDbm); }
        return upd;
      });
      const res = await unifiFetch(url, unifiSitePath(session, site, `/rest/device/${dev._id || dev.device_id || ''}`), {
        method: 'PUT',
        body: { radio_table },
        headers: { Cookie: session.cookie, ...(session.csrf ? { 'x-csrf-token': session.csrf } : {}) },
        fp: session.fp,
      });
      results.push({ name: ch.name, ok: res.status === 200, error: res.status === 200 ? '' : `HTTP ${res.status}` });
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ── Live WiFi sampling (click-to-survey) ───────────────────────────────────
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 15000, ...opts }, (err, stdout) => {
    if (err) reject(err); else resolve(String(stdout));
  });
});

async function wifiSampleMac() {
  // `airport` is gone on modern macOS; system_profiler still reports the
  // current connection (slow — a couple of seconds — but survey clicks are
  // occasional and the renderer shows a "sampling…" toast meanwhile).
  const out = await run('system_profiler', ['SPAirPortDataType', '-json']);
  const json = JSON.parse(out);
  const ifaces = (((json.SPAirPortDataType || [])[0] || {}).spairport_airport_interfaces) || [];
  for (const inf of ifaces) {
    const cur = inf.spairport_current_network_information;
    if (!cur) continue;
    const sn = String(cur.spairport_signal_noise || '');
    const m = /(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/.exec(sn);
    if (!m) continue;
    const chM = /(\d+)/.exec(String(cur.spairport_network_channel || ''));
    return {
      ok: true,
      rssi: parseInt(m[1], 10),
      noise: parseInt(m[2], 10),
      ssid: cur._name || '',
      bssid: '',                    // macOS redacts BSSID without location permission
      channel: chM ? parseInt(chM[1], 10) : null,
    };
  }
  throw new Error('Not connected to WiFi');
}

async function wifiSampleWin() {
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  const pick = (re) => { const m = re.exec(out); return m ? m[1].trim() : ''; };
  const pct = parseInt(pick(/Signal\s*:\s*(\d+)%/i), 10);
  if (!Number.isFinite(pct)) throw new Error('Not connected to WiFi');
  return {
    ok: true,
    rssi: Math.round(pct / 2 - 100),  // netsh reports quality %, ≈ (rssi+100)*2
    noise: null,
    ssid: pick(/^\s*SSID\s*:\s*(.+)$/im),
    bssid: pick(/BSSID\s*:\s*([0-9a-f:]+)/i),
    channel: parseInt(pick(/Channel\s*:\s*(\d+)/i), 10) || null,
  };
}

async function wifiSampleLinux() {
  const dev = (await run('sh', ['-c', "iw dev | awk '/Interface/{print $2; exit}'"])).trim();
  if (!dev) throw new Error('No wireless interface found');
  const out = await run('iw', ['dev', dev, 'link']);
  const m = /signal:\s*(-?\d+)\s*dBm/.exec(out);
  if (!m) throw new Error('Not connected to WiFi');
  const ssid = (/SSID:\s*(.+)/.exec(out) || [])[1] || '';
  const bssid = (/Connected to\s+([0-9a-f:]+)/i.exec(out) || [])[1] || '';
  const freq = parseInt((/freq:\s*(\d+)/.exec(out) || [])[1], 10);
  // Frequency → channel (2.4/5/6 GHz).
  let channel = null;
  if (Number.isFinite(freq)) {
    if (freq >= 2412 && freq <= 2484) channel = freq === 2484 ? 14 : Math.round((freq - 2407) / 5);
    else if (freq >= 5955) channel = Math.round((freq - 5950) / 5);
    else if (freq >= 5000) channel = Math.round((freq - 5000) / 5);
  }
  return { ok: true, rssi: parseInt(m[1], 10), noise: null, ssid: ssid.trim(), bssid, channel };
}

ipcMain.handle('survey:sample', async () => {
  try {
    if (process.platform === 'darwin') return await wifiSampleMac();
    if (process.platform === 'win32') return await wifiSampleWin();
    return await wifiSampleLinux();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ── Open a real terminal running `ssh` to a device (right-click → Connect) ───
// A BOUNDED capability, deliberately not an arbitrary-command bridge:
// the renderer sends only structured fields and the main process rebuilds the
// argv here after strict validation, because a loaded project file is untrusted
// input — a malicious host/user/key from a shared .plexus file must never reach
// a shell. Fail closed on anything that isn't a clean hostname/IP, user, port
// or key path. No password is ever accepted (key- or agent-auth only). The
// validator lives in its own pure module so it can be unit-tested headless.
const { buildSshArgv, buildSshPullArgv } = require('./sshArgv.cjs');

// Single-quote a token for /bin/sh. The validators above already forbid single
// quotes, so this only has to wrap — the escape is defence in depth.
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Start a terminal emulator detached from Plexus. Resolves true once the process
// has spawned and false when the binary is missing. It must never wait for exit
// or carry a timeout: most emulators stay in the foreground for as long as the
// SSH session lives, so a timeout would kill the user's session.
function launchDetached(bin, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { detached: true, stdio: 'ignore' }); } catch { return resolve(false); }
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

function openSshTerminal(t) {
  const built = buildSshArgv(t);
  if (!built.ok) return Promise.resolve(built);
  return new Promise((resolve) => {
    const ok = () => resolve({ ok: true });
    const fail = (err) => resolve({ ok: false, error: String((err && err.message) || err) });

    if (process.platform === 'darwin') {
      // macOS: Terminal.app via AppleScript. The shell command is single-quoted
      // + charset-validated; only \ and " need escaping for the AppleScript literal.
      const cmd = built.argv.map(shQuote).join(' ');
      const script = `tell application "Terminal"\nactivate\ndo script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
      execFile('osascript', ['-e', script], { timeout: 10000 }, (err) => (err ? fail(err) : ok()));

    } else if (process.platform === 'linux') {
      // Linux: try the common terminal emulators in order; keep the window open
      // after ssh exits by dropping into an interactive shell. The ssh command is
      // single-quoted + charset-validated before it reaches bash -lc.
      const cmd = built.argv.map(shQuote).join(' ');
      const line = `${cmd}; exec "${process.env.SHELL || '/bin/bash'}"`;
      const tries = [
        ['x-terminal-emulator', ['-e', 'bash', '-lc', line]],
        ['gnome-terminal', ['--', 'bash', '-lc', line]],
        ['konsole', ['-e', 'bash', '-lc', line]],
        ['xterm', ['-e', 'bash', '-lc', line]],
      ];
      (async () => {
        for (const [bin, args] of tries) {
          if (await launchDetached(bin, args)) return ok();
        }
        resolve({ ok: false, error: 'No supported terminal emulator found (install gnome-terminal, konsole or xterm)' });
      })();

    } else if (process.platform === 'win32') {
      // Windows: open a new console window running ssh (OpenSSH client ships with
      // Windows 10+). Tokens are charset-validated (no cmd metacharacters), so they
      // pass straight through; `cmd /k` keeps the window open after ssh exits.
      execFile('cmd', ['/c', 'start', '', 'cmd', '/k', ...built.argv], { timeout: 10000 }, (err) => {
        if (!err) return ok();
        execFile('wt', ['new-tab', ...built.argv], { timeout: 10000 }, (err2) => (err2 ? fail(err2) : ok()));
      });

    } else {
      resolve({ ok: false, error: `Opening a terminal is not supported on ${process.platform}` });
    }
  });
}

ipcMain.handle('ssh:open-terminal', async (_e, t = {}) => openSshTerminal(t));

// Read-only config pull for the drift check: runs ssh non-interactively with a
// fixed, vendor-specific dump command (see buildSshPullArgv) and returns its
// output. No shell is involved (execFile), no password is accepted, and an
// unknown host key is refused rather than trusted.
ipcMain.handle('ssh:pull-config', async (_e, t = {}) => {
  const built = buildSshPullArgv(t);
  if (!built.ok) return built;
  return new Promise((resolve) => {
    execFile(built.argv[0], built.argv.slice(1), { timeout: 25000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, text: String(stdout) });
      const msg = String(stderr || err.message || '');
      let error = 'Could not read the device configuration';
      if (/Host key verification failed|No .* host key is known/i.test(msg)) error = 'This device\'s SSH host key is not known yet — connect to it once with "Connect via SSH" and accept the key, then try again';
      else if (/Permission denied/i.test(msg)) error = 'SSH login was refused — the pull uses key or agent authentication only (set an SSH key in the device\'s Credentials)';
      else if (/timed out|Connection refused|No route to host|Could not resolve/i.test(msg)) error = 'The device is not reachable over SSH from this computer';
      else if (err.code === 'ENOENT') error = 'No ssh client found on this computer';
      resolve({ ok: false, error });
    });
  });
});

// Windows groups taskbar buttons and resolves the running app's icon by its
// AppUserModelID. It must match the appId electron-builder bakes into the
// installed shortcut (com.plexus.networkplanner); otherwise Windows can't tie
// the live window to the shortcut and shows the generic Electron icon instead
// of (and breaks pinning for) the Plexus logo.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.plexus.networkplanner');
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
