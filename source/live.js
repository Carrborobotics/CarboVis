// ===== Live: turns NT4 topic updates into the same entry model a parsed .wpilog produces =====
const Live = (() => {
  const td = new TextDecoder();
  // NT4 type strings -> .wpilog type strings (they're the same apart from int)
  const typeFor = t => (t === 'int' ? 'int64' : t === 'int[]' ? 'int64[]' : t);

  function newLog(host) {
    return { fileName: `Live · ${host}`, extraHeader: '', records: 0, truncated: false, bytes: 0, live: true, host,
      entries: new Map(), schemas: new Map(), pending: new Map(), tMin: Infinity, tMax: -Infinity, version: 0 };
  }

  function ensure(log, name, ntType, properties) {
    let e = log.entries.get(name);
    const type = typeFor(ntType);
    if (e && e.type === type) return e;
    const kind = Core.classify(type);
    const meta = { ...(properties || {}) };
    e = { name, type, kind, metadata: JSON.stringify(meta), meta, unit: typeof meta.unit === 'string' ? meta.unit : '', count: 0, t: [] };
    if (kind === 'num' || kind === 'bool') e.v = [];
    else if (kind === 'struct') { e.structName = type.slice(7); e.fields = {}; e.layout = null; e.raw = []; }
    else e.vals = [];
    log.entries.set(name, e);
    return e;
  }

  function structLayout(log, e) {
    if (!e.layout) {
      e.layout = Core.makeLayout(e.structName, log.schemas);
      if (e.layout) for (const l of e.layout.leaves) if (!e.fields[l.path]) e.fields[l.path] = [];
    }
    return e.layout;
  }
  function pushStruct(log, e, t, bytes) {
    const layout = structLayout(log, e);
    if (!layout) { e.raw.push([t, bytes]); e.undecoded = true; return; } // schema not seen yet
    if (bytes.length < layout.size) return;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const l of layout.leaves) e.fields[l.path].push(Core.readPrim(dv, l.off, l.type));
    e.t.push(t); e.count = e.t.length; e.undecoded = false;
  }

  function add(log, topic, serverUs, value) {
    // Live time counts from when we connected. Retained values published earlier (CAN IDs, config) land at 0.
    if (log.baseUs == null) { const now = log.serverNow && log.serverNow(); log.baseUs = now != null ? now : serverUs; }
    const t = Math.max(0, (serverUs - log.baseUs) / 1e6);
    const name = topic.name;
    if (name.startsWith('/.schema/')) {
      const text = typeof value === 'string' ? value : td.decode(value);
      log.schemas.set(name.slice('/.schema/'.length), text);
      // schemas can arrive after the data they describe: decode anything that was waiting
      for (const e of log.entries.values()) if (e.kind === 'struct' && !e.layout && e.raw.length) {
        const raw = e.raw; e.raw = [];
        for (const [rt, b] of raw) pushStruct(log, e, rt, b);
      }
      return;
    }
    const e = ensure(log, name, topic.type, topic.properties);
    if (e.t.length && t < e.t[e.t.length - 1]) return; // NT gives no ordering guarantee; keep each series monotonic
    if (e.kind === 'num' || e.kind === 'bool') { e.t.push(t); e.v.push(typeof value === 'boolean' ? (value ? 1 : 0) : Number(value)); }
    else if (e.kind === 'struct') pushStruct(log, e, t, value instanceof Uint8Array ? value : new Uint8Array(value));
    else if (e.kind === 'numarr') { e.t.push(t); e.vals.push(Float64Array.from(value, x => (typeof x === 'boolean' ? (x ? 1 : 0) : Number(x)))); }
    else { e.t.push(t); e.vals.push(value); }
    e.count = e.t.length;
    if (t < log.tMin) log.tMin = t;
    if (t > log.tMax) log.tMax = t;
    log.records++; log.version++;
    if (name === '/FMSInfo/FMSControlData') controlWord(log, t, Number(value));
  }

  // FMSControlData is the HAL control word: enabled, auto, test, e-stop, FMS attached, DS attached.
  // Splitting it gives live data the same DS:* entries a log file has, so match phases work live.
  const BITS = [['DS:enabled', 0x01], ['DS:autonomous', 0x02], ['DS:test', 0x04], ['DS:estop', 0x08], ['DS:fms', 0x10], ['DS:ds', 0x20]];
  function controlWord(log, t, word) {
    for (const [n, bit] of BITS) {
      const e = ensure(log, n, 'boolean', {});
      const v = word & bit ? 1 : 0;
      if (!e.v.length || e.v[e.v.length - 1] !== v) { e.t.push(t); e.v.push(v); e.count = e.t.length; }
    }
  }

  // Drop samples older than keepS so a long session doesn't eat the laptop's memory.
  function trim(log, keepS) {
    const cut = log.tMax - keepS;
    if (!isFinite(cut)) return;
    let minT = Infinity;
    for (const e of log.entries.values()) {
      let k = 0; while (k < e.t.length - 1 && e.t[k] < cut) k++; // keep at least the latest value
      if (k > 0) {
        e.t.splice(0, k);
        if (e.v) e.v.splice(0, k);
        if (e.vals) e.vals.splice(0, k);
        if (e.fields) for (const f in e.fields) e.fields[f].splice(0, k);
        e.count = e.t.length;
      }
      if (e.t.length && e.t[0] < minT) minT = e.t[0];
    }
    if (isFinite(minT)) log.tMin = Math.max(minT, cut);
  }

  return { newLog, add, trim };
})();
if (typeof module !== 'undefined') module.exports = Live;
