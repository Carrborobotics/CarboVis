// CarboVis desktop app (Electron main process).
// Window + match view placement, the log library folder, driver station recording, auto-update from GitHub
// Releases, and sharing the library with phones/laptops on the same network.
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, screen } = require('electron');
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), http = require('http'), dgram = require('dgram'), crypto = require('crypto');

const WEB = path.join(__dirname, 'web');
if (process.env.CARBOVIS_USER_DATA) app.setPath('userData', process.env.CARBOVIS_USER_DATA); // tests and a second dev copy
const LAN_PORT = 5807, UDP_PORT = 5808;
let win = null;

// ---------------- settings (userData/settings.json) ----------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
  settings.libDir = settings.libDir || path.join(app.getPath('documents'), 'CarboVis Logs');
  settings.deviceId = settings.deviceId || crypto.randomUUID();
  settings.device = settings.device || os.hostname();
  settings.secrets = settings.secrets || {};
  fs.mkdirSync(settings.libDir, { recursive: true });
}
function saveSettings() { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 1)); }

// ---------------- library folder ----------------
// Each log is a plain .wpilog in the folder. Summaries and upload state live in one sidecar file.
const metaFile = () => path.join(settings.libDir, '.carbovis-library.json');
let meta = null;
function loadMeta() { try { meta = JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch { meta = {}; } return meta; }
function saveMeta() { fs.writeFileSync(metaFile(), JSON.stringify(meta)); }
function safeName(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || !/\.wpilog$/i.test(name) || name.startsWith('.')) throw new Error(`Bad log name: ${name}`);
  return path.join(settings.libDir, name);
}
function uniqueName(name) {
  let n = name, k = 1;
  while (fs.existsSync(path.join(settings.libDir, n))) n = name.replace(/\.wpilog$/i, `-${k++}.wpilog`);
  return n;
}
async function listLogs() {
  if (!meta) loadMeta();
  const out = [];
  for (const name of await fsp.readdir(settings.libDir)) {
    if (!/\.wpilog$/i.test(name)) continue;
    try { const s = await fsp.stat(path.join(settings.libDir, name)); out.push({ name, size: s.size, mtime: s.mtime.toISOString(), meta: meta[name] || {} }); } catch { /* removed meanwhile */ }
  }
  return out;
}
// Copy a .wpilog from elsewhere into the library (file association, Import). Same name and size = already there.
function adoptFile(file) {
  const base = path.basename(file);
  if (path.dirname(path.resolve(file)) === path.resolve(settings.libDir)) return base;
  const dest = path.join(settings.libDir, base);
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(file).size) return base;
  const name = uniqueName(base);
  fs.copyFileSync(file, path.join(settings.libDir, name));
  return name;
}
// Recordings that were still open when the app or laptop stopped: keep what was written.
function recoverRecordings() {
  for (const f of fs.readdirSync(settings.libDir)) {
    if (!f.endsWith('.wpilog.part')) continue;
    const p = path.join(settings.libDir, f);
    if (fs.statSync(p).size < 4096) { fs.unlinkSync(p); continue; }
    fs.renameSync(p, path.join(settings.libDir, uniqueName(f.slice(0, -5))));
  }
}

ipcMain.handle('lib:list', () => listLogs());
ipcMain.handle('lib:read', (_e, name) => fsp.readFile(safeName(name)));
ipcMain.handle('lib:write', async (_e, name, bytes) => { await fsp.writeFile(safeName(name), Buffer.from(bytes)); return name; });
ipcMain.handle('lib:remove', async (_e, name) => { await fsp.unlink(safeName(name)); loadMeta(); delete meta[name]; saveMeta(); });
ipcMain.handle('lib:meta', (_e, name, patch) => { safeName(name); loadMeta(); meta[name] = { ...(meta[name] || {}), ...patch }; saveMeta(); return meta[name]; });
ipcMain.handle('lib:reveal', () => shell.openPath(settings.libDir));
ipcMain.handle('lib:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import robot logs', properties: ['openFile', 'multiSelections'], filters: [{ name: 'WPILib logs', extensions: ['wpilog'] }] });
  return r.canceled ? [] : r.filePaths.map(adoptFile);
});
ipcMain.handle('lib:chooseDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Folder for match logs', defaultPath: settings.libDir, properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  settings.libDir = r.filePaths[0]; saveSettings(); meta = null; recoverRecordings();
  return settings.libDir;
});

