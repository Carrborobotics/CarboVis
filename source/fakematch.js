// ===== Simulated match: a fake robot that runs inside the page =====
// Stands in for the NetworkTables client (same interface as NT4.Client), so the live view, match view and
// every tab treat it exactly like a real robot. Pick "Simulated match" in the Live panel or the match view.
// Numbers are made up but realistic; each mechanism faults at its own time so every status color shows up.
const FakeMatch = (() => {
  'use strict';
  const HOST = 'sim';
  const DT = 0.05;                       // 20 Hz, like NT4's default periodic rate
  const PRE = 4, AUTO = 20, GAP = 3, TELE = 140, POST = 12;
  const T_AUTO = 0, T_TELE = AUTO + GAP, T_END = T_TELE + TELE;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const within = (t, a, b) => t >= a && t < b;

  // When each thing goes wrong, in seconds from the start of auto. Teleop starts at 23 s.
  // Shown in the match view footer as the "what's next" list.
  const EVENTS = [
    { t: [12, 15], what: 'Back camera latency spike', mech: 'camera' },
    { t: [38, 41], what: 'BL drive drops off CAN', mech: 'drive' },
    { t: [52, 56], what: 'Flywheel follower at its stator limit', mech: 'shooter' },
    { t: [66, 70], what: 'Intake roller drops off CAN, then reboots', mech: 'intake' },
    { t: [84, 89], what: 'Front camera disconnects', mech: 'camera' },
    { t: [97, 100], what: 'Hood loses its CANcoder', mech: 'shooter' },
    { t: [102, 106], what: 'Kicker drops off CAN, then reboots', mech: 'shooter' },
    { t: [110, 114], what: 'Indexer jams (stall at current limit)', mech: 'intake' },
    { t: [122, 125], what: 'Operator controller unplugged', mech: 'controls' },
    { t: [131, 131.3], what: 'Brownout while pushing', mech: 'power' },
    { t: [136, 160], what: 'Turret overheats', mech: 'shooter' },
    { t: [150, 151.5], what: 'Driver Station link drops', mech: 'comms' },
  ];

  // [name, CAN id, bus, start °C, heating k, supply limit, stator limit]
  const MOTORS = [
    ['FL drive', 1, 'Drivetrain', 31, 0.020, 60, 90], ['FL steer', 2, 'Drivetrain', 29, 0.010, 20, 40],
    ['FR drive', 3, 'Drivetrain', 36, 0.042, 60, 90], ['FR steer', 4, 'Drivetrain', 29, 0.010, 20, 40],
    ['BR drive', 5, 'Drivetrain', 30, 0.019, 60, 90], ['BR steer', 6, 'Drivetrain', 28, 0.010, 20, 40],
    ['BL drive', 7, 'Drivetrain', 30, 0.018, 60, 90], ['BL steer', 8, 'Drivetrain', 28, 0.010, 20, 40],
    ['Turret', 21, 'rio', 30, 0.050, 30, 40], ['Flywheel', 22, 'rio', 33, 0.030, 50, 70], ['Flywheel follower', 23, 'rio', 33, 0.034, 50, 70],
    ['Hood', 24, 'rio', 29, 0.020, 20, 30], ['Kicker', 25, 'rio', 30, 0.025, 40, 60],
    ['Roller', 31, 'rio', 29, 0.020, 40, 60], ['Rack', 32, 'rio', 28, 0.020, 30, 40], ['Indexer', 33, 'rio', 30, 0.030, 30, 45],
  ];
  const FAULTS = ['Hardware', 'ProcTemp', 'DeviceTemp', 'Undervoltage', 'BootDuringEnable', 'BridgeBrownout', 'RemoteSensorDataInvalid', 'StatorCurrLimit', 'SupplyCurrLimit'];
  const CAMS = ['FrontLeft', 'BackRight'];

  function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  class Client {
    constructor(o) {
      this.o = { ...o, host: HOST };
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
      this.us = this.serverNowUs();
      this.pub('/FMSInfo/EventName', 'string', 'SIM', null, true);
      this.pub('/FMSInfo/MatchType', 'int', 2, null, true);
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
      this.red = this.R() < 0.5;
      const keepHeat = this.m ? 0.45 : 0; // a quick turnaround between matches leaves motors warm
      this.m = MOTORS.map(([name, id, bus, t0, k, sup, sta]) => ({ name, id, k, sup, sta, T: this.m ? t0 + (this.m.find(x => x.name === name).T - t0) * keepHeat : t0 + this.R() * 2, I: 0 }));
      this.x = this.red ? 14.2 : 2.3; this.y = 4.1; this.h = this.red ? Math.PI : 0;
      this.vx = 0; this.vy = 0; this.turret = 0; this.hood = 22; this.rack = 0; this.Ah = 0;
      this.canTx = 0; this.canRx = 0; this.flyRpm = 0; this.angles = [0, 0, 0, 0];
      this.phaseSeed = this.R() * 100;
    }

    pump() {
      const real = (performance.now() - this.startT) / 1000;
      let steps = 0;
      while (this.simT + DT <= real && steps < 40) { this.simT += DT; this.step(); steps++; }
      if (real - this.simT > 2) this.simT = real; // tab was asleep: don't replay minutes of backlog
      this.rttMs = 1.5 + this.R() * 2;
    }

    step() {
      const R = this.R, mt = (this.mt += DT);
      if (mt > T_END + POST) { this.matchNo++; this.newMatch(-PRE); this.publishStatic(); return; }
      this.us = Math.round((this.startT / 1000 + this.simT) * 1e6);
      const auto = within(mt, T_AUTO, AUTO), tele = within(mt, T_TELE, T_END);
      const dsUp = !within(mt, 150, 151.5);
      const enabled = (auto || tele) && dsUp;
      const ev = (a, b) => within(mt, a, b);
      const brown = ev(131, 131.3);
      const cut = enabled && !brown ? 1 : 0;

      // ---- what the robot is doing: 18 s cycles of intake -> drive -> shoot ----
      const blue = !this.red, home = blue ? 2.6 : 13.9, far = blue ? 7.4 : 9.1;
      const cyc = tele ? ((mt - T_TELE) % 18) : auto ? (mt % 10) : 0;
      const intaking = enabled && (auto ? cyc < 4 : cyc < 7), shooting = enabled && (auto ? cyc >= 6 : cyc >= 13);
      const pushing = enabled && ev(128, 135);
      let tx = intaking ? far + Math.sin(mt / 3 + this.phaseSeed) * 0.8 : home + (blue ? 1 : -1) * 0.6 * Math.sin(mt / 4);
      let ty = intaking ? 4.1 + 2.6 * Math.sin(mt / 5 + this.phaseSeed) : 4.1 + 1.5 * Math.sin(mt / 6);
      if (pushing) { tx = 8.27; ty = 4.0; }
      if (!enabled) { tx = this.x; ty = this.y; }
      const ax = clamp((tx - this.x) * 3 - this.vx * 2.4, -7, 7), ay = clamp((ty - this.y) * 3 - this.vy * 2.4, -7, 7);
      this.vx = clamp(this.vx + ax * DT * cut, -4.3, 4.3) * (cut ? 1 : 0.8); this.vy = clamp(this.vy + ay * DT * cut, -4.3, 4.3) * (cut ? 1 : 0.8);
      this.x = clamp(this.x + this.vx * DT, 0.5, 16.0); this.y = clamp(this.y + this.vy * DT, 0.5, 7.6);
      const speed = Math.hypot(this.vx, this.vy), acc = Math.hypot(ax, ay) * cut;
      const goalH = intaking ? Math.atan2(this.vy, this.vx || 1e-6) : (blue ? 0 : Math.PI) + 0.3 * Math.sin(mt / 7);
      let dh = Math.atan2(Math.sin(goalH - this.h), Math.cos(goalH - this.h));
      const omega = clamp(dh * 2.5, -4, 4) * cut;
      this.h += omega * DT;
      // swerve module angles (robot-relative drive direction + rotation)
      const rel = Math.atan2(this.vy, this.vx) - this.h;
      if (speed > 0.15) this.angles = [0, 1, 2, 3].map(() => rel * 180 / Math.PI + (R() - 0.5) * 2);

      // turret aims at the hub in our alliance zone, hood follows distance
      const hubX = blue ? 4.6 : 11.9, hubY = 4.03;
      let aim = Math.atan2(hubY - this.y, hubX - this.x) - this.h; aim = Math.atan2(Math.sin(aim), Math.cos(aim)) * 180 / Math.PI;
      const turSet = clamp(aim, -170, 170);
      this.turret += (turSet - this.turret) * (1 - Math.exp(-DT / (ev(136, 160) ? 0.35 : 0.12))) * (cut || 0);
      const dist = Math.hypot(hubX - this.x, hubY - this.y);
      const hoodSet = clamp(18 + dist * 5.2, 18, 46);
      if (!ev(97, 100)) this.hood += (hoodSet - this.hood) * (1 - Math.exp(-DT / 0.1)) * cut;
      const rackSet = intaking ? 6.2 : 0.15;
      this.rack += clamp(rackSet - this.rack, -18 * DT, 18 * DT) * cut;
      const flySet = shooting ? 4600 + dist * 120 : enabled ? 1500 : 0;
      this.flyRpm += (flySet - this.flyRpm) * (1 - Math.exp(-DT / 0.45));

      // ---- motor loads ----
      const jam = ev(110, 114) && cut;
      const off = { 'BL drive': ev(38, 41), Roller: ev(66, 70), Kicker: ev(102, 106) && mt < 103.5 };
      const load = {
        drive: [cut * (pushing ? 52 + R() * 8 : 5 + acc * 4 + speed * 3), cut * clamp(speed / 4.3 + (pushing ? 0.45 : 0), 0, 0.9), speed * 60 * 6.75 / (Math.PI * 0.1016)],
        steer: [cut * (2 + Math.abs(omega) * 3 + R() * 1.5), cut * 0.15, omega * 300],
        Turret: [cut * (3 + Math.abs(turSet - this.turret) * 0.5 + (ev(136, 160) ? 22 : 0)), cut * 0.2, (turSet - this.turret) * 20],
        Flywheel: [cut * (8 + Math.max(0, flySet - this.flyRpm) * 0.02 + (shooting ? 14 : 0)), cut * this.flyRpm / 6000, this.flyRpm],
        Hood: [cut * (2 + Math.abs(hoodSet - this.hood) * 0.6), cut * 0.08, (hoodSet - this.hood) * 30],
        Kicker: [cut * (shooting ? 26 : 1), cut * (shooting ? 0.75 : 0.02), cut * (shooting ? 5200 : 100)],
        Roller: [cut * (intaking ? 24 + R() * 8 : 0.5), cut * (intaking ? 0.8 : 0), cut * (intaking ? 4200 : 0)],
        Rack: [cut * (Math.abs(rackSet - this.rack) > 0.1 ? 22 : 2), cut * 0.3, (rackSet - this.rack) * 200],
        Indexer: [jam ? 60 : cut * (intaking || shooting ? 16 + R() * 4 : 0.5), jam ? 0.9 : cut * (intaking || shooting ? 0.7 : 0), jam ? 0 : cut * (intaking || shooting ? 3300 : 0)],
      };
      load['Flywheel follower'] = load.Flywheel.slice();
      if (ev(52, 56)) load['Flywheel follower'] = [80, 0.95, this.flyRpm];
      let total = 2.8 + R() * 0.4;
      for (const m of this.m) {
        const L = /drive$/.test(m.name) ? load.drive : /steer$/.test(m.name) ? load.steer : load[m.name];
        let sta = L[0] * (m.name === 'FR drive' ? 1.12 : 1) * (1 + (R() - 0.5) * 0.06);
        if (off[m.name]) sta = 0;
        m.staLim = sta > m.sta; if (m.staLim) sta = m.sta;
        let sup = Math.abs(L[1]) * sta + (sta > 0.5 ? 0.3 : 0);
        m.supLim = sup > m.sup; if (m.supLim) sup = m.sup;
        m.I = sta; m.Isup = sup; m.duty = L[1]; m.vel = L[2] * (1 + (R() - 0.5) * 0.01);
        total += sup;
        const extra = m.name === 'Turret' && ev(136, 160) ? 2.4 : 0; // turret binding: heats fast
        m.T += (m.k * sta * sta * 0.012 + extra - (m.T - 25) / 380) * DT;
      }
      this.Ah += total * DT / 3600;
      let V = 12.75 - 0.35 * this.Ah - 0.012 * total + (R() - 0.5) * 0.05;
      if (brown) V = 6.6 + R() * 0.3;

      // ---- publish ----
      const word = (enabled ? 0x01 : 0) | (auto && enabled ? 0x02 : 0) | 0x10 | (dsUp ? 0x20 : 0);
      this.pub('/FMSInfo/FMSControlData', 'int', word, null, true);
      this.dbl('DS/MatchTime', auto ? AUTO - mt : tele ? T_END - mt : -1, 's');
      this.dbl('SystemStats/BatteryVoltage', V, 'V');
      this.dbl('SystemStats/PowerDistribution/TotalCurrent', total, 'A');
      this.bool('SystemStats/BrownedOut', brown);
      const anyOff = Object.values(off).some(Boolean);
      this.dbl('SystemStats/CANBus/Utilization', clamp(0.58 + 0.05 * Math.sin(mt / 6) + (R() - 0.5) * 0.04 + (anyOff ? 0.12 : 0), 0, 1));
      if (anyOff && R() < 0.08) { this.canRx++; if (R() < 0.5) this.canTx++; }
      this.dbl('SystemStats/CANBus/ReceiveErrorCount', this.canRx); this.dbl('SystemStats/CANBus/TransmitErrorCount', this.canTx);
      this.dbl('System/LoopTimeMs', 20 + (R() - 0.5) * 1.5 + (R() < 0.003 ? 12 * R() : 0), 'ms');
      this.pub('/Robot/Drive/Pose', 'double[]', [this.x, this.y, this.h], null);
      this.pub('/Robot/Drive/ModuleAngles', 'double[]', this.angles, null);
      this.dbl('Mechanisms/Turret/Position', this.turret, 'deg'); this.dbl('Mechanisms/Turret/Setpoint', turSet, 'deg');
      this.dbl('Mechanisms/Hood/Position', this.hood, 'deg'); this.dbl('Mechanisms/Hood/Setpoint', hoodSet, 'deg');
      this.dbl('Mechanisms/Rack/Position', this.rack, 'rot'); this.dbl('Mechanisms/Rack/Setpoint', rackSet, 'rot');
      for (const p of [0, 1]) {
        const on = !(p === 1 && ev(122, 125));
        this.bool(`DS/Joystick${p}/Connected`, on); this.str(`DS/Joystick${p}/Name`, on ? (p ? 'Controller (Xbox One For Windows)' : 'Xbox Controller') : '');
      }
      CAMS.forEach((n, k) => {
        const on = !(k === 0 && ev(84, 89));
        this.bool(`Vision/${n}/Connected`, on);
        if (!on) return;
        // tags from a rough field layout (sample.js), with the odd dropped frame and a little noise
        const seen = Sample.tagsSeen(this.x, this.y, this.h, Sample.CAM_MOUNTS[n]).filter(() => R() > 0.08);
        this.dbl(`Vision/${n}/TagCount`, seen.length);
        this.pub(`/Robot/Vision/${n}/TagIds`, 'int[]', seen.map(g => g.id), null);
        this.pub(`/Robot/Vision/${n}/TagYawDeg`, 'double[]', seen.map(g => Math.round((g.yaw + (R() - 0.5) * 0.6) * 100) / 100), 'deg');
        this.pub(`/Robot/Vision/${n}/TagDistanceM`, 'double[]', seen.map(g => Math.round(g.dist * (1 + (R() - 0.5) * 0.02) * 1000) / 1000), 'm');
        const lag = k === 1 && ev(12, 15);
        this.dbl(`Vision/${n}/LatencyMs`, lag ? 220 + R() * 50 : 22 + R() * 12, 'ms');
        this.dbl(`Vision/${n}/FPS`, lag ? 7 + R() * 2 : 30 + (R() - 0.5) * 2);
      });
      const fault = (m, k) => {
        if (k === 'StatorCurrLimit') return m.staLim && m.I > 1;
        if (k === 'SupplyCurrLimit') return m.supLim;
        if (k === 'Undervoltage') return brown;
        if (k === 'BridgeBrownout') return brown && / drive$/.test(m.name);
        if (k === 'BootDuringEnable') return (m.name === 'Roller' && ev(70, 73)) || (m.name === 'Kicker' && ev(103.5, 106));
        if (k === 'RemoteSensorDataInvalid') return m.name === 'Hood' && ev(97, 100);
        if (k === 'DeviceTemp') return m.name === 'Turret' && m.T > 80;
        return false;
      };
      for (const m of this.m) {
        const p = 'Motors/' + m.name + '/';
        const online = !off[m.name];
        this.bool(p + 'Connected', online);
        if (!online) continue; // like MotorTelemetry: nothing else is logged while a motor is gone
        this.dbl(p + 'TempC', Math.round(m.T * 2) / 2, 'degC');
        this.dbl(p + 'SupplyCurrentA', m.Isup, 'A'); this.dbl(p + 'StatorCurrentA', m.I, 'A');
        this.dbl(p + 'BusVoltageV', V - 0.05 - m.Isup * 0.004, 'V'); this.dbl(p + 'DutyCycle', m.duty); this.dbl(p + 'VelocityRPM', m.vel, 'rpm');
        if (Math.round(mt / DT) % 2 === 0) for (const k of FAULTS) this.bool(p + 'Faults/' + k, fault(m, k));
      }
    }
  }

  // Upcoming events relative to the current match clock (for the match view footer)
  function upcoming(client, n = 2) {
    if (!client || client.mt == null) return [];
    const mt = client.mt;
    return EVENTS.filter(e => e.t[1] > mt).slice(0, n).map(e => ({ ...e, inS: e.t[0] - mt, active: e.t[0] <= mt }));
  }

  const api = { Client, HOST, EVENTS, upcoming, last: null };
  return api;
})();
if (typeof module !== 'undefined') module.exports = FakeMatch;
