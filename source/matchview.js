// ===== Match view: one full window of live robot status for the driver station laptop =====
// Sized to fill the screen above the FRC Driver Station. Reads the same data model as everything else
// (a live NetworkTables session or an opened .wpilog), so a log can be replayed through it too.
//
// Status colors everywhere on this page:
//   green  = connected and healthy (cameras: connected and seeing an AprilTag)
//   yellow = connected, needs attention (warm, at a current limit, minor fault; cameras: no tag in view)
//   red    = fault reported (hardware fault, over temperature; cameras: fault flag, high latency, low FPS)
//   blinking red = MAJOR: not connected at all (motor off CAN, camera offline, controller unplugged, no comms)
const MatchView = (() => {
  'use strict';
  let api = null;
  const LVL_RANK = { major: 4, fault: 3, warn: 2, ok: 1, missing: 0, none: 0 };
  const worst = lvls => lvls.reduce((a, b) => (LVL_RANK[b] > LVL_RANK[a] ? b : a), 'none');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const DEFAULTS = { dsHeight: 230, autoLen: 20, teleLen: 140, camLatencyMs: 150, camMinFps: 10, autoFit: true };

  // ---------------- motor roles ----------------
  const MODS = ['FL', 'FR', 'BL', 'BR'];
  const MOD_NAME = { FL: 'Front left', FR: 'Front right', BL: 'Back left', BR: 'Back right' };
  const SLOTS = {
    drive: MODS.flatMap(m => [{ id: m + 'd', label: `${MOD_NAME[m]} drive`, short: 'D' }, { id: m + 's', label: `${MOD_NAME[m]} steer`, short: 'S' }]),
    shooter: [{ id: 'turret', label: 'Turret', short: 'TUR' }, { id: 'hood', label: 'Hood', short: 'HOOD' }, { id: 'kicker', label: 'Kicker / feeder', short: 'KICK' },
      { id: 'fw1', label: 'Flywheel 1', short: 'FW1' }, { id: 'fw2', label: 'Flywheel 2', short: 'FW2' }, { id: 'fw3', label: 'Flywheel 3', short: 'FW3' }, { id: 'fw4', label: 'Flywheel 4', short: 'FW4' }],
    intake: [{ id: 'intake', label: 'Intake roller', short: 'INTAKE' }, { id: 'deploy', label: 'Intake deploy', short: 'DEPLOY' }, { id: 'idx1', label: 'Indexer 1', short: 'INDEX 1' }, { id: 'idx2', label: 'Indexer 2', short: 'INDEX 2' }],
  };
  const ALL_SLOTS = Object.values(SLOTS).flat();
  const slotDef = id => ALL_SLOTS.find(s => s.id === id);

  // "DriveFL", "FL drive", "FrontLeftDrive", "Module0Steer" -> tokens
  function tokens(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }
  function moduleOf(tk) {
    const flat = tk.join('');
    for (const [m, words] of [['FL', ['frontleft', 'leftfront']], ['FR', ['frontright', 'rightfront']], ['BL', ['backleft', 'rearleft', 'leftback', 'leftrear']], ['BR', ['backright', 'rearright', 'rightback', 'rightrear']]])
      if (words.some(w => flat.includes(w))) return m;
    for (const [m, ab] of [['FL', ['fl', 'lf']], ['FR', ['fr', 'rf']], ['BL', ['bl', 'rl', 'lb', 'lr']], ['BR', ['br', 'rr', 'rb']]])
      if (tk.some(t => ab.includes(t) || ab.some(a => t === a + 'drive' || t === a + 'steer' || t === 'drive' + a || t === 'steer' + a))) return m;
    const n = flat.match(/(?:module|mod)([0-3])/) || (tk.find(t => /^[0-3]$/.test(t)) || '').match(/([0-3])/);
    return n ? MODS[+n[1]] : null;
  }
  function autoAssign(names) {
    const out = {}, used = new Set();
    const take = (id, n) => { if (n && !used.has(n) && !out[id]) { out[id] = n; used.add(n); } };
    for (const n of names) {
      const tk = tokens(n), flat = tk.join('');
      if (/turret|hood|flywheel|shoot|intake|index|kick|feed/.test(flat)) continue;
      const steer = /steer|turn|azimuth|angle|rotat/.test(flat), drive = /drive|drv|wheel/.test(flat);
      if (!steer && !drive) continue;
      const m = moduleOf(tk);
      if (m) take(m + (steer ? 's' : 'd'), n);
    }
    const rest = () => names.filter(n => !used.has(n)).map(n => [n, tokens(n).join('')]);
    for (const [n, f] of rest()) if (/turret/.test(f)) take('turret', n);
    for (const [n, f] of rest()) if (/hood/.test(f)) take('hood', n);
    for (const [n, f] of rest()) if (/kick|feed|accel|transfer/.test(f)) take('kicker', n);
    for (const [n, f] of rest()) if (/flywheel|shoot|launch/.test(f)) take(['fw1', 'fw2', 'fw3', 'fw4'].find(s => !out[s]) || 'x', n);
    for (const [n, f] of rest()) if (/rack|pivot|deploy|extend|wrist|intakearm/.test(f)) take('deploy', n);
    for (const [n, f] of rest()) if (/intake|roller/.test(f)) take('intake', n);
    for (const [n, f] of rest()) if (/index|spindex|hopper|conveyor|belt|serial|tower|agitat|funnel/.test(f)) take(['idx1', 'idx2'].find(s => !out[s]) || 'x', n);
    delete out.x;
    return out;
  }

  // ---------------- cameras ----------------
  // Robot convention: Vision/<cam>/Connected, TagCount (or HasTarget), LatencyMs, FPS, Heartbeat, Faults/<flag>,
  // plus the arrays TagIds, TagYawDeg, TagDistanceM (one element per tag in view) and RobotToCamera (the mount).
  // PhotonVision (photonvision/<cam>/...) and Limelight (limelight-<name>/...) tables are read directly too.
  function camerasOf(log) {
    const cams = new Map();
    const add = (name, src, k, e) => {
      const id = src + ':' + name;
      if (!cams.has(id)) cams.set(id, { id, name, src, e: {}, faults: {} });
      const c = cams.get(id);
      if (k.startsWith('Faults/')) c.faults[k.slice(7)] = e; else c.e[k] = e;
    };
    for (const e of log.entries.values()) {
      const n = api.Core.stripPrefix(e.name);
      if (e.kind === 'numarr') {
        const r = n.match(/^Vision\/([^/]+)\/(TagIds|TagYawDeg|TagDistanceM|RobotToCamera)$/);
        if (r) add(r[1], 'robot', r[2], e);
        continue;
      }
      if (e.kind !== 'num' && e.kind !== 'bool') continue;
      let r = n.match(/^Vision\/([^/]+)\/(Connected|TagCount|HasTarget|LatencyMs|FPS|Heartbeat|Faults\/\w+)$/);
      if (r) { add(r[1], 'robot', r[2], e); continue; }
      r = n.match(/^photonvision\/([^/]+)\/(hasTarget|latencyMillis|heartbeat)$/);
      if (r) { add(r[1], 'photon', { hasTarget: 'HasTarget', latencyMillis: 'LatencyMs', heartbeat: 'Heartbeat' }[r[2]], e); continue; }
      r = n.match(/^(limelight(?:-[\w]+)?)\/(tv|tl|hb)$/);
      if (r) add(r[1], 'limelight', { tv: 'HasTarget', tl: 'LatencyMs', hb: 'Heartbeat' }[r[2]], e);
    }
    return [...cams.values()].filter(c => c.e.Connected || c.e.TagCount || c.e.HasTarget || c.e.Heartbeat || c.e.TagYawDeg).sort((a, b) => a.name.localeCompare(b.name));
  }
  // Drive drawing geometry: frame center and size, bumper offset from the frame, bottom of the area tags can use
  const DR = { cx: 210, cy: 186, fw: 264, fh: 208, bo: 9, w: 420, top: 362, dy: 0 };
  // a point on the bumper outline in the direction (nx right, ny back) from the robot's center
  const bumperPt = (nx, ny) => { const s = Math.max(Math.abs(nx), Math.abs(ny)) || 1; return [Math.round(DR.cx + nx / s * (DR.fw / 2 + DR.bo)), Math.round(DR.cy + ny / s * (DR.fh / 2 + DR.bo))]; };
  // preset mounts: [right, back, outward facing in degrees clockwise from the front]
  const MOUNTS = {
    'front-left': [-1, -1, -45], front: [0, -1, 0], 'front-right': [1, -1, 45], left: [-1, 0, -90], right: [1, 0, 90],
    'back-left': [-1, 1, -135], back: [0, 1, 180], 'back-right': [1, 1, 135],
  };
  // Vision/<cam>/RobotToCamera = [x forward m, y left m, z m, roll°, pitch°, yaw° (CCW, 0 = forward)], or [x, y, yaw°].
  // The camera is drawn where that sits around the robot, pushed out to the bumper so it never covers a module.
  function loggedMount(e) {
    const xf = e && e.vals && e.vals.length ? e.vals[e.vals.length - 1] : null;
    if (!xf || (xf.length !== 3 && xf.length < 6) || ![...xf].every(isFinite)) return null;
    const yaw = xf.length >= 6 ? xf[5] : xf[2];
    let nx = -xf[1], ny = -xf[0];
    if (Math.hypot(nx, ny) < 0.02) { nx = -Math.sin(yaw * Math.PI / 180); ny = -Math.cos(yaw * Math.PI / 180); }
    return [...bumperPt(nx, ny), -yaw];
  }
  const FACES = { out: null, front: 0, right: 90, back: 180, left: -90 };
  // empty label/mount = take them from the camera's name ("FrontLeft" -> front-left)
  const CAM_DEFAULT = [{ src: '', label: '', mount: '', face: 'out' }, { src: '', label: '', mount: '', face: 'out' }];
  const CAM_FALLBACK_MOUNT = ['front-left', 'back-right'];
  function inferMount(name) {
    if (!name) return null;
    const tk = tokens(name), f = tk.join('');
    const fr = /front/.test(f) || tk.some(t => ['f', 'fl', 'fr'].includes(t)), bk = /back|rear/.test(f) || tk.some(t => ['b', 'bl', 'br'].includes(t));
    const l = /left/.test(f) || tk.some(t => ['l', 'fl', 'bl'].includes(t)), r = /right/.test(f) || tk.some(t => ['r', 'fr', 'br'].includes(t));
    const v = fr ? 'front' : bk ? 'back' : '', hz = l ? 'left' : r ? 'right' : '';
    return v && hz ? `${v}-${hz}` : v || hz || null;
  }

  // ---------------- state ----------------
  const st = { open: false, built: '', el: null, timer: 0, playing: false, lastFrame: 0, rate: 1, hover: null, setup: false, roller: 0, lastRollT: 0 };
  let cfg, overrides, camCfg, mechSrc;
  function loadCfg() {
    cfg = { ...DEFAULTS, ...api.store.get('7763.mv.cfg', {}) };
    overrides = api.store.get('7763.mv.roles', {});
    camCfg = api.store.get('7763.mv.cams', CAM_DEFAULT).map((c, i) => ({ ...CAM_DEFAULT[i], ...c })).slice(0, 2);
    mechSrc = api.store.get('7763.mv.mechs', {});
  }
  const saveCfg = () => { api.store.set('7763.mv.cfg', cfg); api.store.set('7763.mv.roles', overrides); api.store.set('7763.mv.cams', camCfg); api.store.set('7763.mv.mechs', mechSrc); };

  // resolved view of the current log: motors by role, cameras, mechanism sources
  let ctxCache = { sum: null, key: '' };
  function ctx() {
    const S = api.S;
    const key = JSON.stringify([overrides, camCfg, mechSrc]);
    if (ctxCache.sum === S.sum && ctxCache.key === key && ctxCache.log === S.log) return ctxCache;
    const motors = new Map(S.sum.motors.map(m => [m.name, m]));
    const auto = autoAssign([...motors.keys()]);
    const roles = {};
    for (const s of ALL_SLOTS) {
      const o = overrides[s.id];
      roles[s.id] = o === undefined ? (auto[s.id] || '') : o;
    }
    const cams = camerasOf(S.log);
    const used = new Set(camCfg.map(c => c.src).filter(Boolean));
    const front = c => (/^front/.test(inferMount(c.name) || '') ? 0 : /^back/.test(inferMount(c.name) || '') ? 2 : 1);
    const free = cams.filter(c => !used.has(c.id)).sort((a, b) => front(a) - front(b));
    const camSel = camCfg.map(c => (c.src ? cams.find(x => x.id === c.src) || null : free.shift() || null));
    const mechs = S.sum.mechanisms;
    const pick = (k, re) => { const o = mechSrc[k]; if (o !== undefined) return mechs.find(m => m.name === o) || null; return mechs.find(m => re.test(m.name)) || null; };
    const mech = { turret: pick('turret', /turret/i), hood: pick('hood', /hood/i), deploy: pick('deploy', /rack|intake|pivot|deploy|extend/i) };
    const camView = camCfg.map((cc, i) => {
      const sel = camSel[i], logged = !cc.mount && sel ? loggedMount(sel.e.RobotToCamera) : null;
      const mount = cc.mount || (logged ? 'logged' : inferMount(sel && sel.name) || CAM_FALLBACK_MOUNT[i]);
      const [x, y, outA] = logged || (([nx, ny, a]) => [...bumperPt(nx, ny), a])(MOUNTS[mount] || MOUNTS.front);
      return { ...cc, label: cc.label || (sel ? sel.name : `Cam ${i + 1}`), mount, x, y, a: FACES[cc.face] == null ? outA : FACES[cc.face] };
    });
    ctxCache = { sum: S.sum, log: S.log, key, motors, auto, roles, cams, camSel, camView, mech };
    return ctxCache;
  }

  // ---------------- reading values at time t ----------------
  const E = (...names) => api.Core.findEntry(api.S.log, ...names);
  const at = (e, t) => (e && e.v ? api.Core.valueAt(e.t, e.v, t) : NaN);
  const strAt = (e, t) => { if (!e || !e.vals) return ''; const i = api.Core.idxAt(e.t, t); return i < 0 ? '' : String(e.vals[i]); };
  const LIMIT_FAULTS = new Set(['StatorCurrLimit', 'SupplyCurrLimit']);

  function motorNow(name, t) {
    if (!name) return { lvl: 'none', notes: [] };
    const m = ctx().motors.get(name);
    if (!m) return { lvl: 'missing', notes: [['warn', `No data for "${name}" in this ${api.S.isLive ? 'session' : 'log'}`]], name };
    const e = m.entries, L = api.S.limits;
    const conV = at(e.Connected, t);
    const online = e.Connected ? conV === 1 : true;
    const temp = at(e.TempC, t), sup = at(e.SupplyCurrentA, t), sta = at(e.StatorCurrentA, t), vel = at(e.VelocityRPM, t), duty = at(e.DutyCycle, t);
    const notes = []; let lvl = 'ok';
    const bump = l => { if (LVL_RANK[l] > LVL_RANK[lvl]) lvl = l; };
    if (!online) { bump('major'); notes.push(['major', 'Not on the CAN bus']); }
    else {
      for (const [k, fe] of Object.entries(e.faults || {})) {
        if (at(fe, t) !== 1) continue;
        const [sev, label] = api.Core.faultInfo(k);
        const l = LIMIT_FAULTS.has(k) ? 'warn' : sev === 'crit' ? 'fault' : 'warn';
        bump(l); notes.push([l, label]);
      }
      if (temp >= L.tempCrit) { bump('fault'); notes.push(['fault', `${Math.round(temp)} °C, over the ${L.tempCrit} °C limit`]); }
      else if (temp >= L.tempWarn) { bump('warn'); notes.push(['warn', `${Math.round(temp)} °C, past the ${L.tempWarn} °C warning`]); }
      if (!e.faults || !e.faults.SupplyCurrLimit) {
        const lim = e.SupplyLimitA && e.SupplyLimitA.v.length ? e.SupplyLimitA.v[e.SupplyLimitA.v.length - 1] : NaN;
        if (isFinite(lim) && Math.abs(sup) >= lim * 0.97) { bump('warn'); notes.push(['warn', `At the ${Math.round(lim)} A supply limit`]); }
      }
    }
    return { lvl, notes, name, m, online, temp, sup, sta, vel, duty, canId: m.canId, bus: m.canBus, controller: m.controller };
  }

  function camNow(c, t, cc) {
    if (!c) return { lvl: 'none', label: cc.label, text: 'Not set up', notes: [] };
    const v = k => at(c.e[k], t);
    let connected = true;
    if (c.e.Connected) connected = v('Connected') === 1;
    else if (c.e.Heartbeat) { const e = c.e.Heartbeat, i = api.Core.idxAt(e.t, t); connected = i >= 0 && t - e.t[i] < 1.0; }
    const seen = connected ? tagsAt(c, t) : [];
    const counted = !!(c.e.TagCount || c.e.TagYawDeg);
    const tags = c.e.TagCount ? v('TagCount') : c.e.TagYawDeg ? seen.length : c.e.HasTarget ? (v('HasTarget') ? 1 : 0) : NaN;
    const lat = v('LatencyMs'), fps = v('FPS');
    const faults = Object.entries(c.faults).filter(([, e]) => at(e, t) === 1).map(([k]) => k.replace(/([a-z])([A-Z])/g, '$1 $2'));
    if (connected) {
      if (lat > cfg.camLatencyMs) faults.push(`latency ${Math.round(lat)} ms`);
      if (fps < cfg.camMinFps) faults.push(`${Math.round(fps)} FPS`);
    }
    const lvl = !connected ? 'major' : faults.length ? 'fault' : tags > 0 ? 'ok' : 'warn';
    const text = !connected ? 'OFFLINE' : faults.length ? faults.join(', ') : tags > 0 ? (counted ? `${Math.round(tags)} tag${tags === 1 ? '' : 's'}` : 'tag seen') : 'no tag';
    return { lvl, label: cc.label, text, tags, counted, seen, lat, fps, connected, faults, c, notes: !connected ? [['major', 'Camera not connected']] : faults.map(f => ['fault', f]) };
  }

  // AprilTags a camera sees at time t: [{ id, yaw (degrees, + = left of the camera's center), d (meters) }].
  // The robot logs the arrays every loop (empty when nothing is in view); a camera that stops logging them for
  // 2 s is treated as seeing nothing rather than leaving old tags on screen.
  function tagsAt(c, t) {
    const ye = c.e.TagYawDeg;
    if (!ye || !ye.vals) return [];
    const i = api.Core.idxAt(ye.t, t);
    if (i < 0 || t - ye.t[i] > 2) return [];
    const yaw = ye.vals[i];
    const arr = e => { if (!e || !e.vals) return null; const k = api.Core.idxAt(e.t, t); return k >= 0 && e.vals[k].length === yaw.length ? e.vals[k] : null; };
    const d = arr(c.e.TagDistanceM), ids = arr(c.e.TagIds);
    const out = [];
    for (let k = 0; k < yaw.length; k++) if (isFinite(yaw[k])) out.push({ yaw: yaw[k], d: d ? d[k] : NaN, id: ids ? ids[k] : NaN });
    return out;
  }

  function liveComms() {
    const li = api.liveInfo();
    if (!api.S.isLive && li.state === 'off') return { lvl: 'none', text: 'Log', li };
    if (!api.S.isLive) return { lvl: li.state === 'connected' ? 'warn' : 'major', text: li.state === 'connected' ? 'Wait' : 'Lost', li, notLoaded: true };
    if (li.state === 'connected' && li.loaded) return { lvl: 'ok', text: li.rttMs != null ? `${Math.round(li.rttMs)} ms` : 'OK', li };
    if (li.state === 'connected' || li.state === 'connecting') return { lvl: 'warn', text: 'Wait', li };
    return { lvl: 'major', text: 'Lost', li };
  }

  function nowT() {
    const S = api.S, L = S.log;
    if (!L || !isFinite(L.tMax)) return 0;
    if (S.isLive) return L.tMax;
    return S.cursor ?? S.mechT ?? L.tMax;
  }

  // ---------------- SVG pieces ----------------
  const chip = (id, x, y, w, kind = 'slot', h = 28) => `<g class="chip lvl-none" data-${kind}="${id}" transform="translate(${x},${y})"><rect class="chip-bg" width="${w}" height="${h}" rx="6"/><text class="chip-a" x="8" y="${h / 2 + 5}"></text><text class="chip-b" x="${w - 8}" y="${h / 2 + 5}" text-anchor="end"></text></g>`;

  // Swerve modules sit in the frame's corners with their drive/steer chips beside them. Cameras sit on the bumper
  // outline; the AprilTags each one sees are drawn out past the bumper (see drawTags).
  function driveSVG(c) {
    const { cx, cy, fw, fh, bo } = DR, x0 = cx - fw / 2, y0 = cy - fh / 2, POD = 50, IN = 6, CW = 66;
    const pod = (m, px, py) => `<g transform="translate(${px},${py})"><rect x="-25" y="-25" width="50" height="50" rx="9" class="pod"/>
      <circle r="20.5" class="st s" data-part="${m}s" stroke-width="5" fill="none"/>
      <g data-wheel="${m}"><rect x="-7" y="-16" width="14" height="32" rx="4" class="st f" data-part="${m}d"/><path d="M0-11v-7" class="wheel-dir"/></g></g>`;
    const left = x0 + IN + POD / 2, right = x0 + fw - IN - POD / 2, top = y0 + IN + POD / 2, bot = y0 + fh - IN - POD / 2;
    const P = { FL: [left, top], FR: [right, top], BL: [left, bot], BR: [right, bot] };
    const chipX = { FL: x0 + IN + POD + 5, BL: x0 + IN + POD + 5, FR: x0 + fw - IN - POD - 5 - CW, BR: x0 + fw - IN - POD - 5 - CW };
    const chips = MODS.map(m => chip(m + 'd', chipX[m], P[m][1] - 27, CW, 'slot', 26) + chip(m + 's', chipX[m], P[m][1] + 1, CW, 'slot', 26)).join('');
    const cams = c.camView.map((cc, i) => `<g class="cam lvl-none" data-cam="${i}" transform="translate(${cc.x},${cc.y}) rotate(${cc.a})"><path d="M0 0L-26.4-37.7A46 46 0 0 1 26.4-37.7Z" class="fov"/><rect x="-12" y="-9" width="24" height="18" rx="5" class="cam-body"/><text y="4.5" text-anchor="middle" class="cam-n" transform="rotate(${-cc.a})">${i + 1}</text></g>`).join('');
    const legend = c.camView.map((cc, i) => `<g class="cam-leg lvl-none" data-camleg="${i}" data-x="${i ? 214 : 6}" transform="translate(${i ? 214 : 6},372)"><rect class="chip-bg" width="200" height="30" rx="6"/><text class="chip-a" x="10" y="20">${i + 1} · ${esc(cc.label)}</text><text class="chip-b" x="192" y="20" text-anchor="end"></text></g>`).join('');
    const by = y0 - bo;
    return `<svg viewBox="0 0 420 406" class="mv-svg" data-drive="1" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Drive base">
      <text x="${cx}" y="${by - 12}" text-anchor="middle" class="front-lab">FRONT</text>
      <rect x="${x0 - bo}" y="${by}" width="${fw + 2 * bo}" height="${fh + 2 * bo}" rx="14" class="bumper" data-bumper="1"/>
      <path d="M${cx - 10} ${by + 4}L${cx} ${by - 7}L${cx + 10} ${by + 4}Z" class="front-mark"/>
      <rect x="${x0}" y="${y0}" width="${fw}" height="${fh}" rx="8" class="frame"/>
      ${MODS.map(m => pod(m, ...P[m])).join('')}
      <g transform="translate(${cx},${cy - 6})"><circle r="24" class="compass"/><g data-heading="1"><path d="M0-31L5-23H-5Z" class="needle"/></g><text y="4" text-anchor="middle" class="ro-tiny hdg" data-ro="hdg"></text></g>
      <text x="${cx}" y="${cy + 38}" text-anchor="middle" class="ro-small" data-ro="speed"></text>
      <g data-tags="1"></g>${cams}${chips}${legend}</svg>`;
  }

  // Each tag is drawn along the direction its camera sees it. Distance is squeezed with d / (d + TAG_D0), so a
  // tag 2 m away lands halfway between the camera and the edge of the drawing and far tags still stay in view.
  const TAG_D0 = 2;
  // A tall drive card gets a taller drawing: the robot stays put, the camera legend moves to the bottom and the
  // extra room above and below goes to the tags.
  function fitDrive(el) {
    const svg = el.drive, w = svg.clientWidth, h = svg.clientHeight;
    const dy = w > 0 && h > 0 ? Math.round(Math.max(0, Math.min(160, (420 * h / w - 406) / 2))) : 0;
    if (dy === DR.dy && svg.dataset.fit) return;
    DR.dy = dy; svg.dataset.fit = '1';
    svg.setAttribute('viewBox', `0 ${-dy} 420 ${406 + 2 * dy}`);
    for (const l of el.camLeg) l.g.setAttribute('transform', `translate(${l.g.dataset.x},${372 + dy})`);
    el.tags.dataset.k = '';
  }
  function drawTags(el, c, camS) {
    fitDrive(el);
    const parts = [], y0 = 12 - DR.dy, y1 = DR.top + DR.dy - 12;
    camS.forEach((cs, i) => {
      const v = c.camView[i];
      for (const g of cs.seen || []) {
        const th = (v.a - g.yaw) * Math.PI / 180, ux = Math.sin(th), uy = -Math.cos(th), m = 12;
        const room = Math.max(0, Math.min(ux > 1e-6 ? (DR.w - m - v.x) / ux : ux < -1e-6 ? (m - v.x) / ux : Infinity, uy > 1e-6 ? (y1 - v.y) / uy : uy < -1e-6 ? (y0 - v.y) / uy : Infinity));
        const near = Math.min(room, 26), L = near + (room - near) * (isFinite(g.d) && g.d >= 0 ? g.d / (g.d + TAG_D0) : 0.5);
        parts.push({ lvl: cs.lvl, x: v.x + ux * L, y: v.y + uy * L, x0: v.x + ux * 14, y0: v.y + uy * 14, ux, id: g.id, d: g.d });
      }
    });
    const key = parts.map(p => [p.lvl, Math.round(p.x), Math.round(p.y), p.id, isFinite(p.d) ? p.d.toFixed(1) : ''].join()).join(';');
    if (el.tags.dataset.k === key) return;
    el.tags.dataset.k = key;
    el.tags.innerHTML = parts.map(p => {
      // distance label beside the tag, on the side away from the camera unless that runs off the drawing
      const right = p.ux > 0.05 ? p.x < DR.w - 60 : p.ux < -0.05 ? p.x < 60 : p.x < DR.w - 60;
      const lx = right ? p.x + 13 : p.x - 13, ly = p.y + 4, anchor = right ? 'start' : 'end';
      return `<g class="tag lvl-${p.lvl}"><path d="M${p.x0.toFixed(1)} ${p.y0.toFixed(1)}L${p.x.toFixed(1)} ${p.y.toFixed(1)}" class="tag-ray"/>
        <g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><rect x="-9" y="-9" width="18" height="18" rx="2" class="tag-sq"/>${isFinite(p.id) ? `<text y="3.5" text-anchor="middle" class="tag-id">${Math.round(p.id)}</text>` : '<rect x="-4" y="-4" width="8" height="8" class="tag-in"/>'}</g>
        ${isFinite(p.d) ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" class="tag-d">${p.d.toFixed(1)} m</text>` : ''}</g>`;
    }).join('');
  }

  function shooterSVG(c) {
    const fws = ['fw1', 'fw2', 'fw3', 'fw4'].filter((s, i) => i === 0 || c.roles[s]);
    const left = [['turret', 70], ['hood', 104], ['kicker', 138]].map(([id, y]) => chip(id, 4, y, 98)).join('');
    const right = fws.map((id, i) => chip(id, 318, 70 + 34 * i, 98)).join('');
    return `<svg viewBox="0 0 420 406" class="mv-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Shooter and turret">
      <text x="210" y="40" text-anchor="middle" class="front-lab">▲ ROBOT FRONT</text>
      <g transform="translate(210,180)">
        <circle r="104" class="st s" data-part="turret" stroke-width="10" fill="none"/>
        <path d="M0-118V-92" class="tick"/>
        <g data-tset="1"><path d="M0-30V-122" class="setpt"/></g>
        <g data-turret="1">
          <circle r="90" class="plate"/>
          <rect x="-40" y="-78" width="80" height="120" rx="10" class="body"/>
          <rect x="-48" y="-72" width="96" height="24" rx="12" class="st f" data-part="fw"/>
          <path d="M-44-84Q0-108 44-84" class="st s" data-part="hood" stroke-width="8" fill="none" stroke-linecap="round"/>
          <rect x="-30" y="-12" width="60" height="16" rx="6" class="st f" data-part="kicker"/>
          <path d="M0-100V-140M-8-128L0-142L8-128" class="exit"/>
        </g>
      </g>
      ${left}${right}
      <g class="stat" transform="translate(70,330)"><text class="stat-k" text-anchor="middle">TURRET</text><text y="30" class="stat-v" text-anchor="middle" data-ro="turret"></text><text y="50" class="ro-tiny" text-anchor="middle" data-ro="turretSet"></text></g>
      <g class="stat" transform="translate(210,330)"><text class="stat-k" text-anchor="middle">FLYWHEEL RPM</text><text y="30" class="stat-v" text-anchor="middle" data-ro="rpm"></text><text y="50" class="ro-tiny" text-anchor="middle" data-ro="rpmSub"></text></g>
      <g class="stat" transform="translate(350,330)"><text class="stat-k" text-anchor="middle">HOOD</text><text y="30" class="stat-v" text-anchor="middle" data-ro="hood"></text><text y="50" class="ro-tiny" text-anchor="middle" data-ro="hoodSet"></text></g>
    </svg>`;
  }

  function intakeSVG(c) {
    const spokes = [0, 60, 120].map(a => `<path d="M0-17V17" transform="rotate(${a})"/>`).join('');
    return `<svg viewBox="0 0 420 406" class="mv-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Intake and indexer, side view">
      <text x="12" y="40" class="front-lab">◀ FRONT</text>
      <text x="408" y="40" text-anchor="end" class="ro-tiny">to shooter ▲</text>
      <path d="M0 300H420" class="ground"/>
      <rect x="150" y="96" width="250" height="194" rx="10" class="frame"/>
      <g data-deploy="1">
        <rect x="116" y="252" width="124" height="12" rx="6" class="st f" data-part="deploy"/>
        <g transform="translate(116,262)"><circle r="26" class="st f" data-part="intake"/><g class="spokes" data-spin="intake">${spokes}</g></g>
      </g>
      <path d="M196 252L300 168" class="st s belt" data-part="idx1" stroke-width="16" stroke-linecap="round" fill="none"/>
      <path d="M300 168L352 92" class="st s belt" data-part="idx2" stroke-width="16" stroke-linecap="round" fill="none"/>
      <circle cx="196" cy="252" r="9" class="idler"/><circle cx="300" cy="168" r="9" class="idler"/><circle cx="352" cy="92" r="9" class="idler"/>
      <g data-spin-belt="1" class="belt-dots"></g>
      ${c.mech.deploy ? '<text x="12" y="78" class="stat-k">DEPLOY</text><text x="12" y="104" class="stat-v sm" data-ro="deploy"></text><text x="12" y="122" class="ro-tiny" data-ro="deploySet"></text>' : ''}
      ${chip('intake', 6, 320, 200)}${chip('deploy', 214, 320, 200)}${chip('idx1', 6, 356, 200)}${chip('idx2', 214, 356, 200)}
    </svg>`;
  }

  // ---------------- icons ----------------
  const IC = {
    robot: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/>',
    ds: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
    fms: '<path d="M4.5 9.5a11 11 0 0 1 15 0M7.5 13a6.5 6.5 0 0 1 9 0"/><circle cx="12" cy="17" r="1.6"/>',
    pad: '<path d="M7 7.5h10a4 4 0 0 1 4 4.6l-.7 3.8a2.4 2.4 0 0 1-4.2 1.1L14.4 15H9.6l-1.7 2a2.4 2.4 0 0 1-4.2-1.1L3 12.1a4 4 0 0 1 4-4.6z"/><path d="M8 10.2v3.2M6.4 11.8h3.2"/><circle cx="15.6" cy="11" r=".9"/><circle cx="17.4" cy="12.8" r=".9"/>',
    cam: '<rect x="2.5" y="7" width="13" height="10" rx="2"/><path d="m15.5 11 5.5-3.2v8.4L15.5 13"/>',
    can: '<path d="M2.5 12h19M7 12V7.5M12 12v4.5M17 12V7.5"/><circle cx="7" cy="6" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="17" cy="6" r="1.6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const icon = (k, cls = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${IC[k]}</svg>`;

  // ---------------- build ----------------
  function build() {
    const h = api.h, c = ctx();
    const root = document.getElementById('matchView');
    const status = (k, ic, label) => `<div class="mv-ic none" data-ic="${k}" title="">${icon(ic)}<span class="lab">${label}</span><span class="val" data-icv="${k}"></span></div>`;
    root.innerHTML = `
      <header class="mv-top">
        <div class="mv-box mv-id"><b data-ro="id">7763</b><span data-ro="sub"></span></div>
        <div class="mv-box mv-phase"><span class="ph-name" data-ro="phase">—</span><span class="mv-timer" data-ro="timer">—</span></div>
        <div class="mv-box mv-icons">
          ${status('comms', 'robot', 'Robot')}${status('ds', 'ds', 'DS')}${status('fms', 'fms', 'FMS')}
          <span class="sep"></span>${status('js0', 'pad', 'Driver')}${status('js1', 'pad', 'Operator')}
          <span class="sep"></span>${status('cam0', 'cam', esc(c.camView[0].label))}${status('cam1', 'cam', esc(c.camView[1].label))}
          <span class="sep"></span>${status('can', 'can', 'CAN')}
        </div>
        <div class="mv-box mv-batt" data-batt="1"><div><span class="k">Battery</span><b data-ro="batt">—</b></div><svg viewBox="0 0 120 40" preserveAspectRatio="none" class="spark"><path data-spark="batt"/><path data-spark="battWarn" class="thr"/></svg></div>
        <div class="mv-btns"><button class="btn small" data-act="setup" title="Set up motors, cameras and window">${icon('gear')}Setup</button><button class="btn small" data-act="exit" title="Back to the full app">${icon('x')}Exit</button></div>
      </header>
      <div class="mv-main">
        <section class="mv-box mv-card" data-mech="drive"><h2>Drive base<span class="sum" data-sum="drive"></span></h2>${driveSVG(c)}</section>
        <section class="mv-box mv-card" data-mech="shooter"><h2>Shooter / turret<span class="sum" data-sum="shooter"></span></h2>${shooterSVG(c)}</section>
        <section class="mv-box mv-card" data-mech="intake"><h2>Intake / indexer<span class="sum" data-sum="intake"></span></h2>${intakeSVG(c)}</section>
        <div class="mv-side">
          <section class="mv-box mv-card mv-power"><h2>Power</h2>
            <div class="mv-kv"><span>Total current</span><b data-ro="amps">—</b></div>
            <div class="mv-kv"><span>Lowest this match</span><b data-ro="battMin">—</b></div>
            <div class="mv-kv"><span>Brownouts</span><b data-ro="brown">—</b></div>
          </section>
          <section class="mv-box mv-card mv-can"><h2>CAN bus<span class="sum" data-ro="canPct"></span></h2>
            <div class="mv-bar"><i data-ro="canBar"></i></div>
            <div class="mv-buses" data-ro="buses"></div>
            <div class="mv-kv"><span>Errors (last 10 s)</span><b data-ro="canErr">—</b></div>
            <div class="mv-kv"><span>Loop time</span><b data-ro="loop">—</b></div>
          </section>
          <section class="mv-box mv-card mv-faults"><h2>Active faults<span class="sum" data-ro="fcount"></span></h2><div class="mv-flist" data-ro="faults"></div><div class="mv-fnote" data-ro="fnote"></div></section>
        </div>
      </div>
      <footer class="mv-foot" data-ro="foot"></footer>
      <div class="mv-banner" data-ro="banner" hidden></div>
      <div class="tip mv-tip" hidden></div>
      <div class="mv-setup" hidden></div>`;
    const q = s => root.querySelector(s);
    st.el = {
      root, q, tip: q('.mv-tip'),
      ro: Object.fromEntries([...root.querySelectorAll('[data-ro]')].map(e => [e.dataset.ro, e])),
      ic: Object.fromEntries([...root.querySelectorAll('[data-ic]')].map(e => [e.dataset.ic, e])),
      icv: Object.fromEntries([...root.querySelectorAll('[data-icv]')].map(e => [e.dataset.icv, e])),
      chips: [...root.querySelectorAll('[data-slot]')].map(g => ({ g, id: g.dataset.slot, a: g.querySelector('.chip-a'), b: g.querySelector('.chip-b') })),
      parts: [...root.querySelectorAll('[data-part]')],
      cams: [...root.querySelectorAll('[data-cam]')], camLeg: [...root.querySelectorAll('[data-camleg]')].map(g => ({ g, b: g.querySelector('.chip-b') })),
      sum: Object.fromEntries([...root.querySelectorAll('[data-sum]')].map(e => [e.dataset.sum, e])),
      wheels: Object.fromEntries([...root.querySelectorAll('[data-wheel]')].map(e => [e.dataset.wheel, e])),
      spark: Object.fromEntries([...root.querySelectorAll('[data-spark]')].map(e => [e.dataset.spark, e])),
      heading: q('[data-heading]'), turret: q('[data-turret]'), tset: q('[data-tset]'), deploy: q('[data-deploy]'), tags: q('[data-tags]'), drive: q('[data-drive]'), spin: q('[data-spin="intake"]'), bumper: q('[data-bumper]'), batt: q('[data-batt]'),
    };
    root.querySelector('[data-act="setup"]').onclick = () => openSetup();
    root.querySelector('[data-act="exit"]').onclick = () => close();
    root.querySelector('.mv-main').addEventListener('pointermove', onHover);
    root.querySelector('.mv-main').addEventListener('pointerleave', () => { st.hover = null; st.el.tip.hidden = true; });
    st.built = buildKey(c);
    st.footKey = '';
    renderFoot();
  }

  const buildKey = c => c.key + '|' + JSON.stringify(Object.values(c.roles)) + '|' + c.camView.map(v => [v.label, v.mount, v.x, v.y, v.a].join(':')).join() + '|' + api.S.log.fileName + '|' + !!c.mech.deploy;

  // ---------------- per-frame update ----------------
  const setLvl = (el, lvl) => { const cls = el.getAttribute('class').replace(/\blvl-\w+/g, '').trim() + ' lvl-' + lvl; if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); };
  const setText = (el, s) => { if (el && el.textContent !== s) el.textContent = s; };
  const fmt = (v, d) => api.fmt(v, d);
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const cleanUnit = u => String(u || '').replace(/["']/g, '').trim();
  const toDeg = (v, unit) => (/^rot/i.test(cleanUnit(unit)) ? v * 360 : /^rad/i.test(cleanUnit(unit)) ? v * 180 / Math.PI : v);

  function update() {
    const S = api.S;
    if (!st.open || !S.log || !S.sum) return;
    const c = ctx();
    if (buildKey(c) !== st.built) build();
    const el = st.el, t = nowT(), L = S.limits;
    const comms = liveComms();
    const stale = (S.isLive || comms.notLoaded) && comms.lvl !== 'ok';
    el.root.classList.toggle('stale', stale);

    // header
    const info = S.sum.info;
    setText(el.ro.id, S.isLive ? (info.match || 'LIVE') : (info.match || 'LOG'));
    setText(el.ro.sub, [info.event, info.alliance, S.isLive ? (comms.li.sim ? 'simulated' : comms.li.host) : S.isSample ? 'sample match' : S.log.fileName].filter(Boolean).join(' · '));
    const en = at(E('DS:enabled'), t) === 1, au = at(E('DS:autonomous'), t) === 1, te = at(E('DS:test'), t) === 1, es = at(E('DS:estop'), t) === 1;
    const phase = es ? ['E-STOP', 'estop'] : !en ? ['DISABLED', 'dis'] : au ? ['AUTO', 'auto'] : te ? ['TEST', 'test'] : ['TELEOP', 'tele'];
    setText(el.ro.phase, phase[0]); el.ro.phase.className = 'ph-name ' + phase[1];
    let mt = at(E('DS/MatchTime', 'DriverStation/MatchTime'), t), est = false;
    if (!(mt >= 0)) {
      const seg = S.sum.phases.segments.find(s => t >= s.t0 && t < s.t1 + 1e-6);
      if (seg && (seg.mode === 'auto' || seg.mode === 'teleop')) { mt = Math.max(0, (seg.mode === 'auto' ? cfg.autoLen : cfg.teleLen) - (t - seg.t0)); est = true; }
    }
    setText(el.ro.timer, mt >= 0 ? (est ? '~' : '') + mmss(mt) : '—:—');
    el.ro.timer.classList.toggle('low', mt >= 0 && mt <= 20 && phase[1] === 'tele');

    // status icons
    const icSet = (k, lvl, val, title) => { const e = el.ic[k]; if (!e) return; setLvl(e, lvl); e.title = title || ''; setText(el.icv[k], val || ''); };
    icSet('comms', comms.lvl, comms.text, S.isLive ? `NetworkTables ${comms.li.state}${comms.li.host ? ' · ' + comms.li.host : ''}` : 'Showing a log file, not live');
    const dsE = E('DS:ds'), fmsE = E('DS:fms');
    const dsOn = at(dsE, t) === 1;
    icSet('ds', !dsE ? 'none' : dsOn ? 'ok' : 'major', !dsE ? '?' : dsOn ? 'OK' : 'Lost', 'Driver Station attached to the robot');
    icSet('fms', !fmsE ? 'none' : at(fmsE, t) === 1 ? 'ok' : 'none', !fmsE ? '?' : at(fmsE, t) === 1 ? 'OK' : 'Off', 'Field management system');
    const jsState = [];
    for (const p of [0, 1]) {
      const ce = E(`DS/Joystick${p}/Connected`, `DriverStation/Joystick${p}/Connected`), ne = E(`DS/Joystick${p}/Name`);
      const on = at(ce, t) === 1, nm = strAt(ne, t);
      const lvl = !ce ? 'none' : on ? 'ok' : 'major';
      jsState.push({ p, lvl, nm, ce });
      icSet('js' + p, lvl, !ce ? '?' : on ? `USB ${p}` : 'Unplugged', !ce ? `Publish DS/Joystick${p}/Connected from the robot (see robot-code/MatchTelemetry.java)` : `Port ${p}${nm ? ': ' + nm : ''}`);
    }
    const camS = c.camView.map((cc, i) => camNow(c.camSel[i], t, cc));
    camS.forEach((cs, i) => icSet('cam' + i, cs.lvl, cs.lvl === 'none' ? '?' : cs.lvl === 'major' ? 'Off' : cs.lvl === 'ok' ? (isFinite(cs.tags) && cs.counted ? `${Math.round(cs.tags)} tag` : 'Tag') : cs.lvl === 'warn' ? 'No tag' : 'Fault', cs.c ? `${cs.label} (${cs.c.name}): ${cs.text}` : `${cs.label}: no camera data. Log Vision/<name>/Connected and TagCount (see Setup).`));

    // motors
    const mstate = {};
    for (const s of ALL_SLOTS) mstate[s.id] = motorNow(c.roles[s.id], t);
    const allMotors = S.sum.motors.map(m => motorNow(m.name, t));
    for (const ch of el.chips) {
      const ms = mstate[ch.id], d = slotDef(ch.id), wide = ch.g.querySelector('.chip-bg').getAttribute('width') >= 150;
      setLvl(ch.g, ms.lvl);
      const id = ms.canId != null ? String(ms.canId) : '';
      const a = wide ? `${d.short}${id ? ' · ' + id : ''}` : `${d.short}${id ? (d.short.length > 1 ? ' ' : '') + id : ''}`;
      const b = ms.lvl === 'none' ? '—' : ms.lvl === 'missing' ? '?' : ms.lvl === 'major' ? 'OFF' : wide ? `${isFinite(ms.temp) ? Math.round(ms.temp) + '°' : ''} ${isFinite(ms.sup) ? Math.round(Math.abs(ms.sup)) + 'A' : ''}`.trim() : isFinite(ms.temp) ? Math.round(ms.temp) + '°' : 'OK';
      setText(ch.a, a); setText(ch.b, b);
    }
    const fwLvl = worst(['fw1', 'fw2', 'fw3', 'fw4'].map(s => mstate[s].lvl));
    for (const p of el.parts) { const k = p.dataset.part; setLvl(p, k === 'fw' ? fwLvl : (mstate[k] || { lvl: 'none' }).lvl); }
    const mechLvl = { drive: worst(SLOTS.drive.map(s => mstate[s.id].lvl)), shooter: worst(SLOTS.shooter.map(s => mstate[s.id].lvl)), intake: worst(SLOTS.intake.map(s => mstate[s.id].lvl)) };
    const count = ids => { const a = ids.filter(id => c.roles[id]); return `${a.filter(id => mstate[id].lvl === 'ok').length}/${a.length} ok`; };
    setText(el.sum.drive, count(SLOTS.drive.map(s => s.id)));
    setText(el.sum.shooter, count(SLOTS.shooter.map(s => s.id)));
    setText(el.sum.intake, count(SLOTS.intake.map(s => s.id)));
    for (const k of ['drive', 'shooter', 'intake']) setLvl(el.root.querySelector(`[data-mech="${k}"]`), mechLvl[k]);

    // drive: heading, speed, wheel angles, cameras, bumper color
    const pose = S.sum.poses[0];
    let hdg = NaN, spd = NaN;
    if (pose) {
      // pose arrays can be a snapshot from the last analysis while pose.t keeps growing live, so stay inside both
      const i = Math.min(api.Core.idxAt(pose.t, t), Math.min(pose.r.length, pose.x.length, pose.y.length) - 1);
      if (i >= 0) {
        hdg = pose.r[i] * 180 / Math.PI;
        let k = i; while (k > 0 && pose.t[i] - pose.t[k] < 0.25) k--;
        const dt = pose.t[i] - pose.t[k];
        if (dt > 0.02) { const d = Math.hypot(pose.x[i] - pose.x[k], pose.y[i] - pose.y[k]); spd = d < 1.5 ? d / dt : NaN; }
      }
    }
    el.heading.setAttribute('transform', `rotate(${isFinite(hdg) ? -hdg : 0})`);
    el.heading.style.display = isFinite(hdg) ? '' : 'none';
    setText(el.ro.speed, isFinite(spd) ? `${spd.toFixed(1)} m/s` : '');
    setText(el.ro.hdg, isFinite(hdg) ? `${Math.round(((hdg % 360) + 360) % 360)}°` : '—');
    const angE = E('Drive/ModuleAngles', 'Swerve/ModuleAngles');
    if (angE && angE.vals) { const i = api.Core.idxAt(angE.t, t); const arr = i >= 0 ? angE.vals[i] : null; MODS.forEach((m, k) => el.wheels[m].setAttribute('transform', `rotate(${arr && isFinite(arr[k]) ? -arr[k] : 0})`)); }
    el.bumper.setAttribute('class', 'bumper ' + (info.alliance ? info.alliance.toLowerCase() : ''));
    camS.forEach((cs, i) => { if (el.cams[i]) setLvl(el.cams[i], cs.lvl); if (el.camLeg[i]) { setLvl(el.camLeg[i].g, cs.lvl); setText(el.camLeg[i].b, cs.c ? (cs.text.length > 14 ? cs.text.slice(0, 13) + '…' : cs.text) : 'no data'); } });
    drawTags(el, c, camS);

    // shooter readouts
    const mv = (m, k) => (m && m.entries[k] ? at(m.entries[k], t) : NaN);
    const tm = c.mech.turret, tDeg = toDeg(mv(tm, 'Position'), tm && tm.unit), tSet = toDeg(mv(tm, 'Setpoint'), tm && tm.unit);
    el.turret.setAttribute('transform', `rotate(${isFinite(tDeg) ? -tDeg : 0})`);
    el.tset.setAttribute('transform', `rotate(${isFinite(tSet) ? -tSet : 0})`);
    el.tset.style.display = isFinite(tSet) ? '' : 'none';
    setText(el.ro.turret, isFinite(tDeg) ? `${tDeg.toFixed(0)}°` : '—');
    setText(el.ro.turretSet, isFinite(tSet) ? `goal ${tSet.toFixed(0)}°` : tm ? '' : 'no Mechanisms/Turret');
    const rpms = ['fw1', 'fw2', 'fw3', 'fw4'].map(s => Math.abs(mstate[s].vel)).filter(isFinite);
    const rpm = rpms.length ? Math.max(...rpms) : NaN;
    setText(el.ro.rpm, isFinite(rpm) ? Math.round(rpm).toLocaleString() : '—');
    setText(el.ro.rpmSub, rpms.length > 1 ? `spread ${Math.round(Math.max(...rpms) - Math.min(...rpms))}` : '');
    const hm = c.mech.hood, hPos = mv(hm, 'Position'), hSet = mv(hm, 'Setpoint');
    setText(el.ro.hood, isFinite(hPos) ? fmt(hPos) : isFinite(mstate.hood.vel) ? '—' : '—');
    setText(el.ro.hoodSet, isFinite(hSet) ? `goal ${fmt(hSet)}` : '');

    // intake readouts: deploy fraction from the mechanism's own range, roller spin from its velocity
    const dm = c.mech.deploy, dPos = mv(dm, 'Position'), dSet = mv(dm, 'Setpoint');
    const frac = dm && isFinite(dPos) && dm.max > dm.min ? Math.max(0, Math.min(1, (dPos - dm.min) / (dm.max - dm.min))) : 0;
    el.deploy.setAttribute('transform', `translate(${-frac * 70},0)`);
    if (el.ro.deploy) { setText(el.ro.deploy, isFinite(dPos) ? `${Math.round(frac * 100)}% out` : '—'); setText(el.ro.deploySet, `${fmt(dPos)} ${cleanUnit(dm.unit)}`.trim()); }
    const now = performance.now(), dtR = Math.min(0.2, (now - st.lastRollT) / 1000); st.lastRollT = now;
    const iv = mstate.intake.vel, duty = mstate.intake.duty;
    const spin = isFinite(iv) ? iv : isFinite(duty) ? duty * 5000 : 0;
    st.roller = (st.roller + Math.max(-1, Math.min(1, spin / 6000)) * 720 * dtR) % 360;
    el.spin.setAttribute('transform', `rotate(${st.roller})`);

    // battery
    const bat = E(...api.Core.KEYS.battery), bV = at(bat, t);
    const bo = at(E(...api.Core.KEYS.brownout), t) === 1;
    const bLvl = bo ? 'major' : !isFinite(bV) ? 'none' : bV < L.voltCrit ? 'fault' : bV < L.voltWarn ? 'warn' : 'ok';
    setLvl(el.batt, bLvl);
    setText(el.ro.batt, bo ? 'BROWNOUT' : isFinite(bV) ? `${bV.toFixed(2)} V` : '—');
    spark(el.spark.batt, bat, t, 30, 6, 13.5);
    el.spark.battWarn.setAttribute('d', `M0 ${40 - (L.voltWarn - 6) / 7.5 * 40}H120`);
    const cur = at(E(...api.Core.KEYS.current), t);
    setText(el.ro.amps, isFinite(cur) ? `${Math.round(cur)} A` : '—');
    let bmin = NaN;
    if (bat) { const phases = S.sum.phases.enabled; for (let i = 0; i < bat.t.length && bat.t[i] <= t; i++) if (!phases.length || phases.some(([a, b]) => bat.t[i] >= a && bat.t[i] < b)) bmin = isFinite(bmin) ? Math.min(bmin, bat.v[i]) : bat.v[i]; }
    setText(el.ro.battMin, isFinite(bmin) ? `${bmin.toFixed(2)} V` : '—');
    const boE = E(...api.Core.KEYS.brownout);
    const boCount = S.sum.brownouts.filter(x => x <= t).length;
    setText(el.ro.brown, boE ? String(boCount) : '—');
    el.ro.brown.className = boCount ? 'bad' : '';

    // CAN
    const canE = E(...api.Core.KEYS.can); let canP = at(canE, t);
    if (isFinite(canP) && S.sum.canScale === 100) canP *= 100; else if (isFinite(canP) && canP <= 1.0001) canP *= 100;
    setText(el.ro.canPct, isFinite(canP) ? `${Math.round(canP)}%` : '');
    el.ro.canBar.style.width = isFinite(canP) ? Math.min(100, canP) + '%' : '0';
    el.ro.canBar.className = canP > L.canWarn ? 'warn' : '';
    const errE = [E(...api.Core.KEYS.canTxErr), E(...api.Core.KEYS.canRxErr)].filter(Boolean);
    const errs = errE.reduce((q, e) => { const a = at(e, t), b = at(e, t - 10); return q + (isFinite(a) ? a - (isFinite(b) ? b : e.v[0]) : 0); }, 0);
    setText(el.ro.canErr, errE.length ? String(Math.max(0, Math.round(errs))) : '—');
    el.ro.canErr.className = errs > 0 ? 'warn' : '';
    const loop = at(E(...api.Core.KEYS.loop), t);
    setText(el.ro.loop, isFinite(loop) ? `${loop.toFixed(0)} ms` : '—');
    el.ro.loop.className = loop > L.loopMs ? 'warn' : '';
    const buses = new Map();
    for (const ms of allMotors) { const b = ms.bus || 'CAN'; if (!buses.has(b)) buses.set(b, { on: 0, n: 0, off: [] }); const x = buses.get(b); x.n++; if (ms.online) x.on++; else x.off.push(ms); }
    const busKey = [...buses].map(([b, x]) => `${b}:${x.on}/${x.n}`).join('|');
    if (el.ro.buses.dataset.k !== busKey) {
      el.ro.buses.dataset.k = busKey;
      el.ro.buses.innerHTML = [...buses].sort().map(([b, x]) => `<div class="bus lvl-${x.on === x.n ? 'ok' : x.n - x.on >= 3 ? 'major' : 'fault'}"><i></i><span>${esc(b)}</span><b>${x.on}/${x.n} online</b></div>`).join('') || '<div class="hint">No motors reporting</div>';
    }
    const offCount = allMotors.filter(m => !m.online).length;
    icSet('can', offCount >= 3 ? 'major' : offCount ? 'fault' : canP > L.canWarn || errs > 0 ? 'warn' : isFinite(canP) || allMotors.length ? 'ok' : 'none',
      offCount ? `${offCount} off` : isFinite(canP) ? `${Math.round(canP)}%` : 'OK', `${offCount} motor${offCount === 1 ? '' : 's'} off the bus${isFinite(canP) ? ` · ${Math.round(canP)}% utilization` : ''}`);

    // active faults
    const F = [];
    if (comms.lvl === 'major') F.push(['major', 'No robot comms', `Can't reach ${comms.li.host || 'the robot'}. ${comms.notLoaded ? `Showing the ${S.isSample ? 'sample match' : 'open log'}, not the robot.` : 'Data shown is the last received.'}`]);
    if (dsE && !dsOn) F.push(['major', 'Driver Station not connected to robot', '']);
    if (es) F.push(['major', 'E-stopped', '']);
    if (bo) F.push(['major', 'Brownout', 'Motor outputs are cut until voltage recovers.']);
    else if (bLvl === 'fault' || bLvl === 'warn') F.push([bLvl, `Battery ${bV.toFixed(2)} V`, bLvl === 'fault' ? `Below ${L.voltCrit} V` : `Below ${L.voltWarn} V`]);
    for (const j of jsState) if (j.lvl === 'major') F.push(['major', `${j.p ? 'Operator' : 'Driver'} controller unplugged`, `USB port ${j.p}`]);
    camS.forEach((cs, i) => { if (cs.lvl === 'major' || cs.lvl === 'fault') F.push([cs.lvl, `Camera ${i + 1} (${cs.label}): ${cs.text}`, cs.c ? cs.c.name : '']); });
    const slotOf = new Map(Object.entries(c.roles).filter(([, n]) => n).map(([s, n]) => [n, s]));
    for (const ms of allMotors) for (const [lvl, txt] of ms.notes) {
      const s = slotOf.get(ms.name);
      F.push([lvl, `${ms.canId != null ? 'CAN ' + ms.canId + ' · ' : ''}${ms.name}`, txt + (s ? ` · ${slotDef(s).label}` : '')]);
    }
    for (const s of ALL_SLOTS) if (mstate[s.id].lvl === 'missing') F.push(['warn', `${s.label}: no data`, `Assigned to "${c.roles[s.id]}". Check Setup.`]);
    if (canP > L.canWarn) F.push(['warn', `CAN bus ${Math.round(canP)}%`, `Above ${L.canWarn}%`]);
    F.sort((a, b) => LVL_RANK[b[0]] - LVL_RANK[a[0]]);
    const fKey = F.map(f => f.join('|')).join('#');
    if (el.ro.faults.dataset.k !== fKey) {
      el.ro.faults.dataset.k = fKey;
      el.ro.faults.innerHTML = F.length ? F.map(([lvl, a, b]) => `<div class="mv-f lvl-${lvl}"><i></i><div><b>${esc(a)}</b>${b ? `<span>${esc(b)}</span>` : ''}</div></div>`).join('')
        : `<div class="mv-allok"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3.5 8.5 3 3 6-7"/></svg>No active faults</div>`;
      setText(el.ro.fcount, F.length ? String(F.length) : '');
    }
    const earlier = S.sum.flags.filter(f => f.t <= t).length;
    setText(el.ro.fnote, earlier ? `${earlier} issue${earlier === 1 ? '' : 's'} logged so far this ${S.isLive ? 'session' : 'match'} (see Report)` : '');

    // banner when the robot is unreachable
    const ban = el.ro.banner;
    if (stale) {
      const li = comms.li;
      ban.hidden = false;
      ban.innerHTML = `${li.state === 'connected' ? 'Waiting for robot data…' : li.state === 'off' ? 'Not connected to the robot' : 'No robot comms'}<small>${esc(li.host || '')}${comms.notLoaded ? ` · showing ${S.isSample ? 'the sample match' : 'the open log'}` : ' · showing the last data received'}</small>`;
      ban.className = 'mv-banner ' + (comms.lvl === 'major' ? 'lvl-major' : 'lvl-warn');
    } else ban.hidden = true;

    renderFoot();
    if (st.hover) showTip(st.hover.target, st.hover.x, st.hover.y, mstate, camS);
  }

  function spark(path, e, t, span, lo, hi) {
    if (!e || !e.v || !e.t.length) { path.setAttribute('d', ''); return; }
    const t0 = t - span; let i = Math.max(0, api.Core.idxAt(e.t, t0)); const end = api.Core.idxAt(e.t, t);
    const step = Math.max(1, Math.floor((end - i) / 120));
    let d = '';
    for (; i <= end; i += step) { const x = (e.t[i] - t0) / span * 120, y = 40 - (Math.max(lo, Math.min(hi, e.v[i])) - lo) / (hi - lo) * 40; d += (d ? 'L' : 'M') + Math.max(0, x).toFixed(1) + ' ' + y.toFixed(1); }
    path.setAttribute('d', d);
  }

  // ---------------- footer: live connect / log replay ----------------
  function renderFoot() {
    const S = api.S, foot = st.el.ro.foot, li = api.liveInfo();
    const mode = S.isLive ? 'live:' + li.state + li.loaded : li.state !== 'off' ? 'connecting:' + li.state : 'log';
    if (mode === 'log') {
      const tt = nowT(), a = S.log.tMin, b = S.log.tMax;
      if (st.footKey !== 'log' + S.log.fileName) {
        st.footKey = 'log' + S.log.fileName;
        foot.innerHTML = `<button class="btn small" data-f="play">${st.playing ? 'Pause' : 'Play'}</button>
          <select class="sel" data-f="rate" aria-label="Playback speed">${[0.5, 1, 2, 4].map(r => `<option value="${r}"${r === st.rate ? ' selected' : ''}>${r}×</option>`).join('')}</select>
          <input type="range" data-f="scrub" min="${a}" max="${b}" step="0.02" value="${tt}" aria-label="Match time">
          <span class="mono" data-f="time"></span>
          <span class="hint">${S.isSample ? 'Sample match' : 'Replaying ' + esc(S.log.fileName)}</span>
          <span class="foot-live">${liveControls()}</span>`;
        const f = k => foot.querySelector(`[data-f="${k}"]`);
        f('play').onclick = () => { st.playing = !st.playing; f('play').textContent = st.playing ? 'Pause' : 'Play'; st.lastFrame = performance.now(); if (st.playing && nowT() >= S.log.tMax - 0.05) api.setCursor(S.log.tMin); };
        f('rate').onchange = e => { st.rate = +e.target.value; };
        f('scrub').oninput = e => { api.setCursor(+e.target.value); update(); };
        wireLive(foot);
      }
      const sc = foot.querySelector('[data-f="scrub"]'); if (sc && document.activeElement !== sc) sc.value = tt;
      const tm = foot.querySelector('[data-f="time"]'); if (tm) setText(tm, `${(tt - a).toFixed(1)} s`);
      return;
    }
    const k = mode + li.host;
    if (li.sim) renderSimNext();
    if (st.footKey === k) return;
    st.footKey = k;
    const on = li.state === 'connected' || li.state === 'connecting' || li.state === 'retrying';
    foot.innerHTML = `<span class="live-dot ${li.state === 'connected' && li.loaded ? 'on' : on ? 'wait' : 'err'}"></span>
      <span>${li.sim && li.state === 'connected' ? 'Simulated match' : li.state === 'connected' ? (li.loaded ? `Live from ${esc(li.host)}` : `Connected to ${esc(li.host)}, waiting for data`) : li.state === 'retrying' ? `Can't reach ${esc(li.host)}:5810, retrying` : li.state === 'connecting' ? `Connecting to ${esc(li.host)}…` : 'Disconnected, showing the last data received'}</span>
      ${li.sim ? '<span class="sim-next mono" data-f="simnext"></span>' : ''}
      <span class="foot-live">${liveControls()}</span>`;
    wireLive(foot);
    if (li.sim) renderSimNext();
  }
  // simulated match: say what's about to break, so it's easy to watch for
  function renderSimNext() {
    const el = st.el.ro.foot.querySelector('[data-f="simnext"]');
    if (!el) return;
    const up = api.simUpcoming();
    setText(el, up.length ? up.map(e => (e.active ? `NOW: ${e.what}` : `in ${Math.ceil(e.inS)} s: ${e.what}`)).join('  ·  ') : 'No more faults this match; a new match starts after it ends');
  }
  function liveControls() {
    const li = api.liveInfo(), on = li.state !== 'off';
    const sim = `<button class="btn small${li.sim ? '' : ' sim'}" data-ip="${api.simHost}" title="A made-up robot running inside the app, with faults on each mechanism at different times">Simulated match</button>`;
    if (!api.canLive) return on ? '<button class="btn small" data-f="disc">Stop simulation</button>' : sim; // in a browser tab only the simulation can run
    return `<input type="text" data-f="host" value="${esc(api.liveHost())}" spellcheck="false" aria-label="Robot address">
      ${api.presets.map(([l, ip]) => (ip === api.simHost ? sim : `<button class="btn small" data-ip="${ip}" title="${ip}">${l}</button>`)).join('')}
      ${on ? `<button class="btn small" data-f="disc">${li.sim ? 'Stop simulation' : 'Disconnect'}</button>` : '<button class="btn small primary" data-f="conn">Connect</button>'}`;
  }
  function wireLive(foot) {
    const host = foot.querySelector('[data-f="host"]');
    foot.querySelectorAll('[data-ip]').forEach(b => { b.onclick = () => { if (host) host.value = b.dataset.ip; api.startLive(b.dataset.ip); st.footKey = ''; }; });
    const d0 = foot.querySelector('[data-f="disc"]'); if (d0) d0.onclick = () => { api.stopLive(); st.footKey = ''; };
    if (!host) return;
    const c = foot.querySelector('[data-f="conn"]'); if (c) c.onclick = () => { api.startLive(host.value.trim()); st.footKey = ''; };
    const d = foot.querySelector('[data-f="disc"]'); if (d) d.onclick = () => { api.stopLive(); st.footKey = ''; };
    host.onkeydown = e => { if (e.key === 'Enter') { api.startLive(host.value.trim()); st.footKey = ''; } };
  }

  // ---------------- tooltip ----------------
  function onHover(e) {
    const tgt = e.target.closest('[data-slot],[data-part],[data-cam],[data-camleg]');
    const box = st.el.root.getBoundingClientRect();
    st.hover = tgt ? { target: tgt, x: e.clientX - box.left, y: e.clientY - box.top } : null;
    if (!tgt) st.el.tip.hidden = true; else update();
  }
  function showTip(tgt, x, y, mstate, camS) {
    const tip = st.el.tip;
    let html = '';
    const ci = tgt.dataset.cam ?? tgt.dataset.camleg;
    if (ci != null) {
      const cs = camS[+ci];
      html = `<div class="tt">Camera ${+ci + 1} · ${esc(cs.label)}</div>` + (cs.c ? `<div class="row">Source<b>${esc(cs.c.name)}</b></div><div class="row">Status<b>${esc(cs.text)}</b></div>${isFinite(cs.lat) ? `<div class="row">Latency<b>${Math.round(cs.lat)} ms</b></div>` : ''}${isFinite(cs.fps) ? `<div class="row">FPS<b>${Math.round(cs.fps)}</b></div>` : ''}${cs.seen.length ? `<div class="row">Tags<b>${esc(cs.seen.map(g => (isFinite(g.id) ? Math.round(g.id) : '?') + (isFinite(g.d) ? ` (${g.d.toFixed(1)} m)` : '')).join(', '))}</b></div>` : ''}` : '<div>No camera data. Pick a source in Setup.</div>');
    } else {
      let id = tgt.dataset.slot || tgt.dataset.part;
      if (id === 'fw') id = ['fw1', 'fw2', 'fw3', 'fw4'].find(s => mstate[s].lvl !== 'none') || 'fw1';
      const ms = mstate[id], d = slotDef(id);
      if (!ms || !d) return;
      const row = (k, v) => (v ? `<div class="row">${k}<b>${esc(v)}</b></div>` : '');
      html = `<div class="tt">${esc(d.label)}</div>` + (ms.lvl === 'none' ? '<div>Not assigned. Pick a motor in Setup.</div>'
        : row('Motor', ms.name) + row('CAN', ms.canId != null ? `${ms.canId}${ms.bus ? ' on ' + ms.bus : ''}` : '') + row('Temp', isFinite(ms.temp) ? `${ms.temp.toFixed(0)} °C` : '')
          + row('Supply', isFinite(ms.sup) ? `${ms.sup.toFixed(1)} A` : '') + row('Stator', isFinite(ms.sta) ? `${ms.sta.toFixed(1)} A` : '') + row('Speed', isFinite(ms.vel) ? `${Math.round(ms.vel)} rpm` : '')
          + (ms.notes.length ? ms.notes.map(([l, n]) => `<div class="note lvl-${l}">${esc(n)}</div>`).join('') : ms.lvl === 'ok' ? '<div class="note lvl-ok">Healthy</div>' : ''));
    }
    if (tip.innerHTML !== html) tip.innerHTML = html;
    tip.hidden = false;
    const W = st.el.root.clientWidth, H = st.el.root.clientHeight;
    tip.style.left = Math.min(W - tip.offsetWidth - 8, x + 14) + 'px';
    tip.style.top = Math.min(H - tip.offsetHeight - 8, y + 14) + 'px';
  }

  // ---------------- setup dialog ----------------
  function openSetup() {
    const box = st.el.root.querySelector('.mv-setup'), c = ctx();
    const names = [...c.motors.values()].map(m => m.name).sort();
    const motorLabel = n => { const m = c.motors.get(n); return m && m.canId != null ? `CAN ${m.canId} · ${n}` : n; };
    const slotRow = s => {
      const o = overrides[s.id], auto = c.auto[s.id];
      return `<label><span>${esc(s.label)}</span><select class="sel" data-slot-sel="${s.id}">
        <option value="__auto"${o === undefined ? ' selected' : ''}>Auto${auto ? ` (${esc(motorLabel(auto))})` : ' (none found)'}</option>
        <option value=""${o === '' ? ' selected' : ''}>None</option>
        ${names.map(n => `<option value="${esc(n)}"${o === n ? ' selected' : ''}>${esc(motorLabel(n))}</option>`).join('')}</select></label>`;
    };
    const mechRow = (k, label) => `<label><span>${label}</span><select class="sel" data-mech-sel="${k}"><option value="__auto"${mechSrc[k] === undefined ? ' selected' : ''}>Auto${c.mech[k] && mechSrc[k] === undefined ? ` (${esc(c.mech[k].name)})` : ''}</option><option value=""${mechSrc[k] === '' ? ' selected' : ''}>None</option>${api.S.sum.mechanisms.map(m => `<option${mechSrc[k] === m.name ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`;
    const camRow = (cc, i) => `<fieldset><legend>Camera ${i + 1}</legend>
      <label><span>Name</span><input type="text" data-cam-label="${i}" value="${esc(cc.label)}" placeholder="${esc(c.camView[i].label)}"></label>
      <label><span>Data</span><select class="sel" data-cam-src="${i}"><option value=""${!cc.src ? ' selected' : ''}>Auto${!cc.src && c.camSel[i] ? ` (${esc(c.camSel[i].name)})` : ''}</option>${c.cams.map(x => `<option value="${esc(x.id)}"${cc.src === x.id ? ' selected' : ''}>${esc(x.name)} (${x.src})</option>`).join('')}</select></label>
      <label><span>Mounted</span><select class="sel" data-cam-mount="${i}"><option value=""${!cc.mount ? ' selected' : ''}>${c.camView[i].mount === 'logged' && !cc.mount ? 'Auto (logged RobotToCamera)' : `Auto from name (${c.camView[i].mount})`}</option>${Object.keys(MOUNTS).map(m => `<option${cc.mount === m ? ' selected' : ''}>${m}</option>`).join('')}</select></label>
      <label><span>Faces</span><select class="sel" data-cam-face="${i}">${Object.keys(FACES).map(m => `<option value="${m}"${cc.face === m ? ' selected' : ''}>${m === 'out' ? 'outward' : m}</option>`).join('')}</select></label></fieldset>`;
    const num = (k, label, step = 1) => `<label><span>${label}</span><input type="number" step="${step}" data-cfg="${k}" value="${cfg[k]}"></label>`;
    box.innerHTML = `<div class="mv-setup-in" role="dialog" aria-label="Match view setup">
      <div class="ph">Match view setup<small>Saved on this laptop. "Auto" matches motors by name, so most of this fills itself in.</small><span class="right"><button class="btn small" data-s="reset">Reset to auto</button><button class="btn small primary" data-s="done">Done</button></span></div>
      <div class="mv-setup-grid">
        <section><h3>Drive base</h3>${SLOTS.drive.map(slotRow).join('')}</section>
        <section><h3>Shooter / turret</h3>${SLOTS.shooter.map(slotRow).join('')}${mechRow('turret', 'Turret angle (Mechanisms/…)')}${mechRow('hood', 'Hood position')}</section>
        <section><h3>Intake / indexer</h3>${SLOTS.intake.map(slotRow).join('')}${mechRow('deploy', 'Intake extension')}</section>
        <section><h3>Cameras</h3>${camCfg.map(camRow).join('')}
          <div class="mv-two">${num('camLatencyMs', 'Fault above (ms)')}${num('camMinFps', 'Fault below (FPS)')}</div>
          <p class="hint">${c.cams.length ? `Found: ${c.cams.map(x => esc(x.name)).join(', ')}.` : 'No camera data yet. Log Vision/&lt;name&gt;/Connected and Vision/&lt;name&gt;/TagCount (robot-code/MatchTelemetry.java), or PhotonVision/Limelight tables are picked up on their own.'} Cameras that log Vision/&lt;name&gt;/RobotToCamera are placed from it, and TagYawDeg / TagDistanceM / TagIds draw the tags they see (logging-needed/match-view-logging.md).</p></section>
        <section><h3>Window and match</h3>
          ${num('dsHeight', 'Leave for Driver Station (px)')}
          <label class="chk"><input type="checkbox" data-cfg-b="autoFit"${cfg.autoFit ? ' checked' : ''}> Fit the window above the Driver Station when match view opens</label>
          <button class="btn small" data-s="fit">Fit window now</button>
          <div class="mv-two">${num('autoLen', 'Auto length (s)')}${num('teleLen', 'Teleop length (s)')}</div>
          <p class="hint">Match lengths are only used when the robot doesn't publish DS/MatchTime.</p></section>
      </div></div>`;
    box.hidden = false;
    const rerender = () => { ctxCache.key = ''; saveCfg(); };
    box.querySelectorAll('[data-slot-sel]').forEach(s => { s.onchange = () => { if (s.value === '__auto') delete overrides[s.dataset.slotSel]; else overrides[s.dataset.slotSel] = s.value; rerender(); }; });
    box.querySelectorAll('[data-mech-sel]').forEach(s => { s.onchange = () => { if (s.value === '__auto') delete mechSrc[s.dataset.mechSel]; else mechSrc[s.dataset.mechSel] = s.value; rerender(); }; });
    box.querySelectorAll('[data-cam-label]').forEach(s => { s.onchange = () => { camCfg[+s.dataset.camLabel].label = s.value.trim(); rerender(); st.built = ''; }; });
    box.querySelectorAll('[data-cam-src]').forEach(s => { s.onchange = () => { camCfg[+s.dataset.camSrc].src = s.value; rerender(); }; });
    box.querySelectorAll('[data-cam-mount]').forEach(s => { s.onchange = () => { camCfg[+s.dataset.camMount].mount = s.value; rerender(); }; });
    box.querySelectorAll('[data-cam-face]').forEach(s => { s.onchange = () => { camCfg[+s.dataset.camFace].face = s.value; rerender(); }; });
    box.querySelectorAll('[data-cfg]').forEach(s => { s.onchange = () => { const v = +s.value; if (isFinite(v)) cfg[s.dataset.cfg] = v; rerender(); }; });
    box.querySelectorAll('[data-cfg-b]').forEach(s => { s.onchange = () => { cfg[s.dataset.cfgB] = s.checked; rerender(); }; });
    box.querySelector('[data-s="fit"]').onclick = () => fitWindow(true);
    box.querySelector('[data-s="reset"]').onclick = () => { overrides = {}; mechSrc = {}; camCfg = CAM_DEFAULT.map(c => ({ ...c })); rerender(); openSetup(); };
    box.querySelector('[data-s="done"]').onclick = () => { box.hidden = true; st.built = ''; update(); };
    box.onpointerdown = e => { if (e.target === box) { box.hidden = true; st.built = ''; update(); } };
  }

  // Size the window to the screen minus the Driver Station strip at the bottom. Browsers only allow this for
  // app/popup windows (the desktop shortcut opens one); in a normal tab it does nothing.
  function fitWindow(manual) {
    try {
      const sx = screen.availLeft || 0, sy = screen.availTop || 0;
      window.moveTo(sx, sy);
      window.resizeTo(screen.availWidth, Math.max(400, screen.availHeight - cfg.dsHeight));
      if (manual) setTimeout(() => { if (Math.abs(window.outerHeight - (screen.availHeight - cfg.dsHeight)) > 40) api.toast('This window can\'t be resized from the page. Use the "7763 Match View" desktop shortcut, or snap the window by hand.'); }, 400);
    } catch { /* not allowed */ }
  }

  // ---------------- open / close / loop ----------------
  function loop() {
    if (!st.open) return;
    const now = performance.now();
    if (st.playing && !api.S.isLive && api.S.log) {
      const dt = Math.min(0.25, (now - st.lastFrame) / 1000) * st.rate;
      const t = nowT() + dt;
      if (t >= api.S.log.tMax) { st.playing = false; st.footKey = ''; }
      api.setCursor(Math.min(t, api.S.log.tMax));
    }
    st.lastFrame = now;
    try { update(); } catch (err) { console.error('match view', err); }
    st.timer = setTimeout(() => requestAnimationFrame(loop), st.playing ? 30 : 90);
  }
  function open(opts = {}) {
    if (st.open) return;
    st.open = true; st.built = '';
    document.body.classList.add('mv-on');
    document.getElementById('matchView').hidden = false;
    const S = api.S;
    if (!S.isLive && S.log && S.cursor == null && S.mechT == null) {
      const first = S.sum.flags.find(f => f.sev === 'crit');
      api.setCursor(first ? first.t + 0.3 : S.log.tMin);
    }
    if (opts.connect && api.canLive && api.liveInfo().state === 'off' && (S.isSample || !S.log)) api.startLive(api.liveHost());
    if (window.FRC_DESKTOP && cfg.autoFit && opts.fit) fitWindow(false);
    try { history.replaceState(null, '', '#matchview'); } catch { /* ignore */ }
    loop();
  }
  function close() {
    st.open = false; st.playing = false; clearTimeout(st.timer);
    document.body.classList.remove('mv-on');
    document.getElementById('matchView').hidden = true;
    try { history.replaceState(null, '', '#' + api.S.tab); } catch { /* ignore */ }
    api.onClose && api.onClose();
  }

  function init(a) {
    api = a; loadCfg();
    return { open, close, isOpen: () => st.open, update };
  }
  return { init, autoAssign, tokens, SLOTS };
})();
if (typeof module !== 'undefined') module.exports = MatchView;
