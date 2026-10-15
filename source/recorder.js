// ===== Recorder: writes live NetworkTables values to a .wpilog as they arrive (driver station app) =====
// Timestamps are the robot's own NT clock (µs), the same clock DogLog uses, so a recording lines up with the
// robot's log of the same match. Topic names are kept as published, so a recording opens exactly like live data.
const Recorder = (() => {
  const te = new TextEncoder();
  const typeFor = t => (t === 'int' ? 'int64' : t === 'int[]' ? 'int64[]' : t);
  const f64 = (arr, n = 8, set = 'setFloat64') => { const p = new Uint8Array(arr.length * n); const dv = new DataView(p.buffer); arr.forEach((v, k) => dv[set](n * k, Number(v), true)); return p; };
  const i64 = v => (typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0)));
  const bytesOf = v => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : te.encode(typeof v === 'string' ? v : JSON.stringify(v)));

  // NT4 value -> .wpilog payload for that type
  function encode(type, v) {
    switch (type) {
      case 'boolean': return Uint8Array.of(v ? 1 : 0);
      case 'double': return f64([v]);
      case 'float': return f64([v], 4, 'setFloat32');
      case 'int64': { const p = new Uint8Array(8); new DataView(p.buffer).setBigInt64(0, i64(v), true); return p; }
      case 'string': case 'json': return te.encode(typeof v === 'string' ? v : JSON.stringify(v));
      case 'boolean[]': return Uint8Array.from(v, x => (x ? 1 : 0));
      case 'double[]': return f64(v);
      case 'float[]': return f64(v, 4, 'setFloat32');
      case 'int64[]': { const p = new Uint8Array(v.length * 8); const dv = new DataView(p.buffer); v.forEach((x, k) => dv.setBigInt64(8 * k, i64(x), true)); return p; }
      case 'string[]': {
        const parts = v.map(s => te.encode(String(s)));
        const p = new Uint8Array(4 + parts.reduce((n, b) => n + 4 + b.length, 0)); const dv = new DataView(p.buffer);
        dv.setUint32(0, parts.length, true); let q = 4;
        for (const b of parts) { dv.setUint32(q, b.length, true); p.set(b, q + 4); q += 4 + b.length; }
        return p;
      }
      default: return bytesOf(v); // raw, structs, structschema, msgpack, protobuf
    }
  }

  const DS_BITS = [['DS:enabled', 0x01], ['DS:autonomous', 0x02], ['DS:test', 0x04], ['DS:estop', 0x08], ['DS:fms', 0x10], ['DS:ds', 0x20]];
  const MATCH_TYPES = ['', 'P', 'Q', 'E'];
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  class Recording {
    constructor(host) {
      this.host = host; this.started = new Date();
      this.w = new Core.Writer(JSON.stringify({ source: 'CarboVis driver station', host, started: this.started.toISOString() }));
      this.entries = new Map(); // name -> { id, type, lastT }
      this.ds = new Map(); // DS:* name -> { id, v }
      this.fms = {}; this.control = 0; this.enabledS = 0; this.lastEnabledT = null;
      this.tMin = Infinity; this.tMax = -Infinity; this.bytes = 0; this.records = 0; this.matchEndedAt = null;
    }
    entry(name, type, metadata, t) {
      let e = this.entries.get(name);
      if (!e || e.type !== type) { e = { id: this.w.start(name, type, metadata, t), type, lastT: t }; this.entries.set(name, e); }
      return e;
    }
    add(topic, serverUs, value) {
      const type = typeFor(topic.type);
      let payload; try { payload = encode(type, value); } catch { return; } // value didn't match its declared type
      const t = Math.max(0, serverUs);
      const e = this.entry(topic.name, type, JSON.stringify(topic.properties || {}), t);
      e.lastT = Math.max(t, e.lastT); // the reader expects each series in time order; NT doesn't promise it
      this.w.record(e.id, e.lastT, payload);
      this.records++;
      if (e.lastT < this.tMin) this.tMin = e.lastT;
      if (e.lastT > this.tMax) this.tMax = e.lastT;
      const short = topic.name.replace(/^\/?FMSInfo\//, '');
      if (short !== topic.name) { this.fms[short] = value; if (short === 'FMSControlData') this.controlWord(e.lastT, Number(value)); }
    }
    // Same DS:* entries DogLog's withCaptureDs writes, so match phases work when the recording is reopened.
    controlWord(t, word) {
      for (const [n, bit] of DS_BITS) {
        const v = word & bit ? 1 : 0;
        let d = this.ds.get(n);
        if (!d) { d = { id: this.w.start(n, 'boolean', '', t), v: -1 }; this.ds.set(n, d); }
        if (d.v !== v) { this.w.record(d.id, t, Uint8Array.of(v)); d.v = v; }
      }
      const was = this.control, en = word & 1, wasEn = was & 1;
      if (en && !wasEn) this.lastEnabledT = t;
      if (!en && wasEn && this.lastEnabledT != null) { this.enabledS += (t - this.lastEnabledT) / 1e6; this.lastEnabledT = null; }
      // End of a real match: FMS attached, teleop (not auto) enabled -> disabled.
      if ((word & 0x10) && wasEn && !(was & 2) && !en) this.matchEndedAt = Date.now();
      this.control = word;
    }
    get enabled() { return !!(this.control & 1); }
    get fmsAttached() { return !!(this.control & 0x10); }
    get durationS() { return isFinite(this.tMax) ? (this.tMax - this.tMin) / 1e6 : 0; }
    get pending() { return this.w.len; }
    /** Bytes written since the last take(), ready to append to the file. */
    take() { const out = this.w.buf.slice(0, this.w.len); this.bytes += this.w.len; this.w.len = 0; return out; }
    /** File name in the robot's own convention (UTC), e.g. FRC_20260411_183207_NCCMP_Q42_DS.wpilog. */
    fileName() {
      const d = this.started;
      const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
      const ev = String(this.fms.EventName || '').replace(/[^A-Za-z0-9]/g, '');
      const mn = Number(this.fms.MatchNumber) || 0;
      const match = ev && mn ? `_${ev}_${MATCH_TYPES[Number(this.fms.MatchType)] || 'M'}${mn}` : '';
      return `FRC_${stamp}${match}_DS.wpilog`;
    }
  }

  return { Recording, encode, typeFor };
})();
if (typeof module !== 'undefined') module.exports = Recorder;
