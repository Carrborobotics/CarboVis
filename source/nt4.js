// ===== NT4: minimal NetworkTables 4.1 client (read-only) =====
// Protocol: https://github.com/wpilibsuite/allwpilib/blob/main/ntcore/doc/networktables4.adoc
// WebSocket ws://<host>:5810/nt/<name>; JSON text frames for topics, MessagePack binary frames for values.
const NT4 = (() => {
  const SUBPROTOCOLS = ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu'];
  const nowUs = () => Math.round(performance.now() * 1000);

  class Client {
    /**
     * opts: host, port (5810), name, onAnnounce(topic), onUnannounce(topic), onValue(topic, serverUs, value),
     *       onStatus({state, detail, rttMs}), subscribe (array of prefixes, default all topics), periodic (s)
     */
    constructor(opts) {
      this.o = { port: 5810, name: 'FRC7763MatchLogs', subscribe: [''], periodic: 0.05, ...opts };
      this.topics = new Map(); // id -> {id, name, type, properties}
      this.wanted = false; this.ws = null; this.offsetUs = null; this.bestRtt = Infinity; this.rttMs = null;
      this.lastRx = 0; this.timers = []; this.retryMs = 500;
    }
    status(state, detail) { this.state = state; this.o.onStatus && this.o.onStatus({ state, detail, rttMs: this.rttMs }); }
    connect() { this.wanted = true; this.open(); }
    disconnect() {
      this.wanted = false; this.clearTimers();
      if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } }
      this.ws = null; this.status('disconnected');
    }
    clearTimers() { this.timers.forEach(clearInterval); this.timers = []; clearTimeout(this.retryT); }
    /** Server time (µs) that corresponds to "now" on this computer, once a time sync has happened. */
    serverNowUs() { return this.offsetUs == null ? null : nowUs() + this.offsetUs; }

    open() {
      this.clearTimers();
      const url = `ws://${this.o.host}:${this.o.port}/nt/${encodeURIComponent(this.o.name)}`;
      this.status('connecting', url);
      let ws;
      try { ws = new WebSocket(url, SUBPROTOCOLS); } catch (err) { this.status('error', err.message || String(err)); return; }
      ws.binaryType = 'arraybuffer';
      this.ws = ws; this.topics.clear(); this.offsetUs = null; this.bestRtt = Infinity;
      ws.onopen = () => {
        this.retryMs = 500; this.lastRx = performance.now();
        this.status('connected', ws.protocol);
        // Sync clocks first, so the server time is known before any values arrive (the recorder places retained
        // values at "now"). Subscribe on the first answer, or after 500 ms if the server doesn't answer pings.
        this.subscribed = false;
        this.ping();
        this.timers.push(setTimeout(() => this.subscribe(), 500));
        // browsers can't send WebSocket PINGs, so timestamp messages double as the aliveness check (1 s / 3 s per spec)
        this.timers.push(setInterval(() => this.ping(), 1000));
        this.timers.push(setInterval(() => { if (performance.now() - this.lastRx > 3000) { try { ws.close(); } catch { /* ignore */ } } }, 500));
      };
      ws.onmessage = ev => { this.lastRx = performance.now(); if (typeof ev.data === 'string') this.onText(ev.data); else this.onBinary(ev.data); };
      ws.onerror = () => { /* onclose follows with the details we can show */ };
      ws.onclose = ev => {
        this.clearTimers();
        if (this.ws !== ws) return;
        this.ws = null;
        for (const t of this.topics.values()) this.o.onUnannounce && this.o.onUnannounce(t);
        this.topics.clear();
        if (!this.wanted) { this.status('disconnected'); return; }
        this.status('retrying', ev.code === 1006 ? 'robot not reachable' : `closed (${ev.code})`);
        this.retryT = setTimeout(() => this.open(), this.retryMs);
        this.retryMs = Math.min(3000, this.retryMs * 2);
      };
    }
    subscribe() {
      if (this.subscribed) return;
      this.subscribed = true;
      this.sendJson([{ method: 'subscribe', params: { topics: this.o.subscribe, subuid: 1, options: { prefix: true, periodic: this.o.periodic, all: false } } }]);
    }
    sendJson(msgs) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msgs)); }
    ping() {
      if (!this.ws || this.ws.readyState !== 1) return;
      // [-1, 0, int, our time]; the server answers with its own time in the timestamp slot
      this.ws.send(Vendor.msgpack.encode([-1, 0, 2, nowUs()]));
    }
    onText(text) {
      let msgs; try { msgs = JSON.parse(text); } catch { return; }
      if (!Array.isArray(msgs)) return;
      for (const m of msgs) {
        if (!m || typeof m.method !== 'string' || typeof m.params !== 'object') continue;
        const p = m.params;
        if (m.method === 'announce') {
          const t = { id: p.id, name: p.name, type: p.type, properties: p.properties || {} };
          this.topics.set(p.id, t); this.o.onAnnounce && this.o.onAnnounce(t);
        } else if (m.method === 'unannounce') {
          const t = this.topics.get(p.id); this.topics.delete(p.id); if (t && this.o.onUnannounce) this.o.onUnannounce(t);
        } else if (m.method === 'properties') {
          for (const t of this.topics.values()) if (t.name === p.name) Object.assign(t.properties, p.update || {});
        }
      }
    }
    onBinary(buf) {
      let iter;
      try { iter = Vendor.msgpack.decodeMulti(new Uint8Array(buf)); } catch { return; }
      try {
        for (const msg of iter) {
          if (!Array.isArray(msg) || msg.length !== 4) continue;
          const [id, ts, , value] = msg;
          if (id === -1) {
            const rtt = nowUs() - Number(value);
            this.rttMs = rtt / 1000;
            if (rtt < this.bestRtt) { this.bestRtt = rtt; this.offsetUs = Number(ts) + rtt / 2 - nowUs(); }
            this.subscribe();
            this.o.onStatus && this.o.onStatus({ state: this.state, detail: this.ws && this.ws.protocol, rttMs: this.rttMs });
            continue;
          }
          const t = this.topics.get(id);
          if (t && this.o.onValue) this.o.onValue(t, Number(ts), value);
        }
      } catch { /* a malformed frame: skip the rest of it */ }
    }
  }
  return { Client };
})();
if (typeof module !== 'undefined') module.exports = NT4;