// ---------------- recording ----------------
// The page encodes .wpilog bytes as values arrive and sends them here about once a second. Writes are
// synchronous so chunks land in order; the file is "<name>.wpilog.part" until the recording ends.
const recs = new Map();
ipcMain.handle('rec:begin', () => {
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}_${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}`;
  const tok = crypto.randomUUID();
  const file = path.join(settings.libDir, `FRC_${stamp}_DS.wpilog.part`);
  recs.set(tok, { file, fd: fs.openSync(file, 'a') });
  return tok;
});
ipcMain.handle('rec:append', (_e, tok, bytes) => { const r = recs.get(tok); if (r) fs.writeSync(r.fd, Buffer.from(bytes)); });
ipcMain.handle('rec:end', (_e, tok, name) => {
  const r = recs.get(tok); if (!r) return null;
  recs.delete(tok); fs.closeSync(r.fd);
  if (!name) { fs.unlinkSync(r.file); return null; }
  safeName(name);
  const final = uniqueName(name);
  fs.renameSync(r.file, path.join(settings.libDir, final));
  return final;
});

// ---------------- secrets (GitHub token), encrypted with the Windows user's key ----------------
ipcMain.handle('secret:get', (_e, key) => {
  const v = settings.secrets[key]; if (!v) return '';
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : ''; } catch { return ''; }
});
ipcMain.handle('secret:set', (_e, key, value) => {
  if (!value) delete settings.secrets[key];
  else if (safeStorage.isEncryptionAvailable()) settings.secrets[key] = safeStorage.encryptString(value).toString('base64');
  saveSettings();
});

// ---------------- sharing on the local network ----------------
// "Share on this network" serves the web version and this computer's logs (read-only) on port 5807, and
// announces itself over UDP so other CarboVis computers list it under Nearby. Every copy listens for announcements.
let server = null, lanError = '', udp = null, beacon = null;
const peers = new Map();
function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${LAN_PORT}/`);
  return urls;
}
function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
    out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
  }
  return [...out];
}
const lanStatus = () => ({ enabled: !!server, urls: server ? lanUrls() : [], error: lanError });
function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(data); });
}
const TYPES = { '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (p === '/' || p === '/index.html') {
    fs.readFile(path.join(WEB, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); res.end(); return; }
      const inject = `<script>window.CARBOVIS_LAN = ${JSON.stringify({ device: settings.device })};</script>\n`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html.replace('<script>', inject + '<script>'));
    });
  } else if (p === '/api/logs') {
    listLogs().then(list => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ device: settings.device, logs: list.map(f => ({ name: f.name, size: f.size, mtime: f.mtime, summary: f.meta.summary || null })) }));
    });
  } else if (p.startsWith('/api/logs/')) {
    let file; try { file = safeName(p.slice('/api/logs/'.length)); } catch { res.writeHead(400); res.end(); return; }
    fs.stat(file, (err, s) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': s.size });
      fs.createReadStream(file).pipe(res);
    });
  } else if (/^\/[\w.-]+\.(png|webmanifest)$/.test(p)) serveFile(res, path.join(WEB, p.slice(1)), TYPES[path.extname(p)]);
  else { res.writeHead(404); res.end(); }
}
function setLan(on) {
  settings.lanShare = !!on; saveSettings(); lanError = '';
  if (!on) {
    if (server) server.close(); server = null;
    clearInterval(beacon); beacon = null;
    return Promise.resolve(lanStatus());
  }
  if (server) return Promise.resolve(lanStatus());
  return new Promise(resolve => {
    const s = http.createServer(handle);
    s.once('error', err => { lanError = err.code === 'EADDRINUSE' ? `Port ${LAN_PORT} is already in use on this computer.` : err.message; server = null; resolve(lanStatus()); });
    s.listen(LAN_PORT, '0.0.0.0', () => { server = s; beacon = setInterval(announce, 3000); announce(); resolve(lanStatus()); });
  });
}
async function announce() {
  if (!udp || !server) return;
  const msg = Buffer.from(JSON.stringify({ app: 'carbovis', v: 1, id: settings.deviceId, device: settings.device, port: LAN_PORT, count: (await listLogs()).length }));
  for (const addr of broadcastAddrs()) udp.send(msg, UDP_PORT, addr, () => { /* unreachable interface: fine */ });
}
function startDiscovery() {
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', err => { console.warn('discovery', err.message); try { udp.close(); } catch { /* closed */ } udp = null; });
  udp.on('message', (buf, rinfo) => {
    let m; try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.app !== 'carbovis' || m.id === settings.deviceId) return;
    const fresh = !peers.has(m.id);
    peers.set(m.id, { id: m.id, device: String(m.device || rinfo.address), url: `http://${rinfo.address}:${Number(m.port) || LAN_PORT}`, count: m.count, seen: Date.now() });
    if (fresh) send('peers');
  });
  udp.bind(UDP_PORT, () => { try { udp.setBroadcast(true); } catch { /* no broadcast */ } });
  setInterval(() => { let gone = false; for (const [id, p] of peers) if (Date.now() - p.seen > 10000) { peers.delete(id); gone = true; } if (gone) send('peers'); }, 3000);
}
ipcMain.handle('lan:status', () => lanStatus());
ipcMain.handle('lan:set', (_e, on) => setLan(on));
ipcMain.handle('lan:peers', () => [...peers.values()]);
ipcMain.handle('qr', (_e, text) => require('qrcode').toDataURL(String(text), { margin: 1, width: 264 }));

