// ===== Simulated match: a fake robot that runs inside the page =====
// Stands in for the NetworkTables client (same interface as NT4.Client), so the live view, match view and
// every tab treat it exactly like a real robot. Pick "Simulated match" in the Live panel or the match view.
// The same robot, run without a clock, records the demo matches (FakeMatch.record): a clean one, and one
// where things break a few at a time, the radio drops, and finally the robot loses power and reboots.
const FakeMatch = (() => {
  'use strict';
  const HOST = 'sim';
  const DT = 0.05;                       // 20 Hz, like NT4's default periodic rate
  const PRE = 8, AUTO = 20, GAP = 3, TELE = 140, POST = 10;
  const T_TELE = AUTO + GAP, T_END = T_TELE + TELE;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // [name, CAN id, bus, start °C, heating k, supply limit, stator limit]
  const MOTORS = [
    ['FL drive', 1, 'Drivetrain', 31, 0.020, 60, 90], ['FL steer', 2, 'Drivetrain', 29, 0.010, 20, 40],
    ['FR drive', 3, 'Drivetrain', 33, 0.026, 60, 90], ['FR steer', 4, 'Drivetrain', 29, 0.010, 20, 40],
    ['BR drive', 5, 'Drivetrain', 30, 0.019, 60, 90], ['BR steer', 6, 'Drivetrain', 28, 0.010, 20, 40],
    ['BL drive', 7, 'Drivetrain', 30, 0.018, 60, 90], ['BL steer', 8, 'Drivetrain', 28, 0.010, 20, 40],
    ['Turret', 21, 'rio', 30, 0.050, 30, 40], ['Flywheel', 22, 'rio', 33, 0.030, 50, 70], ['Flywheel follower', 23, 'rio', 33, 0.032, 50, 70],
    ['Hood', 24, 'rio', 29, 0.020, 20, 30], ['Kicker', 25, 'rio', 30, 0.025, 40, 60],
    ['Intake rollers', 31, 'rio', 29, 0.020, 40, 60], ['Rack left', 32, 'rio', 28, 0.020, 30, 40], ['Rack right', 34, 'rio', 28, 0.020, 30, 40],
    ['Roller floor', 33, 'rio', 30, 0.030, 30, 45],
  ];
  const DRIVE = MOTORS.filter(m => / (drive|steer)$/.test(m[0])).map(m => m[0]);
  const FAULTS = ['Hardware', 'ProcTemp', 'DeviceTemp', 'Undervoltage', 'BootDuringEnable', 'BridgeBrownout', 'RemoteSensorDataInvalid', 'StatorCurrLimit', 'SupplyCurrLimit'];
  const CAMS = ['FrontLeft', 'BackRight'];

  // What goes wrong and when, in match seconds (auto starts at 0, teleop at 23, the match ends at 163).
  // Effects: off = motors drop off the CAN bus · limit = held at the stator limit · jam = stalled at the limit
  //   boot = reports BootDuringEnable · sensor = remote sensor invalid · hot = overheating
  //   camOff / camLag = camera index · js = controller port unplugged · brown = brownout · push = pushing match
  //   lost = no robot comms (nothing arrives) · dead = robot has no power · sag = battery collapsing
  //   bootAll = every controller reports a reboot · disabled = robot code still starting
  const SCENARIOS = {
    clean: { label: 'Demo: clean match', event: 'NCCMP', type: 2, match: 58, red: false, seed: 58, date: [2026, 3, 12, 14, 15, 2], events: [] },
    faults: { label: 'Demo: everything breaks', event: 'NCCMP', type: 3, match: 4, red: true, seed: 4, date: [2026, 3, 12, 16, 30, 15], events: [
      { t: [-7, -2.5], what: 'Operator controller unplugged before the match', js: [1] },
      { t: [5, 9], what: 'Back camera latency spike + hood loses its CANcoder', camLag: [1], sensor: ['Hood'] },
      { t: [12, 17], what: 'Front camera offline + FL steer drops off CAN', camOff: [0], off: ['FL steer'] },
      { t: [30, 35], what: 'Intake rollers drop off CAN + roller floor jams', off: ['Intake rollers'], jam: ['Roller floor'] },
      { t: [35, 38], what: 'Intake rollers come back after a reboot', boot: ['Intake rollers'] },
      { t: [44, 48], what: 'BL drive drops off CAN + flywheel follower at its current limit', off: ['BL drive'], limit: ['Flywheel follower'] },
      { t: [51, 54], what: 'Kicker drops off CAN', off: ['Kicker'] },
      { t: [54, 57], what: 'Kicker reboots', boot: ['Kicker'] },
      { t: [60, 62.5], what: 'Radio drops: no robot comms', lost: true },
      { t: [68, 73], what: 'Driver controller unplugged + rack right drops off CAN', js: [0], off: ['Rack right'] },
      { t: [78, 163], what: 'Turret starts overheating', hot: ['Turret'] },
      { t: [86, 90], what: 'Vision coprocessor reboots: both cameras offline', camOff: [0, 1] },
      { t: [92, 99], push: true },
      { t: [96, 96.35], what: 'Brownout while pushing', brown: true },
      { t: [100, 101.8], what: 'Radio drops again', lost: true },
      { t: [106, 110], what: 'Intake rollers stall + rack left at its current limit', jam: ['Intake rollers'], limit: ['Rack left'] },
      { t: [116, 119.5], what: 'Battery connector working loose: voltage collapses', sag: true },
      { t: [119.5, 139], what: 'Robot loses power and reboots (no comms)', dead: true, lost: true },
      { t: [139, 143], what: 'Robot back up: every controller reports a reboot', bootAll: true, disabled: true },
      { t: [150, 154], what: 'Operator controller unplugged + back camera offline', js: [1], camOff: [1] },
    ] },
  };

  function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  class Client {
    constructor(o) {
      this.o = { scenario: 'faults', ...o, host: HOST };
      this.sc = SCENARIOS[this.o.scenario];
      this.state = 'disconnected'; this.rttMs = null; this.ws = { protocol: 'simulated' };
      this.topics = new Map(); this.last = new Map();
    }
    status(state) { this.state = state; this.o.onStatus && this.o.onStatus({ state, rttMs: this.rttMs }); }
    serverNowUs() { return Math.round(performance.now() * 1000); }
    connect() {
      api.last = this; // handy from the browser console: FakeMatch.last.mt = 60 jumps the match clock
      this.status('connecting');
      this.R = rng((Math.random() * 1e9) | 0);
      this.matchNo = 10 + Math.floor(this.R() * 60);
      this.newMatch(-PRE);
      this.startT = performance.now(); this.simT = 0;
      this.startTimer = setTimeout(() => {
        this.status('connected');
        this.publishStatic();
        this.timer = setInterval(() => this.pump(), DT * 1000);
      }, 400);
    }
    disconnect() { clearTimeout(this.startTimer); clearInterval(this.timer); this.timer = 0; this.status('disconnected'); }

    // ---- publishing ----
    topic(name, type, unit) {
      let t = this.topics.get(name);
      if (!t) { t = { id: this.topics.size + 1, name, type, properties: unit ? { unit } : {} }; this.topics.set(name, t); }
      return t;
    }
    pub(name, type, value, unit, onlyOnChange) {
      if (onlyOnChange) { const k = this.last.get(name); if (k === value) return; this.last.set(name, value); }
      this.o.onValue && this.o.onValue(this.topic(name, type, unit), this.us, value);
    }
    dbl(n, v, u) { this.pub('/Robot/' + n, 'double', Math.round(v * 1000) / 1000, u); }
    bool(n, v) { this.pub('/Robot/' + n, 'boolean', !!v, null, true); }
    str(n, v) { this.pub('/Robot/' + n, 'string', v, null, true); }

    publishStatic() {
      this.us = Math.round((this.startT / 1000 + this.simT) * 1e6);
      const sc = this.o.demo ? this.sc : null;
      this.pub('/FMSInfo/EventName', 'string', sc ? sc.event : 'SIM', null, true);
      this.pub('/FMSInfo/MatchType', 'int', sc ? sc.type : 2, null, true);
      this.pub('/FMSInfo/MatchNumber', 'int', this.matchNo, null, true);
      this.pub('/FMSInfo/IsRedAlliance', 'boolean', this.red, null, true);
      for (const [name, id, bus, , , sup, sta] of MOTORS) {
        const p = 'Motors/' + name + '/';
        this.pub('/Robot/' + p + 'CANId', 'int', id, null, true);
        this.str(p + 'CANBus', bus); this.str(p + 'Controller', 'TalonFX');
        this.dbl(p + 'SupplyLimitA', sup, 'A'); this.dbl(p + 'StatorLimitA', sta, 'A');
      }
      for (const n of CAMS) this.pub(`/Robot/Vision/${n}/RobotToCamera`, 'double[]', Sample.CAM_MOUNTS[n], null);
    }

    newMatch(t) {
      this.mt = t; // match clock: <0 before auto
      this.red = this.o.demo ? this.sc.red : this.R() < 0.5;
      const keepHeat = this.m ? 0.45 : 0; // a quick turnaround between matches leaves motors warm
      this.m = MOTORS.map(([name, id, bus, t0, k, sup, sta]) => ({ name, id, k, sup, sta, T: this.m ? t0 + (this.m.find(x => x.name === name).T - t0) * keepHeat : t0 + this.R() * 2, I: 0 }));
      this.x = this.red ? 13.0 : 3.55; this.y = this.red ? 2.2 : 5.85; this.h = this.red ? Math.PI : 0;
      this.vx = 0; this.vy = 0; this.turret = 0; this.hood = 22; this.rack = 0; this.Ah = 0;
      this.canTx = 0; this.canRx = 0; this.flyRpm = 0; this.angles = [0, 0, 0, 0]; this.silent = false;
      this.phaseSeed = this.R() * 100;
    }

    pump() {
      const real = (performance.now() - this.startT) / 1000;
      let steps = 0;
      while (this.simT + DT <= real && steps < 40) { this.simT += DT; this.step(); steps++; }
      if (real - this.simT > 2) this.simT = real; // tab was asleep: don't replay minutes of backlog
      this.rttMs = 1.5 + this.R() * 2;
    }

    // everything the scenario says is happening at match time mt
    effects(mt) {
      const fx = { off: new Set(), limit: new Set(), jam: new Set(), boot: new Set(), sensor: new Set(), hot: new Set(), camOff: new Set(), camLag: new Set(), js: new Set() };
      for (const e of this.sc.events) {
        if (mt < e.t[0] || mt >= e.t[1]) continue;
        for (const k of Object.keys(fx)) for (const v of e[k] || []) fx[k].add(v);
        for (const k of ['brown', 'push', 'lost', 'dead', 'sag', 'bootAll', 'disabled']) if (e[k]) fx[k] = e[k] === true ? (mt - e.t[0]) / (e.t[1] - e.t[0]) || 1e-9 : e[k];
      }
      // the battery giving out: motors drop off the bus a few at a time as the voltage falls
      if (fx.sag) this.m.forEach((m, i) => { if (fx.sag > ((i * 7) % this.m.length) / this.m.length * 0.9 + 0.08) fx.off.add(m.name); });
      return fx;
    }

    step() {
      const R = this.R, mt = (this.mt += DT);
      if (mt > T_END + POST) { if (this.o.demo) return; this.matchNo++; this.newMatch(-PRE); this.publishStatic(); return; }
      this.us = Math.round((this.startT / 1000 + this.simT) * 1e6);
      const fx = this.effects(mt);
      const auto = mt >= 0 && mt < AUTO, tele = mt >= T_TELE && mt < T_END;
      const enabled = (auto || tele) && !fx.lost && !fx.dead && !fx.disabled;
      const brown = !!fx.brown || !!fx.sag;
      const cut = enabled && !brown ? 1 : 0;

      // ---- what the robot is doing: 18 s cycles of intake -> drive -> shoot ----
      const blue = !this.red, home = blue ? 2.6 : 13.9, far = blue ? 7.4 : 9.1;
      const cyc = tele ? ((mt - T_TELE) % 18) : auto ? (mt % 10) : 0;
      const intaking = enabled && (auto ? cyc < 4 : cyc < 7), shooting = enabled && (auto ? cyc >= 6 : cyc >= 13);
      const pushing = enabled && !!fx.push;
      let tx = intaking ? far + Math.sin(mt / 3 + this.phaseSeed) * 0.8 : home + (blue ? 1 : -1) * 0.6 * Math.sin(mt / 4);
      let ty = intaking ? 4.1 + 2.6 * Math.sin(mt / 5 + this.phaseSeed) : 4.1 + 1.5 * Math.sin(mt / 6);
      if (pushing) { tx = 8.27; ty = 4.0; }
      if (!enabled) { tx = this.x; ty = this.y; }
      const ax = clamp((tx - this.x) * 3 - this.vx * 2.4, -7, 7), ay = clamp((ty - this.y) * 3 - this.vy * 2.4, -7, 7);
      this.vx = clamp(this.vx + ax * DT * cut, -4.3, 4.3) * (cut ? 1 : 0.8); this.vy = clamp(this.vy + ay * DT * cut, -4.3, 4.3) * (cut ? 1 : 0.8);
      this.x = clamp(this.x + this.vx * DT, 0.5, 16.0); this.y = clamp(this.y + this.vy * DT, 0.5, 7.6);
      const speed = Math.hypot(this.vx, this.vy), acc = Math.hypot(ax, ay) * cut;
      const goalH = intaking ? Math.atan2(this.vy, this.vx || 1e-6) : (blue ? 0 : Math.PI) + 0.3 * Math.sin(mt / 7);
      const dh = Math.atan2(Math.sin(goalH - this.h), Math.cos(goalH - this.h));
      const omega = clamp(dh * 2.5, -4, 4) * cut;
      this.h += omega * DT;
      // swerve module angles (robot-relative drive direction + rotation)
      const rel = Math.atan2(this.vy, this.vx) - this.h;
      if (speed > 0.15) this.angles = [0, 1, 2, 3].map(() => rel * 180 / Math.PI + (R() - 0.5) * 2);

      // turret aims at the hub in our alliance zone, hood follows distance
      const hubX = blue ? 4.6 : 11.9, hubY = 4.03;
      let aim = Math.atan2(hubY - this.y, hubX - this.x) - this.h; aim = Math.atan2(Math.sin(aim), Math.cos(aim)) * 180 / Math.PI;
      const turSet = clamp(aim, -170, 170), hot = fx.hot.has('Turret');
      this.turret += (turSet - this.turret) * (1 - Math.exp(-DT / (hot ? 0.35 : 0.12))) * cut;
      const dist = Math.hypot(hubX - this.x, hubY - this.y);
      const hoodSet = clamp(18 + dist * 5.2, 18, 46);
      if (!fx.sensor.has('Hood')) this.hood += (hoodSet - this.hood) * (1 - Math.exp(-DT / 0.1)) * cut;
      // the hopper's rack slides out to intake (two motors, one each side)
      const rackSet = intaking ? 6.2 : 0.15, rackOn = !fx.off.has('Rack left') || !fx.off.has('Rack right');
      if (rackOn) this.rack += clamp(rackSet - this.rack, -18 * DT, 18 * DT) * cut;
      const flySet = shooting ? 4600 + dist * 120 : enabled ? 1500 : 0;
      this.flyRpm += (flySet - this.flyRpm) * (1 - Math.exp(-DT / 0.45));
      if (fx.dead) { this.flyRpm *= 0.97; this.vx *= 0.9; this.vy *= 0.9; }

      // ---- motor loads: [stator A, duty, rpm] ----
      const rackMove = Math.abs(rackSet - this.rack) > 0.1;
      const load = {
        drive: [cut * (pushing ? 52 + R() * 8 : 5 + acc * 4 + speed * 3), cut * clamp(speed / 4.3 + (pushing ? 0.45 : 0), 0, 0.9), speed * 60 * 6.75 / (Math.PI * 0.1016)],
        steer: [cut * (2 + Math.abs(omega) * 3 + R() * 1.5), cut * 0.15, omega * 300],
        Turret: [cut * (3 + Math.min(60, Math.abs(turSet - this.turret)) * 0.4 + (hot ? 22 : 0)), cut * 0.2, (turSet - this.turret) * 20],
        Flywheel: [cut * (8 + Math.max(0, flySet - this.flyRpm) * 0.008 + (shooting ? 14 : 0)), cut * this.flyRpm / 6000, this.flyRpm],
        Hood: [cut * (2 + Math.abs(hoodSet - this.hood) * 0.6), cut * 0.08, (hoodSet - this.hood) * 30],
        Kicker: [cut * (shooting ? 26 : 1), cut * (shooting ? 0.75 : 0.02), cut * (shooting ? 5200 : 100)],
        'Intake rollers': [cut * (intaking ? 24 + R() * 8 : 0.5), cut * (intaking ? 0.8 : 0), cut * (intaking ? 4200 : 0)],
        'Rack left': [cut * (rackMove ? 22 : 2), cut * (rackMove ? 0.5 : 0.04), cut * (rackSet - this.rack) * 200],
        'Roller floor': [cut * (intaking || shooting ? 15 + R() * 4 : 0.5), cut * (intaking || shooting ? 0.65 : 0), cut * (intaking || shooting ? 2800 : 0)],
      };
      load['Rack right'] = load['Rack left'].slice();
      load['Flywheel follower'] = load.Flywheel.slice();
      let total = 2.8 + R() * 0.4;
      for (const m of this.m) {
        let L = /drive$/.test(m.name) ? load.drive : /steer$/.test(m.name) ? load.steer : load[m.name];
        if (cut && fx.jam.has(m.name)) L = [m.sta + 10, 0.9, 0];
        else if (cut && fx.limit.has(m.name)) L = [m.sta + 12, 0.95, L[2]];
        let sta = L[0] * (m.name === 'FR drive' ? 1.12 : 1) * (1 + (R() - 0.5) * 0.06);
        if (fx.off.has(m.name) || fx.dead) sta = 0;
        m.staLim = sta > m.sta; if (m.staLim) sta = m.sta;
        let sup = Math.abs(L[1]) * sta + (sta > 0.5 ? 0.3 : 0);
        m.supLim = sup > m.sup; if (m.supLim) sup = m.sup;
        m.I = sta; m.Isup = sup; m.duty = sta ? L[1] : 0; m.vel = sta ? L[2] * (1 + (R() - 0.5) * 0.01) : 0;
        total += sup;
        const extra = fx.hot.has(m.name) ? 0.95 : 0; // a binding turret heats fast
        m.T += (m.k * sta * sta * 0.012 + extra - (m.T - 25) / 380) * DT;
      }
      this.Ah += total * DT / 3600;
      let V = 12.75 - 0.35 * this.Ah - 0.012 * total + (R() - 0.5) * 0.05;
      if (fx.brown) V = 6.6 + R() * 0.3;
      if (fx.sag) V = 9.2 - 4.6 * fx.sag + (R() - 0.5) * 0.4;

      // ---- comms: when the robot can't be reached nothing arrives at all ----
      if (fx.lost) {
        if (!this.silent) { this.silent = true; if (this.o.onLost) this.o.onLost(this.us); else this.status('retrying'); }
        return;
      }
      if (this.silent) { // reconnected: like a real NT reconnect, every value is sent again
        this.silent = false; this.last.clear();
        if (!this.o.demo) this.status('connected');
        this.publishStatic();
      }

      // ---- publish ----
      const word = (enabled ? 0x01 : 0) | (auto && enabled ? 0x02 : 0) | 0x10 | 0x20;
      this.pub('/FMSInfo/FMSControlData', 'int', word, null, true);
      this.dbl('DS/MatchTime', auto ? AUTO - mt : tele ? T_END - mt : -1, 's');
      this.dbl('SystemStats/BatteryVoltage', V, 'V');
      this.dbl('SystemStats/PowerDistribution/TotalCurrent', total, 'A');
      this.bool('SystemStats/BrownedOut', brown);
      const nOff = this.m.filter(m => fx.off.has(m.name)).length;
      this.dbl('SystemStats/CANBus/Utilization', clamp(0.58 + 0.05 * Math.sin(mt / 6) + (R() - 0.5) * 0.04 + (nOff ? 0.12 : 0), 0, 1));
      if (nOff && R() < 0.08) { this.canRx++; if (R() < 0.5) this.canTx++; }
      this.dbl('SystemStats/CANBus/ReceiveErrorCount', this.canRx); this.dbl('SystemStats/CANBus/TransmitErrorCount', this.canTx);
      this.dbl('System/LoopTimeMs', 20 + (R() - 0.5) * 1.5 + (this.sc.events.length > 1 && R() < 0.003 ? 12 * R() : 0) + (brown ? 9 : 0), 'ms');
      this.pub('/Robot/Drive/Pose', 'double[]', [this.x, this.y, this.h], null);
      this.pub('/Robot/Drive/ModuleAngles', 'double[]', this.angles, null);
      this.dbl('Mechanisms/Turret/Position', this.turret, 'deg'); this.dbl('Mechanisms/Turret/Setpoint', turSet, 'deg');
      this.dbl('Mechanisms/Hood/Position', this.hood, 'deg'); this.dbl('Mechanisms/Hood/Setpoint', hoodSet, 'deg');
      this.dbl('Mechanisms/Rack/Position', this.rack, 'rot'); this.dbl('Mechanisms/Rack/Setpoint', rackSet, 'rot');
      for (const p of [0, 1]) {
        const on = !fx.js.has(p);
        this.bool(`DS/Joystick${p}/Connected`, on); this.str(`DS/Joystick${p}/Name`, on ? (p ? 'Controller (Xbox One For Windows)' : 'Xbox Controller') : '');
      }
      CAMS.forEach((n, k) => {
        const on = !fx.camOff.has(k) && !brown;
        this.bool(`Vision/${n}/Connected`, on);
        if (!on) return;
        // tags from a rough field layout (sample.js), with the odd dropped frame and a little noise
        const seen = Sample.tagsSeen(this.x, this.y, this.h, Sample.CAM_MOUNTS[n]).filter(() => R() > 0.08);
        this.dbl(`Vision/${n}/TagCount`, seen.length);
        this.pub(`/Robot/Vision/${n}/TagIds`, 'int[]', seen.map(g => g.id), null);
        this.pub(`/Robot/Vision/${n}/TagYawDeg`, 'double[]', seen.map(g => Math.round((g.yaw + (R() - 0.5) * 0.6) * 100) / 100), 'deg');
        this.pub(`/Robot/Vision/${n}/TagDistanceM`, 'double[]', seen.map(g => Math.round(g.dist * (1 + (R() - 0.5) * 0.02) * 1000) / 1000), 'm');
        const lag = fx.camLag.has(k);
        this.dbl(`Vision/${n}/LatencyMs`, lag ? 220 + R() * 50 : 22 + R() * 12, 'ms');
        this.dbl(`Vision/${n}/FPS`, lag ? 7 + R() * 2 : 30 + (R() - 0.5) * 2);
      });
      const fault = (m, k) => {
        if (k === 'StatorCurrLimit') return m.staLim && m.I > 1;
        if (k === 'SupplyCurrLimit') return m.supLim;
        if (k === 'Undervoltage') return brown;
        if (k === 'BridgeBrownout') return brown && DRIVE.includes(m.name);
        if (k === 'BootDuringEnable') return fx.boot.has(m.name) || !!fx.bootAll;
        if (k === 'RemoteSensorDataInvalid') return fx.sensor.has(m.name);
        if (k === 'DeviceTemp') return m.T > 80;
        return false;
      };
      for (const m of this.m) {
        const p = 'Motors/' + m.name + '/';
        const online = !fx.off.has(m.name);
        this.bool(p + 'Connected', online);
        if (!online) continue; // like MotorTelemetry: nothing else is logged while a motor is gone
        this.dbl(p + 'TempC', Math.round(m.T * 2) / 2, 'degC');
        this.dbl(p + 'SupplyCurrentA', m.Isup, 'A'); this.dbl(p + 'StatorCurrentA', m.I, 'A');
        this.dbl(p + 'BusVoltageV', V - 0.05 - m.Isup * 0.004, 'V'); this.dbl(p + 'DutyCycle', m.duty); this.dbl(p + 'VelocityRPM', m.vel, 'rpm');
        for (const k of FAULTS) this.bool(p + 'Faults/' + k, fault(m, k));
      }
    }
  }

  // Upcoming events relative to the current match clock (for the match view footer)
  function upcoming(client, n = 2) {
    if (!client || client.mt == null) return [];
    const mt = client.mt;
    return client.sc.events.filter(e => e.what && e.t[1] > mt).slice(0, n).map(e => ({ ...e, inS: e.t[0] - mt, active: e.t[0] <= mt }));
  }

  // A whole demo match, recorded the way the driver station app records one (recorder.js), as .wpilog bytes.
  const demoName = id => { const d = SCENARIOS[id].date, p = n => String(n).padStart(2, '0'); return `FRC_${d[0]}${p(d[1] + 1)}${p(d[2])}_${p(d[3])}${p(d[4])}${p(d[5])}_${SCENARIOS[id].event}_${['', 'P', 'Q', 'E'][SCENARIOS[id].type]}${SCENARIOS[id].match}_DEMO.wpilog`; };
  function record(id) {
    const sc = SCENARIOS[id], rec = new Recorder.Recording('demo');
    rec.started = new Date(Date.UTC(...sc.date));
    const sim = new Client({ scenario: id, demo: true, onValue: (topic, us, value) => rec.add(topic, us, value), onLost: us => rec.commsLost(us) });
    sim.R = rng(sc.seed); sim.matchNo = sc.match; sim.startT = 0; sim.simT = 0;
    sim.newMatch(-PRE);
    sim.publishStatic();
    while (sim.mt < T_END + POST - DT / 2) { sim.simT += DT; sim.step(); }
    return { buf: rec.take().buffer, fileName: demoName(id) };
  }
  const DEMOS = Object.keys(SCENARIOS).map(id => ({ id, label: SCENARIOS[id].label, fileName: demoName(id) }));

  // Robot code running in WPILib simulation has no cameras. Whatever it publishes for them (Vision/<cam>/...,
  // photonvision/..., limelight...) is dropped, and what each camera would see from the simulated robot's pose is
  // made up instead, on the same field layout as the simulated match. A camera's mount comes from the robot's own
  // Vision/<cam>/RobotToCamera (kept, since it's config rather than a camera input), else from its name.
  const CAM_TOPIC = /^(?:Vision\/([^/]+)\/|photonvision\/([^/]+)\/|(limelight(?:-[\w]+)?)\/)/;
  const SIM_CAM_DT = 0.05;
  class SimCameras {
    constructor(emit) { this.emit = emit; this.names = new Set(); this.mounts = {}; this.pose = ''; this.poseRank = 101; this.firstUs = null; this.lastUs = -Infinity; }
    // true when the value is a camera input to drop
    drop(topic, value) {
      const n = Core.stripPrefix(topic.name), r = n.match(CAM_TOPIC);
      if (!r) return false;
      const name = r[1] || r[2] || r[3];
      this.names.add(name);
      if (r[1] && /\/RobotToCamera$/.test(n)) {
        const v = [...value].map(Number);
        if (v.length >= 6) this.mounts[name] = v.slice(0, 6); else if (v.length === 3) this.mounts[name] = [v[0], v[1], 0, 0, 0, v[2]];
        return false;
      }
      return true;
    }
    mount(name, i) {
      if (this.mounts[name]) return this.mounts[name];
      if (Sample.CAM_MOUNTS[name]) return Sample.CAM_MOUNTS[name];
      const f = /front/i.test(name), b = /back|rear/i.test(name), l = /left/i.test(name), r = /right/i.test(name);
      const x = f ? 0.27 : b ? -0.27 : 0, y = l ? 0.27 : r ? -0.27 : 0;
      if (!x && !y) return i ? [-0.27, 0, 0.22, 0, -20, 180] : [0.27, 0, 0.22, 0, -20, 0];
      return [x, y, 0.22, 0, -20, Math.atan2(y, x) * 180 / Math.PI];
    }
    // after every value is added to the log: keep track of the robot's main pose, and publish what the cameras see
    // from it 20 times a second. Any value moves the clock on, since NT only sends a pose when it changes.
    afterValue(topic, us, log) {
      const e = log.entries.get(topic.name);
      if (e && (e.kind === 'struct' ? e.structName === 'Pose2d' : e.kind === 'numarr' && /pose$/i.test(e.name))) {
        const n = Core.stripPrefix(e.name), rank = Core.poseRank(n);
        if (rank < this.poseRank) { this.pose = topic.name; this.poseRank = rank; }
      }
      const pe = this.pose && log.entries.get(this.pose);
      const pose = !pe ? null : pe.kind === 'struct' ? (pe.undecoded || !pe.t.length ? null : ['translation/x', 'translation/y', 'rotation/value'].map(k => pe.fields[k][pe.fields[k].length - 1]))
        : pe.vals.length && pe.vals[pe.vals.length - 1].length === 3 ? [...pe.vals[pe.vals.length - 1]] : null;
      if (!pose) return;
      if (this.firstUs == null) this.firstUs = us;
      if (us - this.lastUs < SIM_CAM_DT * 1e6) return;
      // give the robot a couple of seconds to name its cameras before falling back to the simulated match's two
      let names = [...this.names];
      if (!names.length) { if (us - this.firstUs < 2e6) return; names = Object.keys(Sample.CAM_MOUNTS); }
      this.lastUs = us;
      const pub = (name, type, value, unit) => this.emit({ name: '/Robot/' + name, type, properties: unit ? { unit, simulated: true } : { simulated: true } }, us, value);
      names.forEach((name, i) => {
        const seen = Sample.tagsSeen(pose[0], pose[1], pose[2], this.mount(name, i)), p = `Vision/${name}/`;
        pub(p + 'Connected', 'boolean', true);
        pub(p + 'TagCount', 'double', seen.length);
        pub(p + 'TagIds', 'int[]', seen.map(g => g.id));
        pub(p + 'TagYawDeg', 'double[]', seen.map(g => Math.round(g.yaw * 100) / 100), 'deg');
        pub(p + 'TagDistanceM', 'double[]', seen.map(g => Math.round(g.dist * 1000) / 1000), 'm');
        pub(p + 'LatencyMs', 'double', 25, 'ms');
        pub(p + 'FPS', 'double', 30);
      });
    }
  }
  const isRobotSim = host => /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(String(host || '').trim());

  const api = { Client, HOST, SCENARIOS, DEMOS, upcoming, record, SimCameras, isRobotSim, last: null };
  return api;
})();
if (typeof module !== 'undefined') module.exports = FakeMatch;
