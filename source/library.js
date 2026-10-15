// ===== Library: match logs on this computer, in the team's GitHub repo, and on nearby CarboVis computers =====
// Desktop app: logs live in a folder (Documents\CarboVis Logs). The driver station records live NetworkTables
// data into it, one file per match or run, and uploads each finished log to the team repo when it has internet.
// Phones and other computers read the team repo from the web version (GitHub Pages), or browse a desktop app's
// folder over the local network ("Share on this network").
const Library = (() => {
  const desk = window.carbovis || null; // desktop app bridge (desktop/preload.js)
  const LAN = window.CARBOVIS_LAN || null; // set when a desktop app served this page over the local network
  const ON_CLAUDE = !!window.claude || /claude(usercontent)?\.(ai|com)$/.test(location.hostname);
  const ENABLED = !!desk || !!LAN || (!ON_CLAUDE && /^https?:$/.test(location.protocol));
  const WEB_URL = 'https://carrborobotics.github.io/CarboVis/';
  // Logs live on their own branch of the app's repo, with no history shared with the code, so uploads never
  // touch main (no new commits there, no Pages or release runs).
  const DEFAULT_REPO = 'Carrborobotics/CarboVis', DEFAULT_BRANCH = 'logs';
  const GH = 'https://api.github.com';
  const MAX_UPLOAD = 95e6; // GitHub's blob limit is 100 MB

  let api, h, fmt, toast;
  let lists = Promise.resolve(); // first load of the team / hub lists
  const cfg = { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, autoUpload: true, record: 'enabled' };
  let token = '';
  const st = { open: false, view: 'team', local: null, team: null, teamErr: '', repo: null, peers: [], peerLogs: new Map(), hub: null, filter: '', busy: new Map(), confirm: null, settings: false, info: null, lan: null, update: null, summarizing: false };

  // ---------------- small helpers ----------------
  const toAB = u8 => (u8 instanceof ArrayBuffer ? u8 : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  const mb = n => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const encPath = p => p.split('/').map(encodeURIComponent).join('/');
  async function pipe(buf, stream) { return new Response(new Blob([buf]).stream().pipeThrough(stream)).arrayBuffer(); }
  const gzip = buf => pipe(buf, new CompressionStream('gzip'));
  const gunzip = buf => pipe(buf, new DecompressionStream('gzip'));
  function b64(buf) {
    const u8 = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // FRC_20260411_183207[_NCCMP_Q42][_DS].wpilog -> what the file name says about the match
  function nameInfo(name) {
    const f = name.match(/(?:FRC|WPILib)_(\d{8})_(\d{6})(?:_([A-Za-z0-9]+)_([A-Za-z]*\d+))?/);
    if (!f) return {};
    return { date: `${f[1].slice(0, 4)}-${f[1].slice(4, 6)}-${f[1].slice(6, 8)}`, time: `${f[2].slice(0, 2)}:${f[2].slice(2, 4)}`, stamp: f[1] + f[2], event: f[3] || '', match: f[4] || '' };
  }
  function summarize(buf, name) {
    const log = Core.parseWpilog(toAB(buf), name);
    return Core.summaryDoc(log, Core.analyze(log, api.limits()));
  }

  // ---------------- team library: a GitHub repo holding logs/<name>.gz and index.json ----------------
  // index.json: { version: 1, logs: [{ name, path, size, gzSize, uploadedAt, uploadedBy, summary }] }
  const branchOf = r => cfg.branch || r.default_branch || 'main';
  async function gh(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const body = opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body;
    const r = await fetch(GH + path, { method: opts.method || 'GET', headers, body, cache: 'no-store', signal: opts.method && opts.method !== 'GET' ? undefined : AbortSignal.timeout(15000) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const limited = r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0';
      const msg = limited ? 'GitHub\'s hourly limit for this network was reached. Try again later, or add a token in Settings.'
        : r.status === 401 ? 'GitHub rejected the token. Check it in Settings.'
        : r.status === 404 ? `${cfg.repo} wasn't found. Check the name, or add a token if it's private.`
        : j.message || `GitHub error ${r.status}`;
      throw Object.assign(new Error(msg), { status: r.status, limited });
    }
    return opts.raw ? r : r.status === 204 ? null : r.json();
  }
  const rawAccept = { Accept: 'application/vnd.github.raw+json' };
  async function repoInfo(force) {
    if (st.repo && st.repo.full === cfg.repo && st.repo.branch === branchOf({}) && !force) return st.repo;
    const r = await gh(`/repos/${cfg.repo}`);
    st.repo = { full: cfg.repo, branch: branchOf(r), private: r.private, canWrite: !!(r.permissions && r.permissions.push) };
    return st.repo;
  }
  async function readIndex(ref) {
    try {
      const r = await gh(`/repos/${cfg.repo}/contents/index.json?ref=${encodeURIComponent(ref)}`, { headers: rawAccept, raw: true });
      const j = await r.json();
      return { version: 1, logs: Array.isArray(j.logs) ? j.logs : [] };
    } catch (err) { if (err.status === 404) return { version: 1, logs: [] }; throw err; }
  }
  const rawUrl = (branch, p) => `https://raw.githubusercontent.com/${cfg.repo}/${encodeURIComponent(branch)}/${encPath(p)}`;
  async function teamList() {
    try {
      const repo = await repoInfo();
      return (await readIndex(repo.branch)).logs;
    } catch (err) {
      // out of anonymous API calls on a public repo: the raw CDN still works (may be a few minutes behind)
      if (err.limited && !token) {
        const branch = branchOf({}), r = await fetch(rawUrl(branch, 'index.json'));
        if (r.ok) { st.repo = st.repo || { full: cfg.repo, branch, private: false, canWrite: false }; return (await r.json()).logs || []; }
      }
      throw err;
    }
  }
  async function teamRead(entry) {
    const repo = await repoInfo().catch(() => ({ branch: branchOf({}), private: false }));
    const r = token || repo.private ? await gh(`/repos/${cfg.repo}/contents/${encPath(entry.path)}?ref=${encodeURIComponent(repo.branch)}`, { headers: rawAccept, raw: true })
      : await fetch(rawUrl(repo.branch, entry.path));
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    const buf = await r.arrayBuffer();
    return entry.path.endsWith('.gz') ? gunzip(buf) : buf;
  }
  async function writableRepo() {
    const repo = await repoInfo(true);
    if (!repo.canWrite) throw new Error(token ? `The token can't write to ${cfg.repo}. It needs Contents: Read and write on that repo.` : 'Add a GitHub token in Settings to upload.');
    const start = { message: 'Start the CarboVis log library', empty: '{"version":1,"logs":[]}\n' };
    try { await gh(`/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(repo.branch)}`); return repo; }
    catch (err) {
      if (err.status === 409) { // a brand-new repo with no commits: the Git data API needs one first
        await gh(`/repos/${cfg.repo}/contents/index.json`, { method: 'PUT', body: { message: start.message, content: btoa(start.empty), branch: repo.branch } });
        return repo;
      }
      if (err.status !== 404) throw err;
    }
    // first upload: start the branch with just index.json and no parent, so it shares nothing with the code
    const blob = await gh(`/repos/${cfg.repo}/git/blobs`, { method: 'POST', body: { content: start.empty, encoding: 'utf-8' } });
    const tree = await gh(`/repos/${cfg.repo}/git/trees`, { method: 'POST', body: { tree: [{ path: 'index.json', mode: '100644', type: 'blob', sha: blob.sha }] } });
    const c = await gh(`/repos/${cfg.repo}/git/commits`, { method: 'POST', body: { message: start.message, tree: tree.sha, parents: [] } });
    try { await gh(`/repos/${cfg.repo}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${repo.branch}`, sha: c.sha } }); }
    catch (err) { if (err.status !== 422) throw err; } // another computer created it first
    return repo;
  }
  // One commit that adds/removes files and updates index.json. Retries if someone else committed in between.
  async function teamCommit(message, files, edit) {
    const repo = await writableRepo();
    for (let attempt = 0; ; attempt++) {
      const ref = await gh(`/repos/${cfg.repo}/git/ref/heads/${encodeURIComponent(repo.branch)}`);
      const head = ref.object.sha;
      const commit = await gh(`/repos/${cfg.repo}/git/commits/${head}`);
      const index = await readIndex(head);
      edit(index);
      const idxBlob = await gh(`/repos/${cfg.repo}/git/blobs`, { method: 'POST', body: { content: JSON.stringify(index, null, 1) + '\n', encoding: 'utf-8' } });
      const tree = await gh(`/repos/${cfg.repo}/git/trees`, { method: 'POST', body: { base_tree: commit.tree.sha, tree: [...files, { path: 'index.json', mode: '100644', type: 'blob', sha: idxBlob.sha }] } });
      const c = await gh(`/repos/${cfg.repo}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [head] } });
      try { await gh(`/repos/${cfg.repo}/git/refs/heads/${encodeURIComponent(repo.branch)}`, { method: 'PATCH', body: { sha: c.sha, force: false } }); return; }
      catch (err) { if (attempt >= 3 || (err.status !== 422 && err.status !== 409)) throw err; }
    }
  }
  async function teamUpload(name, buf, summary) {
    const gz = await gzip(buf);
    if (gz.byteLength > MAX_UPLOAD) throw new Error(`${name} is ${mb(gz.byteLength)} compressed, over GitHub's 100 MB limit.`);
    await writableRepo();
    const path = `logs/${name}.gz`;
    const blob = await gh(`/repos/${cfg.repo}/git/blobs`, { method: 'POST', body: { content: b64(gz), encoding: 'base64' } });
    const entry = { name, path, size: buf.byteLength, gzSize: gz.byteLength, uploadedAt: new Date().toISOString(), uploadedBy: (st.info && st.info.device) || 'web', summary: summary || null };
    await teamCommit(`Add ${name}`, [{ path, mode: '100644', type: 'blob', sha: blob.sha }], idx => { idx.logs = idx.logs.filter(l => l.name !== name); idx.logs.push(entry); });
    return entry;
  }
  async function teamDelete(entry) {
    await teamCommit(`Remove ${entry.name}`, [{ path: entry.path, mode: '100644', type: 'blob', sha: null }], idx => { idx.logs = idx.logs.filter(l => l.name !== entry.name); });
  }

  // ---------------- nearby: desktop apps sharing their folder on the local network ----------------
  async function lanList(base) { const r = await fetch(`${base}/api/logs`, { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }
  async function lanRead(base, name) { const r = await fetch(`${base}/api/logs/${encodeURIComponent(name)}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }

  // ---------------- loading lists ----------------
  async function refreshLocal() {
    if (!desk) return;
    st.local = await desk.lib.list();
    render(); updateHistory(); summarizeMissing();
  }
  async function refreshTeam() {
    if (!cfg.repo) { st.team = []; st.teamErr = ''; render(); return; }
    try { st.team = await teamList(); st.teamErr = ''; }
    catch (err) { st.teamErr = err.message; if (!st.team) st.team = []; }
    render(); updateHistory();
  }
  async function refreshHub() {
    try { st.hub = await lanList(''); } catch (err) { st.hub = { device: LAN.device, logs: [], error: err.message }; }
    render(); updateHistory();
  }
  async function refreshPeers() {
    if (!desk) return;
    st.peers = await desk.lan.peers();
    await Promise.all(st.peers.map(async p => { try { st.peerLogs.set(p.id, (await lanList(p.url)).logs); } catch { st.peerLogs.set(p.id, null); } }));
    render();
  }
  const refreshAll = () => Promise.all([refreshLocal(), cfg.repo ? refreshTeam() : null, LAN ? refreshHub() : null, refreshPeers()]);

  // Local logs without a summary yet (recovered recordings, files copied into the folder by hand): read them in the background.
  async function summarizeMissing() {
    if (st.summarizing || !st.local) return;
    st.summarizing = true;
    try {
      for (const f of st.local.filter(f => !f.meta.summary && !f.meta.unreadable && f.size < 300e6)) {
        await new Promise(r => setTimeout(r, 50));
        try { const s = summarize(await desk.lib.read(f.name), f.name); f.meta = await desk.lib.meta(f.name, { summary: s }); }
        catch (err) { console.warn('summary', f.name, err); f.meta = await desk.lib.meta(f.name, { unreadable: true }); }
        render(); updateHistory();
      }
    } finally { st.summarizing = false; }
  }

  // History tab: one summary per match, from every place we can see.
  function updateHistory() {
    const docs = new Map();
    const add = (name, summary, extra) => { if (summary && !docs.has(name)) docs.set(name, { id: name, ...summary, fileName: name, ...extra }); };
    for (const f of st.local || []) add(f.name, f.meta.summary);
    for (const l of st.team || []) add(l.name, l.summary);
    for (const l of (st.hub && st.hub.logs) || []) add(l.name, l.summary);
    api.onHistory([...docs.values()]);
    api.onLists && api.onLists();
  }

  // ---------------- uploading ----------------
  const isUploaded = f => !!(f.meta.uploadedAt || (st.team && st.team.some(l => l.name === f.name && l.size === f.size)));
  async function upload(f, quiet) {
    if (st.busy.has(f.name)) return;
    st.busy.set(f.name, 'Uploading…'); render();
    try {
      const buf = await desk.lib.read(f.name);
      const summary = f.meta.summary || summarize(buf, f.name);
      const entry = await teamUpload(f.name, toAB(buf), summary);
      f.meta = await desk.lib.meta(f.name, { uploadedAt: entry.uploadedAt, wantUpload: false, uploadError: null, summary });
      if (!quiet) toast(`Uploaded ${titleOf(f.name, summary)} to the team library`);
      refreshTeam();
    } catch (err) {
      f.meta = await desk.lib.meta(f.name, { uploadError: err.message });
      if (!quiet) toast(`Couldn't upload: ${err.message}`);
    } finally { st.busy.delete(f.name); render(); }
  }
  // Uploads waiting for internet: tried every minute and whenever the laptop comes back online.
  let pumping = false;
  async function pump() {
    if (!desk || !token || !cfg.repo || pumping || !navigator.onLine) return;
    pumping = true;
    try { for (const f of (st.local || []).filter(f => f.meta.wantUpload && !f.meta.uploadedAt)) await upload(f, true); }
    finally { pumping = false; }
  }

  // ---------------- recording live data (desktop only) ----------------
  // Modes: 'enabled' keeps each run where the robot was enabled (default), 'fms' keeps only real matches,
  // 'all' keeps everything while connected, 'off'.
  const rec = { cur: null, last: new Map(), checkClock: false, lostAt: 0, host: null };
  const recSim = () => { try { return localStorage.getItem('carbovis.recordSim') === 'true'; } catch { return false; } };
  const recWanted = host => !!desk && cfg.record !== 'off' && (host !== api.simHost || recSim());
  function recBegin(nowUs) {
    const r = new Recorder.Recording(rec.host);
    r.floor = nowUs != null ? nowUs : 0;
    r.offset = r.floor > 1e15 ? r.floor : 0; // a robot simulation's clock is Unix time: start the file near 0 like a roboRIO log
    r.startedMs = Date.now(); r.chain = desk.rec.begin().then(tok => (r.tok = tok));
    // a file started mid-session needs the values the robot published once (CAN IDs, schemas, FMS info)
    for (const [topic, value] of rec.last.values()) r.add(topic, r.floor - r.offset, value);
    rec.cur = r; renderRecLine();
    return r;
  }
  function recFlush(r) {
    if (!r || !r.pending) return r && r.chain;
    const chunk = r.take();
    r.chain = r.chain.then(() => desk.rec.append(r.tok, chunk)).catch(err => console.error('recording', err));
    return r.chain;
  }
  async function recFinish(reason) {
    const r = rec.cur; if (!r) return;
    rec.cur = null; renderRecLine();
    await recFlush(r); await r.chain;
    const everEnabled = r.enabledS > 0 || r.enabled;
    const keep = reason !== 'discard' && r.records > 0 && (cfg.record === 'fms' ? r.everFms : cfg.record === 'all' || everEnabled);
    const name = await desk.rec.end(r.tok, keep ? r.fileName() : null);
    if (!name) return;
    let summary = null;
    try { summary = summarize(await desk.lib.read(name), name); } catch (err) { console.warn('summary', err); }
    await desk.lib.meta(name, { summary, recorded: true, wantUpload: cfg.autoUpload && !!cfg.repo });
    toast(`Saved ${titleOf(name, summary)}${cfg.autoUpload && token ? ' · uploading when online' : ''}`);
    await refreshLocal(); pump();
  }
  function liveValue(topic, us, value, serverNow) {
    if (!recWanted(rec.host)) return;
    rec.last.set(topic.name, [topic, value]);
    let r = rec.cur;
    if (r && rec.checkClock) { // reconnected: if the robot's clock went backwards it rebooted, so start a new file
      rec.checkClock = false;
      const now = serverNow();
      if (now != null && now - r.offset + 5e6 < r.tMax) { recFinish('reboot'); r = null; }
    }
    if (!r) r = recBegin(serverNow());
    r.add(topic, Math.max(us, r.floor) - r.offset, value);
    if (r.control & 0x10) r.everFms = true;
  }
  function liveStatus(state, host) {
    if (host != null && host !== rec.host) { if (rec.cur) recFinish('host'); rec.host = host; rec.last.clear(); }
    if (state === 'connected') { rec.lostAt = 0; rec.checkClock = true; }
    else if (state === 'stopped') { rec.lostAt = 0; if (rec.cur) recFinish('stopped'); rec.last.clear(); rec.host = null; }
    else if (!rec.lostAt) { // comms drop: keep the file open in case it comes back
      rec.lostAt = Date.now();
      if (rec.cur) rec.cur.commsLost();
    }
    renderRecLine();
  }
  function recTick() {
    const r = rec.cur; if (!r) return;
    recFlush(r);
    const now = Date.now();
    if (r.enabled) r.disabledSince = 0; else if (!r.disabledSince) r.disabledSince = now;
    const everEnabled = r.enabledS > 0 || r.enabled;
    if (r.matchEndedAt && now - r.matchEndedAt > 3000) recFinish('match');
    else if (rec.lostAt && now - rec.lostAt > 60000) recFinish('lost');
    else if (everEnabled && !r.enabled && !r.fmsAttached && now - r.disabledSince > 30000) recFinish('run');
    else if (!everEnabled && now - r.startedMs > (cfg.record === 'all' ? 600e3 : 120e3)) recFinish(cfg.record === 'all' ? 'idle' : 'discard');
    renderRecLine();
  }
  function renderRecLine() {
    const on = !!rec.cur;
    const dot = document.getElementById('libRec'); if (dot) dot.hidden = !on;
    const line = document.getElementById('libRecLine'); if (!line) return;
    line.replaceChildren(...recLine());
  }
  function recLine() {
    const r = rec.cur;
    if (!desk) return [];
    if (cfg.record === 'off') return [h('span', { class: 'hint' }, 'Recording is off (Settings).')];
    if (!r) return [h('span', { class: 'hint' }, rec.host ? 'Connected. Recording starts with the next value from the robot.' : 'Not recording. Connect to the robot (Live or Match view) and this laptop records everything it sends.')];
    const secs = (Date.now() - r.startedMs) / 1000;
    return [h('span', { class: 'rec-dot' }), h('b', null, 'Recording'), h('span', { class: 'mono' }, r.fileName()), h('span', { class: 'hint' }, `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')} · ${mb(r.bytes + r.pending)}${rec.lostAt ? ' · robot not connected' : r.enabled ? ' · enabled' : ''}`)];
  }

  // ---------------- opening ----------------
  async function openItem(it, opts) {
    const busy = h('div', { class: 'busy' }, `Opening ${it.title}…`); document.body.append(busy);
    let ok = false;
    try {
      const buf = it.src === 'local' ? toAB(await desk.lib.read(it.name)) : it.src === 'team' ? await teamRead(it.entry) : await lanRead(it.base, it.name);
      if (api.openBuffer(buf, it.name, opts)) { close(); ok = true; }
    } catch (err) { toast(`Couldn't open ${it.name}: ${err.message}`); console.error(err); }
    busy.remove();
    return ok;
  }

  // ---------------- the match menu (header) and opening the latest match ----------------
  // Every log we can see, one per name, newest match first. Local copies first: they open without a download.
  function allItems() {
    const out = new Map();
    const push = it => { if (!out.has(it.name)) out.set(it.name, it); };
    for (const f of st.local || []) push(itemOf('local', f.name, f.size, f.meta.summary, { file: f, mtime: f.mtime }));
    for (const l of (st.hub && st.hub.logs) || []) push(itemOf('hub', l.name, l.size, l.summary, { base: '', mtime: l.mtime }));
    for (const l of st.team || []) push(itemOf('team', l.name, l.size, l.summary, { entry: l, mtime: l.uploadedAt }));
    return [...out.values()].sort((a, b) => b.sortKey.localeCompare(a.sortKey) || a.name.localeCompare(b.name));
  }
  const keyOf = it => `${it.src}:${it.name}`;
  function recent(n = 15) {
    return allItems().slice(0, n).map(it => ({ key: keyOf(it), name: it.name, title: it.title, date: it.date, summary: it.summary, src: it.src }));
  }
  function openKey(key) { const it = allItems().find(x => keyOf(x) === key); return it ? openItem(it) : Promise.resolve(false); }
  // Opens the newest match there is. Waits for the team library at most waitMs (a laptop at the field has no
  // internet), then settles for what this computer has. False when there's nothing to open.
  async function openLatest(waitMs = 4000) {
    await Promise.race([lists, new Promise(r => setTimeout(r, waitMs))]);
    const it = allItems()[0];
    return it ? openItem(it, { auto: true }) : false;
  }
  async function saveLocal(it) {
    st.busy.set(it.name, 'Saving…'); render();
    try {
      const buf = it.src === 'team' ? await teamRead(it.entry) : await lanRead(it.base, it.name);
      await desk.lib.write(it.name, new Uint8Array(buf));
      await desk.lib.meta(it.name, { summary: it.summary || null, uploadedAt: it.src === 'team' ? it.entry.uploadedAt : null });
      toast(`Saved ${it.title} to this computer`);
      await refreshLocal();
    } catch (err) { toast(`Couldn't save: ${err.message}`); }
    st.busy.delete(it.name); render();
  }
  // Called by the app when a file is opened from disk or dropped on the window: keep a copy in the library.
  async function adopt(name, buf) {
    if (!desk) return;
    if ((st.local || []).some(f => f.name === name && f.size === buf.byteLength)) return;
    try {
      await desk.lib.write(name, new Uint8Array(buf));
      await desk.lib.meta(name, { summary: summarize(buf, name), wantUpload: cfg.autoUpload && !!cfg.repo });
      toast(`Added ${name} to the library on this computer`);
      await refreshLocal(); pump();
    } catch (err) { console.warn('adopt', err); }
  }

  // ---------------- UI ----------------
  function titleOf(name, s) {
    const n = nameInfo(name);
    const match = (s && s.match) || n.match, event = (s && s.event) || n.event;
    const base = match ? [match, event].filter(Boolean).join(' · ') : name.replace(/\.wpilog$/i, '');
    return /_DS\.wpilog$/i.test(name) ? `${base} (DS)` : base;
  }
  function itemOf(src, name, size, summary, extra) {
    const n = nameInfo(name);
    const date = (summary && summary.date) || n.date || '';
    return { src, name, size, summary, title: titleOf(name, summary), date, sortKey: n.stamp || (extra.mtime ? new Date(extra.mtime).toISOString().replace(/\D/g, '').slice(0, 14) : ''), ...extra };
  }
  function items() {
    let list = [];
    if (st.view === 'local') list = (st.local || []).map(f => itemOf('local', f.name, f.size, f.meta.summary, { file: f, mtime: f.mtime }));
    else if (st.view === 'team') list = (st.team || []).map(l => itemOf('team', l.name, l.size, l.summary, { entry: l, mtime: l.uploadedAt }));
    else if (st.view === 'hub') list = ((st.hub && st.hub.logs) || []).map(l => itemOf('hub', l.name, l.size, l.summary, { base: '', mtime: l.mtime }));
    else for (const p of st.peers) for (const l of st.peerLogs.get(p.id) || []) list.push(itemOf('peer', l.name, l.size, l.summary, { base: p.url, peer: p.device, mtime: l.mtime }));
    const q = st.filter.trim().toLowerCase();
    if (q) list = list.filter(it => `${it.title} ${it.name} ${it.summary ? it.summary.event : ''}`.toLowerCase().includes(q));
    return list.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || a.name.localeCompare(b.name));
  }
  function flagPill(s) {
    if (!s) return null;
    return s.critCount ? h('span', { class: 'pill' }, h('span', { class: 'dot crit' }), `${s.critCount} critical`)
      : s.warnCount ? h('span', { class: 'pill' }, h('span', { class: 'dot warn' }), `${s.warnCount} warning`) : h('span', { class: 'pill' }, h('span', { class: 'dot ok' }), 'Clean');
  }
  function row(it) {
    const s = it.summary, busy = st.busy.get(it.name);
    const sub = [it.date, s && s.durationS != null ? `${fmt(s.durationS, 0)} s` : null, mb(it.size), it.peer, it.src === 'team' && it.entry.uploadedBy ? `from ${it.entry.uploadedBy}` : null].filter(Boolean).join(' · ');
    const acts = [h('button', { class: 'btn small primary', onclick: () => openItem(it) }, 'Open')];
    const localHas = (st.local || []).some(f => f.name === it.name);
    if (it.src === 'local') {
      const f = it.file;
      if (busy) acts.push(h('span', { class: 'hint' }, busy));
      else if (cfg.repo && isUploaded(f)) acts.push(h('span', { class: 'pill', title: `In ${cfg.repo}` }, h('span', { class: 'dot ok' }), 'On team'));
      else if (cfg.repo) acts.push(h('button', { class: 'btn small', disabled: !token, title: token ? `Upload to ${cfg.repo}` : 'Add a GitHub token in Settings to upload', onclick: () => upload(f) }, f.meta.wantUpload ? 'Upload now' : 'Upload'));
    } else if (desk && !localHas) acts.push(busy ? h('span', { class: 'hint' }, busy) : h('button', { class: 'btn small', onclick: () => saveLocal(it) }, 'Save here'));
    const canDelete = it.src === 'local' || (it.src === 'team' && token && st.repo && st.repo.canWrite);
    if (canDelete) {
      if (st.confirm === it.src + it.name) acts.push(h('span', { class: 'confirm' }, it.src === 'team' ? 'Delete for everyone?' : 'Delete?',
        h('button', { class: 'linkbtn danger', onclick: () => remove(it) }, 'Yes'), h('button', { class: 'linkbtn', onclick: () => { st.confirm = null; render(); } }, 'No')));
      else acts.push(h('button', { class: 'linkbtn danger', onclick: () => { st.confirm = it.src + it.name; render(); } }, 'Delete'));
    }
    const err = it.src === 'local' && it.file.meta.uploadError && !isUploaded(it.file) ? h('div', { class: 'hint err' }, `Upload failed: ${it.file.meta.uploadError}${it.file.meta.wantUpload ? ' · will retry' : ''}`) : null;
    return h('div', { class: 'lib-row' },
      h('div', { class: 'lib-main' }, h('div', { class: 'lib-t' }, h('b', null, it.title), flagPill(s)), h('div', { class: 'hint mono', title: it.name }, it.name), h('div', { class: 'lib-s' }, sub), err),
      h('div', { class: 'lib-a' }, ...acts));
  }
  async function remove(it) {
    st.confirm = null; st.busy.set(it.name, 'Deleting…'); render();
    try {
      if (it.src === 'local') { await desk.lib.remove(it.name); await refreshLocal(); }
      else { await teamDelete(it.entry); await refreshTeam(); }
      toast(`Deleted ${it.title}`);
    } catch (err) { toast(`Couldn't delete: ${err.message}`); }
    st.busy.delete(it.name); render();
  }

  function views() {
    const v = [];
    if (desk) v.push(['local', 'This computer', st.local && st.local.length]);
    if (LAN) v.push(['hub', (st.hub && st.hub.device) || LAN.device || 'Driver station', st.hub && st.hub.logs.length]);
    v.push(['team', 'Team', st.team && st.team.length]);
    if (desk) v.push(['nearby', 'Nearby', st.peers.length ? [...st.peerLogs.values()].reduce((n, l) => n + (l ? l.length : 0), 0) : null]);
    return v;
  }
  function emptyNote() {
    if (st.view === 'local') return ['Nothing here yet', 'Recordings from the driver station land here, and so does any .wpilog you open or import.'];
    if (st.view === 'team') return !cfg.repo ? ['No team library set', 'Open Settings and enter the GitHub repo the team keeps logs in.']
      : st.teamErr ? ['Can\'t reach the team library', st.teamErr] : st.team == null ? ['Loading…', ''] : ['No logs uploaded yet', 'The driver station uploads each match here when it has internet.'];
    if (st.view === 'hub') return [st.hub && st.hub.error ? 'Can\'t reach the driver station' : 'No logs yet', (st.hub && st.hub.error) || 'Nothing has been recorded on that computer yet.'];
    return st.peers.length ? ['No logs on nearby computers', ''] : ['No computers found', 'Other CarboVis computers on this network show up here when they turn on "Share on this network" in Settings.'];
  }
  function render() {
    const root = document.getElementById('library');
    if (!root || !st.open) return;
    if (st.settings) { root.replaceChildren(h('div', { class: 'lib-in' }, head(), settingsPane())); return; }
    const list = items();
    const [eb, et] = emptyNote();
    const tools = [];
    if (st.view === 'local') tools.push(h('button', { class: 'btn small', onclick: async () => {
      const names = await desk.lib.import(); if (!names || !names.length) return;
      if (cfg.autoUpload && cfg.repo) for (const n of names) await desk.lib.meta(n, { wantUpload: true });
      await refreshLocal(); pump();
    } }, 'Import .wpilog files…'),
      h('button', { class: 'btn small', onclick: () => desk.lib.reveal() }, 'Show folder'));
    if (st.view === 'team' && cfg.repo) tools.push(h('a', { class: 'hint', href: `https://github.com/${cfg.repo}${cfg.branch ? '/tree/' + cfg.branch : ''}`, target: '_blank', rel: 'noopener' }, cfg.repo + (cfg.branch ? ` · ${cfg.branch}` : '')));
    root.replaceChildren(h('div', { class: 'lib-in' }, head(),
      desk ? h('div', { class: 'lib-rec', id: 'libRecLine' }, ...recLine()) : null,
      h('div', { class: 'lib-bar' },
        h('div', { class: 'seg', role: 'tablist' }, ...views().map(([id, label, n]) => h('button', { role: 'tab', 'aria-selected': String(st.view === id), class: st.view === id ? 'on' : '', onclick: () => { st.view = id; st.confirm = null; render(); if (id === 'team') refreshTeam(); if (id === 'nearby') refreshPeers(); } }, label, n != null ? h('span', { class: 'count' }, n) : null))),
        h('input', { type: 'search', class: 'lib-q', placeholder: 'Filter (Q42, event, date…)', value: st.filter, 'aria-label': 'Filter logs', oninput: e => { st.filter = e.target.value; const l = document.querySelector('#library .lib-list'); if (l) l.replaceChildren(...listRows()); } }),
        ...tools),
      h('div', { class: 'lib-list' }, ...(list.length ? list.map(row) : [h('div', { class: 'empty' }, h('b', null, eb), et)]))));
    function listRows() { const l = items(); return l.length ? l.map(row) : [h('div', { class: 'empty' }, h('b', null, eb), et)]; }
  }
  function head() {
    const up = st.update;
    return h('div', { class: 'lib-head' },
      h('h2', null, st.settings ? 'Settings' : 'Match logs'),
      up && up.state === 'ready' ? h('button', { class: 'btn small primary', onclick: () => desk.update.install() }, `Restart to update to ${up.version}`) : null,
      h('button', { class: 'btn small', onclick: () => { st.settings = !st.settings; render(); } }, st.settings ? 'Back to logs' : 'Settings'),
      h('button', { class: 'btn small', 'aria-label': 'Close', onclick: close }, 'Close'));
  }

  function settingsPane() {
    const status = h('span', { class: 'hint' }, st.repo && st.repo.full === cfg.repo ? `${st.repo.private ? 'Private' : 'Public'} repo · ${st.repo.canWrite ? 'this computer can upload' : token ? 'token is read-only here' : 'read-only (no token)'}` : '');
    const repoIn = h('input', { type: 'text', value: cfg.repo, spellcheck: 'false', placeholder: 'owner/repo', 'aria-label': 'Team repo' });
    const branchIn = h('input', { type: 'text', value: cfg.branch || '', spellcheck: 'false', placeholder: 'default branch', 'aria-label': 'Branch' });
    const tokIn = h('input', { type: 'password', value: token, spellcheck: 'false', placeholder: 'github_pat_…', autocomplete: 'off', 'aria-label': 'GitHub token' });
    const save = async () => {
      cfg.repo = repoIn.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''); cfg.branch = branchIn.value.trim(); token = tokIn.value.trim();
      saveCfg(); await setToken(token); st.repo = null; st.team = null;
      status.textContent = 'Checking…';
      try { const r = await repoInfo(true); status.textContent = `Found ${r.private ? 'private' : 'public'} repo · ${r.canWrite ? 'this computer can upload' : token ? 'token can\'t write here' : 'read-only (no token)'}`; refreshTeam(); pump(); }
      catch (err) { status.textContent = err.message; }
    };
    const kids = [
      h('fieldset', null, h('legend', null, 'Team library (GitHub)'),
        h('div', { class: 'lib-two' }, h('label', null, 'Repo', repoIn), h('label', null, 'Branch', branchIn)),
        h('label', null, desk ? 'Token (needed to upload; stays on this computer)' : 'Token (only needed for a private repo)', tokIn),
        h('div', { class: 'row2' }, h('button', { class: 'btn small primary', onclick: save }, 'Save and test'), status),
        h('p', { class: 'hint' }, 'Make a ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'fine-grained token'),
          ` with access to only ${cfg.repo || 'the repo'} and Contents: ${desk ? 'Read and write' : 'Read-only'}. Phones and laptops viewing a public repo need no token.`)),
    ];
    if (desk) {
      const lan = st.lan || {};
      kids.push(h('fieldset', null, h('legend', null, 'Driver station'),
        h('label', null, 'Record live data from the robot', h('select', { class: 'sel', onchange: e => { cfg.record = e.target.value; saveCfg(); if (cfg.record === 'off' && rec.cur) recFinish('stopped'); } },
          ...[['enabled', 'Each time the robot is enabled'], ['fms', 'Real matches only (FMS attached)'], ['all', 'Everything while connected'], ['off', 'Off']].map(([v, l]) => h('option', { value: v, selected: cfg.record === v }, l)))),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: cfg.autoUpload, onchange: e => { cfg.autoUpload = e.target.checked; saveCfg(); } }), 'Upload each new log to the team library when online'),
        h('p', { class: 'hint' }, 'One file per match (it closes 3 s after teleop ends) or per run (30 s after the robot is disabled). A short comms drop keeps the same file.'),
        h('div', { class: 'row2' }, h('span', { class: 'hint mono' }, st.info ? st.info.libDir : ''), h('button', { class: 'btn small', onclick: async () => { const d = await desk.lib.chooseDir(); if (d) { st.info = await desk.info(); refreshLocal(); render(); } } }, 'Change folder…'))));
      kids.push(h('fieldset', null, h('legend', null, 'Share on this network'),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!lan.enabled, onchange: async e => { st.lan = await desk.lan.set(e.target.checked); render(); } }), 'Let phones and laptops on this Wi-Fi or switch open this computer\'s logs'),
        lan.enabled && lan.urls && lan.urls.length ? h('div', { class: 'lib-share' }, h('img', { id: 'lanQr', alt: 'QR code for this computer\'s address', width: 132, height: 132 }),
          h('div', null, ...lan.urls.map(u => h('div', { class: 'mono' }, h('a', { href: u, target: '_blank', rel: 'noopener' }, u))), h('p', { class: 'hint' }, 'Scan with a phone on the same network. No internet needed. Read-only. Windows may ask to allow CarboVis through the firewall: allow it on private networks.'))) : null,
        lan.error ? h('p', { class: 'hint err' }, lan.error) : null,
        h('p', { class: 'hint' }, 'Turn this off at events while the laptop is on the field network.')));
      if (lan.enabled && lan.urls && lan.urls[0]) desk.qr(lan.urls[0]).then(src => { const img = document.getElementById('lanQr'); if (img) img.src = src; });
      const up = st.update || {};
      kids.push(h('fieldset', null, h('legend', null, 'App'),
        h('p', { style: 'margin:0' }, `CarboVis ${st.info ? st.info.version : ''} on ${st.info ? st.info.device : ''}`),
        h('div', { class: 'row2' }, h('button', { class: 'btn small', onclick: () => { st.update = { state: 'checking' }; render(); desk.update.check(); } }, 'Check for updates'),
          h('span', { class: 'hint' }, up.state === 'checking' ? 'Checking…' : up.state === 'none' ? 'Up to date.' : up.state === 'downloading' ? `Downloading ${up.version || ''} ${up.percent != null ? Math.round(up.percent) + '%' : ''}` : up.state === 'ready' ? `${up.version} is ready. It installs when CarboVis closes.` : up.state === 'error' ? `Couldn't check: ${up.message}` : up.state === 'dev' ? 'Updates only run in the installed app.' : '')),
        h('p', { class: 'hint' }, 'Updates download in the background and install the next time CarboVis closes, never during a match. Phones: ', h('a', { href: WEB_URL, target: '_blank', rel: 'noopener' }, WEB_URL)),
        h('div', { class: 'lib-share' }, h('img', { id: 'webQr', alt: 'QR code for the web version', width: 132, height: 132 }), h('p', { class: 'hint' }, 'The web version for phones and other computers. On a phone, "Add to Home Screen" installs it like an app.'))));
      desk.qr(WEB_URL).then(src => { const img = document.getElementById('webQr'); if (img) img.src = src; });
    } else {
      kids.push(h('fieldset', null, h('legend', null, 'This device'),
        h('p', { class: 'hint' }, 'Open logs here; recording and uploading happen on the driver station laptop. Install the desktop app on Windows from ', h('a', { href: 'https://github.com/Carrborobotics/CarboVis/releases/latest', target: '_blank', rel: 'noopener' }, 'the latest release'), '. On a phone, "Add to Home Screen" keeps this page one tap away.')));
    }
    return h('div', { class: 'lib-set' }, ...kids);
  }

  function open(view) {
    if (!ENABLED) { toast('The match log library works in the CarboVis app and its web version, not here.'); return; }
    st.open = true; if (view) st.view = view;
    const root = document.getElementById('library'); root.hidden = false;
    render(); refreshAll();
  }
  function close() { st.open = false; st.settings = false; st.confirm = null; const root = document.getElementById('library'); if (root) root.hidden = true; }

  // ---------------- settings storage ----------------
  function saveCfg() { try { localStorage.setItem('carbovis.library', JSON.stringify(cfg)); } catch { /* storage blocked */ } }
  async function setToken(t) { if (desk) await desk.secret.set('github', t); else try { localStorage.setItem('carbovis.token', t); } catch { /* storage blocked */ } }

  async function init(a) {
    api = a; h = a.h; fmt = a.fmt; toast = a.toast;
    try { Object.assign(cfg, JSON.parse(localStorage.getItem('carbovis.library') || '{}')); } catch { /* defaults */ }
    const lib = document.getElementById('library');
    if (lib) lib.onpointerdown = e => { if (e.target === lib) close(); };
    if (!ENABLED) { const b = document.getElementById('libBtn'); if (b) b.hidden = true; return { enabled: false }; }
    st.view = desk ? 'local' : LAN ? 'hub' : 'team';
    if (desk) {
      token = (await desk.secret.get('github')) || '';
      st.info = await desk.info();
      if (st.info.update) { st.update = st.info.update; a.onUpdate && a.onUpdate(st.update); }
      st.lan = await desk.lan.status();
      desk.on('update', u => { st.update = u; render(); a.onUpdate && a.onUpdate(u); });
      desk.on('peers', () => { if (st.open && st.view === 'nearby') refreshPeers(); });
      desk.on('lib-changed', () => refreshLocal());
      setInterval(recTick, 1000);
      setInterval(pump, 60000);
      window.addEventListener('online', pump);
      await refreshLocal(); pump();
    } else {
      try { token = localStorage.getItem('carbovis.token') || ''; } catch { /* none */ }
    }
    lists = Promise.all([LAN ? refreshHub() : null, cfg.repo ? refreshTeam() : null]);
    return { enabled: true };
  }

  return { init, open, close, adopt, recent, openKey, openLatest, liveValue, liveStatus, codec: { gzip, gunzip, b64 }, isOpen: () => st.open, get enabled() { return ENABLED; }, get desktop() { return !!desk; }, get recording() { return !!rec.cur; }, nameInfo };
})();
if (typeof module !== 'undefined') module.exports = Library;