// ---------------- updates (GitHub Releases) ----------------
// Downloads in the background and installs when the app closes, so it can never restart mid-match.
let update = null;
function setUpdate(u) { update = u; send('update', u); }
function setupUpdates() {
  if (!app.isPackaged) {
    update = { state: 'dev' };
    ipcMain.handle('update:check', () => setUpdate({ state: 'dev' }));
    ipcMain.handle('update:install', () => { /* nothing to install in a dev build */ });
    return;
  }
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => { if (!update || update.state !== 'ready') setUpdate({ state: 'checking' }); });
  autoUpdater.on('update-available', i => setUpdate({ state: 'downloading', version: i.version }));
  autoUpdater.on('download-progress', p => setUpdate({ state: 'downloading', version: update && update.version, percent: p.percent }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }));
  autoUpdater.on('update-downloaded', i => setUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('error', err => { if (!update || update.state !== 'ready') setUpdate({ state: 'error', message: String(err && err.message || err).split('\n')[0] }); });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ });
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
  setTimeout(check, 5000);
  setInterval(check, 4 * 3600e3);
}

// ---------------- window ----------------
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }
const wantsMatchView = argv => argv.includes('--matchview');
const fileArg = argv => argv.slice(1).find(a => /\.wpilog$/i.test(a) && fs.existsSync(a));
function aboveDS(dsHeight) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x, y: wa.y, width: wa.width, height: Math.max(400, wa.height - (dsHeight || settings.dsHeight || 230)) };
}
ipcMain.handle('win:fit', (_e, dsHeight) => {
  if (!win) return;
  settings.dsHeight = Number(dsHeight) || 230; saveSettings();
  if (win.isMaximized()) win.unmaximize();
  win.setBounds(aboveDS(settings.dsHeight));
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), device: settings.device, libDir: settings.libDir, update }));

function openArgs(argv) {
  const file = fileArg(argv);
  if (file) { try { send('open-log', adoptFile(file)); } catch (err) { dialog.showErrorBox('CarboVis', `Couldn't open ${file}: ${err.message}`); } }
  if (wantsMatchView(argv)) send('open-matchview');
}
function createWindow() {
  const mv = wantsMatchView(process.argv);
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(1440, wa.width), height: Math.min(900, wa.height), ...(mv ? aboveDS() : {}),
    minWidth: 360, minHeight: 400, title: 'CarboVis', icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true, backgroundColor: '#eef0ee', show: false,
    // keep recording and the NT connection at full speed when the window is behind the Driver Station
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(WEB, 'index.html'), mv ? { hash: 'matchview' } : undefined);
  win.once('ready-to-show', () => win.show());
  win.webContents.once('did-finish-load', () => { const f = fileArg(process.argv); if (f) openArgs([process.argv[0], f]); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    openArgs(argv);
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('org.carrborobotics.carbovis');
    loadSettings(); saveSettings(); recoverRecordings();
    createWindow();
    startDiscovery();
    if (settings.lanShare) setLan(true);
    setupUpdates();
    if (process.platform === 'win32' && app.isPackaged) app.setUserTasks([{ program: process.execPath, arguments: '--matchview', iconPath: process.execPath, iconIndex: 0, title: 'Match view', description: 'Live match view above the Driver Station' }]);
  });
  app.on('window-all-closed', () => app.quit());
}
