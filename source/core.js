// ===== core: .wpilog reader/writer, struct decoding, match analysis (no DOM) =====
const Core = (() => {
  const td = new TextDecoder('utf-8');
  const te = new TextEncoder();

  // ---------- reader ----------
  function readUIntLE(u8, p, n) {
    let v = 0, mul = 1;
    for (let k = 0; k < n; k++) { v += u8[p + k] * mul; mul *= 256; }
    return v;
  }

  function classify(type) {
    if (type === 'double' || type === 'float' || type === 'int64') return 'num';
    if (type === 'boolean') return 'bool';
    if (type === 'string' || type === 'json' || type === 'structschema') return 'str';
    if (type === 'double[]' || type === 'float[]' || type === 'int64[]' || type === 'boolean[]') return 'numarr';
    if (type === 'string[]') return 'strarr';
    if (type.startsWith('struct:')) return type.endsWith('[]') ? 'structarr' : 'struct';
    return 'other';
  }

  function parseMeta(meta) {
    if (!meta) return {};
    try { const o = JSON.parse(meta); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }

  function parseWpilog(buffer, fileName = 'log.wpilog') {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (u8.length < 12 || td.decode(u8.subarray(0, 6)) !== 'WPILOG') {
      throw new Error('This is not a WPILib data log. Expected a .wpilog file that starts with "WPILOG".');
    }
    const version = dv.getUint16(6, true);
    if ((version >> 8) !== 1) throw new Error(`Unsupported .wpilog version ${version >> 8}.${version & 255}. This viewer reads version 1.x.`);
    const extraLen = dv.getUint32(8, true);
    const extraHeader = td.decode(u8.subarray(12, 12 + extraLen));
    let p = 12 + extraLen;

    const live = new Map();   // entry id -> entry (current start)
    const entries = [];       // every started entry, in start order
    let records = 0, truncated = false, tMinUs = Infinity, tMaxUs = -Infinity;

    while (p < u8.length) {
      const lb = u8[p];
      const idLen = (lb & 3) + 1, sizeLen = ((lb >> 2) & 3) + 1, tsLen = ((lb >> 4) & 7) + 1;
      const hdr = 1 + idLen + sizeLen + tsLen;
      if (p + hdr > u8.length) { truncated = true; break; }
      const id = readUIntLE(u8, p + 1, idLen);
      const size = readUIntLE(u8, p + 1 + idLen, sizeLen);
      const ts = readUIntLE(u8, p + 1 + idLen + sizeLen, tsLen);
      const d = p + hdr;
      if (d + size > u8.length) { truncated = true; break; }
      p = d + size;
      records++;

      if (id === 0) {
        if (size < 5) continue;
        const kind = u8[d];
        const target = dv.getUint32(d + 1, true);
        if (kind === 0) {
          let q = d + 5;
          const nl = dv.getUint32(q, true); q += 4;
          const name = td.decode(u8.subarray(q, q + nl)); q += nl;
          const tl = dv.getUint32(q, true); q += 4;
          const type = td.decode(u8.subarray(q, q + tl)); q += tl;
          const ml = dv.getUint32(q, true); q += 4;
          const metadata = td.decode(u8.subarray(q, q + ml));
          const e = { name, type, metadata, kind: classify(type), ts: [], vs: [] };
          live.set(target, e);
          entries.push(e);
        } else if (kind === 1) {
          live.delete(target);
        } else if (kind === 2) {
          const e = live.get(target);
          if (e) { const ml = dv.getUint32(d + 5, true); e.metadata = td.decode(u8.subarray(d + 9, d + 9 + ml)); }
        }
        continue;
      }

      const e = live.get(id);
      if (!e) continue;
      if (ts < tMinUs) tMinUs = ts;
      if (ts > tMaxUs) tMaxUs = ts;
      const t = ts / 1e6;
      switch (e.type) {
        case 'double': if (size >= 8) { e.ts.push(t); e.vs.push(dv.getFloat64(d, true)); } break;
        case 'float': if (size >= 4) { e.ts.push(t); e.vs.push(dv.getFloat32(d, true)); } break;
        case 'int64': if (size >= 8) { e.ts.push(t); e.vs.push(Number(dv.getBigInt64(d, true))); } break;
        case 'boolean': if (size >= 1) { e.ts.push(t); e.vs.push(u8[d] ? 1 : 0); } break;
        case 'string': case 'json': case 'structschema':
          e.ts.push(t); e.vs.push(td.decode(u8.subarray(d, d + size))); break;
        case 'double[]': { const n = size >> 3, a = new Float64Array(n); for (let k = 0; k < n; k++) a[k] = dv.getFloat64(d + 8 * k, true); e.ts.push(t); e.vs.push(a); break; }
        case 'float[]': { const n = size >> 2, a = new Float64Array(n); for (let k = 0; k < n; k++) a[k] = dv.getFloat32(d + 4 * k, true); e.ts.push(t); e.vs.push(a); break; }
        case 'int64[]': { const n = size >> 3, a = new Float64Array(n); for (let k = 0; k < n; k++) a[k] = Number(dv.getBigInt64(d + 8 * k, true)); e.ts.push(t); e.vs.push(a); break; }
        case 'boolean[]': { const a = new Float64Array(size); for (let k = 0; k < size; k++) a[k] = u8[d + k] ? 1 : 0; e.ts.push(t); e.vs.push(a); break; }
        case 'string[]': {
          const arr = []; let q = d; const n = dv.getUint32(q, true); q += 4;
          for (let k = 0; k < n && q + 4 <= d + size; k++) { const l = dv.getUint32(q, true); q += 4; arr.push(td.decode(u8.subarray(q, q + l))); q += l; }
          e.ts.push(t); e.vs.push(arr); break;
        }
        default:
          // structs (decoded after all schemas are known), raw, msgpack, protobuf: keep payload view
          e.ts.push(t); e.vs.push(u8.subarray(d, d + size));
      }
    }

    const log = finalize(entries, { fileName, extraHeader, records, truncated, bytes: u8.length });
    log.tMin = isFinite(tMinUs) ? tMinUs / 1e6 : 0;
    log.tMax = isFinite(tMaxUs) ? tMaxUs / 1e6 : 0;
    return log;
  }

  // Merge duplicate names, sort by time, convert to typed arrays, decode structs.
  function finalize(rawEntries, info) {
    const byName = new Map();
    for (const e of rawEntries) {
      const prev = byName.get(e.name);
      if (prev && prev.type === e.type) { for (let i = 0; i < e.ts.length; i++) { prev.ts.push(e.ts[i]); prev.vs.push(e.vs[i]); } prev.metadata = e.metadata || prev.metadata; }
      else byName.set(e.name, e);
    }
    const entries = new Map();
    const schemas = new Map();
    for (const e of byName.values()) {
      sortPairs(e);
      if (e.name.startsWith('/.schema/') && e.vs.length) schemas.set(e.name.slice('/.schema/'.length), String(e.vs[e.vs.length - 1]));
    }
    for (const e of byName.values()) {
      const meta = parseMeta(e.metadata);
      const out = { name: e.name, type: e.type, kind: e.kind, metadata: e.metadata, meta, unit: meta.unit || '', count: e.ts.length };
      out.t = Float64Array.from(e.ts);
      if (e.kind === 'num' || e.kind === 'bool') out.v = Float64Array.from(e.vs);
      else if (e.kind === 'struct') decodeStructEntry(out, e.vs, schemas);
      else out.vals = e.vs;
      entries.set(e.name, out);
    }
    return { ...info, entries, schemas };
  }

  function sortPairs(e) {
    const ts = e.ts;
    let sorted = true;
    for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) { sorted = false; break; }
    if (sorted) return;
    const idx = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
    e.ts = idx.map(i => ts[i]); e.vs = idx.map(i => e.vs[i]);
  }

  // ---------- struct schemas ----------
  const PRIM = { bool: 1, char: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float: 4, float32: 4, double: 8, float64: 8 };
  // Fallback layouts for the common geometry types if a log is missing its schema entries.
  const BUILTIN = {
    Translation2d: 'double x;double y',
    Rotation2d: 'double value',
    Pose2d: 'Translation2d translation;Rotation2d rotation',
    Twist2d: 'double dx;double dy;double dtheta',
    ChassisSpeeds: 'double vx;double vy;double omega',
    SwerveModuleState: 'double speed;Rotation2d angle',
    SwerveModulePosition: 'double distance;Rotation2d angle',
  };

  function parseSchema(text) {
    const fields = [];
    for (let decl of text.split(';')) {
      decl = decl.trim();
      if (!decl) continue;
      if (decl.startsWith('enum')) decl = decl.replace(/^enum\s*\{[^}]*\}\s*/, '');
      if (/:\s*\d+\s*$/.test(decl)) return null; // bit-fields: not supported
      const m = decl.match(/^(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?$/);
      if (!m) return null;
      fields.push({ type: m[1], name: m[2], n: m[3] ? +m[3] : 0 });
    }
    return fields;
  }

  function makeLayout(structName, schemas, depth = 0) {
    if (depth > 16) return null;
    const text = schemas.get('struct:' + structName) ?? BUILTIN[structName];
    if (text == null) return null;
    const fields = parseSchema(text);
    if (!fields) return null;
    const leaves = []; let off = 0;
    for (const f of fields) {
      const count = f.n || 1;
      if (PRIM[f.type]) {
        if (f.type === 'char') { off += PRIM.char * count; continue; }
        for (let k = 0; k < count; k++) {
          leaves.push({ path: f.n ? `${f.name}[${k}]` : f.name, type: f.type, off });
          off += PRIM[f.type];
        }
      } else {
        const sub = makeLayout(f.type, schemas, depth + 1);
        if (!sub) return null;
        for (let k = 0; k < count; k++) {
          const pre = f.n ? `${f.name}[${k}]` : f.name;
          for (const l of sub.leaves) leaves.push({ path: `${pre}/${l.path}`, type: l.type, off: off + l.off });
          off += sub.size;
        }
      }
    }
    return { leaves, size: off };
  }

  function readPrim(dv, off, type) {
    switch (type) {
      case 'bool': case 'uint8': return dv.getUint8(off);
      case 'int8': return dv.getInt8(off);
      case 'int16': return dv.getInt16(off, true);
      case 'uint16': return dv.getUint16(off, true);
      case 'int32': return dv.getInt32(off, true);
      case 'uint32': return dv.getUint32(off, true);
      case 'int64': return Number(dv.getBigInt64(off, true));
      case 'uint64': return Number(dv.getBigUint64(off, true));
      case 'float': case 'float32': return dv.getFloat32(off, true);
      default: return dv.getFloat64(off, true);
    }
  }

  function decodeStructEntry(out, payloads, schemas) {
    out.structName = out.type.slice('struct:'.length);
    const layout = makeLayout(out.structName, schemas);
    out.fields = {};
    if (!layout) { out.undecoded = true; return; }
    const n = payloads.length;
    for (const l of layout.leaves) out.fields[l.path] = new Float64Array(n);
    const keepT = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const b = payloads[i];
      if (b.length < layout.size) continue;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (const l of layout.leaves) out.fields[l.path][j] = readPrim(dv, l.off, l.type);
      keepT.push(out.t[i]); j++;
    }
    if (j !== n) { out.t = Float64Array.from(keepT); for (const k in out.fields) out.fields[k] = out.fields[k].slice(0, j); }
    out.count = j;
  }

  // ---------- writer (sample generation + tests) ----------
  class Writer {
    constructor(extraHeader = '') {
      this.buf = new Uint8Array(1 << 20); this.len = 0; this.nextId = 1;
      const eh = te.encode(extraHeader);
      this.bytes(te.encode('WPILOG')); this.uint(0x0100, 2); this.uint(eh.length, 4); this.bytes(eh);
    }
    grow(n) { if (this.len + n <= this.buf.length) return; let c = this.buf.length; while (c < this.len + n) c *= 2; const b = new Uint8Array(c); b.set(this.buf.subarray(0, this.len)); this.buf = b; }
    bytes(b) { this.grow(b.length); this.buf.set(b, this.len); this.len += b.length; }
    uint(v, n) { this.grow(n); for (let k = 0; k < n; k++) { this.buf[this.len++] = v % 256; v = Math.floor(v / 256); } }
    static nbytes(v, max) { let n = 1; while (n < max && v >= 2 ** (8 * n)) n++; return n; }
    record(id, tUs, payload) {
      tUs = Math.max(0, Math.round(tUs));
      const il = Writer.nbytes(id, 4), sl = Writer.nbytes(payload.length, 4), tl = Writer.nbytes(tUs, 8);
      this.uint((il - 1) | ((sl - 1) << 2) | ((tl - 1) << 4), 1);
      this.uint(id, il); this.uint(payload.length, sl); this.uint(tUs, tl); this.bytes(payload);
    }
    start(name, type, metadata = '', tUs = 0) {
      const id = this.nextId++;
      const n = te.encode(name), ty = te.encode(type), m = te.encode(metadata);
      const p = new Uint8Array(1 + 4 + 4 + n.length + 4 + ty.length + 4 + m.length);
      const dv = new DataView(p.buffer); let q = 0;
      p[q++] = 0; dv.setUint32(q, id, true); q += 4;
      dv.setUint32(q, n.length, true); q += 4; p.set(n, q); q += n.length;
      dv.setUint32(q, ty.length, true); q += 4; p.set(ty, q); q += ty.length;
      dv.setUint32(q, m.length, true); q += 4; p.set(m, q);
      this.record(0, tUs, p);
      return id;
    }
    finish(id, tUs) { const p = new Uint8Array(5); p[0] = 1; new DataView(p.buffer).setUint32(1, id, true); this.record(0, tUs, p); }
    double(id, tUs, v) { const p = new Uint8Array(8); new DataView(p.buffer).setFloat64(0, v, true); this.record(id, tUs, p); }
    bool(id, tUs, v) { this.record(id, tUs, Uint8Array.of(v ? 1 : 0)); }
    int64(id, tUs, v) { const p = new Uint8Array(8); new DataView(p.buffer).setBigInt64(0, BigInt(Math.round(v)), true); this.record(id, tUs, p); }
    string(id, tUs, s) { this.record(id, tUs, te.encode(s)); }
    doubles(id, tUs, arr) { const p = new Uint8Array(arr.length * 8); const dv = new DataView(p.buffer); arr.forEach((v, k) => dv.setFloat64(8 * k, v, true)); this.record(id, tUs, p); }
    result() { return this.buf.slice(0, this.len).buffer; }
  }

  // ---------- time-series helpers ----------
  // index of last sample with t <= x (or -1)
  function idxAt(t, x) {
    let lo = 0, hi = t.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (t[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  function valueAt(t, v, x) { const i = idxAt(t, x); return i < 0 ? NaN : v[i]; }

  // Step-function -> list of [t0,t1] where value is truthy, clipped to [a,b]
  function trueIntervals(t, v, a, b) {
    const out = []; let on = null;
    for (let i = 0; i < t.length; i++) {
      if (v[i] && on === null) on = t[i];
      else if (!v[i] && on !== null) { out.push([on, t[i]]); on = null; }
    }
    if (on !== null) out.push([on, b]);
    return out.map(([x, y]) => [Math.max(x, a), Math.min(y, b)]).filter(([x, y]) => y > x);
  }
  const inAny = (iv, x) => iv.some(([a, b]) => x >= a && x < b);
  const ivLen = iv => iv.reduce((s, [a, b]) => s + b - a, 0);

  // ---------- conventions ----------
  function findEntry(log, ...names) {
    for (const n of names) {
      const e = log.entries.get(n) || log.entries.get('/' + n) || log.entries.get('NT:/' + n)
        || log.entries.get('/Robot/' + n) || log.entries.get('NT:/Robot/' + n);
      if (e) return e;
    }
    return null;
  }
  // "NT:" (NetworkTables capture), a leading "/", and DogLog's "/Robot" table all come off
  function stripPrefix(name) { return name.replace(/^NT:/, '').replace(/^\//, '').replace(/^Robot\//, ''); }
  // Our names first, then DogLog's built-in extras (logExtras + setPdh)
  const KEYS = {
    battery: ['Power/BatteryV', 'SystemStats/BatteryVoltage'],
    current: ['Power/TotalCurrentA', 'SystemStats/PowerDistribution/TotalCurrent'],
    power: ['Power/TotalPowerW', 'SystemStats/PowerDistribution/TotalPower'],
    brownout: ['System/BrownedOut', 'SystemStats/BrownedOut'],
    can: ['System/CANBusUtilization', 'SystemStats/CANBus/Utilization'],
    canTxErr: ['System/CANTxErrorCount', 'SystemStats/CANBus/TransmitErrorCount'],
    canRxErr: ['System/CANRxErrorCount', 'SystemStats/CANBus/ReceiveErrorCount'],
    loop: ['System/LoopTimeMs'],
    pdhTemp: ['Power/PDHTempC', 'SystemStats/PowerDistribution/Temperature'],
    channels: ['Power/ChannelCurrentsA', 'SystemStats/PowerDistribution/ChannelCurrent'],
  };
  const key = (log, k) => findEntry(log, ...KEYS[k]);

  function motorsOf(log) {
    const m = new Map();
    for (const e of log.entries.values()) {
      const n = stripPrefix(e.name);
      if (e.kind !== 'num' && e.kind !== 'bool' && !(e.kind === 'str' && /^Motors\/[^/]+\/(Controller|CANBus)$/.test(n))) continue;
      const f = n.match(/^Motors\/([^/]+)\/Faults\/(\w+)$/);
      const r = f || n.match(/^Motors\/([^/]+)\/(\w+)$/);
      if (!r) continue;
      if (!m.has(r[1])) m.set(r[1], { name: r[1], faults: {} });
      if (f) m.get(r[1]).faults[f[2]] = e; else m.get(r[1])[r[2]] = e;
    }
    return [...m.values()];
  }
  function mechanismsOf(log) {
    const m = new Map();
    for (const e of log.entries.values()) {
      const r = stripPrefix(e.name).match(/^Mechanisms\/([^/]+)\/(\w+)$/);
      if (!r || e.kind !== 'num') continue;
      if (!m.has(r[1])) m.set(r[1], { name: r[1] });
      m.get(r[1])[r[2]] = e;
    }
    return [...m.values()];
  }
  // Pose2d struct entries (any name) plus double[3] entries whose name ends in "Pose"
  function posesOf(log) {
    const out = [];
    for (const e of log.entries.values()) {
      if (e.kind === 'struct' && e.structName === 'Pose2d' && !e.undecoded) {
        out.push({ name: stripPrefix(e.name), t: e.t, x: e.fields['translation/x'], y: e.fields['translation/y'], r: e.fields['rotation/value'] });
      } else if (e.kind === 'numarr' && /pose$/i.test(e.name) && e.vals.length && e.vals[0].length === 3) {
        out.push({ name: stripPrefix(e.name), t: e.t, x: Float64Array.from(e.vals, a => a[0]), y: Float64Array.from(e.vals, a => a[1]), r: Float64Array.from(e.vals, a => a[2]) });
      }
    }
    // the robot's main pose: our convention first, then common names from DogLog / CTRE swerve code
    const PREF = ['Robot/Pose', 'Drive/Pose', 'Swerve/Pose', 'DriveState/Pose', 'Drive/EstimatedPose', 'Odometry/Robot'];
    const rank = n => { const i = PREF.indexOf(n); return i < 0 ? (/pose$/i.test(n) && !/vision|target|camera|tag/i.test(n) ? 50 : 100) : i; };
    out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    return out;
  }

  function matchInfo(log) {
    const info = { event: '', match: '', alliance: '' };
    const f = log.fileName.match(/(?:FRC|WPILib)_(\d{8})_(\d{6})(?:_([A-Za-z0-9]+)_([A-Za-z]*\d+))?/);
    if (f) {
      info.date = `${f[1].slice(0, 4)}-${f[1].slice(4, 6)}-${f[1].slice(6, 8)}`;
      info.time = `${f[2].slice(0, 2)}:${f[2].slice(2, 4)} UTC`;
      if (f[3]) { info.event = f[3]; info.match = f[4]; }
    }
    const last = e => (e && e.count ? (e.v ? e.v[e.v.length - 1] : e.vals[e.vals.length - 1]) : undefined);
    const ev = last(findEntry(log, 'FMSInfo/EventName'));
    const mn = last(findEntry(log, 'FMSInfo/MatchNumber'));
    const mt = last(findEntry(log, 'FMSInfo/MatchType'));
    const red = last(findEntry(log, 'FMSInfo/IsRedAlliance'));
    if (ev) info.event = ev;
    if (mn) info.match = (['', 'P', 'Q', 'E'][mt] || '') + mn;
    if (red !== undefined) info.alliance = red ? 'Red' : 'Blue';
    return info;
  }

  // ---------- phases ----------
  function phasesOf(log) {
    const en = findEntry(log, 'DS:enabled'), au = findEntry(log, 'DS:autonomous'), te_ = findEntry(log, 'DS:test');
    const a = log.tMin, b = log.tMax;
    if (!en) return { hasDS: false, segments: [{ t0: a, t1: b, mode: 'unknown' }], enabled: [[a, b]] };
    const cuts = new Set([a, b]);
    for (const e of [en, au, te_]) if (e) for (const x of e.t) if (x > a && x < b) cuts.add(x);
    const xs = [...cuts].sort((p, q) => p - q);
    const segs = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const mid = xs[i];
      const isEn = valueAt(en.t, en.v, mid) === 1;
      const mode = !isEn ? 'disabled' : (au && valueAt(au.t, au.v, mid) === 1) ? 'auto' : (te_ && valueAt(te_.t, te_.v, mid) === 1) ? 'test' : 'teleop';
      const last = segs[segs.length - 1];
      if (last && last.mode === mode) last.t1 = xs[i + 1]; else segs.push({ t0: xs[i], t1: xs[i + 1], mode });
    }
    return { hasDS: true, segments: segs, enabled: segs.filter(s => s.mode !== 'disabled').map(s => [s.t0, s.t1]) };
  }

  // ---------- analysis ----------
  const DEFAULT_LIMITS = {
    tempWarn: 60, tempCrit: 80,       // motor °C
    voltWarn: 8.0, voltCrit: 7.0,     // battery V while enabled
    loopMs: 22,                       // a loop counts as an overrun above this
    canWarn: 80,                      // CAN bus utilization %
    supplyLimitA: 60, statorLimitA: 120, // used only for motors that don't log their own limits
    ocMinS: 0.1,                      // ignore at-limit blips shorter than this
  };

  // ---------- motor faults ----------
  // [severity, label, what it means]. Names match what TalonFXSource / SparkSource log.
  const FAULT_INFO = {
    // Phoenix 6 (TalonFX)
    Hardware: ['crit', 'Hardware fault', 'The controller reported an internal hardware fault. Replace it before trusting it again.'],
    ProcTemp: ['crit', 'Processor too hot', 'The controller electronics overheated.'],
    DeviceTemp: ['crit', 'Device too hot', 'The controller cut output to protect the motor from heat.'],
    Undervoltage: ['warn', 'Undervoltage', 'Voltage at the controller fell close to brownout. Check battery sag and this controller\'s power wiring.'],
    BootDuringEnable: ['crit', 'Rebooted while enabled', 'The controller lost power or reset during the match. Check its power connector, breaker and wire crimps.'],
    BridgeBrownout: ['crit', 'Bridge brownout', 'The output stage shut off from low voltage, so the motor went limp.'],
    OverSupplyV: ['crit', 'Supply over voltage', 'Supply voltage went above the controller\'s rating.'],
    UnstableSupplyV: ['warn', 'Unstable supply voltage', 'Usually a loose or high-resistance power connection.'],
    StatorCurrLimit: ['warn', 'Stator limit active', 'The controller was clamping motor current.'],
    SupplyCurrLimit: ['warn', 'Supply limit active', 'The controller was clamping battery current.'],
    RemoteSensorDataInvalid: ['crit', 'Remote sensor invalid', 'A remote or fused sensor (such as a CANcoder) stopped reporting, so closed-loop control on it was unreliable.'],
    FusedSensorOutOfSync: ['warn', 'Fused sensor desync', 'The remote sensor and the rotor sensor disagreed.'],
    UnlicensedFeatureInUse: ['warn', 'Unlicensed feature', 'A Phoenix Pro feature ran without a license, so it may have behaved differently.'],
    // REV SPARK faults
    Other: ['crit', 'Other fault', 'The SPARK reported an unclassified fault.'],
    MotorType: ['crit', 'Motor type fault', 'The SPARK\'s configured motor type does not match the motor.'],
    Sensor: ['crit', 'Sensor fault', 'The motor\'s encoder or hall sensor stopped reporting correctly.'],
    CAN: ['crit', 'CAN fault', 'The SPARK reported a CAN communication fault.'],
    Temperature: ['crit', 'Over temperature', 'The SPARK cut output because of heat.'],
    GateDriver: ['crit', 'Gate driver fault', 'The output stage reported a hardware fault.'],
    ESCEeprom: ['crit', 'ESC EEPROM fault', 'The SPARK could not read or write its settings memory.'],
    Firmware: ['crit', 'Firmware fault', 'The SPARK reported a firmware fault.'],
    // REV SPARK warnings
    Brownout: ['warn', 'Brownout warning', 'Voltage at the SPARK sagged low enough to warn.'],
    Overcurrent: ['warn', 'Overcurrent warning', 'Current exceeded what the SPARK expects.'],
    ESCEepromWarning: ['warn', 'ESC EEPROM warning', ''],
    ExtEeprom: ['warn', 'External EEPROM warning', ''],
    SensorWarning: ['warn', 'Sensor warning', 'The sensor reading looked suspect.'],
    Stall: ['warn', 'Stalled', 'The motor was commanded but not turning. Look for a jam or a mechanism at a hard stop.'],
    HasReset: ['crit', 'Controller reset', 'The SPARK rebooted. Check its power connector and breaker.'],
    OtherWarning: ['warn', 'Other warning', ''],
  };
  const LIMIT_FAULTS = new Set(['StatorCurrLimit', 'SupplyCurrLimit']);
  const faultInfo = k => FAULT_INFO[k] || ['warn', k.replace(/([a-z])([A-Z])/g, '$1 $2'), 'Reported by the controller.'];

  // Intervals where pred(v) holds, using sample-and-hold. Gaps under `gap` s merge; runs under minDur drop.
  function condIntervals(t, v, pred, tEnd, gap = 0.06, minDur = 0) {
    const out = []; let a = null, peak = -Infinity, pk = [];
    for (let i = 0; i < t.length; i++) {
      const on = isFinite(v[i]) && pred(v[i]);
      if (on) { if (a === null) { a = t[i]; peak = -Infinity; } peak = Math.max(peak, Math.abs(v[i])); }
      else if (a !== null) { out.push([a, t[i]]); pk.push(peak); a = null; }
    }
    if (a !== null) { out.push([a, tEnd]); pk.push(peak); }
    const merged = [], mp = [];
    out.forEach((iv, k) => {
      const last = merged[merged.length - 1];
      if (last && iv[0] - last[1] <= gap) { last[1] = iv[1]; mp[mp.length - 1] = Math.max(mp[mp.length - 1], pk[k]); }
      else { merged.push([...iv]); mp.push(pk[k]); }
    });
    const keep = merged.map((iv, k) => [iv, mp[k]]).filter(([iv]) => iv[1] - iv[0] >= minDur);
    return { ivs: keep.map(x => x[0]), peaks: keep.map(x => x[1]) };
  }
  function laneOf(group, key, label, sev, kind, ivs, extra = {}) {
    // ivs: [t0, t1, sev]
    return { group, key, label, sev, kind, ivs, count: ivs.length, total: ivs.reduce((q, iv) => q + iv[1] - iv[0], 0), first: ivs.length ? ivs[0][0] : NaN, ...extra };
  }
  const lastVal = e => (e && e.v && e.v.length ? e.v[e.v.length - 1] : NaN);

  function motorLanes(m, log, L) {
    const lanes = [], end = log.tMax;
    if (m.Connected) {
      const r = condIntervals(m.Connected.t, m.Connected.v, x => !x, end, 0.02);
      if (r.ivs.length) lanes.push(laneOf(m.name, 'Disconnected', 'Off CAN', 'crit', 'derived', r.ivs.map(iv => [...iv, 'crit']), { ref: m.Connected.name }));
    }
    if (m.TempC) {
      const t = m.TempC.t, v = m.TempC.v, ivs = []; let a = null, lvl = 0;
      const lv = x => (x >= L.tempCrit ? 2 : x >= L.tempWarn ? 1 : 0);
      for (let i = 0; i <= t.length; i++) {
        const l = i < t.length ? lv(v[i]) : 0, x = i < t.length ? t[i] : end;
        if (l !== lvl) { if (lvl) ivs.push([a, x, lvl === 2 ? 'crit' : 'warn']); a = x; lvl = l; }
      }
      if (ivs.length) {
        let count = 0; for (let k = 0; k < ivs.length; k++) if (k === 0 || ivs[k][0] > ivs[k - 1][1]) count++;
        const peak = Math.max(...Array.from(v));
        lanes.push({ ...laneOf(m.name, 'Temp', `Temp ≥ ${L.tempWarn} °C`, ivs.some(x => x[2] === 'crit') ? 'crit' : 'warn', 'derived', ivs, { ref: m.TempC.name, peak, unit: '°C' }), count });
      }
    }
    const limitLane = (e, limE, dflt, key, word) => {
      if (!e) return;
      const logged = isFinite(lastVal(limE));
      const lim = logged ? lastVal(limE) : dflt;
      // a logged limit is enforced by the controller, so "at the limit" (within 3%) is the event
      const thr = logged ? lim * 0.97 : lim;
      const r = condIntervals(e.t, e.v, x => Math.abs(x) >= thr, end, 0.1, L.ocMinS);
      if (r.ivs.length) lanes.push(laneOf(m.name, key, logged ? `${word} at ${fmt0(lim)} A limit` : `${word} ≥ ${fmt0(lim)} A`, 'warn', 'limit', r.ivs.map(iv => [...iv, 'warn']), { ref: e.name, peak: Math.max(...r.peaks), unit: 'A', limit: lim, limitLogged: logged }));
    };
    // when the controller reports its own limit flag, that lane replaces the one derived from current
    const fz = m.faults || {};
    if (!fz.SupplyCurrLimit) limitLane(m.SupplyCurrentA, m.SupplyLimitA, L.supplyLimitA, 'Supply', 'Supply');
    if (!fz.StatorCurrLimit) limitLane(m.StatorCurrentA, m.StatorLimitA, L.statorLimitA, 'Stator', 'Stator');
    for (const [k, e] of Object.entries(m.faults || {})) {
      const r = condIntervals(e.t, e.v, x => !!x, end, 0.05);
      if (!r.ivs.length) continue;
      const [sev, label, why] = faultInfo(k);
      lanes.push(laneOf(m.name, 'F:' + k, label, sev, LIMIT_FAULTS.has(k) ? 'limit' : 'hw', r.ivs.map(iv => [...iv, sev]), { ref: e.name, fault: k, why }));
    }
    const order = { Disconnected: 0, Temp: 2, Supply: 3, Stator: 4 };
    const rank = l => (l.kind === 'hw' ? (l.sev === 'crit' ? 0.5 : 1) : order[l.key] ?? 5);
    return lanes.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }
  const fmt0 = x => (Math.round(x * 10) / 10).toString();

  // ∫ f dt over samples inside intervals; dt capped so a gap in logging doesn't hold a stale value
  function integrate(t, valFn, iv, dtCap = 0.2) {
    let s = 0;
    for (let i = 0; i < t.length - 1; i++) {
      const x = t[i];
      if (!inAnyFast(iv, x)) continue;
      const dt = Math.min(t[i + 1] - x, dtCap);
      const y = valFn(i, x);
      if (isFinite(y)) s += y * dt;
    }
    return s;
  }
  // intervals are sorted & few; linear scan is fine
  function inAnyFast(iv, x) { for (let k = 0; k < iv.length; k++) if (x >= iv[k][0] && x < iv[k][1]) return true; return false; }

  function statsIn(e, iv) {
    let max = -Infinity, min = Infinity, sum = 0, n = 0, tMax = NaN, tMin = NaN;
    if (!e) return null;
    for (let i = 0; i < e.t.length; i++) {
      if (!inAnyFast(iv, e.t[i])) continue;
      const y = e.v[i]; if (!isFinite(y)) continue;
      if (y > max) { max = y; tMax = e.t[i]; }
      if (y < min) { min = y; tMin = e.t[i]; }
      sum += y; n++;
    }
    return n ? { max, min, avg: sum / n, n, tMax, tMin } : null;
  }

  function risingEdges(e, iv, from1to0 = false) {
    if (!e) return [];
    const out = [];
    for (let i = 1; i < e.v.length; i++) {
      const fire = from1to0 ? (e.v[i - 1] && !e.v[i]) : (!e.v[i - 1] && e.v[i]);
      if (fire && (!iv || inAnyFast(iv, e.t[i]))) out.push(e.t[i]);
    }
    return out;
  }

  function analyze(log, limits = DEFAULT_LIMITS) {
    const L = { ...DEFAULT_LIMITS, ...limits };
    const phases = phasesOf(log);
    const en = phases.enabled;
    const all = [[log.tMin, log.tMax + 1e-9]];
    const flags = [];
    const flag = (sev, title, detail, t, ref) => flags.push({ sev, title, detail, t, ref });

    const s = { phases, info: matchInfo(log), limits: L };
    s.duration = log.tMax - log.tMin;
    s.enabledTime = ivLen(en);
    s.autoTime = ivLen(phases.segments.filter(x => x.mode === 'auto').map(x => [x.t0, x.t1]));
    s.teleopTime = ivLen(phases.segments.filter(x => x.mode === 'teleop').map(x => [x.t0, x.t1]));

    // power
    const bat = key(log, 'battery');
    const cur = key(log, 'current');
    const pwr = key(log, 'power');
    const bs = statsIn(bat, en), cs = statsIn(cur, en);
    s.battery = bs ? { min: bs.min, tMin: bs.tMin, start: bat.v[0], end: bat.v[bat.v.length - 1],
      below: { warn: timeBelow(bat, en, L.voltWarn), crit: timeBelow(bat, en, L.voltCrit) } } : null;
    s.current = cs ? { peak: cs.max, tPeak: cs.tMax, avg: cs.avg } : null;
    if (cur) s.ampHours = integrate(cur.t, i => cur.v[i], en) / 3600;
    if (pwr) s.energyWh = integrate(pwr.t, i => pwr.v[i], en) / 3600;
    else if (bat && cur) s.energyWh = integrate(cur.t, (i, x) => cur.v[i] * valueAt(bat.t, bat.v, x), en) / 3600;
    if (s.battery) {
      if (s.battery.min < L.voltCrit) flag('crit', `Battery sagged to ${s.battery.min.toFixed(2)} V`, `${s.battery.below.crit >= 0.1 ? `Below ${L.voltCrit} V for ${s.battery.below.crit.toFixed(1)} s` : `Dipped below ${L.voltCrit} V briefly`} while enabled. Check battery health and current limits.`, s.battery.tMin, 'Power/BatteryV');
      else if (s.battery.min < L.voltWarn) flag('warn', `Battery sagged to ${s.battery.min.toFixed(2)} V`, `${s.battery.below.warn >= 0.1 ? `Below ${L.voltWarn} V for ${s.battery.below.warn.toFixed(1)} s` : `Dipped below ${L.voltWarn} V briefly`} while enabled.`, s.battery.tMin, 'Power/BatteryV');
      if (s.battery.start < 12.3) flag('warn', `Match started at ${s.battery.start.toFixed(2)} V`, 'Resting voltage under 12.3 V usually means the battery was not fully charged.', log.tMin, 'Power/BatteryV');
    }
    const bo = key(log, 'brownout');
    s.brownouts = risingEdges(bo, null);
    if (s.brownouts.length) flag('crit', `${s.brownouts.length} brownout${s.brownouts.length > 1 ? 's' : ''}`, 'The controller cut motor output to protect itself. Every motor went limp for the duration.', s.brownouts[0], 'System/BrownedOut');

    // comms
    const ds = findEntry(log, 'DS:ds'), fms = findEntry(log, 'DS:fms');
    s.fms = !!(fms && fms.v.some(x => x));
    s.commsDrops = [];
    if (ds) {
      const firstOn = ds.t[ds.v.indexOf(1)];
      if (firstOn !== undefined) {
        const offs = trueIntervals(ds.t, ds.v.map(x => (x ? 0 : 1)), firstOn, log.tMax);
        s.commsDrops = offs.filter(([a]) => a > firstOn).map(([a, b]) => ({ t: a, dur: b - a }));
      }
    }
    if (s.commsDrops.length) {
      const tot = s.commsDrops.reduce((q, d) => q + d.dur, 0);
      flag('crit', `Lost driver station ${s.commsDrops.length}×`, `${tot.toFixed(1)} s without comms in total. The robot disables itself when the DS link drops. Check the radio power and ethernet.`, s.commsDrops[0].t, 'DS:ds');
    }
    const can = key(log, 'can');
    if (can) {
      const cst = statsIn(can, all);
      const scale = cst && cst.max <= 1.0001 ? 100 : 1;
      s.canPeak = cst ? cst.max * scale : null; s.canAvg = cst ? cst.avg * scale : null; s.canScale = scale;
      if (s.canPeak > L.canWarn) flag('warn', `CAN bus peaked at ${s.canPeak.toFixed(0)}%`, 'High utilization delays status frames and commands. Lower status-frame rates on devices that don\'t need them.', cst.tMax, can.name);
    }
    const txe = key(log, 'canTxErr'), rxe = key(log, 'canRxErr');
    s.canErrors = (txe ? txe.v[txe.v.length - 1] - txe.v[0] : 0) + (rxe ? rxe.v[rxe.v.length - 1] - rxe.v[0] : 0);
    const loop = key(log, 'loop');
    if (loop) {
      const over = []; for (let i = 0; i < loop.v.length; i++) if (loop.v[i] > L.loopMs && inAnyFast(en, loop.t[i])) over.push(i);
      const ls = statsIn(loop, en);
      s.loop = { overruns: over.length, worst: ls ? ls.max : null, tWorst: ls ? ls.tMax : null, avg: ls ? ls.avg : null };
      if (over.length > 5) flag('warn', `${over.length} loop overruns`, `Robot loop ran longer than ${L.loopMs} ms ${over.length} times while enabled (worst ${s.loop.worst.toFixed(0)} ms). Look for blocking calls in periodic code.`, s.loop.tWorst, loop.name);
    }

    // motors
    s.motors = motorsOf(log).map(m => {
      const o = { name: m.name };
      const ts = m.TempC ? statsIn(m.TempC, all) : null;
      if (ts) { o.tempMax = ts.max; o.tempStart = m.TempC.v[0]; o.tempEnd = m.TempC.v[m.TempC.v.length - 1]; o.tMaxTemp = ts.tMax; }
      const sup = m.SupplyCurrentA ? statsIn(m.SupplyCurrentA, en) : null;
      if (sup) { o.supplyPeak = sup.max; o.supplyAvg = sup.avg; o.tSupplyPeak = sup.tMax; }
      const st = m.StatorCurrentA ? statsIn(m.StatorCurrentA, en) : null;
      if (st) o.statorPeak = Math.max(Math.abs(st.max), Math.abs(st.min));
      if (m.SupplyCurrentA) {
        const v = m.BusVoltageV;
        o.energyWh = integrate(m.SupplyCurrentA.t, (i, x) => m.SupplyCurrentA.v[i] * (v ? valueAt(v.t, v.v, x) : 12), en) / 3600;
      }
      if (m.Connected) {
        o.drops = risingEdges(m.Connected, null, true);
        o.offline = ivLen(trueIntervals(m.Connected.t, m.Connected.v.map(x => (x ? 0 : 1)), log.tMin, log.tMax));
      } else { o.drops = []; o.offline = 0; }
      o.lanes = motorLanes(m, log, L);
      o.canId = m.CANId && m.CANId.v && m.CANId.v.length ? m.CANId.v[m.CANId.v.length - 1] : null;
      const lastStr = e => (e && e.vals && e.vals.length ? String(e.vals[e.vals.length - 1]) : '');
      o.controller = lastStr(m.Controller); o.canBus = lastStr(m.CANBus);
      o.label = o.canId != null ? `${m.name} · CAN ${o.canId}` : m.name;
      o.hwFaults = o.lanes.filter(l => l.kind === 'hw');
      o.faultCount = o.hwFaults.reduce((q, l) => q + l.count, 0) + o.drops.length;
      o.limitTime = o.lanes.filter(l => l.kind === 'limit').reduce((q, l) => q + l.total, 0);
      o.sev = 'ok';
      if (o.tempMax >= L.tempCrit) { o.sev = 'crit'; flag('crit', `${m.name} reached ${o.tempMax.toFixed(0)} °C`, `Above the ${L.tempCrit} °C limit. Expect thermal current limiting. Add a supply current limit or let it cool between matches.`, o.tMaxTemp, m.TempC.name); }
      else if (o.tempMax >= L.tempWarn) { o.sev = 'warn'; flag('warn', `${m.name} reached ${o.tempMax.toFixed(0)} °C`, `Above the ${L.tempWarn} °C warning level.`, o.tMaxTemp, m.TempC.name); }
      if (o.drops.length) { o.sev = 'crit'; flag('crit', `${m.name} dropped off CAN ${o.drops.length}×`, `Offline for ${o.offline.toFixed(2)} s. Check the CAN connectors and the power wiring to this controller.`, o.drops[0], m.Connected.name); }
      for (const l of o.hwFaults) { if (l.sev === 'crit') o.sev = 'crit'; else if (o.sev === 'ok') o.sev = 'warn'; }
      o.entries = m;
      return o;
    });
    // controller faults: the same fault on 3+ controllers becomes one flag (it's the power path, not the controller)
    const byFault = new Map();
    for (const m of s.motors) for (const l of m.hwFaults) { if (!byFault.has(l.fault)) byFault.set(l.fault, []); byFault.get(l.fault).push({ m, l }); }
    for (const [k, hits] of byFault) {
      const [sev, label, why] = faultInfo(k);
      if (hits.length >= 3) {
        const t0 = Math.min(...hits.map(x => x.l.first));
        const nearBo = s.brownouts.some(b => Math.abs(b - t0) < 1);
        flag(sev, `${label} on ${hits.length} controllers`, `${nearBo ? 'At the same time as the brownout. ' : ''}${hits.map(x => x.m.name).slice(0, 6).join(', ')}${hits.length > 6 ? ` and ${hits.length - 6} more` : ''}. The same fault on many controllers at once points to the battery or main power path rather than one controller. ${why}`, t0, hits[0].l.ref);
      } else for (const { m, l } of hits) flag(l.sev, `${m.name}: ${l.label}${l.count > 1 ? ` ${l.count}×` : ''}`, `${l.total >= 0.1 ? `Active for ${l.total.toFixed(1)} s in total. ` : ''}${l.why}`, l.first, l.ref);
    }
    // current limits: one flag per kind across all motors, so four drive motors don't make four flags
    for (const [word, keys] of [['supply', ['Supply', 'F:SupplyCurrLimit']], ['stator', ['Stator', 'F:StatorCurrLimit']]]) {
      const hit = s.motors.map(m => {
        const ls = m.lanes.filter(l => keys.includes(l.key));
        if (!ls.length) return null;
        const best = ls.reduce((a, b) => (b.total > a.total ? b : a));
        return { m, l: best };
      }).filter(Boolean).sort((a, b) => b.l.total - a.l.total);
      if (!hit.length) continue;
      const list = hit.slice(0, 4).map(x => `${x.m.name} ${x.l.total.toFixed(1)} s`).join(', ') + (hit.length > 4 ? `, +${hit.length - 4} more` : '');
      flag('warn', `${hit.length} motor${hit.length > 1 ? 's' : ''} ran at the ${word} current limit`, `Time at the limit: ${list}. Some limiting under heavy load is expected. If it happens during normal driving, the limit or gearing is too tight for the job.`, Math.min(...hit.map(x => x.l.first)), hit[0].l.ref);
    }
    // robot-wide lanes for the fault timeline
    s.robotLanes = [];
    if (bo) { const r = condIntervals(bo.t, bo.v, x => !!x, log.tMax, 0.02); if (r.ivs.length) s.robotLanes.push(laneOf('Robot', 'Brownout', 'Brownout', 'crit', 'robot', r.ivs.map(iv => [...iv, 'crit']), { ref: bo.name })); }
    if (s.commsDrops.length) s.robotLanes.push(laneOf('Robot', 'Comms', 'Driver station lost', 'crit', 'robot', s.commsDrops.map(d => [d.t, d.t + d.dur, 'crit']), { ref: 'DS:ds' }));
    if (bat) {
      const r = condIntervals(bat.t, bat.v, x => x < L.voltWarn, log.tMax, 0.06);
      const ivs = r.ivs.filter(iv => inAnyFast(en, iv[0])).map((iv, k) => [...iv, (statsIn(bat, [iv])?.min ?? Infinity) < L.voltCrit ? 'crit' : 'warn']);
      if (ivs.length) s.robotLanes.push(laneOf('Robot', 'BatteryLow', `Battery < ${L.voltWarn} V`, ivs.some(x => x[2] === 'crit') ? 'crit' : 'warn', 'robot', ivs, { ref: bat.name }));
    }
    s.motorFaults = s.motors.reduce((q, m) => q + m.faultCount, 0);
    const totM = s.motors.reduce((q, m) => q + (m.energyWh || 0), 0);
    s.motors.forEach(m => { m.share = totM > 0 ? (m.energyWh || 0) / totM : 0; });
    s.motorEnergyWh = totM;

    // mechanisms: tracking error
    s.mechanisms = mechanismsOf(log).map(m => {
      const o = { name: m.name, unit: m.Position ? m.Position.unit : '', entries: m };
      if (m.Position && m.Setpoint) {
        let se = 0, n = 0, worst = 0, tWorst = NaN;
        const p = m.Position;
        for (let i = 0; i < p.t.length; i++) {
          if (!inAnyFast(en, p.t[i])) continue;
          const err = p.v[i] - valueAt(m.Setpoint.t, m.Setpoint.v, p.t[i]);
          if (!isFinite(err)) continue;
          se += err * err; n++;
          if (Math.abs(err) > Math.abs(worst)) { worst = err; tWorst = p.t[i]; }
        }
        if (n) { o.rmsErr = Math.sqrt(se / n); o.worstErr = worst; o.tWorst = tWorst; }
      }
      if (m.Position) { const ps = statsIn(m.Position, all); if (ps) { o.min = ps.min; o.max = ps.max; } }
      return o;
    });

    // drive
    const poses = posesOf(log);
    s.poses = poses;
    const main = poses[0];
    if (main && main.t.length > 1) {
      let dist = 0, vmax = 0, tv = NaN;
      const sp = new Float64Array(main.t.length);
      for (let i = 1; i < main.t.length; i++) {
        const dt = main.t[i] - main.t[i - 1];
        const d = Math.hypot(main.x[i] - main.x[i - 1], main.y[i] - main.y[i - 1]);
        if (d > 1.0 || dt <= 0) { sp[i] = sp[i - 1]; continue; } // pose reset / vision snap
        dist += d;
        sp[i] = d / dt;
      }
      // smooth speed over ~0.1 s to remove odometry jitter
      const sm = new Float64Array(sp.length);
      for (let i = 0; i < sp.length; i++) {
        let a = 0, n = 0;
        for (let k = i; k >= 0 && main.t[i] - main.t[k] <= 0.1; k--) { a += sp[k]; n++; }
        sm[i] = a / n;
        if (sm[i] > vmax && inAnyFast(en, main.t[i])) { vmax = sm[i]; tv = main.t[i]; }
      }
      s.drive = { distance: dist, topSpeed: vmax, tTopSpeed: tv, speed: sm };
    }

    const order = { crit: 0, warn: 1, info: 2 };
    flags.sort((a, b) => order[a.sev] - order[b.sev] || a.t - b.t);
    s.flags = flags;
    return s;
  }

  function timeBelow(e, iv, thr) { return integrate(e.t, i => (e.v[i] < thr ? 1 : 0), iv); }

  // Compact JSON summary for the shared match history (one db doc per log)
  function summaryDoc(log, s) {
    const r = x => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
    return {
      fileName: log.fileName,
      event: s.info.event || '', match: s.info.match || '', date: s.info.date || '', alliance: s.info.alliance || '',
      savedAt: new Date().toISOString(),
      durationS: r(s.duration), enabledS: r(s.enabledTime),
      batteryStartV: r(s.battery?.start), batteryMinV: r(s.battery?.min),
      peakCurrentA: r(s.current?.peak), avgCurrentA: r(s.current?.avg), energyWh: r(s.energyWh), ampHours: r(s.ampHours),
      brownouts: s.brownouts.length, commsDrops: s.commsDrops.length, canPeakPct: r(s.canPeak),
      loopOverruns: s.loop?.overruns ?? null,
      distanceM: r(s.drive?.distance), topSpeedMps: r(s.drive?.topSpeed),
      critCount: s.flags.filter(f => f.sev === 'crit').length, warnCount: s.flags.filter(f => f.sev === 'warn').length,
      motors: Object.fromEntries(s.motors.map(m => [m.name, { tempMax: r(m.tempMax), tempStart: r(m.tempStart), supplyPeak: r(m.supplyPeak), supplyAvg: r(m.supplyAvg), energyWh: r(m.energyWh), canId: m.canId, drops: m.drops.length, faults: m.faultCount, limitS: r(m.limitTime) }])),
      motorFaults: s.motorFaults,
    };
  }

  return { parseWpilog, Writer, analyze, summaryDoc, idxAt, valueAt, trueIntervals, findEntry, stripPrefix, motorsOf, mechanismsOf, posesOf, phasesOf, DEFAULT_LIMITS, parseSchema, makeLayout, faultInfo, FAULT_INFO, KEYS, classify, readPrim, parseMeta };
})();
if (typeof module !== 'undefined') module.exports = Core;
