// ===== app: UI =====
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const UNITS = { degC: '°C', fraction: '', raw: '', count: '', rpm: 'rpm', A: 'A', V: 'V', W: 'W', ms: 'ms', deg: '°', m: 'm', 'm/s': 'm/s', Wh: 'Wh', '%': '%' };
  const unitLabel = u => (u in UNITS ? UNITS[u] : u || '');
  function fmt(v, d) {
    if (v == null || !isFinite(v)) return '—';
    if (d == null) { const a = Math.abs(v); d = a >= 1000 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3; }
    return v.toFixed(d);
  }
  const fmtU = (v, u, d) => { const ul = unitLabel(u); return fmt(v, d) + (ul ? (ul === '°' || ul === '°C' ? '' : ' ') + ul : ''); };
  const mmss = s => { if (!isFinite(s)) return '—'; s = Math.max(0, s); return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };

  // ---------- colors from tokens ----------
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['bg', 'surface', 'surface-2', 'ink', 'ink-2', 'muted', 'line', 'line-2', 'accent', 'accent-soft', 'faint', 'good', 'warn', 'serious', 'crit', 'phase-auto', 'phase-tele', 'phase-dis', 'phase-test', 'seq1', 'seq2', 'seq3', 'seq4', 'seq5', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'])
      C[k] = cs.getPropertyValue('--' + k).trim();
  }
  const slotColor = i => C['s' + i] || C.muted;

  // ---------- state ----------
  const S = {
    log: null, sum: null, isSample: false, view: { t0: 0, t1: 1 }, cursor: null, tab: 'report', built: {},
    motorSel: [], motorSlot: new Map(), motorSort: { key: 'tempMax', dir: -1 }, faultSel: null, faultOcc: 0, showLimits: store.get('7763.showLimits', true), mechSel: store.get('7763.mech', null), mechMap: store.get('7763.mechmap', {}), mechT: null,
    sigSel: [], sigSlot: new Map(), sigFilter: '', sigString: null,
    limits: { ...Core.DEFAULT_LIMITS, ...store.get('7763.limits', {}) },
    field: store.get('7763.field', { w: 16.54, h: 8.07 }), playing: false, rate: 1,
    db: null, canWrite: false, history: null, histMetric: 'batteryMinV', histMotor: '',
  };
  function takeSlot(map, key) {
    if (map.has(key)) return map.get(key);
    const used = new Set(map.values());
    for (let i = 1; i <= 8; i++) if (!used.has(i)) { map.set(key, i); return i; }
    return 0;
  }

  // ---------- redraw scheduling ----------
  const charts = new Set();
  let rafFull = 0, rafOver = 0;
  function scheduleRedraw() { if (!rafFull) rafFull = requestAnimationFrame(() => { rafFull = 0; rafOver = 0; for (const c of charts) { if (!c.root.isConnected) charts.delete(c); else c.draw(); } drawTimeline(); drawField(); updateReadout(); }); }
  function scheduleOverlay() { if (rafFull || rafOver) return; rafOver = requestAnimationFrame(() => { rafOver = 0; for (const c of charts) c.drawOverlay(); drawTimeline(); drawField(); updateReadout(); }); }
  function setCursor(t) { S.cursor = t; if (t != null) S.mechT = t; scheduleOverlay(); }
  function setView(a, b) {
    const L = S.log; if (!L) return;
    if (b < a) [a, b] = [b, a];
    const minSpan = 0.25;
    if (b - a < minSpan) { const m = (a + b) / 2; a = m - minSpan / 2; b = m + minSpan / 2; }
    const span = b - a;
    if (a < L.tMin) { a = L.tMin; b = Math.min(L.tMax, a + span); }
    if (b > L.tMax) { b = L.tMax; a = Math.max(L.tMin, b - span); }
    S.view = { t0: a, t1: b }; scheduleRedraw();
  }
  function matchRange() {
    const L = S.log, en = S.sum.phases.enabled;
    if (!S.sum.phases.hasDS || !en.length) return [L.tMin, L.tMax];
    return [Math.max(L.tMin, en[0][0] - 3), Math.min(L.tMax, en[en.length - 1][1] + 3)];
  }
  const resetView = () => setView(...matchRange());
  function zoom(f) {
    const { t0, t1 } = S.view; const c = S.cursor != null && S.cursor > t0 && S.cursor < t1 ? S.cursor : (t0 + t1) / 2;
    setView(c - (c - t0) * f, c + (t1 - c) * f);
  }
  function phaseAt(t) { if (!S.sum) return null; for (const s of S.sum.phases.segments) if (t >= s.t0 && t < s.t1) return s; return null; }
  function updateReadout() {
    const el = $('#readout'); if (!S.log) { el.textContent = '—'; return; }
    const t = S.cursor;
    if (t == null) { el.textContent = `${fmt(S.view.t0, 1)}–${fmt(S.view.t1, 1)} s`; return; }
    const p = phaseAt(t); const segs = S.sum.phases.segments;
    let clock = '';
    if (p && p.mode !== 'disabled' && p.mode !== 'unknown') { const first = segs.find(s => s.mode === p.mode); clock = ` · ${p.mode === 'auto' ? 'Auto' : p.mode === 'teleop' ? 'Teleop' : 'Test'} ${mmss(t - first.t0)}`; }
    else if (p && p.mode === 'disabled') clock = ' · Disabled';
    el.textContent = `${t.toFixed(2)} s${clock}`;
  }

  // ---------- axis helpers ----------
  function niceStep(span, count) {
    const raw = span / Math.max(1, count); const mag = 10 ** Math.floor(Math.log10(raw)); const e = raw / mag;
    return (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
  }
  function drawPhases(ctx, x2px, y0, y1, xl, xr) {
    for (const s of S.sum.phases.segments) {
      const col = s.mode === 'auto' ? C['phase-auto'] : s.mode === 'teleop' ? C['phase-tele'] : s.mode === 'test' ? C['phase-test'] : s.mode === 'disabled' ? C['phase-dis'] : null;
      if (!col) continue;
      const a = clamp(x2px(s.t0), xl, xr), b = clamp(x2px(s.t1), xl, xr);
      if (b - a < 0.5) continue;
      ctx.fillStyle = col; ctx.fillRect(a, y0, b - a, y1 - y0);
    }
  }
  function sizeCanvas(cv, w, hh) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(hh * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, hh);
    return ctx;
  }
  function visRange(t) {
    const i0 = Math.max(0, Core.idxAt(t, S.view.t0)); const i1 = Math.min(t.length - 1, Core.idxAt(t, S.view.t1) + 1);
    return [i0, i1];
  }

  // ---------- time chart ----------
  class TimeChart {
    // opts: {title, unit, height, series:[{name,t,v,slot|faint,step,dash}], thresholds:[{y,sev,label}], markers:[t], yZero, includeThresholds}
    constructor(opts) {
      this.o = opts;
      this.root = h('div', { class: 'chart' });
      const ul = unitLabel(opts.unit);
      this.legendEl = h('div', { class: 'legend' });
      this.plot = h('div', { class: 'plot', style: `height:${opts.height || 170}px` });
      this.base = h('canvas'); this.over = h('canvas', { class: 'over', 'aria-label': `${opts.title} chart. Drag to zoom.` });
      this.tip = h('div', { class: 'tip', hidden: true });
      this.plot.append(this.base, this.over, this.tip);
      this.root.append(h('div', { class: 'chart-head' }, opts.title ? h('h4', null, opts.title, ul ? h('span', { class: 'unit' }, `(${ul})`) : null) : null, this.legendEl), this.plot);
      this.renderLegend(); this.bind();
      charts.add(this);
      new ResizeObserver(() => this.draw()).observe(this.plot);
    }
    setSeries(series) { this.o.series = series; this.renderLegend(); this.draw(); }
    renderLegend() {
      const col = this.o.series.filter(s => !s.faint), faint = this.o.series.filter(s => s.faint);
      this.legendEl.replaceChildren();
      if (col.length >= 2 || (col.length && faint.length)) for (const s of col) this.legendEl.append(h('span', null, h('i', { class: s.dash ? 'dash' : '', style: `background:${slotColor(s.slot)};color:${slotColor(s.slot)}` }), s.name));
      if (faint.length) this.legendEl.append(h('span', null, h('i', { style: `background:${C.faint}` }), col.length ? 'Others' : `${faint.length} series`));
    }
    geom() { return { w: this.plot.clientWidth, h: this.plot.clientHeight, l: 46, r: 10, t: 8, b: 20 }; }
    x2px(t, g) { return g.l + (t - S.view.t0) / (S.view.t1 - S.view.t0) * (g.w - g.l - g.r); }
    px2x(px, g) { return S.view.t0 + (px - g.l) / (g.w - g.l - g.r) * (S.view.t1 - S.view.t0); }
    y2px(y, g) { return g.t + (1 - (y - this.y0) / (this.y1 - this.y0)) * (g.h - g.t - g.b); }
    visible() { return this.root.isConnected && this.plot.clientWidth > 0; }
    draw() {
      if (!this.visible() || !S.log) return;
      const g = this.geom(); const ctx = sizeCanvas(this.base, g.w, g.h);
      // y range over visible data
      let lo = Infinity, hi = -Infinity;
      for (const s of this.o.series) {
        if (!s.t.length) continue;
        const [i0, i1] = visRange(s.t);
        for (let i = i0; i <= i1; i++) { const y = s.v[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
      }
      if (this.o.includeThresholds) for (const th of this.o.thresholds || []) { lo = Math.min(lo, th.y); hi = Math.max(hi, th.y); }
      if (this.o.yZero && lo > 0) lo = 0;
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const rows = Math.max(2, Math.floor((g.h - g.t - g.b) / 34));
      const step = niceStep(hi - lo, rows);
      this.y0 = Math.floor(lo / step + 1e-9) * step; this.y1 = Math.ceil(hi / step - 1e-9) * step;
      if (this.y1 - this.y0 < step) this.y1 = this.y0 + step;
      const xl = g.l, xr = g.w - g.r, yt = g.t, yb = g.h - g.b;
      drawPhases(ctx, t => this.x2px(t, g), yt, yb, xl, xr);
      // grid + y labels
      ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      const dec = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
      for (let y = this.y0; y <= this.y1 + step * 1e-6; y += step) {
        const py = Math.round(this.y2px(y, g)) + 0.5;
        ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xl, py); ctx.lineTo(xr, py); ctx.stroke();
        ctx.fillStyle = C.muted; ctx.fillText(y.toFixed(dec), xl - 6, py);
      }
      // x labels
      const span = S.view.t1 - S.view.t0; const xs = niceStep(span, Math.max(2, Math.floor((xr - xl) / 80)));
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const xdec = xs >= 1 ? 0 : Math.ceil(-Math.log10(xs));
      for (let t = Math.ceil(S.view.t0 / xs) * xs; t <= S.view.t1; t += xs) {
        const px = this.x2px(t, g); if (px < xl + 12 || px > xr - 12) continue;
        ctx.fillStyle = C.muted; ctx.fillText(t.toFixed(xdec) + 's', px, yb + 5);
      }
      ctx.strokeStyle = C['line-2']; ctx.beginPath(); ctx.moveTo(xl, yb + 0.5); ctx.lineTo(xr, yb + 0.5); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(xl, yt - 2, xr - xl, yb - yt + 4); ctx.clip();
      // markers
      for (const m of this.o.markers || []) {
        const px = this.x2px(m, g); if (px < xl || px > xr) continue;
        ctx.strokeStyle = C.crit; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(px, yt); ctx.lineTo(px, yb); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
      // thresholds
      for (const th of this.o.thresholds || []) {
        if (th.y < this.y0 || th.y > this.y1) continue;
        const py = Math.round(this.y2px(th.y, g)) + 0.5;
        ctx.strokeStyle = th.sev === 'crit' ? C.crit : C.warn; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(xl, py); ctx.lineTo(xr, py); ctx.stroke(); ctx.setLineDash([]);
        ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = C['ink-2'];
        ctx.fillText(th.label, xr - 4, py - 2);
      }
      // series: faint first, colored on top
      const ordered = [...this.o.series.filter(s => s.faint), ...this.o.series.filter(s => !s.faint)];
      for (const s of ordered) this.line(ctx, s, g);
      ctx.restore();
      this.drawOverlay();
    }
    line(ctx, s, g) {
      if (!s.t.length) return;
      const [i0, i1] = visRange(s.t); if (i1 < i0) return;
      ctx.strokeStyle = s.faint ? C.faint : slotColor(s.slot); ctx.lineWidth = s.faint ? 1 : 1.75; ctx.lineJoin = 'round';
      if (s.dash) ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const t = s.t, v = s.v; const plotW = g.w - g.l - g.r;
      let started = false;
      if (!s.step && i1 - i0 > plotW * 2) {
        let col = null, mn = 0, mx = 0, first = 0, last = 0;
        const flush = () => { if (col == null) return; const a = this.y2px(first, g), b = this.y2px(mn, g), c = this.y2px(mx, g), d = this.y2px(last, g);
          if (!started) { ctx.moveTo(col, a); started = true; } else ctx.lineTo(col, a); ctx.lineTo(col, b); ctx.lineTo(col, c); ctx.lineTo(col, d); };
        for (let i = i0; i <= i1; i++) {
          const y = v[i]; if (!isFinite(y)) continue;
          const px = Math.round(this.x2px(t[i], g));
          if (px !== col) { flush(); col = px; mn = mx = first = last = y; } else { if (y < mn) mn = y; if (y > mx) mx = y; last = y; }
        }
        flush();
      } else {
        let py = null;
        for (let i = i0; i <= i1; i++) {
          const y = v[i]; if (!isFinite(y)) { started = false; continue; }
          const px = this.x2px(t[i], g), yy = this.y2px(y, g);
          if (!started) { ctx.moveTo(px, yy); started = true; } else { if (s.step) ctx.lineTo(px, py); ctx.lineTo(px, yy); }
          py = yy;
        }
        if (s.step && started && py != null) ctx.lineTo(this.x2px(Math.min(S.view.t1, S.log.tMax), g), py);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    drawOverlay() {
      if (!this.visible() || this.y0 == null) return;
      const g = this.geom(); const ctx = sizeCanvas(this.over, g.w, g.h);
      const xl = g.l, xr = g.w - g.r, yt = g.t, yb = g.h - g.b;
      if (this.drag && this.drag.active) {
        const a = clamp(Math.min(this.drag.x0, this.drag.x1), xl, xr), b = clamp(Math.max(this.drag.x0, this.drag.x1), xl, xr);
        ctx.fillStyle = C['accent-soft']; ctx.fillRect(a, yt, b - a, yb - yt);
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.strokeRect(a + 0.5, yt + 0.5, b - a - 1, yb - yt - 1);
      }
      const t = S.cursor;
      if (t == null || t < S.view.t0 || t > S.view.t1) { this.tip.hidden = true; return; }
      const px = Math.round(this.x2px(t, g)) + 0.5;
      ctx.strokeStyle = C['ink-2']; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, yt); ctx.lineTo(px, yb); ctx.stroke(); ctx.globalAlpha = 1;
      const rows = [];
      for (const s of this.o.series) {
        if (s.faint || !s.t.length || t < s.t[0]) continue;
        const y = Core.valueAt(s.t, s.v, t); if (!isFinite(y)) continue;
        const py = this.y2px(y, g);
        if (py >= yt - 1 && py <= yb + 1) {
          ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fillStyle = C.surface; ctx.fill();
          ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fillStyle = slotColor(s.slot); ctx.fill();
        }
        rows.push([s, y]);
      }
      if (!this.hover || !rows.length) { this.tip.hidden = true; return; }
      rows.sort((a, b) => b[1] - a[1]);
      this.tip.replaceChildren(h('div', { class: 'tt' }, `${t.toFixed(2)} s`),
        ...rows.slice(0, 10).map(([s, y]) => h('div', { class: 'row' }, h('i', { style: `background:${slotColor(s.slot)}` }), s.name, h('b', null, s.bool ? (y ? 'true' : 'false') : fmtU(y, this.o.unit)))));
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = (px + 12 + tw > g.w ? px - 12 - tw : px + 12) + 'px';
    }
    bind() {
      const ov = this.over;
      const tAt = e => { const g = this.geom(); return this.px2x(clamp(e.offsetX, g.l, g.w - g.r), g); };
      ov.addEventListener('pointerdown', e => { if (e.button) return; this.drag = { x0: e.offsetX, x1: e.offsetX, active: false }; try { ov.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
      ov.addEventListener('pointermove', e => {
        this.hover = true;
        if (this.drag) { this.drag.x1 = e.offsetX; if (Math.abs(this.drag.x1 - this.drag.x0) > 5) this.drag.active = true; }
        if (e.pointerType === 'mouse' || this.drag) setCursor(tAt(e));
      });
      ov.addEventListener('pointerup', e => {
        const d = this.drag; this.drag = null; if (!d) return;
        const g = this.geom();
        if (d.active) setView(this.px2x(clamp(Math.min(d.x0, d.x1), g.l, g.w - g.r), g), this.px2x(clamp(Math.max(d.x0, d.x1), g.l, g.w - g.r), g));
        else { setCursor(tAt(e)); if (this.onClick) this.onClick(e); }
        scheduleOverlay();
      });
      ov.addEventListener('pointercancel', () => { this.drag = null; scheduleOverlay(); });
      ov.addEventListener('pointerleave', e => { this.hover = false; if (e.pointerType === 'mouse' && !this.drag) setCursor(null); else scheduleOverlay(); });
      ov.addEventListener('dblclick', resetView);
    }
  }

  // ---------- timeline ----------
  const tl = $('#tl'); let tlDrag = null;
  function tlGeom() { return { w: tl.clientWidth, h: tl.clientHeight }; }
  const tlX = (t, g) => (t - S.log.tMin) / Math.max(1e-9, S.log.tMax - S.log.tMin) * g.w;
  const tlT = (x, g) => S.log.tMin + clamp(x, 0, g.w) / g.w * (S.log.tMax - S.log.tMin);
  function drawTimeline() {
    const g = tlGeom(); if (!g.w) return;
    const ctx = sizeCanvas(tl, g.w, g.h);
    ctx.fillStyle = C['surface-2']; ctx.fillRect(0, 0, g.w, g.h);
    if (!S.log) return;
    const bandTop = 12, bandBot = g.h - 12;
    drawPhases(ctx, t => tlX(t, g), bandTop, bandBot, 0, g.w);
    ctx.strokeStyle = C.line; ctx.strokeRect(0.5, bandTop + 0.5, g.w - 1, bandBot - bandTop - 1);
    for (const f of S.sum.flags) {
      const x = Math.round(tlX(f.t, g)) + 0.5; ctx.strokeStyle = f.sev === 'crit' ? C.crit : C.warn; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, bandTop - 1); ctx.stroke();
    }
    ctx.lineWidth = 1;
    const a = tlX(S.view.t0, g), b = tlX(S.view.t1, g);
    ctx.fillStyle = C.bg; ctx.globalAlpha = 0.55; ctx.fillRect(0, bandTop, a, bandBot - bandTop); ctx.fillRect(b, bandTop, g.w - b, bandBot - bandTop); ctx.globalAlpha = 1;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 2; ctx.strokeRect(a + 1, bandTop + 1, Math.max(2, b - a - 2), bandBot - bandTop - 2); ctx.lineWidth = 1;
    ctx.font = '10.5px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = C.muted; ctx.textBaseline = 'top';
    const st = niceStep(S.log.tMax - S.log.tMin, Math.max(2, Math.floor(g.w / 90)));
    for (let t = Math.ceil(S.log.tMin / st) * st; t <= S.log.tMax; t += st) { const x = tlX(t, g); if (x < 8 || x > g.w - 24) continue; ctx.textAlign = 'center'; ctx.fillText(Math.round(t) + 's', x, bandBot + 1); }
    if (tlDrag && tlDrag.active) { const p = Math.min(tlDrag.x0, tlDrag.x1), q = Math.max(tlDrag.x0, tlDrag.x1); ctx.fillStyle = C['accent-soft']; ctx.fillRect(p, bandTop, q - p, bandBot - bandTop); }
    if (S.cursor != null) { const x = Math.round(tlX(S.cursor, g)) + 0.5; ctx.strokeStyle = C.ink; ctx.beginPath(); ctx.moveTo(x, bandTop - 2); ctx.lineTo(x, bandBot + 2); ctx.stroke(); }
  }
  tl.addEventListener('pointerdown', e => { if (!S.log) return; tlDrag = { x0: e.offsetX, x1: e.offsetX, active: false }; try { tl.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
  tl.addEventListener('pointermove', e => { if (!tlDrag) return; tlDrag.x1 = e.offsetX; if (Math.abs(tlDrag.x1 - tlDrag.x0) > 4) tlDrag.active = true; drawTimeline(); });
  tl.addEventListener('pointerup', e => {
    const d = tlDrag; tlDrag = null; if (!d || !S.log) return; const g = tlGeom();
    if (d.active) setView(tlT(Math.min(d.x0, d.x1), g), tlT(Math.max(d.x0, d.x1), g));
    else { const t = tlT(e.offsetX, g); if (t < S.view.t0 || t > S.view.t1) { const sp = S.view.t1 - S.view.t0; setView(t - sp / 2, t + sp / 2); } setCursor(t); }
  });
  $('#zMatch').onclick = resetView;
  $('#zAll').onclick = () => S.log && setView(S.log.tMin, S.log.tMax);
  $('#zIn').onclick = () => S.log && zoom(0.5);
  $('#zOut').onclick = () => S.log && zoom(2);
  new ResizeObserver(drawTimeline).observe(tl);

  // ---------- tabs ----------
  const TABS = [['report', 'Report'], ['motors', 'Motors'], ['faults', 'Faults'], ['power', 'Power'], ['field', 'Field'], ['mech', 'Mechanisms'], ['robot3d', 'Robot 3D'], ['signals', 'Signals'], ['history', 'History']];
  function renderTabs() {
    const counts = S.sum ? { faults: allLanes().filter(l => l.kind !== 'limit' && l.key !== 'Temp').reduce((q, l) => q + l.count, 0), motors: S.sum.motors.length, mech: mechNames().length, signals: S.log.entries.size, history: S.history ? S.history.length : null } : {};
    $('#tabs').replaceChildren(...TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': S.tab === id ? 'true' : 'false', 'aria-controls': 'tab-' + id, onclick: () => showTab(id) }, label, counts[id] != null ? h('span', { class: 'count' }, counts[id]) : null)));
  }
  function showTab(id) {
    S.tab = id; S.playing = false;
    for (const [t] of TABS) $('#tab-' + t).hidden = t !== id;
    renderTabs();
    if (!S.built[id]) { S.built[id] = true; BUILD[id](); }
    try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
    scheduleRedraw();
  }

  // ---------- shared builders ----------
  const panel = (title, sub, ...kids) => h('div', { class: 'panel' }, h('div', { class: 'ph' }, title, sub ? h('small', null, sub) : null), ...kids);
  const entry = name => Core.findEntry(S.log, name);
  const keyE = k => Core.findEntry(S.log, ...Core.KEYS[k]);
  const ser = (e, name, slot, extra = {}) => ({ name, t: e.t, v: e.v, slot, bool: e.kind === 'bool', step: e.kind === 'bool', ...extra });
  const tempThresholds = () => [{ y: S.limits.tempWarn, sev: 'warn', label: `Warning ${S.limits.tempWarn} °C` }, { y: S.limits.tempCrit, sev: 'crit', label: `Limit ${S.limits.tempCrit} °C` }];
  const voltThresholds = () => [{ y: S.limits.voltWarn, sev: 'warn', label: `${S.limits.voltWarn} V` }, { y: S.limits.voltCrit, sev: 'crit', label: `${S.limits.voltCrit} V` }];
  const sevIcon = sev => h('span', { html: sev === 'crit'
    ? '<svg viewBox="0 0 12 12"><path d="M6 1 11 10.5H1z" fill="currentColor"/><path d="M6 4.5v3M6 8.6v.1" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="currentColor"/><path d="M6 3.5v3.2M6 8.3v.1" stroke="#000" stroke-opacity=".7" stroke-width="1.4" stroke-linecap="round"/></svg>' });

  function motorSeries(field) {
    const out = [];
    for (const m of S.sum.motors) {
      const e = m.entries[field]; if (!e) continue;
      const slot = S.motorSlot.get(m.name);
      out.push(S.motorSel.includes(m.name) ? ser(e, m.name, slot) : ser(e, m.name, 0, { faint: true }));
    }
    return out;
  }
  const motorCharts = [];
  function refreshMotorCharts() { for (const [c, f] of motorCharts) if (c.root.isConnected) c.setSeries(motorSeries(f)); }
  function toggleMotor(name) {
    const i = S.motorSel.indexOf(name);
    if (i >= 0) { S.motorSel.splice(i, 1); S.motorSlot.delete(name); }
    else { if (S.motorSel.length >= 8) { toast('Up to 8 motors can be highlighted at once.'); return; } S.motorSel.push(name); takeSlot(S.motorSlot, name); }
    refreshMotorCharts(); if (S.built.motors) renderMotorTable();
  }

  function buildTiles() {
    const s = S.sum, L = S.limits;
    const sevOf = (v, warnFn, critFn) => (v == null ? null : critFn(v) ? 'crit' : warnFn(v) ? 'warn' : 'ok');
    const hottest = [...s.motors].filter(m => m.tempMax != null).sort((a, b) => b.tempMax - a.tempMax)[0];
    const tile = (k, v, unit, d, sev) => h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', null, unit) : null), h('div', { class: 'd' }, sev ? h('span', { class: 'dot ' + sev, title: sev === 'ok' ? 'Within limits' : sev === 'warn' ? 'Warning' : 'Critical' }) : null, d));
    const commsTot = s.commsDrops.reduce((q, d) => q + d.dur, 0);
    const faulty = s.motors.filter(m => m.faultCount);
    const faultSev = faulty.some(m => m.drops.length || m.hwFaults.some(l => l.sev === 'crit')) ? 'crit' : faulty.length ? 'warn' : 'ok';
    return h('div', { class: 'tiles' },
      tile('Lowest battery', fmt(s.battery?.min, 2), 'V', s.battery ? `started at ${fmt(s.battery.start, 2)} V` : 'not logged', sevOf(s.battery?.min, v => v < L.voltWarn, v => v < L.voltCrit)),
      tile('Energy used', fmt(s.energyWh, 1), 'Wh', 'while enabled'),
      tile('Peak current', fmt(s.current?.peak, 0), 'A', s.current ? `avg ${fmt(s.current.avg, 0)} A enabled` : 'not logged'),
      tile('Hottest motor', hottest ? fmt(hottest.tempMax, 0) : '—', '°C', hottest ? hottest.name : 'not logged', hottest ? sevOf(hottest.tempMax, v => v >= L.tempWarn, v => v >= L.tempCrit) : null),
      tile('Brownouts', s.brownouts.length, '', s.brownouts.length ? `first at ${fmt(s.brownouts[0], 1)} s` : 'none', s.brownouts.length ? 'crit' : 'ok'),
      tile('Comms drops', s.commsDrops.length, '', s.commsDrops.length ? `${fmt(commsTot, 1)} s offline` : s.fms ? 'on FMS' : 'no FMS', s.commsDrops.length ? 'crit' : 'ok'),
      tile('CAN bus peak', fmt(s.canPeak, 0), '%', s.canAvg != null ? `avg ${fmt(s.canAvg, 0)}%` : 'not logged', s.canPeak != null ? (s.canPeak > L.canWarn ? 'warn' : 'ok') : null),
      tile('Loop overruns', s.loop ? s.loop.overruns : '—', '', s.loop ? `worst ${fmt(s.loop.worst, 0)} ms` : 'not logged', s.loop ? (s.loop.overruns > 5 ? 'warn' : 'ok') : null),
      tile('Distance driven', fmt(s.drive?.distance, 0), 'm', s.drive ? `top speed ${fmt(s.drive.topSpeed, 2)} m/s` : 'no pose logged'),
      tile('Enabled', mmss(s.enabledTime), '', `auto ${mmss(s.autoTime)} · teleop ${mmss(s.teleopTime)}`),
      tile('Charge used', fmt(s.ampHours, 2), 'Ah', 'while enabled'),
      tile('Motor faults', s.motorFaults, '', faulty.length ? `on ${faulty.length} of ${s.motors.length} controllers` : s.motors.length ? 'none reported' : 'no motors logged', s.motors.length ? faultSev : null));
  }
  // ---------- REPORT ----------
  const BUILD = {};
  BUILD.report = () => {
    const s = S.sum, L = S.limits, root = $('#tab-report');
    const crit = s.flags.filter(f => f.sev === 'crit').length, warn = s.flags.filter(f => f.sev === 'warn').length;
    const flagsBox = h('div', { class: 'flags' });
    for (const f of s.flags) {
      const card = h('div', { class: 'flag ' + f.sev },
        h('div', { class: 'stripe' }),
        h('div', { class: 'body' }, h('span', { class: 'sev' }, sevIcon(f.sev), f.sev === 'crit' ? 'Critical' : 'Warning', ` · ${fmt(f.t, 1)} s`), h('h3', null, f.title), h('p', null, f.detail)));
      const btn = h('button', { class: 'btn small go', 'aria-expanded': 'false' }, 'Show');
      btn.onclick = () => {
        const open = btn.getAttribute('aria-expanded') === 'true';
        const old = card.querySelector('.inline-chart'); if (old) old.remove();
        btn.setAttribute('aria-expanded', open ? 'false' : 'true'); btn.textContent = open ? 'Show' : 'Hide';
        if (open) return;
        const e = S.log.entries.get(f.ref) || entry(f.ref);
        if (e) {
          const c = new TimeChart({ title: Core.stripPrefix(e.name), unit: e.unit, height: 130, series: [ser(e, Core.stripPrefix(e.name), 1)],
            thresholds: /TempC$/.test(e.name) ? tempThresholds() : /BatteryV$/.test(e.name) ? voltThresholds() : [] });
          card.append(h('div', { class: 'inline-chart' }, c.root));
        }
        setView(f.t - 10, f.t + 10); setCursor(f.t);
      };
      card.append(btn);
      flagsBox.append(card);
    }
    const attention = panel('Needs attention', s.flags.length ? `${s.flags.length} item${s.flags.length > 1 ? 's' : ''}, worst first` : null,
      allLanes().length ? h('p', { class: 'hint', style: 'margin:-4px 0 10px' }, h('button', { class: 'linkbtn', onclick: () => showTab('faults') }, 'Open the fault timeline'), ' to see every fault and current-limit event in order.') : null,
      s.flags.length ? h('div', { class: 'verdict' }, h('b', null, crit ? `${crit} critical` : `${warn} warning${warn > 1 ? 's' : ''}`), crit && warn ? h('span', { class: 'hint' }, `and ${warn} warning${warn > 1 ? 's' : ''}`) : null) : null,
      s.flags.length ? flagsBox : h('div', { class: 'allclear', html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 8.5 3 3 7-7"/></svg><span>Nothing crossed a limit in this log.</span>' }));

    const tiles = buildTiles();
    const limInput = (key, label, stepv) => h('label', null, label, h('input', { id: 'lim-' + key, type: 'number', step: stepv, value: L[key], onchange: e => { const v = parseFloat(e.target.value); if (!isFinite(v)) return; S.limits[key] = v; store.set('7763.limits', S.limits); reanalyze(); } }));
    const limits = h('details', { class: 'limits-box' }, h('summary', null, 'Limits used for warnings'),
      h('div', { class: 'limits' }, limInput('tempWarn', 'Motor warn °C', 1), limInput('tempCrit', 'Motor limit °C', 1), limInput('voltWarn', 'Battery warn V', 0.1), limInput('voltCrit', 'Battery limit V', 0.1), limInput('loopMs', 'Loop overrun ms', 1), limInput('canWarn', 'CAN warn %', 1), limInput('supplyLimitA', 'Default supply limit A', 1), limInput('statorLimitA', 'Default stator limit A', 1), limInput('ocMinS', 'Ignore limit blips under s', 0.05),
        h('button', { class: 'linkbtn', onclick: () => { S.limits = { ...Core.DEFAULT_LIMITS }; store.set('7763.limits', S.limits); reanalyze(); } }, 'Reset defaults')),
      h('p', { class: 'hint' }, 'These are starting points, not manufacturer ratings. Set them from your motors\' datasheets and your own experience. The default current limits apply only to motors that don\'t log their own SupplyLimitA / StatorLimitA.'));
    const summary = panel('Match summary', s.phases.hasDS ? null : 'No DS:enabled entry, so the whole log counts as enabled', tiles, limits);

    // charts
    const charts = h('div', { class: 'grid2' });
    const bat = keyE('battery'), cur = keyE('current');
    const left = panel('Battery', 'Voltage and current share one time axis');
    if (bat) left.append(new TimeChart({ title: 'Battery voltage', unit: 'V', series: [ser(bat, 'Battery', 1)], thresholds: voltThresholds(), markers: s.brownouts }).root);
    if (cur) left.append(new TimeChart({ title: 'Total current', unit: 'A', series: [ser(cur, 'Total current', 1)], yZero: true, markers: s.brownouts }).root);
    if (!bat && !cur) left.append(h('p', { class: 'hint' }, 'No Power/BatteryV or Power/TotalCurrentA in this log.'));
    const right = panel('Motor temperature', S.motorSel.length ? 'Highlighted: hottest three. Pick others on the Motors tab.' : null);
    if (s.motors.some(m => m.entries.TempC)) { const c = new TimeChart({ title: 'Temperature', unit: 'degC', height: 290, series: motorSeries('TempC'), thresholds: tempThresholds(), includeThresholds: false }); motorCharts.push([c, 'TempC']); right.append(c.root); }
    else right.append(h('p', { class: 'hint' }, 'No Motors/<name>/TempC entries in this log.'));
    charts.append(left, right);
    root.replaceChildren(h('div', { class: 'report-top' }, attention, summary), charts);
  };

  // ---------- MOTORS ----------
  const MCOLS = [
    ['name', 'Motor', false], ['canId', 'CAN', true], ['tempMax', 'Max temp', true], ['tempRise', 'Rise', true], ['supplyPeak', 'Peak supply', true], ['supplyAvg', 'Avg supply', true],
    ['statorPeak', 'Peak stator', true], ['energyWh', 'Energy', true], ['share', 'Share', true], ['faultCount', 'Faults', true], ['limitTime', 'At limit', true], ['sev', 'Status', false],
  ];
  function renderMotorTable() {
    const box = $('#motorTable'); if (!box) return;
    const { key, dir } = S.motorSort;
    const val = m => key === 'tempRise' ? (m.tempMax ?? NaN) - (m.tempStart ?? NaN) : key === 'drops' ? m.drops.length : key === 'sev' ? { crit: 2, warn: 1, ok: 0 }[m.sev] : m[key];
    const rows = [...S.sum.motors].sort((a, b) => { const x = val(a), y = val(b); if (typeof x === 'string') return x.localeCompare(y) * dir; return ((isFinite(x) ? x : -1e9) - (isFinite(y) ? y : -1e9)) * dir; });
    const L = S.limits;
    const head = h('tr', null, ...MCOLS.map(([k, label, num]) => h('th', { class: 'sortable' + (num ? ' r' : ''), 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none', onclick: () => { S.motorSort = { key: k, dir: key === k ? -dir : (num ? -1 : 1) }; renderMotorTable(); } }, label, key === k ? (dir > 0 ? ' ↑' : ' ↓') : '')));
    const body = rows.map(m => {
      const on = S.motorSel.includes(m.name), slot = S.motorSlot.get(m.name);
      const tcol = m.tempMax >= L.tempCrit ? C.crit : m.tempMax >= L.tempWarn ? C.warn : C.muted;
      const pill = m.sev === 'ok' ? h('span', { class: 'pill' }, h('span', { class: 'dot ok' }), 'OK') : h('span', { class: 'pill' }, h('span', { class: 'dot ' + m.sev }), m.sev === 'crit' ? 'Critical' : 'Warning');
      return h('tr', { class: on ? 'sel' : '', onclick: () => toggleMotor(m.name), tabindex: 0, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMotor(m.name); } } },
        h('td', null, h('span', { class: 'sw', style: on ? `background:${slotColor(slot)};border-color:${slotColor(slot)}` : '' }), m.name),
        h('td', { class: 'r mono', title: m.controller ? `${m.controller}${m.canBus ? ' on ' + m.canBus : ''}` : '' }, m.canId != null ? m.canId : '—'),
        h('td', { class: 'r' }, m.tempMax != null ? h('span', { class: 'tbar' }, h('i', { style: `width:${clamp(m.tempMax / Math.max(L.tempCrit * 1.15, 1) * 100, 2, 100)}%;background:${tcol}` })) : null, fmtU(m.tempMax, 'degC', 1)),
        h('td', { class: 'r' }, m.tempMax != null ? `+${fmt(m.tempMax - m.tempStart, 1)}°` : '—'),
        h('td', { class: 'r' }, fmtU(m.supplyPeak, 'A', 1)), h('td', { class: 'r' }, fmtU(m.supplyAvg, 'A', 1)), h('td', { class: 'r' }, fmtU(m.statorPeak, 'A', 1)),
        h('td', { class: 'r' }, fmtU(m.energyWh, 'Wh', 2)), h('td', { class: 'r' }, fmt(m.share * 100, 0) + '%'),
        h('td', { class: 'r' }, m.faultCount ? h('button', { class: 'linkbtn', onclick: ev => { ev.stopPropagation(); allLanes(); S.faultSel = m.lanes.find(l => l.kind === 'hw' || l.key === 'Disconnected')?.id ?? m.lanes[0]?.id ?? null; S.faultOcc = 0; showTab('faults'); } }, String(m.faultCount)) : '0'),
        h('td', { class: 'r' }, m.limitTime >= 0.05 ? `${fmt(m.limitTime, 1)} s` : '—'), h('td', null, pill));
    });
    box.replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, ...body)));
  }
  BUILD.motors = () => {
    const root = $('#tab-motors');
    if (!S.sum.motors.length) { root.replaceChildren(panel('Motors', null, h('div', { class: 'empty' }, h('b', null, 'No motor entries'), 'Log Motors/<name>/TempC, SupplyCurrentA, StatorCurrentA, BusVoltageV, DutyCycle, VelocityRPM and Connected to fill this tab.'))); return; }
    const table = panel('Motors', 'Click a row to highlight it in the charts. Supply current and energy count enabled time only.', h('div', { class: 'tscroll', id: 'motorTable' }));
    const grid = h('div', { class: 'grid2' });
    const add = (field, title, unit, extra = {}) => { if (!S.sum.motors.some(m => m.entries[field])) return; const c = new TimeChart({ title, unit, series: motorSeries(field), ...extra }); motorCharts.push([c, field]); grid.append(h('div', { class: 'panel' }, c.root)); };
    add('TempC', 'Temperature', 'degC', { thresholds: tempThresholds() });
    add('SupplyCurrentA', 'Supply current', 'A', { yZero: true });
    add('StatorCurrentA', 'Stator current', 'A');
    add('VelocityRPM', 'Velocity', 'rpm');
    add('DutyCycle', 'Duty cycle', 'fraction');
    add('BusVoltageV', 'Bus voltage', 'V');
    root.replaceChildren(table, grid);
    renderMotorTable();
  };

  // ---------- POWER ----------
  BUILD.power = () => {
    const s = S.sum, root = $('#tab-power');
    const bat = keyE('battery'), cur = keyE('current'), pw = keyE('power'), bo = keyE('brownout'), pdhT = keyE('pdhTemp');
    const left = panel('Battery and draw', s.brownouts.length ? 'Dashed red lines mark brownouts' : null);
    if (bat) left.append(new TimeChart({ title: 'Battery voltage', unit: 'V', series: [ser(bat, 'Battery', 1)], thresholds: voltThresholds(), markers: s.brownouts }).root);
    if (cur) left.append(new TimeChart({ title: 'Total current', unit: 'A', series: [ser(cur, 'Total', 1)], yZero: true, markers: s.brownouts }).root);
    if (pw) left.append(new TimeChart({ title: 'Total power', unit: 'W', series: [ser(pw, 'Power', 1)], yZero: true, markers: s.brownouts }).root);
    if (bo) left.append(new TimeChart({ title: 'Browned out', unit: '', height: 70, series: [ser(bo, 'Browned out', 8)] }).root);
    if (pdhT) left.append(new TimeChart({ title: 'PDH temperature', unit: 'degC', height: 120, series: [ser(pdhT, 'PDH', 1)] }).root);
    if (left.children.length === 1) left.append(h('p', { class: 'hint' }, 'No Power/* entries in this log.'));

    const right = h('div', { style: 'display:grid;gap:18px;align-content:start;min-width:0' });
    const ms = [...s.motors].filter(m => m.energyWh > 0).sort((a, b) => b.energyWh - a.energyWh);
    if (ms.length) {
      const max = ms[0].energyWh;
      right.append(panel('Energy by motor', `${fmt(s.motorEnergyWh, 1)} Wh through motor controllers of ${fmt(s.energyWh, 1)} Wh total`,
        h('div', { class: 'hbars' }, ...ms.map(m => h('div', { class: 'hbar', title: `${m.name}: ${fmt(m.energyWh, 2)} Wh (${fmt(m.share * 100, 0)}%)` }, h('span', { class: 'lab' }, m.name), h('span', { class: 'track' }, h('i', { style: `width:${Math.max(1, m.energyWh / max * 100)}%` })), h('span', { class: 'val' }, fmt(m.energyWh, 2) + ' Wh'))))));
    }
    const ch = keyE('channels');
    if (ch && ch.vals && ch.vals.length) {
      const n = Math.max(...ch.vals.map(a => a.length)); const peak = new Array(n).fill(0), sum = new Array(n).fill(0); let cnt = 0;
      const en = s.phases.enabled;
      ch.vals.forEach((a, i) => { const t = ch.t[i]; if (!en.some(([p, q]) => t >= p && t < q)) return; cnt++; for (let k = 0; k < a.length; k++) { peak[k] = Math.max(peak[k], a[k]); sum[k] += a[k]; } });
      const rows = peak.map((p, k) => [k, p, cnt ? sum[k] / cnt : 0]).filter(r => r[1] > 0.05);
      const max = Math.max(1, ...rows.map(r => r[1]));
      right.append(panel('PDH channels', 'Peak current per channel while enabled',
        h('div', { class: 'hbars' }, ...rows.map(([k, p, a]) => h('div', { class: 'hbar', title: `Channel ${k}: peak ${fmt(p, 1)} A, average ${fmt(a, 1)} A` }, h('span', { class: 'lab mono' }, `Ch ${k}`), h('span', { class: 'track' }, h('i', { style: `width:${Math.max(1, p / max * 100)}%` })), h('span', { class: 'val' }, fmt(p, 1) + ' A'))))));
    }
    root.replaceChildren(h('div', { class: 'grid2' }, left, right));
  };

  // ---------- FIELD ----------
  let fieldCanvas = null, fieldHover = null;
  BUILD.field = () => {
    const root = $('#tab-field'), s = S.sum;
    if (!s.poses.length) { fieldCanvas = null; root.replaceChildren(panel('Field', null, h('div', { class: 'empty' }, h('b', null, 'No robot pose logged'), 'Log a struct:Pose2d entry named Robot/Pose to draw the robot\'s path.'))); return; }
    fieldCanvas = h('canvas', { 'aria-label': 'Robot path on the field. Hover to scrub through time.' });
    const play = h('button', { class: 'btn small play-btn', id: 'playBtn' }, 'Play');
    play.onclick = () => { S.playing = !S.playing; play.textContent = S.playing ? 'Pause' : 'Play'; if (S.playing) { if (S.cursor == null || S.cursor >= S.view.t1 - 0.05 || S.cursor < S.view.t0) S.cursor = S.view.t0; tick.last = performance.now(); requestAnimationFrame(tick); } };
    const rate = h('select', { class: 'sel', id: 'rateSel', 'aria-label': 'Playback speed', onchange: e => { S.rate = +e.target.value; } }, ...[1, 2, 4, 8].map(r => h('option', { value: r, selected: S.rate === r }, r + '×')));
    const dim = (k, label) => h('label', null, label, h('input', { id: 'field-' + k, type: 'number', step: 0.01, value: S.field[k], onchange: e => { const v = parseFloat(e.target.value); if (v > 1) { S.field[k] = v; store.set('7763.field', S.field); drawField(); } } }));
    const vmax = s.drive ? s.drive.topSpeed : 0;
    const legend = h('span', null, 'Speed ', h('span', { class: 'mono' }, '0'), ' ', h('span', { class: 'ramp' }), ' ', h('span', { class: 'mono' }, fmt(vmax, 1) + ' m/s'));
    const others = s.poses.slice(1).map((p, i) => h('span', null, h('span', { class: 'dot', style: `background:${slotColor(i + 2)}` }), ' ', p.name));
    const tools = h('div', { class: 'field-tools' }, play, rate, legend, ...others, h('span', { style: 'margin-left:auto;display:inline-flex;gap:10px' }, dim('w', 'Field length m'), dim('h', 'width m')));
    const wrap = h('div', { class: 'field-wrap' }, fieldCanvas);
    fieldCanvas.addEventListener('pointermove', e => { fieldHover = [e.offsetX, e.offsetY]; scrubField(); });
    fieldCanvas.addEventListener('pointerdown', e => { fieldHover = [e.offsetX, e.offsetY]; scrubField(); });
    fieldCanvas.addEventListener('pointerleave', () => { fieldHover = null; });
    new ResizeObserver(drawField).observe(wrap);
    const kids = [panel('Field', `${s.poses[0].name} · blue-alliance origin, x toward the red wall`, tools, wrap)];
    if (s.drive) kids.push(panel('Speed', 'From odometry, 0.1 s moving average', new TimeChart({ title: 'Robot speed', unit: 'm/s', series: [{ name: 'Speed', t: s.poses[0].t, v: s.drive.speed, slot: 1 }], yZero: true }).root));
    root.replaceChildren(...kids);
  };
  function tick(now) {
    if (!S.playing) return;
    const dt = Math.min(0.1, (now - (tick.last || now)) / 1000); tick.last = now;
    S.cursor = (S.cursor ?? S.view.t0) + dt * S.rate;
    if (S.cursor >= S.view.t1) { S.cursor = S.view.t1; S.playing = false; document.querySelectorAll('.play-btn').forEach(b => { b.textContent = 'Play'; }); }
    scheduleOverlay();
    if (S.playing) requestAnimationFrame(tick);
  }
  function fieldGeom() {
    const w = fieldCanvas.parentElement.clientWidth; const pad = 24;
    const sc = (w - pad * 2) / S.field.w; const hh = S.field.h * sc + pad * 2;
    return { w, h: hh, pad, sc, X: x => pad + x * sc, Y: y => hh - pad - y * sc };
  }
  function scrubField() {
    if (!fieldHover || !fieldCanvas || S.playing) return;
    const g = fieldGeom(), p = S.sum.poses[0]; const [i0, i1] = visRange(p.t);
    let best = -1, bd = 26 * 26;
    for (let i = i0; i <= i1; i++) { const dx = g.X(p.x[i]) - fieldHover[0], dy = g.Y(p.y[i]) - fieldHover[1]; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    if (best >= 0) setCursor(p.t[best]);
  }
  function drawField() {
    if (!fieldCanvas || !fieldCanvas.isConnected || !fieldCanvas.parentElement.clientWidth || S.tab !== 'field') return;
    const g = fieldGeom(); fieldCanvas.style.height = g.h + 'px';
    const ctx = sizeCanvas(fieldCanvas, g.w, g.h);
    const W = S.field.w, H = S.field.h;
    ctx.fillStyle = C['surface-2']; ctx.fillRect(g.X(0), g.Y(H), W * g.sc, H * g.sc);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    for (let x = 1; x < W; x++) { const px = Math.round(g.X(x)) + 0.5; ctx.beginPath(); ctx.moveTo(px, g.Y(0)); ctx.lineTo(px, g.Y(H)); ctx.stroke(); }
    for (let y = 1; y < H; y++) { const py = Math.round(g.Y(y)) + 0.5; ctx.beginPath(); ctx.moveTo(g.X(0), py); ctx.lineTo(g.X(W), py); ctx.stroke(); }
    ctx.strokeStyle = C['line-2']; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(g.X(W / 2), g.Y(0)); ctx.lineTo(g.X(W / 2), g.Y(H)); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 3; ctx.strokeStyle = C.s1; ctx.beginPath(); ctx.moveTo(g.X(0), g.Y(0)); ctx.lineTo(g.X(0), g.Y(H)); ctx.stroke();
    ctx.strokeStyle = C.crit; ctx.beginPath(); ctx.moveTo(g.X(W), g.Y(0)); ctx.lineTo(g.X(W), g.Y(H)); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = C['line-2']; ctx.strokeRect(g.X(0), g.Y(H), W * g.sc, H * g.sc);
    ctx.font = '10.5px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let x = 0; x <= W; x += 2) ctx.fillText(x + '', g.X(x), g.Y(0) + 5);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let y = 0; y <= H; y += 2) ctx.fillText(y + '', g.X(0) - 6, g.Y(y));
    const s = S.sum, p = s.poses[0]; const [i0, i1] = visRange(p.t);
    const vmax = Math.max(0.5, s.drive ? s.drive.topSpeed : 1); const seq = [C.seq1, C.seq2, C.seq3, C.seq4, C.seq5];
    ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    for (let i = Math.max(i0, 1); i <= i1; i++) {
      if (Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]) > 1) continue;
      const sp = s.drive ? s.drive.speed[i] : 0;
      ctx.strokeStyle = seq[clamp(Math.floor(sp / vmax * 5), 0, 4)];
      ctx.beginPath(); ctx.moveTo(g.X(p.x[i - 1]), g.Y(p.y[i - 1])); ctx.lineTo(g.X(p.x[i]), g.Y(p.y[i])); ctx.stroke();
    }
    s.poses.slice(1).forEach((q, k) => {
      const [a, b] = visRange(q.t); ctx.fillStyle = slotColor(k + 2);
      for (let i = a; i <= b; i++) { if (q.t[i] < S.view.t0 || q.t[i] > S.view.t1) continue; ctx.beginPath(); ctx.arc(g.X(q.x[i]), g.Y(q.y[i]), 2.5, 0, Math.PI * 2); ctx.fill(); }
    });
    const t = S.cursor != null && S.cursor >= S.view.t0 && S.cursor <= S.view.t1 ? S.cursor : S.view.t1;
    const k = Core.idxAt(p.t, t);
    if (k >= 0) {
      const x = p.x[k], y = p.y[k], r = p.r[k], half = 0.42 * g.sc;
      ctx.save(); ctx.translate(g.X(x), g.Y(y)); ctx.rotate(-r);
      ctx.fillStyle = C['accent-soft']; ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5;
      ctx.fillRect(-half, -half, half * 2, half * 2); ctx.strokeRect(-half, -half, half * 2, half * 2);
      ctx.strokeStyle = C.accent; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(half, 0); ctx.stroke();
      ctx.restore();
      ctx.font = '11.5px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillStyle = C['ink-2']; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${t.toFixed(2)} s   x ${x.toFixed(2)}  y ${y.toFixed(2)} m   heading ${(r * 180 / Math.PI).toFixed(0)}°`, g.X(0) + 6, g.Y(H) + 6);
    }
  }


  // ---------- FAULTS ----------
  function allLanes() {
    if (!S.sum) return [];
    if (S.sum._lanes) return S.sum._lanes;
    const rank = { crit: 0, warn: 1, ok: 2 };
    const motors = [...S.sum.motors].filter(m => m.lanes.length).sort((a, b) => rank[a.sev] - rank[b.sev] || b.faultCount - a.faultCount || a.name.localeCompare(b.name));
    // the same controller fault on 3+ motors at once becomes one row under "All motors"
    const byKey = new Map();
    for (const m of motors) for (const l of m.lanes) if (l.kind === 'hw') { if (!byKey.has(l.key)) byKey.set(l.key, []); byKey.get(l.key).push(l); }
    const merged = [], absorbed = new Set();
    for (const [key, ls] of byKey) {
      if (ls.length < 3) continue;
      const t0 = Math.min(...ls.map(l => l.first));
      const together = ls.filter(l => l.first - t0 < 1.0);
      if (together.length < 3) continue;
      together.forEach(l => absorbed.add(l));
      const ivs = []; for (const l of together) for (const iv of l.ivs) ivs.push([...iv]);
      ivs.sort((a, b) => a[0] - b[0]);
      const u = []; for (const iv of ivs) { const last = u[u.length - 1]; if (last && iv[0] <= last[1]) { last[1] = Math.max(last[1], iv[1]); if (iv[2] === 'crit') last[2] = 'crit'; } else u.push(iv); }
      merged.push({ ...together[0], group: 'All motors', label: `${together[0].label} ×${together.length}`, ivs: u, count: u.length, total: u.reduce((q, iv) => q + iv[1] - iv[0], 0), first: u[0][0], members: together.map(l => l.group), refs: together.map(l => l.ref) });
    }
    for (const m of motors) for (const l of m.lanes) l.groupLabel = m.label;
    const lanes = [...S.sum.robotLanes, ...merged, ...motors.flatMap(m => m.lanes.filter(l => !absorbed.has(l)))];
    lanes.forEach((l, i) => { l.id = l.group + '|' + l.key; l.idx = i; });
    return (S.sum._lanes = lanes);
  }
  const visibleLanes = () => allLanes().filter(l => S.showLimits || l.kind !== 'limit');

  class LaneChart extends TimeChart {
    constructor(lanes) {
      super({ title: '', unit: '', height: lanes.length * 24 + 26, series: [] });
      this.lanes = lanes; this.rowH = 24;
      this.onClick = e => { const i = this.rowAt(e); if (i >= 0) selectLane(this.lanes[i].id, true); };
      this.hoverRow = -1;
      this.over.addEventListener('pointermove', e => { const i = this.rowAt(e); if (i !== this.hoverRow) { this.hoverRow = i; this.over.style.cursor = i >= 0 ? 'pointer' : 'crosshair'; } });
      this.over.addEventListener('pointerleave', () => { this.hoverRow = -1; });
      this.renderLegend(); this.draw();
    }
    renderLegend() {
      if (!this.lanes) return;
      this.legendEl.replaceChildren(h('span', null, h('i', { style: `background:${C.crit};height:8px` }), 'Critical'), h('span', null, h('i', { style: `background:${C.warn};height:8px` }), 'Warning'), h('span', { class: 'hint' }, 'Click a row for detail'));
    }
    geom() { const w = this.plot.clientWidth; return { w, h: this.plot.clientHeight, l: w < 560 ? 8 : clamp(Math.round(w * 0.32), 128, 250), r: 10, t: 2, b: 22 }; }
    fitHeight() {
      // phones: label sits above each bar, so rows are taller and the plot gets the full width
      this.narrow = this.plot.clientWidth < 560; this.rowH = this.narrow ? 34 : 24;
      const want = this.lanes.length * this.rowH + 26 + 'px';
      if (this.plot.style.height !== want) this.plot.style.height = want;
    }
    rowAt(e) { const g = this.geom(); const i = Math.floor((e.offsetY - g.t) / this.rowH); return i >= 0 && i < this.lanes.length ? i : -1; }
    draw() {
      if (!this.lanes || !this.visible() || !S.log) return;
      this.fitHeight();
      const g = this.geom(); const ctx = sizeCanvas(this.base, g.w, g.h);
      const xl = g.l, xr = g.w - g.r, yt = g.t, yb = yt + this.lanes.length * this.rowH;
      const barTop = this.narrow ? 17 : 6, barH = this.narrow ? 12 : this.rowH - 12;
      drawPhases(ctx, t => this.x2px(t, g), yt, yb, xl, xr);
      const span = S.view.t1 - S.view.t0; const xs = niceStep(span, Math.max(2, Math.floor((xr - xl) / 80)));
      ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const xdec = xs >= 1 ? 0 : Math.ceil(-Math.log10(xs));
      for (let t = Math.ceil(S.view.t0 / xs) * xs; t <= S.view.t1; t += xs) {
        const px = this.x2px(t, g); if (px < xl + 12 || px > xr - 12) continue;
        ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, yt); ctx.lineTo(Math.round(px) + 0.5, yb); ctx.stroke();
        ctx.fillStyle = C.muted; ctx.fillText(t.toFixed(xdec) + 's', px, yb + 6);
      }
      ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
      const gw = Math.min(Math.round((xl - 12) * 0.46), 12 + Math.max(...this.lanes.map(l => ctx.measureText(l.groupLabel || l.group).width)));
      const fit = (txt, w) => { if (ctx.measureText(txt).width <= w) return txt; while (txt.length > 1 && ctx.measureText(txt + '…').width > w) txt = txt.slice(0, -1); return txt + '…'; };
      this.lanes.forEach((ln, i) => {
        const y = yt + i * this.rowH, newGroup = i === 0 || this.lanes[i - 1].group !== ln.group;
        if (ln.id === S.faultSel) { ctx.fillStyle = C['accent-soft']; ctx.fillRect(0, y, g.w, this.rowH); }
        ctx.strokeStyle = newGroup ? C['line-2'] : C.line; ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(g.w, y + 0.5); ctx.stroke();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        if (this.narrow) {
          ctx.font = '600 11.5px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = C.ink;
          const gtxt = (ln.groupLabel || ln.group) + ' · '; ctx.fillText(gtxt, 10, y + 9);
          const gwid = ctx.measureText(gtxt).width;
          ctx.font = '11.5px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = C['ink-2']; ctx.fillText(fit(ln.label, g.w - 24 - gwid), 10 + gwid, y + 9);
          return;
        }
        if (newGroup) { ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = C.ink; ctx.fillText(fit(ln.groupLabel || ln.group, gw - 4), 6, y + this.rowH / 2); }
        ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = C['ink-2'];
        ctx.fillText(fit(ln.label, xl - gw - 14), gw + 6, y + this.rowH / 2);
      });
      ctx.strokeStyle = C['line-2']; ctx.beginPath(); ctx.moveTo(0, yb + 0.5); ctx.lineTo(g.w, yb + 0.5); ctx.stroke();
      if (!this.narrow) { ctx.beginPath(); ctx.moveTo(xl + 0.5, yt); ctx.lineTo(xl + 0.5, yb); ctx.stroke(); }
      ctx.save(); ctx.beginPath(); ctx.rect(xl + 1, yt, xr - xl - 1, yb - yt); ctx.clip();
      this.lanes.forEach((ln, i) => {
        const y = yt + i * this.rowH;
        for (const [a, b, sev] of ln.ivs) {
          if (b < S.view.t0 || a > S.view.t1) continue;
          const x0 = this.x2px(a, g), x1 = this.x2px(b, g), w = Math.max(3, x1 - x0);
          ctx.fillStyle = sev === 'crit' ? C.crit : C.warn;
          ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, y + barTop, w, barH, 2); else ctx.rect(x0, y + barTop, w, barH); ctx.fill();
        }
      });
      ctx.restore();
      this.y0 = 0; this.drawOverlay();
    }
    drawOverlay() {
      if (!this.lanes || !this.visible()) return;
      const g = this.geom(); const ctx = sizeCanvas(this.over, g.w, g.h);
      const xl = g.l, xr = g.w - g.r, yt = g.t, yb = yt + this.lanes.length * this.rowH;
      if (this.drag && this.drag.active) {
        const a = clamp(Math.min(this.drag.x0, this.drag.x1), xl, xr), b = clamp(Math.max(this.drag.x0, this.drag.x1), xl, xr);
        ctx.fillStyle = C['accent-soft']; ctx.fillRect(a, yt, b - a, yb - yt);
      }
      if (this.hoverRow >= 0 && !this.drag) { ctx.fillStyle = C.faint; ctx.globalAlpha = 0.25; ctx.fillRect(0, yt + this.hoverRow * this.rowH, g.w, this.rowH); ctx.globalAlpha = 1; }
      const t = S.cursor;
      if (t == null || t < S.view.t0 || t > S.view.t1) { this.tip.hidden = true; return; }
      const px = Math.round(this.x2px(t, g)) + 0.5;
      ctx.strokeStyle = C.ink; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(px, yt); ctx.lineTo(px, yb); ctx.stroke(); ctx.globalAlpha = 1;
      if (!this.hover) { this.tip.hidden = true; return; }
      const active = this.lanes.filter(l => l.ivs.some(([a, b]) => t >= a && t < b));
      this.tip.replaceChildren(h('div', { class: 'tt' }, `${t.toFixed(2)} s`),
        ...(active.length ? active.slice(0, 10).map(l => { const e = S.log.entries.get(l.ref); const v = e && e.kind === 'num' ? Core.valueAt(e.t, e.v, t) : NaN;
          return h('div', { class: 'row' }, h('i', { style: `background:${l.ivs.find(([a, b]) => t >= a && t < b)[2] === 'crit' ? C.crit : C.warn}` }), `${l.groupLabel || l.group} · ${l.label}`, isFinite(v) ? h('b', null, fmtU(v, e.unit, 1)) : null); })
          : [h('div', { class: 'row' }, 'Nothing active')]));
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth; this.tip.style.left = (px + 12 + tw > g.w ? px - 12 - tw : px + 12) + 'px';
    }
  }

  function laneDetailCharts(l) {
    const out = [];
    const E = n => (n ? S.log.entries.get(n) || entry(n) : null);
    const motor = S.sum.motors.find(m => m.name === l.group);
    const me = motor ? motor.entries : null;
    const flagChart = e => e && out.push(new TimeChart({ title: Core.stripPrefix(e.name), unit: '', height: 80, series: [ser(e, l.label, 8)] }).root);
    if (l.members) {
      const bat = keyE('battery');
      if (bat) out.push(new TimeChart({ title: 'Battery voltage', unit: 'V', height: 140, series: [ser(bat, 'Battery', 1)], thresholds: voltThresholds(), markers: S.sum.brownouts }).root);
      const bus = l.members.map((name, i) => { const mm = S.sum.motors.find(m => m.name === name); return mm && mm.entries.BusVoltageV ? ser(mm.entries.BusVoltageV, name, i < 4 ? i + 1 : 0, i < 4 ? {} : { faint: true }) : null; }).filter(Boolean);
      if (bus.length) out.push(new TimeChart({ title: 'Bus voltage at each controller', unit: 'V', series: bus, thresholds: voltThresholds(), markers: S.sum.brownouts }).root);
      return out;
    }
    if (l.group === 'Robot') {
      const bat = keyE('battery');
      if (l.key === 'Comms') flagChart(E('DS:ds'));
      if (l.key === 'Brownout') flagChart(E(l.ref));
      if (bat) out.push(new TimeChart({ title: 'Battery voltage', unit: 'V', series: [ser(bat, 'Battery', 1)], thresholds: voltThresholds(), markers: S.sum.brownouts }).root);
      return out;
    }
    if (l.key === 'Temp' && me.TempC) out.push(new TimeChart({ title: `${l.group} temperature`, unit: 'degC', series: [ser(me.TempC, l.group, 1)], thresholds: tempThresholds() }).root);
    else if (l.key === 'Supply' || l.fault === 'SupplyCurrLimit' || l.key === 'Stator' || l.fault === 'StatorCurrLimit') {
      const sup = l.key === 'Supply' || l.fault === 'SupplyCurrLimit';
      if (l.kind === 'hw' || l.fault) flagChart(E(l.ref));
      const e = sup ? me.SupplyCurrentA : me.StatorCurrentA, limE = sup ? me.SupplyLimitA : me.StatorLimitA;
      const lim = l.limit ?? (limE ? limE.v[limE.v.length - 1] : NaN);
      if (e) out.push(new TimeChart({ title: `${l.group} ${sup ? 'supply' : 'stator'} current`, unit: 'A', series: [ser(e, l.group, 1)], thresholds: isFinite(lim) ? [{ y: lim, sev: 'warn', label: `Limit ${fmt(lim, 0)} A` }] : [], includeThresholds: true, yZero: true }).root);
    } else {
      flagChart(E(l.ref));
      if (me.SupplyCurrentA) out.push(new TimeChart({ title: `${l.group} supply current`, unit: 'A', series: [ser(me.SupplyCurrentA, l.group, 1)], yZero: true, markers: S.sum.brownouts }).root);
      if (me.BusVoltageV) out.push(new TimeChart({ title: `${l.group} bus voltage`, unit: 'V', height: 130, series: [ser(me.BusVoltageV, l.group, 1)], thresholds: voltThresholds(), markers: S.sum.brownouts }).root);
    }
    return out;
  }
  function renderFaultDetail() {
    const box = $('#faultDetail'); if (!box) return;
    const l = allLanes().find(x => x.id === S.faultSel);
    if (!l) { box.replaceChildren(panel('Detail', null, h('p', { class: 'hint' }, 'Pick a row in the timeline or the table to see the signals behind it.'))); return; }
    const k = clamp(S.faultOcc, 0, l.ivs.length - 1);
    const go = i => { S.faultOcc = clamp(i, 0, l.ivs.length - 1); const [a, b] = l.ivs[S.faultOcc]; const pad = Math.max(3, (b - a) * 0.6); setView(a - pad, b + pad); setCursor(a); renderFaultDetail(); };
    const [a, b] = l.ivs[k];
    const nav = h('span', { class: 'right' },
      h('button', { class: 'btn small', disabled: k === 0, onclick: () => go(k - 1), 'aria-label': 'Previous occurrence' }, '‹'),
      h('span', { class: 'mono hint' }, `${k + 1} of ${l.ivs.length}`),
      h('button', { class: 'btn small', disabled: k >= l.ivs.length - 1, onclick: () => go(k + 1), 'aria-label': 'Next occurrence' }, '›'),
      h('button', { class: 'btn small', onclick: () => go(k) }, 'Zoom to it'));
    const facts = [`${l.count} event${l.count > 1 ? 's' : ''}`, `${fmt(l.total, 2)} s total`, `this one ${fmt(a, 2)}–${fmt(b, 2)} s`, l.peak != null && isFinite(l.peak) ? `peak ${fmt(l.peak, 1)} ${l.unit || ''}` : null, l.limit != null ? (l.limitLogged ? `limit ${fmt(l.limit, 0)} A from the log` : `default limit ${fmt(l.limit, 0)} A (motor doesn't log its own)`) : null].filter(Boolean).join(' · ');
    const p = h('div', { class: 'panel' }, h('div', { class: 'ph' }, `${l.groupLabel || l.group} · ${l.label}`, nav), h('p', { class: 'hint', style: 'margin:0 0 8px' }, facts), l.why ? h('p', { style: 'margin:0 0 12px;max-width:80ch;font-size:13px' }, l.why) : null,
      l.members ? h('p', { class: 'hint', style: 'margin:-6px 0 12px' }, `On ${l.members.join(', ')}. When many controllers fault together, look at the battery and main power path first.`) : null, ...laneDetailCharts(l));
    box.replaceChildren(p);
  }
  function selectLane(id, keepView) {
    S.faultSel = id; S.faultOcc = 0;
    const l = allLanes().find(x => x.id === id);
    if (l && !keepView) { const [a, b] = l.ivs[0]; const pad = Math.max(3, (b - a) * 0.6); setView(a - pad, b + pad); setCursor(a); }
    renderFaultTable(); renderFaultDetail(); scheduleRedraw();
  }
  function renderFaultTable() {
    const box = $('#faultTable'); if (!box) return;
    const rank = { crit: 0, warn: 1 };
    const rows = [...visibleLanes()].sort((a, b) => rank[a.sev] - rank[b.sev] || (a.kind === 'limit') - (b.kind === 'limit') || a.first - b.first);
    box.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Where'), h('th', null, 'Condition'), h('th', null, 'Severity'), h('th', { class: 'r' }, 'Events'), h('th', { class: 'r' }, 'Total'), h('th', { class: 'r' }, 'First at'), h('th', { class: 'r' }, 'Peak'))),
      h('tbody', null, ...rows.map(l => h('tr', { class: l.id === S.faultSel ? 'sel' : '', tabindex: 0, onclick: () => selectLane(l.id), onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLane(l.id); } } },
        h('td', null, h('b', null, l.groupLabel || l.group)), h('td', null, l.label),
        h('td', null, h('span', { class: 'pill' }, h('span', { class: 'dot ' + l.sev }), l.sev === 'crit' ? 'Critical' : 'Warning')),
        h('td', { class: 'r' }, l.count), h('td', { class: 'r' }, fmt(l.total, l.total < 10 ? 2 : 1) + ' s'), h('td', { class: 'r' }, fmt(l.first, 1) + ' s'),
        h('td', { class: 'r' }, l.peak != null && isFinite(l.peak) ? fmtU(l.peak, l.unit === '°C' ? 'degC' : l.unit, 1) : '—'))))));
  }
  BUILD.faults = () => {
    const root = $('#tab-faults'), s = S.sum;
    const lanes = visibleLanes();
    const anyFaultEntries = s.motors.some(m => Object.keys(m.entries.faults || {}).length);
    const note = anyFaultEntries ? null : h('div', { class: 'banner', style: 'margin-bottom:0' }, h('p', null, 'This log has no controller fault flags, so only conditions worked out from the data (temperature, current at the limit, off CAN) are shown. Log ', h('code', null, 'Motors/<name>/Faults/<Flag>'), ' booleans to add the controllers\' own faults.'));
    if (!allLanes().length) { root.replaceChildren(...[note, panel('Faults', null, h('div', { class: 'empty' }, h('b', null, 'Nothing to report'), 'No faults, current-limit events, over-temperature or dropouts in this log.'))].filter(Boolean)); return; }
    const toggle = h('label', { class: 'hint', style: 'display:inline-flex;gap:6px;align-items:center;cursor:pointer' }, h('input', { type: 'checkbox', id: 'showLimits', checked: S.showLimits, onchange: e => { S.showLimits = e.target.checked; store.set('7763.showLimits', S.showLimits); if (!S.showLimits && allLanes().find(l => l.id === S.faultSel)?.kind === 'limit') S.faultSel = null; S.built.faults = false; BUILD.faults(); S.built.faults = true; scheduleRedraw(); } }), 'Show current-limit rows');
    const quiet = s.motors.filter(m => !m.lanes.length).map(m => m.name);
    const tl = h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Fault timeline', h('small', null, 'Shares the time axis with every other chart. Drag to zoom.'), h('span', { class: 'right' }, toggle)),
      lanes.length ? new LaneChart(lanes).root : h('p', { class: 'hint' }, 'Only current-limit events in this log. Turn on current-limit rows to see them.'),
      quiet.length ? h('p', { class: 'hint', style: 'margin:8px 0 0' }, `Nothing reported for ${quiet.join(', ')}.`) : null);
    const table = panel('Events', 'Worst first. Click a row to zoom to it.', h('div', { class: 'tscroll', id: 'faultTable' }));
    root.replaceChildren(...[note, tl, h('div', { id: 'faultDetail', style: 'min-width:0' }), table].filter(Boolean));
    if (S.faultSel && !lanes.some(l => l.id === S.faultSel)) S.faultSel = null;
    if (!S.faultSel) { const first = [...lanes].sort((a, b) => ({ crit: 0, warn: 1 }[a.sev] - { crit: 0, warn: 1 }[b.sev]) || (a.kind === 'limit') - (b.kind === 'limit') || a.first - b.first)[0]; if (first) S.faultSel = first.id; }
    renderFaultTable(); renderFaultDetail();
  };

  // ---------- MECHANISMS ----------
  // mechanisms: plain ones come from Mechanisms/<name>/* entries, pictured ones from MECH_VIZ
  function mechNames() {
    const names = Object.keys(MECH_VIZ);
    if (S.sum) for (const m of S.sum.mechanisms) if (!names.includes(m.name)) names.push(m.name);
    return names;
  }
  BUILD.mech = () => {
    const root = $('#tab-mech'), names = mechNames();
    if (!names.includes(S.mechSel)) S.mechSel = names[0];
    const nav = h('div', { class: 'subnav', role: 'tablist', 'aria-label': 'Mechanism' }, ...names.map(n => h('button', { role: 'tab', 'aria-selected': n === S.mechSel ? 'true' : 'false', onclick: () => { S.mechSel = n; store.set('7763.mech', n); S.playing = false; BUILD.mech(); scheduleRedraw(); } }, n, MECH_VIZ[n] ? h('span', { class: 'count' }, MECH_VIZ[n].motors.length + ' motors') : null)));
    const body = MECH_VIZ[S.mechSel] ? buildMechViz(S.mechSel) : buildMechPlain(S.mechSel);
    root.replaceChildren(nav, ...body);
  };
  function buildMechPlain(name) {
    const m = S.sum.mechanisms.find(x => x.name === name);
    if (!m) return [panel(name, null, h('div', { class: 'empty' }, h('b', null, 'Not in this log'), `Log Mechanisms/${name}/Position (and Setpoint, if it has one) to fill this view.`))];
    const series = [];
    if (m.entries.Position) series.push(ser(m.entries.Position, 'Position', 1));
    if (m.entries.Setpoint) series.push(ser(m.entries.Setpoint, 'Setpoint', 2, { dash: true, step: true }));
    for (const [k, e] of Object.entries(m.entries)) if (k !== 'Position' && k !== 'Setpoint' && k !== 'name') series.push(ser(e, k, series.length + 1));
    const sub = [m.min != null ? `range ${fmt(m.min)} to ${fmt(m.max)} ${unitLabel(m.unit)}` : null, m.rmsErr != null ? `RMS tracking error ${fmt(m.rmsErr)} ${unitLabel(m.unit)}` : null].filter(Boolean).join(' · ');
    const pnl = panel(m.name, sub, new TimeChart({ title: `${m.name} position`, unit: m.unit, height: 240, series }).root);
    if (m.worstErr != null) pnl.append(h('p', { class: 'hint' }, `Worst error ${fmt(m.worstErr)} ${unitLabel(m.unit)} at ${fmt(m.tWorst, 2)} s. `, h('button', { class: 'linkbtn', onclick: () => { setView(m.tWorst - 4, m.tWorst + 4); setCursor(m.tWorst); } }, 'Zoom to it')));
    return [pnl];
  }

  // ----- pictured mechanism -----
  const VIZ_COL = { orange: [240, 122, 26], red: [226, 44, 40], fault: [255, 45, 45], can: [255, 210, 26] };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const mixc = (a, b, f) => a.map((x, i) => Math.round(x + (b[i] - x) * f));
  const reduceMotion = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  const vizImg = {};
  let mv = null; // live state of the open pictured mechanism

  // the picture shows each motor's CAN ID once it's assigned to a log motor that reports one
  function badgeText(n, name) { const m = name && S.sum.motors.find(x => x.name === name); return m && m.canId != null ? String(m.canId) : String(n); }
  function mechMotorName(viz, n) {
    const saved = (S.mechMap[viz] || {})[n];
    const names = S.sum.motors.map(m => m.name);
    if (saved != null && (saved === '' || names.includes(saved))) return saved;
    return names.find(x => x.toLowerCase() === (viz + n).toLowerCase()) || '';
  }
  function motorStateAt(name, t) {
    const m = S.sum.motors.find(x => x.name === name);
    if (!m) return { mode: 'none', notes: [] };
    const e = m.entries, L = S.limits;
    const online = e.Connected ? Core.valueAt(e.Connected.t, e.Connected.v, t) !== 0 : true;
    const temp = e.TempC ? Core.valueAt(e.TempC.t, e.TempC.v, t) : NaN;
    const sup = e.SupplyCurrentA ? Core.valueAt(e.SupplyCurrentA.t, e.SupplyCurrentA.v, t) : NaN;
    const act = m.lanes.filter(l => l.ivs.some(([a, b]) => t >= a && t < b));
    const faults = act.filter(l => l.kind === 'hw'), limits = act.filter(l => l.kind === 'limit');
    const mode = !online ? 'offline' : faults.length ? 'fault' : temp >= L.tempCrit ? 'hot' : temp >= L.tempWarn ? 'warm' : temp >= L.tempWarn - 10 ? 'warming' : 'ok';
    const notes = [];
    if (!online) notes.push(['crit', 'Not found on the CAN bus']);
    for (const f of faults) notes.push([f.sev, f.label]);
    if (temp >= L.tempCrit) notes.push(['crit', `${fmt(temp, 0)} °C, over the ${L.tempCrit} °C limit`]);
    else if (temp >= L.tempWarn) notes.push(['warn', `${fmt(temp, 0)} °C, past the ${L.tempWarn} °C warning`]);
    for (const l of limits) notes.push(['warn', l.label]);
    return { m, online, temp, sup, faults, limits, mode, notes };
  }
  // tint for a state; null = draw nothing
  function stateTint(st, now) {
    const L = S.limits;
    const pulse = reduceMotion ? 1 : 0.5 + 0.5 * Math.cos(now / 1000 * Math.PI * 2 * 1.6);
    if (st.mode === 'offline') return { c: VIZ_COL.can, a: 0.12 + 0.68 * pulse, flash: true };
    if (st.mode === 'fault') return { c: VIZ_COL.fault, a: 0.12 + 0.68 * pulse, flash: true };
    if (!isFinite(st.temp)) return null;
    if (st.temp >= L.tempCrit) return { c: VIZ_COL.red, a: 0.72 };
    if (st.temp >= L.tempWarn) { const f = (st.temp - L.tempWarn) / Math.max(1, L.tempCrit - L.tempWarn); return { c: mixc(VIZ_COL.orange, VIZ_COL.red, f), a: 0.5 + 0.2 * f }; }
    const f = (st.temp - (L.tempWarn - 10)) / 10;
    if (f > 0) return { c: VIZ_COL.orange, a: 0.5 * f };
    return null;
  }
  function worstMoment(viz) {
    const cfg = MECH_VIZ[viz], L = S.log;
    const names = cfg.motors.map(mo => mechMotorName(viz, mo.n)).filter(Boolean);
    if (!names.length) return null;
    const w = { offline: 4, fault: 3, hot: 2, warm: 1, warming: 0.3, ok: 0, none: 0 };
    let best = null, bestScore = 0;
    for (let t = L.tMin; t <= L.tMax; t += 0.1) {
      const sts = names.map(n => motorStateAt(n, t));
      const modes = new Set(sts.map(x => x.mode).filter(x => x !== 'ok' && x !== 'none'));
      // favor moments where several different things are wrong at once
      const sc = sts.reduce((q, x) => q + w[x.mode] + 0.3 * x.limits.length, 0) + 3 * modes.size;
      if (sc > bestScore + 1e-9) { bestScore = sc; best = t; }
    }
    return best;
  }
  function jumpTo(t) {
    if (t == null) return;
    if (t < S.view.t0 || t > S.view.t1) { const sp = Math.min(30, S.log.tMax - S.log.tMin); setView(t - sp / 2, t + sp / 2); }
    setCursor(t);
  }

  function buildMechViz(viz) {
    const cfg = MECH_VIZ[viz];
    if (!vizImg[viz]) { vizImg[viz] = new Image(); vizImg[viz].onload = () => { if (mv) mv.dirty = true; }; vizImg[viz].src = cfg.img; }
    const canvas = h('canvas', { class: 'mech-canvas', role: 'img', 'aria-label': `${viz} with motor status. Colors show temperature, faults and CAN status at the selected time.` });
    const tip = h('div', { class: 'tip', hidden: true });
    const wrap = h('div', { class: 'mech-wrap' }, canvas, tip);
    const play = h('button', { class: 'btn small play-btn' }, S.playing ? 'Pause' : 'Play');
    play.onclick = () => { S.playing = !S.playing; play.textContent = S.playing ? 'Pause' : 'Play'; if (S.playing) { if (S.cursor == null) S.cursor = S.mechT ?? S.view.t0; if (S.cursor >= S.view.t1 - 0.05 || S.cursor < S.view.t0) S.cursor = S.view.t0; tick.last = performance.now(); requestAnimationFrame(tick); } };
    const rate = h('select', { class: 'sel', 'aria-label': 'Playback speed', onchange: e => { S.rate = +e.target.value; } }, ...[0.25, 0.5, 1, 2, 4].map(r => h('option', { value: r, selected: S.rate === r }, r + '×')));
    const worst = h('button', { class: 'btn small', onclick: () => jumpTo(worstMoment(viz)) }, 'Jump to the most eventful moment');
    const timeEl = h('span', { class: 'mono hint mech-time' });
    const key = h('div', { class: 'mech-key' },
      h('span', null, h('i', { class: 'k-warm' }), 'Warming toward the limit'), h('span', null, h('i', { class: 'k-hot' }), `Over ${S.limits.tempCrit} °C`),
      h('span', null, h('i', { class: 'k-fault' }), 'Fault (flashes red)'), h('span', null, h('i', { class: 'k-can' }), 'Not on CAN (flashes yellow)'),
      h('span', { class: 'hint' }, 'Current-limit events are labeled but don\'t flash.'));
    const listEl = h('div', { class: 'mech-list' });

    // mapping + live status table
    const opts = ['', ...S.sum.motors.map(m => m.name)];
    const optLabel = o => { if (!o) return '— not assigned —'; const m = S.sum.motors.find(x => x.name === o); return m && m.canId != null ? `CAN ${m.canId} · ${o}` : o; };
    const rows = cfg.motors.map(mo => {
      const sel = h('select', { class: 'sel', id: `map-${viz}-${mo.n}`, 'aria-label': `Log motor for motor ${mo.n}`, onchange: e => { S.mechMap[viz] = { ...(S.mechMap[viz] || {}), [mo.n]: e.target.value }; store.set('7763.mechmap', S.mechMap); BUILD.mech(); scheduleRedraw(); } },
        ...opts.map(o => h('option', { value: o, selected: o === mechMotorName(viz, mo.n) }, optLabel(o))));
      const cells = { temp: h('td', { class: 'r' }), sup: h('td', { class: 'r' }), st: h('td') };
      return { n: mo.n, tr: h('tr', null, h('td', null, h('span', { class: 'num-badge' }, mo.n)), h('td', null, sel), cells.temp, cells.sup, cells.st), cells };
    });
    const table = h('div', { class: 'tscroll' }, h('table', { class: 'static' }, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Log motor'), h('th', { class: 'r' }, 'Temp'), h('th', { class: 'r' }, 'Supply'), h('th', null, 'Status'))), h('tbody', null, ...rows.map(r => r.tr))));

    mv = { viz, cfg, canvas, wrap, tip, timeEl, listEl, rows, hover: -1, lastKey: '', dirty: true };
    canvas.addEventListener('pointermove', e => { const i = mechHit(e.offsetX, e.offsetY); if (i !== mv.hover) { mv.hover = i; mv.dirty = true; } mv.px = e.offsetX; mv.py = e.offsetY; mv.dirty = true; canvas.style.cursor = i >= 0 ? 'help' : 'default'; });
    canvas.addEventListener('pointerleave', () => { mv.hover = -1; mv.dirty = true; });
    new ResizeObserver(() => { if (mv) mv.dirty = true; }).observe(wrap);

    // lanes + temperature for just these motors
    const mapped = cfg.motors.map(mo => [mo.n, mechMotorName(viz, mo.n)]).filter(([, n]) => n);
    allLanes();
    const lanes = mapped.flatMap(([n, name]) => (S.sum.motors.find(m => m.name === name)?.lanes || []).map(l => ({ ...l, groupLabel: `${badgeText(n, name)} · ${name}` })));
    const lanePanel = h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Timeline', h('small', null, 'Hover or click to pick the moment shown above. Drag to zoom.')),
      lanes.length ? new LaneChart(lanes).root : h('p', { class: 'hint' }, 'Nothing to report for these motors.'));
    const tempSeries = mapped.map(([n, name]) => { const m = S.sum.motors.find(x => x.name === name); return m && m.entries.TempC ? ser(m.entries.TempC, `${badgeText(n, name)} · ${name}`, n <= 8 ? n : 0) : null; }).filter(Boolean);
    const tempPanel = tempSeries.length ? h('div', { class: 'panel' }, new TimeChart({ title: `${viz} motor temperature`, unit: 'degC', height: 200, series: tempSeries, thresholds: tempThresholds() }).root) : null;

    const main = h('div', { class: 'panel' },
      h('div', { class: 'ph' }, viz, h('small', null, 'Each motor on the picture shows its CAN ID once assigned to a log motor (until then, its number). Assign them below.'), h('span', { class: 'right' }, timeEl)),
      h('div', { class: 'mech-tools' }, play, rate, worst), key, wrap, listEl,
      h('details', { class: 'mech-map', open: true }, h('summary', null, 'Motor assignments and live readout'), table));
    if (S.cursor == null && S.mechT == null) setTimeout(() => jumpTo(worstMoment(viz)), 0);
    if (!mechLoop.on) { mechLoop.on = true; requestAnimationFrame(mechLoop); }
    return [main, lanePanel, tempPanel].filter(Boolean);
  }

  function mechGeom() {
    const W = mv.wrap.clientWidth, cfg = mv.cfg;
    const gutter = W >= 760 ? Math.min(260, Math.round(W * 0.25)) : 0;
    const maxH = W >= 760 ? 660 : Infinity;
    const sc = Math.min((W - 2 * gutter) / cfg.w, maxH / cfg.h);
    const iw = cfg.w * sc, ih = cfg.h * sc;
    return { W, H: ih, sc, ix: (W - iw) / 2, iy: 0, iw, ih, gutter };
  }
  const toPx = (g, p) => [g.ix + p[0] * g.sc, g.iy + p[1] * g.sc];
  function inPoly(x, y, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; }
  function mechHit(x, y) {
    if (!mv) return -1; const g = mechGeom();
    for (let i = mv.cfg.motors.length - 1; i >= 0; i--) if (inPoly(x, y, mv.cfg.motors[i].poly.map(p => toPx(g, p)))) return i;
    return -1;
  }
  function mechLoop(now) {
    if (!mv || !mv.canvas.isConnected) { mechLoop.on = false; mv = null; return; }
    if (S.tab === 'mech') drawMech(now);
    requestAnimationFrame(mechLoop);
  }
  function drawMech(now) {
    const t = S.cursor ?? S.mechT;
    const states = mv.cfg.motors.map(mo => { const name = mechMotorName(mv.viz, mo.n); return { mo, name, st: name && t != null ? motorStateAt(name, t) : { mode: 'none', notes: [] } }; });
    const flashing = states.some(x => x.st.mode === 'offline' || x.st.mode === 'fault');
    const key = `${t}|${mv.hover}|${mv.wrap.clientWidth}|${S.limits.tempWarn}|${S.limits.tempCrit}|${document.documentElement.dataset.theme || ''}`;
    if (!flashing && !mv.dirty && key === mv.lastKey) return;
    mv.dirty = false; mv.lastKey = key;
    const g = mechGeom(), cv = mv.canvas, img = vizImg[mv.viz];
    cv.style.height = g.H + 'px';
    const ctx = sizeCanvas(cv, g.W, g.H);
    if (img && img.complete && img.naturalWidth) { ctx.save(); ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(g.ix, g.iy, g.iw, g.ih, 6); else ctx.rect(g.ix, g.iy, g.iw, g.ih); ctx.clip(); ctx.drawImage(img, g.ix, g.iy, g.iw, g.ih); ctx.restore(); }
    // tints
    states.forEach(({ mo, st }, i) => {
      const pts = mo.poly.map(p => toPx(g, p));
      const path = () => { ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); };
      const tint = st.mode === 'none' ? null : stateTint(st, now);
      if (tint) {
        ctx.save(); path(); ctx.fillStyle = rgba(tint.c, tint.a); ctx.shadowColor = rgba(tint.c, Math.min(1, tint.a + 0.2)); ctx.shadowBlur = 18 * Math.max(0.6, g.sc); ctx.fill(); ctx.restore();
        ctx.save(); path(); ctx.lineWidth = 2; ctx.strokeStyle = rgba(tint.c, Math.min(1, 0.35 + tint.a)); if (reduceMotion && tint.flash) ctx.setLineDash([5, 4]); ctx.stroke(); ctx.restore();
      }
      if (i === mv.hover) { ctx.save(); path(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); ctx.restore(); }
    });
    // number badges at the middle of each motor's axis
    ctx.font = '700 12px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    states.forEach(({ mo, st }) => {
      const a = mo.axis[0], b = mo.axis[1]; const [x, y] = toPx(g, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      const r = Math.max(9, 12 * Math.min(1, g.sc * 1.3));
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = st.mode === 'none' ? 'rgba(255,255,255,0.55)' : '#ffffff'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      const txt = badgeText(mo.n, mechMotorName(mv.viz, mo.n));
      if (txt.length > 1) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = st.mode === 'none' ? 'rgba(255,255,255,0.55)' : '#ffffff'; ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = '#111513'; ctx.font = `700 ${txt.length > 2 ? 10 : 12}px "IBM Plex Sans", system-ui, sans-serif`; ctx.fillText(txt, x, y + 0.5);
    });
    // time stamp on the picture
    if (t != null) {
      const p = phaseAt(t); const label = `${t.toFixed(2)} s${p && p.mode !== 'unknown' ? ' · ' + (p.mode === 'auto' ? 'Auto' : p.mode === 'teleop' ? 'Teleop' : p.mode === 'test' ? 'Test' : 'Disabled') : ''}`;
      ctx.font = '500 12px "IBM Plex Mono", ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const tw = ctx.measureText(label).width; ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(g.ix + 10, g.iy + 10, tw + 14, 22);
      ctx.fillStyle = '#ffffff'; ctx.fillText(label, g.ix + 17, g.iy + 15);
      mv.timeEl.textContent = label;
    } else mv.timeEl.textContent = 'Pick a moment on the timeline';
    // callouts with leader lines (desktop) or a list (phone)
    const withNotes = states.filter(x => x.st.notes && x.st.notes.length);
    if (g.gutter > 0) drawCallouts(ctx, g, withNotes, now); 
    renderMechList(g.gutter > 0 ? [] : withNotes);
    // live table
    for (const r of mv.rows) {
      const s2 = states.find(x => x.mo.n === r.n).st;
      // an offline controller's last values are stale, so don't show them as current
      const stale = s2.mode === 'none' || s2.mode === 'offline';
      r.cells.temp.textContent = stale ? '—' : fmtU(s2.temp, 'degC', 1);
      r.cells.sup.textContent = stale ? '—' : fmtU(s2.sup, 'A', 1);
      const label = s2.mode === 'none' ? (t == null ? '—' : 'Not assigned') : s2.notes.length ? s2.notes.map(n => n[1]).join(' · ') : 'OK';
      const sev = s2.mode === 'offline' || s2.mode === 'fault' || s2.mode === 'hot' ? 'crit' : s2.notes.length ? 'warn' : s2.mode === 'none' ? '' : 'ok';
      const want = sev + '|' + label;
      if (r.cells.st.dataset.v !== want) { r.cells.st.dataset.v = want; r.cells.st.replaceChildren(h('span', { class: 'pill' }, sev ? h('span', { class: 'dot ' + sev }) : null, label)); }
    }
    // hover tooltip
    if (mv.hover >= 0) {
      const { mo, name, st } = states[mv.hover];
      const bt = badgeText(mo.n, name);
      mv.tip.replaceChildren(h('div', { class: 'tt' }, `${bt !== String(mo.n) ? 'CAN ' + bt : 'Motor ' + mo.n}${name ? ' · ' + name : ''}`),
        ...(st.mode === 'none' ? [h('div', { class: 'row' }, name ? 'No data at this time' : 'Not assigned to a log motor')] :
          [h('div', { class: 'row' }, 'Temperature', h('b', null, st.online ? fmtU(st.temp, 'degC', 1) : '—')), h('div', { class: 'row' }, 'Supply current', h('b', null, st.online ? fmtU(st.sup, 'A', 1) : '—')), h('div', { class: 'row' }, 'CAN', h('b', null, st.online ? 'connected' : 'missing'))]));
      mv.tip.hidden = false;
      const tw = mv.tip.offsetWidth; mv.tip.style.left = (mv.px + 14 + tw > g.W ? mv.px - 14 - tw : mv.px + 14) + 'px'; mv.tip.style.top = Math.max(6, mv.py - 20) + 'px';
    } else mv.tip.hidden = true;
  }
  function noteColor(sev, mode) { return mode === 'offline' ? VIZ_COL.can : sev === 'crit' ? VIZ_COL.fault : VIZ_COL.orange; }
  function drawCallouts(ctx, g, items, now) {
    const pad = 10, lineH = 17, boxW = g.ix - 16 - 8;
    if (boxW < 120) return;
    const centerX = g.ix + g.iw / 2;
    const placed = items.map(({ mo, name, st }) => {
      const pts = mo.poly.map(p => toPx(g, p));
      const cx = pts.reduce((q, p) => q + p[0], 0) / pts.length, cy = pts.reduce((q, p) => q + p[1], 0) / pts.length;
      const side = cx > g.ix + g.iw * 0.37 ? 'right' : 'left';
      // anchor: outline point nearest the callout's side, at about the motor's middle height
      const cand = pts.filter(p => Math.abs(p[1] - cy) < (Math.max(...pts.map(q => q[1])) - Math.min(...pts.map(q => q[1]))) * 0.35);
      const anchor = (cand.length ? cand : pts).reduce((a, b) => (side === 'left' ? (b[0] < a[0] ? b : a) : (b[0] > a[0] ? b : a)));
      const lines = st.notes.slice(0, 5);
      return { mo, name, st, side, anchor, cy, lines, h: pad * 2 + 18 + lines.length * lineH };
    });
    for (const side of ['left', 'right']) {
      const col = placed.filter(p => p.side === side).sort((a, b) => a.cy - b.cy);
      let y = 0;
      for (const p of col) { p.y = Math.max(y, Math.round(p.cy - p.h / 2)); y = p.y + p.h + 10; }
      const over = y - 10 - g.H; if (over > 0) { let shift = over; for (let k = col.length - 1; k >= 0 && shift > 0; k--) { const room = k ? col[k].y - (col[k - 1].y + col[k - 1].h + 10) : col[k].y; const d = Math.min(shift, Math.max(0, room)); for (let j = k; j < col.length; j++) col[j].y -= d; shift -= d; } }
    }
    for (const p of placed) {
      const x = p.side === 'left' ? 8 : g.W - 8 - boxW, worst = p.st.mode === 'offline' ? 'can' : p.lines.some(l => l[0] === 'crit') ? 'crit' : 'warn';
      const c = worst === 'can' ? VIZ_COL.can : worst === 'crit' ? VIZ_COL.fault : VIZ_COL.orange;
      // leader
      const ex = p.side === 'left' ? x + boxW : x, ey = p.y + 19;
      ctx.strokeStyle = rgba(c, 0.95); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ex, ey); const kx = p.side === 'left' ? ex + 14 : ex - 14; ctx.lineTo(kx, ey); ctx.lineTo(p.anchor[0], p.anchor[1]); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.anchor[0], p.anchor[1], 3.5, 0, Math.PI * 2); ctx.fillStyle = rgba(c, 1); ctx.fill();
      // box
      ctx.fillStyle = C.surface; ctx.strokeStyle = rgba(c, 0.95); ctx.lineWidth = 1.5;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, p.y, boxW, p.h, 6); else ctx.rect(x, p.y, boxW, p.h); ctx.fill(); ctx.stroke();
      ctx.fillStyle = rgba(c, 1); ctx.fillRect(p.side === 'left' ? x : x + boxW - 4, p.y + 6, 4, p.h - 12);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = '700 12.5px "IBM Plex Sans", system-ui, sans-serif'; ctx.fillStyle = C.ink;
      const tx = x + pad + (p.side === 'left' ? 4 : 0);
      const bt = badgeText(p.mo.n, p.name);
      ctx.fillText(bt !== String(p.mo.n) ? `CAN ${bt} · ${p.name}` : `Motor ${p.mo.n} · ${p.name}`, tx, p.y + pad + 8);
      ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
      p.lines.forEach(([sev, text], k) => {
        const yy = p.y + pad + 18 + k * lineH + 8;
        ctx.fillStyle = rgba(noteColor(sev, text === 'Not found on the CAN bus' ? 'offline' : ''), 1);
        ctx.beginPath(); ctx.arc(tx + 4, yy, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C['ink-2'];
        let s = text; while (s.length > 3 && ctx.measureText(s).width > boxW - pad * 2 - 16) s = s.slice(0, -2);
        ctx.fillText(s === text ? s : s + '…', tx + 13, yy);
      });
    }
  }
  function renderMechList(items) {
    const want = items.map(x => x.mo.n + ':' + x.st.notes.map(n => n[1]).join(',')).join('|');
    if (mv.listEl.dataset.v === want) return; mv.listEl.dataset.v = want;
    mv.listEl.replaceChildren(...items.map(({ mo, name, st }) => h('div', { class: 'mech-note ' + (st.mode === 'offline' ? 'can' : st.notes.some(n => n[0] === 'crit') ? 'crit' : 'warn') },
      h('span', { class: 'num-badge' }, badgeText(mo.n, name)), h('div', null, h('b', null, name), h('div', null, st.notes.map(n => n[1]).join(' · '))))));
  }


  // ---------- ROBOT 3D ----------
  let r3 = null, r3Loop = false;
  const numericSignals = () => S.log ? [...S.log.entries.values()].filter(e => e.kind === 'num').map(e => Core.stripPrefix(e.name)).sort() : [];
  function r3api() {
    return { h, S, Core, motorStateAt, stateTint, toast, numericSignals, onChange: () => renderR3Side(), onPreview: () => {} };
  }
  BUILD.robot3d = async () => {
    const root = $('#tab-robot3d');
    if (!window.Vendor || !Vendor.THREE) { root.replaceChildren(panel('Robot 3D', null, h('p', { class: 'hint' }, '3D isn\'t available in this build.'))); return; }
    r3 = r3 || Robot3D.create(r3api());
    await r3.load();
    const fileIn = h('input', { type: 'file', accept: '.glb,.gltf,.bin,.stl,.json,.png,.jpg,.jpeg', multiple: true, hidden: true, id: 'r3Files', onchange: async e => { await r3.addFiles([...e.target.files]); e.target.value = ''; renderR3Tools(); } });
    const importIn = h('input', { type: 'file', accept: '.json', hidden: true, id: 'r3Import', onchange: async e => { try { await r3.importSetup(e.target.files[0]); toast('Robot setup imported'); renderR3Tools(); } catch (err) { toast(err.message); } e.target.value = ''; } });
    const viewEl = h('div', { class: 'r3-view', 'aria-label': 'Robot 3D view. Drag to orbit, scroll to zoom, click a part to edit it.' });
    const key = h('div', { class: 'mech-key' },
      h('span', null, h('i', { class: 'k-warm' }), 'Motor warming'), h('span', null, h('i', { class: 'k-hot' }), `Motor over ${S.limits.tempCrit} °C`),
      h('span', null, h('i', { class: 'k-fault' }), 'Fault'), h('span', null, h('i', { class: 'k-can' }), 'Not on CAN'), h('span', { class: 'hint' }, 'Drag to orbit · scroll to zoom · click a part to edit it'));
    const help = h('details', { class: 'r3-help' }, h('summary', null, 'How to get your CAD in here'),
      h('ol', null,
        h('li', null, h('b', null, 'Export the robot in its assembly position'), '. From Onshape, export the assembly as ', h('code', null, '.glb'), ': each top-level sub-assembly becomes its own part here. An AdvantageScope robot folder works too: select its ', h('code', null, 'model.glb'), ' and ', h('code', null, 'config.json'), ' together. From SOLIDWORKS, save each moving group as ', h('code', null, '.stl'), ' with "Do not translate STL output data to positive space" checked.'),
        h('li', null, 'Set ', h('b', null, 'Model units / Up axis'), ' so the robot sits upright on the grid, nose toward +X.'),
        h('li', null, 'For each moving part: pick the joint type, its axis, click ', h('b', null, 'Pick on model'), ' then the pivot, and type the signal that drives it (any number in the log or on NetworkTables).'),
        h('li', null, h('b', null, 'Zero'), ' is the signal\'s value when the mechanism is in the position the CAD was exported in. ', h('b', null, 'Scale'), ' converts the signal to the mechanism (gear ratio, or −1 to flip).'),
        h('li', null, 'Give each motor part its CAN ID to color it by temperature, faults and CAN status.')),
      h('p', { class: 'hint' }, 'The setup is saved on this computer. Use Export setup to move it to another laptop.'));
    root.replaceChildren(h('div', { class: 'panel' },
      h('div', { class: 'ph' }, 'Robot 3D', h('small', { id: 'r3Sub' }), h('span', { class: 'right mono hint', id: 'r3Time' })),
      h('div', { class: 'mech-tools', id: 'r3Tools' }), key, fileIn, importIn,
      h('div', { class: 'r3-layout' }, viewEl, h('div', { class: 'r3-side', id: 'r3Side' })), help),
      h('datalist', { id: 'r3-signals' }, ...numericSignals().map(n => h('option', { value: n }))));
    renderR3Tools(); renderR3Side();
    r3.mountView(viewEl);
    if (!r3Loop) { r3Loop = true; requestAnimationFrame(r3Tick); }
  };
  function r3Tick(now) {
    if (!r3 || S.tab !== 'robot3d') { r3Loop = false; return; }
    const t = S.cursor ?? S.mechT ?? (S.view ? S.view.t1 : null);
    r3.render(t, now);
    const te = $('#r3Time'); if (te) te.textContent = t != null ? `${t.toFixed(2)} s` : '';
    requestAnimationFrame(r3Tick);
  }
  function renderR3Tools() {
    const box = $('#r3Tools'); if (!box || !r3) return;
    const m = r3.cfg.model || {};
    const sel = (id, label, val, opts, onch) => h('label', { class: 'r3-inline' }, label, h('select', { class: 'sel', id, onchange: e => onch(e.target.value) }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l))));
    const confirmBox = h('span', { class: 'confirm' });
    const startOver = h('button', { class: 'linkbtn danger', onclick: () => confirmBox.replaceChildren('Remove all parts and files?', h('button', { class: 'linkbtn danger', onclick: async () => { await r3.reset(false); renderR3Tools(); } }, 'Yes'), h('button', { class: 'linkbtn', onclick: () => confirmBox.replaceChildren(startOver) }, 'No')) }, 'Start over');
    confirmBox.append(startOver);
    box.replaceChildren(...[
      h('button', { class: 'btn small primary', onclick: () => $('#r3Files').click() }, 'Add CAD files'),
      r3.cfg.sample ? null : h('button', { class: 'btn small', onclick: async () => { await r3.reset(true); renderR3Tools(); } }, 'Load sample robot'),
      CAN_LIVE ? h('button', { class: 'btn small', onclick: async () => { const blob = await r3.exportSetup(); const a = h('a', { href: URL.createObjectURL(blob), download: '7763-robot-setup.json' }); document.body.append(a); a.click(); a.remove(); } }, 'Export setup') : null,
      h('button', { class: 'btn small', onclick: () => $('#r3Import').click() }, 'Import setup'),
      h('button', { class: 'btn small', onclick: () => r3.frame() }, 'Reset view'),
      ...(Array.isArray(m.rotations) ? [h('span', { class: 'hint' }, 'Orientation from the AdvantageScope config'), h('button', { class: 'linkbtn', onclick: () => r3.setModel('rotations', undefined).then(renderR3Tools) }, 'Set it by hand')] : [
      sel('r3Units', 'Model units', m.units || 'm', [['mm', 'mm'], ['in', 'in'], ['m', 'm']], v => r3.setModel('units', v)),
      sel('r3Up', 'Up axis', m.up || 'z', [['z', 'Z up'], ['y', 'Y up']], v => r3.setModel('up', v)),
      sel('r3Yaw', 'Turn', m.yaw || 0, [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], v => r3.setModel('yaw', +v))]),
      confirmBox].filter(Boolean));
    const sub = $('#r3Sub'); if (sub) sub.textContent = r3.cfg.sample ? 'Sample robot built from boxes. Add your CAD to replace it.' : `${r3.cfg.parts.length} parts`;
  }
  function renderR3Side() {
    const side = $('#r3Side'); if (!side || !r3) return;
    const cfg = r3.cfg, t = S.cursor ?? S.mechT ?? (S.view ? S.view.t1 : null);
    const depth = p => { let d = 0, q = p; const seen = new Set(); while (q && q.parent && !seen.has(q.id) && d < 8) { seen.add(q.id); d++; q = cfg.parts.find(x => x.id === q.parent); } return d; };
    const ordered = []; const add = (parent) => cfg.parts.filter(p => (p.parent || null) === parent).forEach(p => { ordered.push(p); add(p.id); }); add(null);
    cfg.parts.forEach(p => { if (!ordered.includes(p)) ordered.push(p); });
    const list = h('div', { class: 'r3-list', role: 'listbox', 'aria-label': 'Parts' }, ...ordered.map(p => {
      const j = p.joint || {};
      const tag = j.type === 'revolute' ? 'rotates' : j.type === 'prismatic' ? 'slides' : '';
      const jv = j.type && j.type !== 'fixed' ? r3.jointValue(p, t) : null;
      return h('button', { class: 'r3-item' + (p.id === r3.selected ? ' on' : ''), role: 'option', 'aria-selected': p.id === r3.selected ? 'true' : 'false', style: `padding-left:${8 + depth(p) * 14}px`, onclick: () => { r3.selected = p.id === r3.selected ? null : p.id; renderR3Side(); } },
        h('span', { class: 'n' }, p.name), p.canId != null ? h('span', { class: 'tagc' }, 'CAN ' + p.canId) : null,
        tag ? h('span', { class: 'tagj', title: jv && jv.src === 'log' ? 'Driven by ' + j.signal : 'No data for its signal; showing the preview value' }, tag + (jv && jv.src === 'log' ? '' : ' · preview')) : null);
    }));
    const sel = cfg.parts.find(p => p.id === r3.selected);
    side.replaceChildren(...[sel ? h('div', { class: 'r3-side-h' }, `Editing: ${sel.name}`) : h('p', { class: 'hint', style: 'margin:0' }, 'Pick a part (here or on the model) to set how it moves.'), sel ? r3.partEditor(sel) : null,
      h('div', { class: 'r3-side-h' }, `Parts (${cfg.parts.length})`), list].filter(Boolean));
  }

  // ---------- SIGNALS ----------
  function sigItems() {
    const items = [];
    for (const e of S.log.entries.values()) {
      if (e.name.startsWith('/.schema/')) continue;
      const nm = e.name;
      if (e.kind === 'num' || e.kind === 'bool') items.push({ key: nm, label: nm, type: e.type, unit: e.unit, get: () => ({ t: e.t, v: e.v, bool: e.kind === 'bool' }) });
      else if (e.kind === 'struct' && !e.undecoded) for (const f of Object.keys(e.fields)) items.push({ key: nm + '›' + f, label: `${nm} › ${f}`, type: 'double', unit: '', get: () => ({ t: e.t, v: e.fields[f] }) });
      else if (e.kind === 'numarr' && e.vals.length) {
        const n = e.vals[e.vals.length - 1].length;
        if (n <= 32) for (let k = 0; k < n; k++) items.push({ key: `${nm}[${k}]`, label: `${nm}[${k}]`, type: e.type.replace('[]', ''), unit: e.unit, get: () => ({ t: e.t, v: Float64Array.from(e.vals, a => (k < a.length ? a[k] : NaN)) }) });
      } else if (e.kind === 'str' || e.kind === 'strarr') items.push({ key: nm, label: nm, type: e.type, str: true });
      else items.push({ key: nm, label: nm, type: e.type, none: true });
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items;
  }
  let SIG_ITEMS = [];
  BUILD.signals = () => {
    SIG_ITEMS = sigItems();
    const root = $('#tab-signals');
    const search = h('input', { class: 'sig-search', id: 'sigSearch', type: 'search', placeholder: `Search ${SIG_ITEMS.length} signals`, value: S.sigFilter, oninput: e => { S.sigFilter = e.target.value; renderSigList(); } });
    const left = panel('Signals', 'Pick up to 8 to plot', search, h('div', { class: 'sig-list', id: 'sigList' }));
    const right = h('div', { id: 'sigRight', style: 'display:grid;gap:18px;min-width:0;align-content:start' });
    root.replaceChildren(h('div', { class: 'sig-layout' }, left, right));
    renderSigList(); renderSigCharts();
  };
  function renderSigList() {
    const box = $('#sigList'); if (!box) return;
    const q = S.sigFilter.trim().toLowerCase();
    const kids = []; let group = null;
    for (const it of SIG_ITEMS) {
      if (q && !it.label.toLowerCase().includes(q)) continue;
      const g = Core.stripPrefix(it.label).split(/[/:]/)[0] || '/';
      const gl = (it.label.startsWith('NT:') ? 'NT · ' : '') + g;
      if (gl !== group) { group = gl; kids.push(h('div', { class: 'sig-group' }, gl)); }
      const on = S.sigSel.includes(it.key) || S.sigString === it.key, slot = S.sigSlot.get(it.key);
      kids.push(h('button', { class: 'sig' + (on ? ' on' : ''), disabled: it.none, 'aria-pressed': on ? 'true' : 'false', title: it.label, onclick: () => toggleSig(it) },
        h('span', { class: 'sw', style: on ? `background:${it.str ? C.ink : slotColor(slot)}` : '' }), h('span', { class: 'n' }, it.label), h('span', { class: 'ty' }, it.type)));
    }
    if (!kids.length) kids.push(h('p', { class: 'hint', style: 'padding:8px' }, 'No signal names match.'));
    box.replaceChildren(...kids);
  }
  function toggleSig(it) {
    if (it.str) { S.sigString = S.sigString === it.key ? null : it.key; }
    else {
      const i = S.sigSel.indexOf(it.key);
      if (i >= 0) { S.sigSel.splice(i, 1); S.sigSlot.delete(it.key); }
      else { if (S.sigSel.length >= 8) { toast('Up to 8 signals can be plotted at once. Remove one first.'); return; } S.sigSel.push(it.key); takeSlot(S.sigSlot, it.key); }
    }
    renderSigList(); renderSigCharts();
  }
  function renderSigCharts() {
    const right = $('#sigRight'); if (!right) return;
    const kids = [];
    const groups = new Map();
    for (const key of S.sigSel) {
      const it = SIG_ITEMS.find(x => x.key === key); if (!it) continue;
      const d = it.get(); const u = d.bool ? 'boolean' : it.unit || '';
      if (!groups.has(u)) groups.set(u, []);
      groups.get(u).push({ name: it.label, t: d.t, v: d.v, slot: S.sigSlot.get(key), bool: d.bool, step: d.bool });
    }
    for (const [u, series] of groups) {
      const title = u === 'boolean' ? 'True / false' : u ? `Signals in ${unitLabel(u) || u}` : 'Signals without a unit';
      kids.push(h('div', { class: 'panel' }, new TimeChart({ title, unit: u === 'boolean' ? '' : u, height: u === 'boolean' ? 110 : 220, series }).root));
    }
    if (!groups.size) kids.push(panel('Plot', null, h('div', { class: 'empty' }, h('b', null, 'Nothing plotted yet'), 'Pick signals on the left. Signals with different units get separate charts on the same time axis.')));
    const strName = S.sigString || (S.log.entries.has('messages') ? 'messages' : null);
    const se = strName && S.log.entries.get(strName);
    if (se && se.vals && se.vals.length) {
      const list = h('div', { class: 'msgs' }, ...se.vals.map((v, i) => h('div', { onclick: () => { const t = se.t[i]; if (t < S.view.t0 || t > S.view.t1) { const sp = S.view.t1 - S.view.t0; setView(t - sp / 2, t + sp / 2); } setCursor(t); } }, h('span', null, fmt(se.t[i], 2)), h('span', null, Array.isArray(v) ? v.join(', ') : String(v)))));
      kids.push(panel(Core.stripPrefix(strName), `${se.vals.length} value${se.vals.length > 1 ? 's' : ''} · click one to jump there`, list));
    }
    right.replaceChildren(...kids);
  }

  // ---------- HISTORY ----------
  const METRICS = [
    ['batteryMinV', 'Lowest battery voltage', 'V', 2], ['energyWh', 'Energy used', 'Wh', 1], ['peakCurrentA', 'Peak current', 'A', 0], ['hottest', 'Hottest motor', '°C', 0],
    ['motor', 'One motor\'s max temperature', '°C', 0], ['batteryStartV', 'Starting battery voltage', 'V', 2], ['commsDrops', 'Comms drops', '', 0], ['brownouts', 'Brownouts', '', 0], ['loopOverruns', 'Loop overruns', '', 0], ['motorFaults', 'Motor fault events', '', 0],
  ];
  const histLabel = d => [d.match || d.fileName.replace(/\.wpilog$/, ''), d.event].filter(Boolean).join(' · ');
  const hottestOf = d => Object.entries(d.motors || {}).filter(([, m]) => m.tempMax != null).sort((a, b) => b[1].tempMax - a[1].tempMax)[0];
  BUILD.history = () => renderHistory();
  function renderHistory() {
    const root = $('#tab-history'); if (!root) return;
    if (!S.db && !Library.enabled) { root.replaceChildren(panel('Match history', null, h('div', { class: 'empty' }, h('b', null, 'History isn\'t available here'), 'Saved match summaries live with this page on claude.ai. Open it there while signed in to save and compare matches.'))); return; }
    if (S.history == null) { root.replaceChildren(panel('Match history', null, h('p', { class: 'hint' }, 'Loading saved matches…'))); return; }
    const docs = [...S.history].sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.event).localeCompare(String(b.event)) || (parseInt(String(a.match).replace(/\D/g, '')) || 0) - (parseInt(String(b.match).replace(/\D/g, '')) || 0) || (a.savedAt || '').localeCompare(b.savedAt || ''));
    if (!docs.length) { root.replaceChildren(panel('Match history', null, h('div', { class: 'empty' }, h('b', null, 'No matches saved yet'), S.db ? 'Open a .wpilog, then press Save to history. Each save stores the match summary (not the log itself), so the team can compare matches across an event.' : 'Every log in the match library (this computer, the team library, the driver station) shows up here, so you can compare matches across an event.'))); return; }
    const motorNames = [...new Set(docs.flatMap(d => Object.keys(d.motors || {})))].sort();
    if (!S.histMotor || !motorNames.includes(S.histMotor)) S.histMotor = motorNames[0] || '';
    const [mk, mlabel, munit, mdec] = METRICS.find(m => m[0] === S.histMetric) || METRICS[0];
    const valOf = d => mk === 'hottest' ? hottestOf(d)?.[1].tempMax : mk === 'motor' ? d.motors?.[S.histMotor]?.tempMax : d[mk];
    const vals = docs.map(valOf).filter(v => v != null && isFinite(v));
    const max = Math.max(1e-9, ...vals.map(Math.abs));
    const msel = h('select', { class: 'sel', id: 'histMetric', 'aria-label': 'Metric', onchange: e => { S.histMetric = e.target.value; renderHistory(); } }, ...METRICS.map(([k, l]) => h('option', { value: k, selected: k === mk }, l)));
    const motSel = mk === 'motor' ? h('select', { class: 'sel', id: 'histMotor', 'aria-label': 'Motor', onchange: e => { S.histMotor = e.target.value; renderHistory(); } }, ...motorNames.map(n => h('option', { value: n, selected: n === S.histMotor }, n))) : null;
    const bars = h('div', { class: 'hbars' }, ...docs.map(d => { const v = valOf(d); return h('div', { class: 'hbar' }, h('span', { class: 'lab', title: d.fileName }, histLabel(d)), h('span', { class: 'track' }, v != null ? h('i', { style: `width:${Math.max(1, Math.abs(v) / max * 100)}%` }) : null), h('span', { class: 'val' }, v != null ? fmt(v, mdec) + (munit ? ' ' + munit : '') : '—')); }));
    const trend = h('div', { class: 'panel' }, h('div', { class: 'ph' }, 'Across matches', h('small', null, `${mk === 'motor' ? S.histMotor + ' max temperature' : mlabel}, in match order`), h('span', { class: 'right' }, msel, motSel)), bars);

    const rows = docs.slice().reverse().map(d => {
      const hot = hottestOf(d);
      const del = h('span', null);
      const ask = () => del.replaceChildren(h('span', { class: 'confirm' }, 'Delete?', h('button', { class: 'linkbtn danger', onclick: async () => { try { await S.db.collection('matches').doc(d.id).delete(); toast(`Deleted ${histLabel(d)}`); } catch (err) { toast(`Couldn't delete: ${err.message || err.code}`); } } }, 'Yes'), h('button', { class: 'linkbtn', onclick: () => del.replaceChildren(btn) }, 'No')));
      const btn = h('button', { class: 'linkbtn danger', onclick: ask }, 'Delete');
      del.append(S.canWrite ? btn : '');
      return h('tr', null, h('td', null, h('b', null, d.match || '—')), h('td', null, d.event || '—'), h('td', null, d.date || '—'),
        h('td', { class: 'r' }, fmt(d.batteryStartV, 2)), h('td', { class: 'r' }, fmt(d.batteryMinV, 2)), h('td', { class: 'r' }, fmt(d.energyWh, 1)), h('td', { class: 'r' }, fmt(d.peakCurrentA, 0)),
        h('td', null, hot ? `${hot[0]} ${fmt(hot[1].tempMax, 0)}°C` : '—'), h('td', { class: 'r' }, d.brownouts ?? '—'), h('td', { class: 'r' }, d.commsDrops ?? '—'),
        h('td', null, d.critCount ? h('span', { class: 'pill' }, h('span', { class: 'dot crit' }), `${d.critCount} critical`) : d.warnCount ? h('span', { class: 'pill' }, h('span', { class: 'dot warn' }), `${d.warnCount} warning`) : h('span', { class: 'pill' }, h('span', { class: 'dot ok' }), 'Clean')), h('td', null, del));
    });
    const table = panel('Saved matches', S.db ? `${docs.length} saved · newest first · open the .wpilog again for full detail` : `${docs.length} in the library · newest first · open one from Logs for full detail`,
      h('div', { class: 'tscroll' }, h('table', { class: 'static' }, h('thead', null, h('tr', null, ...['Match', 'Event', 'Date'].map(x => h('th', null, x)), ...['Start V', 'Min V', 'Energy Wh', 'Peak A'].map(x => h('th', { class: 'r' }, x)), h('th', null, 'Hottest motor'), h('th', { class: 'r' }, 'Brownouts'), h('th', { class: 'r' }, 'Comms drops'), h('th', null, 'Flags'), h('th', null, ''))), h('tbody', null, ...rows))));
    root.replaceChildren(trend, table);
  }
  const docId = name => name.replace(/\.wpilog$/i, '').replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 180) || 'log';
  async function saveToHistory() {
    if (!S.db || !S.log || S.isSample) return;
    const d = Core.summaryDoc(S.log, S.sum); const id = docId(S.log.fileName);
    const exists = (S.history || []).some(x => x.id === id);
    const btn = $('#saveBtn'); btn.disabled = true;
    try { await S.db.collection('matches').doc(id).set(d); toast(`${exists ? 'Updated' : 'Saved'} ${histLabel(d)} in match history`); }
    catch (err) { toast(err.code === 'quota_exceeded' ? 'History is full. Delete some old matches first.' : `Couldn't save: ${err.message || err.code}`); }
    btn.disabled = false;
  }
  $('#saveBtn').onclick = saveToHistory;
  function updateSaveBtn() {
    const b = $('#saveBtn'); b.hidden = !S.db || !S.log;
    b.disabled = S.isSample || S.isLive || !S.canWrite;
    b.title = S.isSample ? 'The sample match can\'t be saved. Open a real log first.' : S.isLive ? 'Save works on log files. Open the match\'s .wpilog after the match.' : !S.canWrite ? 'You have view-only access to this page.' : 'Save this match\'s summary to the shared history';
  }
  (async () => {
    try {
      if (!window.claude || !window.claude.use) return;
      const db = await window.claude.use('db'); if (!db) return;
      S.db = db;
      const user = await window.claude.use('user');
      const cw = user ? await user.can('data.write') : null;
      S.canWrite = cw !== false;
      updateSaveBtn();
      db.collection('matches').onSnapshot(snap => {
        S.history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTabs(); if (S.built.history) renderHistory();
      }, err => { S.history = []; if (S.built.history) renderHistory(); console.warn('history', err); });
      if (S.built.history) renderHistory();
    } catch (err) { console.warn('db unavailable', err); }
  })();


  // ---------- LIVE (NetworkTables 4) ----------
  // Works where the page can open a WebSocket to the robot: the driver station app, or the HTML file opened from disk.
  // Inside claude.ai the page's security policy blocks it, so there the panel explains instead.
  const CAN_LIVE = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || !!window.FRC_DESKTOP;
  const LIVE_PRESETS = [['Robot (radio)', '10.77.63.2'], ['USB tether', '172.22.11.2'], ['Simulation', '127.0.0.1'], ['Simulated match', FakeMatch.HOST]];
  const isSim = host => host === FakeMatch.HOST;
  let live = null; // { client, log, loaded, follow, span, seen, lastAnalyze }
  const liveState = { host: store.get('7763.liveHost', '10.77.63.2'), follow: true, span: store.get('7763.liveSpan', 30) };

  function liveSig() {
    if (!S.sum) return '';
    return [S.sum.motors.map(m => m.name + ':' + m.lanes.map(l => l.key + l.count).join(',')).join('|'), S.sum.flags.map(f => f.title).join('|'), S.sum.mechanisms.length, S.sum.poses.length].join('#');
  }
  function setLiveIndicator() {
    const dot = $('#liveDot'), label = $('#liveLabel');
    const st = live && live.client ? live.client.state : 'off';
    dot.className = 'live-dot' + (st === 'connected' ? (live.loaded ? ' on' : ' wait') : st === 'connecting' || st === 'retrying' ? ' wait' : st === 'error' ? ' err' : '');
    label.textContent = st === 'connected' ? (live.loaded ? `Live${live.client.rttMs != null ? ' · ' + Math.round(live.client.rttMs) + ' ms' : ''}` : 'Waiting for data') : st === 'connecting' ? 'Connecting…' : st === 'retrying' ? 'Reconnecting…' : 'Live';
  }
  function renderLivePanel() {
    const panel = $('#livePanel');
    if (!CAN_LIVE) {
      panel.replaceChildren(h('h3', null, 'Live from the robot'),
        h('p', { style: 'margin:0;font-size:13px' }, 'Live view runs in the driver station app, not inside claude.ai, because this page isn\'t allowed to open a connection to your robot. Install the app on the driver station laptop and connect from there.'),
        live && live.client ? h('button', { class: 'btn', onclick: () => { stopLive(); renderLivePanel(); } }, 'Stop simulated match')
          : h('button', { class: 'btn primary', onclick: () => { startLive(FakeMatch.HOST); renderLivePanel(); } }, 'Run a simulated match'),
        h('p', { class: 'hint', style: 'margin:0' }, 'A made-up robot that runs inside this page, with faults on each mechanism at different times.'));
      return;
    }
    const st = live && live.client ? live.client.state : 'off';
    const on = st === 'connected' || st === 'connecting' || st === 'retrying';
    const host = h('input', { type: 'text', id: 'liveHost', value: liveState.host, spellcheck: 'false', 'aria-label': 'Robot address', oninput: e => { liveState.host = e.target.value.trim(); store.set('7763.liveHost', liveState.host); } });
    const status = live && live.client ? (st === 'connected' ? `${isSim(live.client.o.host) ? 'Simulated match running' : `Connected (${live.client.ws && live.client.ws.protocol.startsWith('v4.1') ? 'NT 4.1' : 'NT 4.0'})`}${live.client.rttMs != null ? ', round trip ' + live.client.rttMs.toFixed(1) + ' ms' : ''}. ${live.log ? live.log.entries.size + ' signals' : ''}`
      : st === 'retrying' ? `Can't reach ${live.client.o.host}:5810 yet. Retrying. Check you're on the robot's network and the code is running.` : st === 'connecting' ? 'Connecting…' : st === 'error' ? 'Couldn\'t start the connection.' : 'Not connected.') : 'Not connected.';
    panel.replaceChildren(
      h('h3', null, 'Live from the robot'),
      h('label', null, 'Robot address', host),
      h('div', { class: 'presets' }, ...LIVE_PRESETS.map(([label, ip]) => h('button', { class: 'btn small', onclick: () => { liveState.host = ip; store.set('7763.liveHost', ip); host.value = ip; } }, label))),
      h('div', { class: 'row2' },
        on ? h('button', { class: 'btn', onclick: () => { stopLive(); renderLivePanel(); } }, 'Disconnect') : h('button', { class: 'btn primary', onclick: () => { startLive(liveState.host); renderLivePanel(); } }, 'Connect'),
        h('label', { style: 'display:inline-flex;gap:6px;align-items:center;font-size:12.5px' }, h('input', { type: 'checkbox', id: 'liveFollow', checked: liveState.follow, onchange: e => { liveState.follow = e.target.checked; if (live) live.follow = liveState.follow; } }), 'Follow live'),
        h('select', { class: 'sel', id: 'liveSpan', 'aria-label': 'Window', onchange: e => { liveState.span = +e.target.value; store.set('7763.liveSpan', liveState.span); if (live) live.span = liveState.span; } }, ...[15, 30, 60, 150].map(v => h('option', { value: v, selected: v === liveState.span }, `last ${v} s`)))),
      h('div', { class: 'live-status' }, h('span', { class: 'live-dot ' + (st === 'connected' ? 'on' : on ? 'wait' : '') }), status),
      h('p', { class: 'hint', style: 'margin:0' }, `Reads NetworkTables on port 5810. Nothing is sent to the robot. Shows the last 10 minutes${Library.desktop ? ' and records everything to the match library (Logs)' : ''}. "Simulated match" runs a made-up robot inside the app instead (address: sim).`));
  }
  function startLive(host) {
    stopLive();
    const log = Live.newLog(host);
    live = { log, loaded: false, follow: liveState.follow, span: liveState.span, seen: -1, lastAnalyze: 0 };
    log.serverNow = () => live && live.client ? live.client.serverNowUs() : null;
    const Client = isSim(host) ? FakeMatch.Client : NT4.Client; // the simulated match runs in the page, no robot needed
    const serverNow = () => (live && live.client ? live.client.serverNowUs() : null);
    live.client = new Client({ host, onValue: (topic, us, value) => { Live.add(log, topic, us, value); Library.liveValue(topic, us, value, serverNow); },
      onStatus: ({ state }) => { Library.liveStatus(state, host); setLiveIndicator(); if (!$('#livePanel').hidden) renderLivePanelSoon(); if (S.isLive) renderHeader(); } });
    live.client.connect();
    setLiveIndicator();
  }
  function stopLive() { if (live && live.client) live.client.disconnect(); if (live) live.client = null; Library.liveStatus('stopped'); setLiveIndicator(); if (S.isLive) renderHeader(); }
  let panelT = 0; function renderLivePanelSoon() { clearTimeout(panelT); panelT = setTimeout(renderLivePanel, 150); }
  $('#liveBtn').onclick = () => { const p = $('#livePanel'); p.hidden = !p.hidden; $('#liveBtn').setAttribute('aria-expanded', String(!p.hidden)); if (!p.hidden) renderLivePanel(); };
  document.addEventListener('pointerdown', e => { const p = $('#livePanel'); if (!p.hidden && !e.target.closest('.live-wrap')) { p.hidden = true; $('#liveBtn').setAttribute('aria-expanded', 'false'); } });

  setInterval(() => {
    if (!live || !live.log) return;
    const L = live.log;
    if (L.version === live.seen) return;
    live.seen = L.version;
    if (!live.loaded) {
      if (!isFinite(L.tMax) || L.entries.size < 3) return;
      live.loaded = true; live.lastAnalyze = performance.now();
      loadLog(L, false); setLiveIndicator(); return;
    }
    if (S.log !== L) return; // a file was opened over the live view
    if (live.follow) { S.view = { t0: Math.max(L.tMin, L.tMax - live.span), t1: L.tMax }; S.mechT = L.tMax; }
    const now = performance.now();
    if (now - live.lastAnalyze > 1000) { live.lastAnalyze = now; Live.trim(L, 600); refreshLive(); }
    scheduleRedraw();
  }, 100);

  // Re-run the analysis about once a second. Rebuild the open tab only when something new appeared
  // (a motor, a fault, a flag), so live charts and the user's place on the page aren't reset every second.
  function refreshLive() {
    S.sum = Core.analyze(S.log, S.limits);
    const sig = liveSig();
    renderTabs();
    if (sig !== S.sig) {
      S.sig = sig;
      motorCharts.length = 0; S.built = {};
      for (const [t] of TABS) if (t !== S.tab) $('#tab-' + t).replaceChildren();
      S.built[S.tab] = true; BUILD[S.tab]();
    } else {
      if (S.tab === 'motors') renderMotorTable();
      if (S.tab === 'faults') renderFaultTable();
      if (S.tab === 'report') { const t = $('#tab-report .tiles'); if (t) t.replaceWith(buildTiles()); }
    }
  }

  // ---------- header / loading ----------
  function renderHeader() {
    const s = S.sum, i = s.info;
    const id = S.isLive ? 'Live' : i.match || S.log.fileName.replace(/\.wpilog$/i, '');
    const sub = S.isLive ? [isSim(S.log.host) ? 'Simulated match' : S.log.host, i.event && `${i.event} ${i.match || ''}`.trim(), live && live.client && live.client.state === 'connected' ? 'connected' : 'disconnected, showing what was received'].filter(Boolean).join(' · ')
      : [i.event, i.date && `${i.date}${i.time ? ' ' + i.time : ''}`, `${fmt(s.duration, 0)} s log`].filter(Boolean).join(' · ');
    $('#matchHead').replaceChildren(...[h('span', { class: 'id' }, id), h('span', { class: 'sub' }, sub),
      i.alliance ? h('span', { class: 'chip ' + i.alliance.toLowerCase() }, i.alliance) : null,
      S.isLive ? h('span', { class: 'chip live' }, 'Live') : S.isSample ? h('span', { class: 'chip sample' }, 'Sample data') : h('span', { class: 'chip mono', title: S.log.fileName }, S.log.fileName.length > 34 ? S.log.fileName.slice(0, 32) + '…' : S.log.fileName)].filter(Boolean));
    const b = $('#banner');
    if (S.isSample) b.replaceChildren(h('div', { class: 'banner', style: 'margin-bottom:18px' }, h('p', null,
      'This is a made-up match so you can see how the viewer works. To load your own, open the ', h('code', null, '.wpilog'), ' from the ', h('code', null, 'logs'),
      ' folder on the robot\'s USB stick (or pull it off the robot with WPILib\'s DataLogTool), or drop it anywhere on this page. Files are read in your browser and never uploaded.')));
    else if (S.log.truncated) b.replaceChildren(h('div', { class: 'banner', style: 'margin-bottom:18px' }, h('p', null, 'The file ends partway through a record, probably because the robot lost power while logging. Everything before that point is shown.')));
    else b.replaceChildren();
  }
  function showError(msg) { $('#banner').replaceChildren(h('div', { class: 'banner error', style: 'margin-bottom:18px' }, h('p', null, msg))); }
  function reanalyze() {
    S.sum = Core.analyze(S.log, S.limits);
    motorCharts.length = 0; S.built = {}; for (const [t] of TABS) $('#tab-' + t).replaceChildren();
    renderHeader(); showTab(S.tab);
  }
  function loadLog(log, isSample) {
    S.log = log; S.isSample = isSample; S.isLive = !!log.live; S.cursor = null; S.playing = false; S.sig = null;
    S.sum = Core.analyze(log, S.limits);
    S.motorSel = []; S.motorSlot = new Map();
    for (const m of [...S.sum.motors].filter(m => m.tempMax != null).sort((a, b) => b.tempMax - a.tempMax).slice(0, 3)) { S.motorSel.push(m.name); takeSlot(S.motorSlot, m.name); }
    S.sigSel = []; S.sigSlot = new Map(); S.sigString = null; S.sigFilter = ''; S.faultSel = null; S.faultOcc = 0;
    motorCharts.length = 0; S.built = {};
    for (const [t] of TABS) $('#tab-' + t).replaceChildren();
    S.view = { t0: log.tMin, t1: log.tMax }; const [a, b] = matchRange(); S.view = { t0: a, t1: b };
    if (S.isLive && live) { S.view = { t0: Math.max(log.tMin, log.tMax - live.span), t1: log.tMax }; S.mechT = log.tMax; }
    S.sig = liveSig();
    renderHeader(); updateSaveBtn(); showTab(S.tab);
  }
  function openBuffer(buf, name) {
    try {
      const log = Core.parseWpilog(buf, name);
      if (!log.entries.size) throw new Error('The file opened but contains no entries.');
      if (matchView.isOpen()) matchView.close();
      loadLog(log, false);
      toast(`Opened ${name}: ${log.entries.size} signals, ${log.records.toLocaleString()} records`);
      return true;
    } catch (err) { showError(`Couldn't read ${name}. ${err.message}`); console.error(err); return false; }
  }
  async function openFile(file) {
    if (!file) return;
    if (!/\.wpilog$/i.test(file.name)) { showError(`${file.name} isn't a .wpilog file. Robot logs are named like FRC_20260411_183207.wpilog.`); return; }
    const busy = h('div', { class: 'busy' }, `Reading ${file.name}…`); document.body.append(busy);
    const buf = await file.arrayBuffer();
    await new Promise(r => setTimeout(r, 20));
    if (openBuffer(buf, file.name)) Library.adopt(file.name, buf); // the desktop app keeps a copy in its library
    busy.remove();
  }
  $('#openBtn').onclick = () => $('#fileIn').click();
  $('#fileIn').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('#drop').hidden = false; e.preventDefault(); } });
  window.addEventListener('dragover', e => { if (!$('#drop').hidden) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop').hidden = true; });
  window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });

  let toastT = 0;
  function toast(msg) { document.querySelectorAll('.toast').forEach(x => x.remove()); const el = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(el); clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 3200); }

  // keyboard: arrows step the cursor
  window.addEventListener('keydown', e => {
    if (!S.log || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const step = (S.view.t1 - S.view.t0) / 200 * (e.shiftKey ? 10 : 1); setCursor(clamp((S.cursor ?? (S.view.t0 + S.view.t1) / 2) + (e.key === 'ArrowLeft' ? -step : step), S.view.t0, S.view.t1)); e.preventDefault(); }
    if (e.key === 'Escape') { if (Library.isOpen()) Library.close(); else if (matchView.isOpen()) matchView.close(); else setCursor(null); }
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (matchView.isOpen()) matchView.close(); else matchView.open({ connect: true, fit: true }); }
  });

  // theme changes: re-read tokens and redraw
  const retheme = () => { readColors(); for (const c of charts) c.renderLegend(); if (S.built.motors) renderMotorTable(); if (S.built.signals) renderSigList(); scheduleRedraw(); };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme); } catch { /* old browsers */ }
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- MATCH VIEW ----------
  // Full-window status page for the driver station laptop (matchview.js). It reads S directly and runs its own redraw loop.
  const matchView = MatchView.init({
    S, h, fmt, Core, store, toast, setCursor,
    canLive: CAN_LIVE, presets: LIVE_PRESETS, liveHost: () => liveState.host,
    liveInfo: () => (live && live.client ? { state: live.client.state, loaded: live.loaded && S.log === live.log, host: live.client.o.host, rttMs: live.client.rttMs, sim: isSim(live.client.o.host) } : { state: 'off', loaded: false, host: liveState.host }),
    simHost: FakeMatch.HOST, simUpcoming: () => (live && live.client && isSim(live.client.o.host) ? FakeMatch.upcoming(live.client) : []),
    startLive: host => { if (!host) return; liveState.host = host; store.set('7763.liveHost', host); startLive(host); },
    stopLive,
    onClose: () => { renderTabs(); scheduleRedraw(); },
  });
  $('#mvBtn').onclick = () => matchView.open({ connect: true, fit: true });

  // ---------- LIBRARY ----------
  // Logs on this computer, the team's GitHub library and nearby computers (library.js).
  $('#libBtn').onclick = () => Library.open();
  const libReady = Library.init({
    h, fmt, toast, openBuffer, simHost: FakeMatch.HOST, limits: () => S.limits,
    onHistory: docs => { if (S.db) return; S.history = docs; renderTabs(); if (S.built.history) renderHistory(); },
    onUpdate: u => { const b = $('#updBtn'); b.hidden = u.state !== 'ready'; b.title = `CarboVis ${u.version} is downloaded. Restart to install it now, or it installs the next time CarboVis closes.`; },
  });
  if (window.carbovis) {
    $('#updBtn').onclick = () => window.carbovis.update.install();
    window.carbovis.on('open-log', async name => { const buf = await window.carbovis.lib.read(name); openBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name); });
    window.carbovis.on('open-matchview', () => matchView.open({ connect: true, fit: true }));
  }

  window.__frc = { S, Core, matchView }; // for debugging from the browser console
  // ---------- boot ----------
  readColors();
  const hash = (location.hash || '').slice(1);
  if (TABS.some(([t]) => t === hash)) S.tab = hash;
  renderTabs();
  setTimeout(() => {
    try { loadLog(Core.parseWpilog(Sample.generate(), Sample.fileName), true); }
    catch (err) { showError('The sample match failed to load: ' + err.message); console.error(err); }
    if (hash === 'matchview') matchView.open({ connect: true, fit: true });
    // phones and other computers come here for the team's logs: show them first
    else if (!hash && !window.carbovis && Library.enabled) libReady.then(() => Library.open());
  }, 0);
})();
