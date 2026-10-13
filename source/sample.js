// ===== synthetic sample match: written as a real .wpilog, then parsed like any upload =====
const Sample = (() => {
  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // Catmull-Rom through timed waypoints [t, x, y, headingDeg]
  function path(wps) {
    return t => {
      let i = 0; while (i < wps.length - 2 && t > wps[i + 1][0]) i++;
      const p0 = wps[Math.max(0, i - 1)], p1 = wps[i], p2 = wps[i + 1], p3 = wps[Math.min(wps.length - 1, i + 2)];
      const u = clamp((t - p1[0]) / (p2[0] - p1[0]), 0, 1);
      const s = u * u * (3 - 2 * u); // ease in/out so the robot stops at waypoints
      const cr = k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * s + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * s * s + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * s * s * s);
      let dh = p2[3] - p1[3]; dh = ((dh + 540) % 360) - 180;
      return [cr(1), cr(2), (p1[3] + dh * s) * Math.PI / 180];
    };
  }

  function generate() {
    const R = rng(7763);
    const W = new Core.Writer('Carrborobotics 7763 sample (synthetic)');
    const us = t => t * 1e6;
    const meta = u => JSON.stringify({ unit: u });
    const T_END = 182, DT = 0.04;
    const AUTO = [22, 37], TELE = [40, 175];
    const DROP = [118.4, 119.3];        // radio link drop
    const BROWN = 150.9;                 // brownout while pushing + spinning up
    const CAN_DROP = [96.0, 96.45];      // intake controller falls off CAN

    // schemas + entries
    const sch = (n, s) => { const id = W.start('/.schema/struct:' + n, 'structschema', '', 0); W.string(id, 0, s); };
    sch('Translation2d', 'double x;double y'); sch('Rotation2d', 'double value'); sch('Pose2d', 'Translation2d translation;Rotation2d rotation');
    const pose2d = (id, t, x, y, r) => { const p = new Uint8Array(24); const dv = new DataView(p.buffer); dv.setFloat64(0, x, true); dv.setFloat64(8, y, true); dv.setFloat64(16, r, true); W.record(id, us(t), p); };

    const E = {};
    E.en = W.start('DS:enabled', 'boolean'); E.au = W.start('DS:autonomous', 'boolean'); E.test = W.start('DS:test', 'boolean');
    E.ds = W.start('DS:ds', 'boolean'); E.fms = W.start('DS:fms', 'boolean');
    E.msg = W.start('messages', 'string');
    E.ev = W.start('NT:/FMSInfo/EventName', 'string', '{"source":"NT"}'); E.mn = W.start('NT:/FMSInfo/MatchNumber', 'double', '{"source":"NT"}');
    E.mt = W.start('NT:/FMSInfo/MatchType', 'double', '{"source":"NT"}'); E.red = W.start('NT:/FMSInfo/IsRedAlliance', 'boolean', '{"source":"NT"}');
    E.pose = W.start('Robot/Pose', 'struct:Pose2d'); E.vis = W.start('Robot/Pose/Vision', 'struct:Pose2d');
    E.bat = W.start('Power/BatteryV', 'double', meta('V')); E.cur = W.start('Power/TotalCurrentA', 'double', meta('A'));
    E.pw = W.start('Power/TotalPowerW', 'double', meta('W')); E.pdhT = W.start('Power/PDHTempC', 'double', meta('degC'));
    E.ch = W.start('Power/ChannelCurrentsA', 'double[]', meta('A'));
    E.bo = W.start('System/BrownedOut', 'boolean'); E.can = W.start('System/CANBusUtilization', 'double', meta('raw'));
    E.txf = W.start('System/CANTxFullCount', 'double', meta('count')); E.rxe = W.start('System/CANRxErrorCount', 'double', meta('count'));
    E.txe = W.start('System/CANTxErrorCount', 'double', meta('count')); E.loop = W.start('System/LoopTimeMs', 'double', meta('ms'));
    // match view extras (robot-code/MatchTelemetry.java): match time, controllers, two AprilTag cameras
    E.mtime = W.start('DS/MatchTime', 'double', meta('s'));
    const JS = [0, 1].map(p => ({ con: W.start(`DS/Joystick${p}/Connected`, 'boolean'), name: W.start(`DS/Joystick${p}/Name`, 'string'), last: null }));
    const CAMS = ['FrontLeft', 'BackRight'].map(n => ({ n, con: W.start(`Vision/${n}/Connected`, 'boolean'), tags: W.start(`Vision/${n}/TagCount`, 'double'),
      lat: W.start(`Vision/${n}/LatencyMs`, 'double', meta('ms')), fps: W.start(`Vision/${n}/FPS`, 'double'), last: null }));
    const CAM_OFF = [100.0, 106.5];      // back camera's USB/ethernet drops out
    const CAM_LAG = [60.0, 63.0];        // back camera latency spike (coprocessor overloaded)
    const JS1_OFF = [70.0, 74.0];        // operator controller unplugged

    // [name, start °C, heating k, controller, supply limit A, stator limit A]
    const motorDefs = [
      ['DriveFL', 38, 0.0245, 'fx', 60, 85], ['DriveFR', 33, 0.0195, 'fx', 60, 85], ['DriveBL', 32, 0.016, 'fx', 60, 85], ['DriveBR', 31, 0.0168, 'fx', 60, 85],
      ['SteerFL', 30, 0.004, 'fx', 20, 40], ['SteerFR', 30, 0.004, 'fx', 20, 40], ['SteerBL', 29, 0.004, 'fx', 20, 40], ['SteerBR', 29, 0.004, 'fx', 20, 40],
      ['Intake', 31, 0.0045, 'spark', NaN, 40], ['Arm', 30, 0.0060, 'fx', 40, 60], ['Climber', 28, 0.0042, 'spark', NaN, 60],
      // shooter: 1 runs hot, 2 runs warm, 3 reboots, 4 drops off CAN, 5 sits on its current limit
      ['Turret', 30, 0.010, 'fx', 30, 40], ['Hood', 29, 0.006, 'fx', 20, 30], ['Kicker', 31, 0.020, 'fx', 40, 60], ['Indexer', 30, 0.012, 'spark', NaN, 40],
      ['Shooter1', 46, 0.205, 'fx', 50, 60], ['Shooter2', 44, 0.16, 'fx', 50, 60], ['Shooter3', 33, 0.03, 'fx', 50, 60], ['Shooter4', 32, 0.03, 'fx', 50, 60], ['Shooter5', 31, 0.03, 'fx', 50, 60],
    ];
    const FX_FAULTS = ['Hardware', 'ProcTemp', 'DeviceTemp', 'Undervoltage', 'BootDuringEnable', 'BridgeBrownout', 'OverSupplyV', 'UnstableSupplyV', 'StatorCurrLimit', 'SupplyCurrLimit', 'RemoteSensorDataInvalid', 'FusedSensorOutOfSync', 'UnlicensedFeatureInUse'];
    const SPARK_FAULTS = ['Other', 'MotorType', 'Sensor', 'CAN', 'Temperature', 'GateDriver', 'ESCEeprom', 'Firmware', 'Brownout', 'Overcurrent', 'ESCEepromWarning', 'ExtEeprom', 'SensorWarning', 'Stall', 'HasReset', 'OtherWarning'];
    const REBOOT = [139.4, 139.55];     // Shooter3 loses power for a moment, then reports BootDuringEnable
    const S4_OFF = [139.8, 142.8];      // Shooter4 drops off the CAN bus
    const S5_LIM = [139.9, 141.4];      // Shooter5 held at its stator current limit
    const JAM = [133.0, 134.0];         // game piece jams in the intake
    const M = motorDefs.map(([name, t0, k, type, supLim, staLim], i) => {
      const p = 'Motors/' + name + '/';
      if (isFinite(supLim)) W.double(W.start(p + 'SupplyLimitA', 'double', meta('A')), us(0.5), supLim);
      if (isFinite(staLim)) W.double(W.start(p + 'StatorLimitA', 'double', meta('A')), us(0.5), staLim);
      const CAN_IDS = { Turret: 26, Hood: 27, Kicker: 28, Indexer: 41, DriveFL: 1, SteerFL: 2, DriveFR: 3, SteerFR: 4, DriveBR: 5, SteerBR: 6, DriveBL: 7, SteerBL: 8, Intake: 42, Arm: 31, Climber: 32, Shooter1: 22, Shooter2: 23, Shooter3: 24, Shooter4: 25, Shooter5: 21 };
      W.int64(W.start(p + 'CANId', 'int64'), us(0.5), CAN_IDS[name] ?? 50 + i);
      W.string(W.start(p + 'Controller', 'string'), us(0.5), type === 'fx' ? 'TalonFX' : 'SPARK MAX');
      W.string(W.start(p + 'CANBus', 'string'), us(0.5), /^(Drive|Steer)/.test(name) ? 'Drivetrain' : 'rio');
      const fnames = type === 'fx' ? FX_FAULTS : SPARK_FAULTS;
      const fids = Object.fromEntries(fnames.map(f => [f, W.start(p + 'Faults/' + f, 'boolean')]));
      return { name, ch: i, T: t0, k, I: 0, type, supLim, staLim, fids, fstate: {}, ids: {
        temp: W.start(p + 'TempC', 'double', meta('degC')), sup: W.start(p + 'SupplyCurrentA', 'double', meta('A')),
        sta: W.start(p + 'StatorCurrentA', 'double', meta('A')), bus: W.start(p + 'BusVoltageV', 'double', meta('V')),
        duty: W.start(p + 'DutyCycle', 'double', meta('fraction')), vel: W.start(p + 'VelocityRPM', 'double', meta('rpm')),
        con: W.start(p + 'Connected', 'boolean') } };
    });
    const mech = n => ({ pos: W.start(`Mechanisms/${n}/Position`, 'double', meta(n === 'Arm' ? 'deg' : 'm')), set: W.start(`Mechanisms/${n}/Setpoint`, 'double', meta(n === 'Arm' ? 'deg' : 'm')) });
    const ARM = mech('Arm'), CLIMB = mech('Climber');
    const TUR = { pos: W.start('Mechanisms/Turret/Position', 'double', meta('deg')), set: W.start('Mechanisms/Turret/Setpoint', 'double', meta('deg')) };
    const HOOD = { pos: W.start('Mechanisms/Hood/Position', 'double', meta('deg')), set: W.start('Mechanisms/Hood/Setpoint', 'double', meta('deg')) };
    let tur = 0, hood = 20;

    // field path (blue alliance, meters). Speaker ~ (1.4, 5.5), source ~ (15.2, 1.0)
    const auto = path([[22, 1.35, 5.55, 180], [24.6, 2.9, 7.0, 200], [26.2, 1.75, 5.7, 180], [28.9, 2.9, 5.55, 180], [30.4, 1.75, 5.5, 180], [33.0, 2.9, 4.1, 160], [34.6, 1.8, 5.3, 180], [37, 1.8, 5.3, 180]]);
    const tw = [[40, 1.8, 5.3, 180]];
    let t = 41;
    for (let c = 0; c < 6; c++) {
      tw.push([t + 3.0, 6.5, 6.4, 90], [t + 6.4, 13.6, 2.2, 330], [t + 7.6, 15.0, 1.15, 300], [t + 9.0, 14.6, 1.6, 300], [t + 12.6, 8.5, 6.2, 200], [t + 15.6, 2.4, 5.6, 180], [t + 16.8, 2.3, 5.5, 180]);
      t += 17;
      if (c === 5) break;
    }
    // defense battle at midfield, then climb
    tw.push([146.5, 8.6, 4.3, 0], [147.0, 8.65, 4.3, 0], [153.5, 8.75, 4.28, 0], [158.5, 4.9, 4.1, 120], [160, 4.85, 4.1, 120], [175, 4.85, 4.1, 120]);
    const tele = path(tw);
    const wheelRpmPerMps = 60 * 6.75 / (Math.PI * 0.1016);

    let prev = [1.35, 5.55, Math.PI], prevV = 0, prevH = Math.PI, arm = 10, climb = 0.02, txf = 0, rxe = 0, txe = 0;
    let Ah = 0, lastLoop = 0, overrunNext = 52, pdhT = 31, brownUntil = -1, lastVis = 0, lastTemp = -1;
    let enPrev = null, auPrev = null, dsPrev = null, boPrev = null;

    const set = (id, tt, v, last, kind = 'bool') => { if (v !== last) (kind === 'bool' ? W.bool(id, us(tt), v) : W.double(id, us(tt), v)); return v; };

    for (let tt = 0.5; tt <= T_END; tt += DT) {
      const dsUp = tt > 2.1 && !(tt >= DROP[0] && tt < DROP[1]);
      const enabled = dsUp && ((tt >= AUTO[0] && tt < AUTO[1]) || (tt >= TELE[0] && tt < TELE[1]));
      const isAuto = tt >= AUTO[0] && tt < AUTO[1];
      if (dsPrev === null) { W.bool(E.ds, us(tt), false); W.bool(E.fms, us(tt), false); W.bool(E.test, us(tt), false); }
      dsPrev = set(E.ds, tt, dsUp, dsPrev);
      if (Math.abs(tt - 3.0) < DT / 2) {
        W.bool(E.fms, us(tt), true); W.string(E.ev, us(tt), 'NCCMP'); W.double(E.mn, us(tt), 42); W.double(E.mt, us(tt), 2); W.bool(E.red, us(tt), false);
        W.string(E.msg, us(tt), 'FMS connected: NCCMP Qualification 42');
      }
      enPrev = set(E.en, tt, enabled, enPrev);
      auPrev = set(E.au, tt, isAuto, auPrev);
      if (Math.abs(tt - DROP[0]) < DT / 2) W.string(E.msg, us(tt), 'Driver Station disconnected');
      if (Math.abs(tt - DROP[1]) < DT / 2) W.string(E.msg, us(tt), 'Driver Station connected');

      // pose
      const tp = tt < AUTO[1] ? auto(Math.max(tt, AUTO[0])) : tele(clamp(tt, TELE[0], TELE[1]));
      if (!enabled && !(tt >= DROP[0] && tt < DROP[1])) { tp[0] = prev[0]; tp[1] = prev[1]; tp[2] = prev[2]; }
      const v = Math.hypot(tp[0] - prev[0], tp[1] - prev[1]) / DT;
      const a = clamp((v - prevV) / DT, -9, 9);
      let dh = tp[2] - prevH; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const omega = dh / DT;
      prev = tp; prevV = v; prevH = tp[2];
      pose2d(E.pose, tt, tp[0], tp[1], tp[2]);
      if (enabled && tt - lastVis > 0.2 && (tp[0] < 5.5 || tp[0] > 11.5) && R() < 0.7) {
        lastVis = tt; pose2d(E.vis, tt, tp[0] + (R() - 0.5) * 0.09, tp[1] + (R() - 0.5) * 0.09, tp[2] + (R() - 0.5) * 0.03);
      }

      // what the subsystems are doing
      const pushing = enabled && tt > 147 && tt < 153.5;
      const nearSource = Math.hypot(tp[0] - 15.0, tp[1] - 1.15) < 2.2;
      const nearSpeaker = Math.hypot(tp[0] - 1.4, tp[1] - 5.5) < 3.4 && tt < 146;
      const climbing = enabled && tt > 160;
      const armSet = !enabled ? arm : climbing ? 92 : nearSpeaker ? 47 : nearSource ? -4 : 12;
      arm += (armSet - arm) * (1 - Math.exp(-DT / 0.16));
      const climbSet = !climbing ? 0.02 : tt < 165 ? 0.56 : 0.12;
      climb += clamp(climbSet - climb, -0.25 * DT, 0.25 * DT);

      const browned = tt < brownUntil;
      const cut = enabled && !browned ? 1 : 0;
      const vmax = 4.6;
      const driveDuty = clamp(v / vmax + (pushing ? 0.55 : 0), 0, 1) * cut;
      const driveStator = cut * (pushing ? 74 + R() * 10 : 6 + 32 * Math.abs(a) / 4 + 10 * v / vmax) + R() * 1.5;
      const cmd = {
        drive: [driveStator, driveDuty, v * wheelRpmPerMps],
        steer: [cut * (2.5 + 1.8 * Math.abs(omega) + (R() < 0.04 ? 9 * R() : 0)), cut * clamp(0.1 + Math.abs(omega) / 6, 0, 1), omega * 60 / (2 * Math.PI) * 21.4],
        Intake: [cut * (nearSource ? 28 + (R() < 0.08 ? 22 : 0) : 0), cut * (nearSource ? 0.85 : 0), cut * (nearSource ? 9800 : 0)],
        Shooter: [cut * (nearSpeaker ? (tt % 17 > 13.4 && tt % 17 < 13.9 ? 62 : 17) + R() * 3 : 9 + R()), cut * (nearSpeaker ? 0.78 : 0.3), cut * (nearSpeaker ? 4700 : 1800)],
        Arm: [cut * (6 + Math.abs(armSet - arm) * 0.9 + 4 * Math.cos(arm * Math.PI / 180)), cut * clamp(Math.abs(armSet - arm) / 40 + 0.08, 0, 1), (armSet - arm) / 0.16 / 6 * 100],
        Turret: [cut * (3 + Math.abs(omega) * 6), cut * 0.12, 0], Hood: [cut * 2.5, cut * 0.05, 0],
        Kicker: [cut * (nearSpeaker ? 24 : 2), cut * (nearSpeaker ? 0.7 : 0.05), cut * (nearSpeaker ? 5200 : 300)],
        Indexer: [cut * (nearSource || nearSpeaker ? 14 : 1), cut * (nearSource || nearSpeaker ? 0.6 : 0), cut * (nearSource || nearSpeaker ? 3100 : 0)],
        Climber: [climbing ? (tt > 165 ? 52 + R() * 6 : 14) * cut : 0, climbing ? (tt > 165 ? 0.95 : 0.6) * cut : 0, climbing ? (tt > 165 ? -2100 : 3600) * cut : 0],
      };

      // electrical
      let total = 3.2 + R() * 0.4; // radio, controller, sensors
      const chan = new Array(24).fill(0);
      for (const m of M) {
        const c = m.name.startsWith('Drive') ? cmd.drive : m.name.startsWith('Steer') ? cmd.steer : m.name.startsWith('Shooter') ? cmd.Shooter : cmd[m.name];
        let sta = c[0] * ({ DriveFL: 1.08, DriveFR: 1.03, DriveBL: 0.96, DriveBR: 0.99 }[m.name] || 1) * (1 + (R() - 0.5) * 0.04);
        m.duty = c[1]; m.vel = c[2] * (1 + (R() - 0.5) * 0.01);
        m.stall = false;
        if (m.name === 'Intake' && cut && tt >= JAM[0] && tt < JAM[1]) { sta = 55; m.duty = 0.85; m.vel = 0; m.stall = true; }
        if (m.name === 'Shooter5' && cut && tt >= S5_LIM[0] && tt < S5_LIM[1]) { sta = 70; m.duty = 0.9; }
        const rebooting = m.name === 'Shooter3' && tt >= REBOOT[0] && tt < REBOOT[1];
        if (rebooting) { sta = 0; m.duty = 0; }
        m.staLimited = sta > m.staLim; if (m.staLimited) sta = m.staLim;
        let sup = Math.abs(m.duty) * sta + (sta > 0 ? 0.25 : 0);
        m.supLimited = sup > m.supLim; if (m.supLimited) sup = m.supLim;
        m.I = sta; m.sup = sup;
        total += m.sup; chan[m.ch] = m.sup;
      }
      chan[20] = 1.6; chan[21] = 0.9;
      const Rint = 0.018, Voc = 12.82 - 0.085 * Ah;
      let V = Voc - Rint * total + (R() - 0.5) * 0.04;
      if (pushing && Math.abs(tt - BROWN) < DT / 2 && !browned) { V = 6.62; brownUntil = tt + 0.16; W.string(E.msg, us(tt), 'Brownout detected: motor outputs disabled'); }
      Ah += total * DT / 3600;
      const boNow = tt < brownUntil;
      W.double(E.bat, us(tt), V); W.double(E.cur, us(tt), total); W.double(E.pw, us(tt), V * total); W.doubles(E.ch, us(tt), chan);
      boPrev = set(E.bo, tt, boNow, boPrev);

      const logTemp = tt - lastTemp >= 0.2;
      if (logTemp) { lastTemp = tt; pdhT += (31 + total * 0.04 - pdhT) * 0.002; W.double(E.pdhT, us(tt), pdhT); }

      // CAN + loop
      W.double(E.can, us(tt), clamp(0.6 + 0.06 * Math.sin(tt / 7) + (R() - 0.5) * 0.05, 0, 1));
      if (R() < 0.002) { txf++; W.double(E.txf, us(tt), txf); }
      if (Math.abs(tt - CAN_DROP[0]) < DT / 2) { rxe += 3; txe += 5; W.double(E.rxe, us(tt), rxe); W.double(E.txe, us(tt), txe); }
      let lt = 20 + (R() - 0.5) * 1.2;
      if (enabled && tt > overrunNext) { lt = 27 + R() * 18; overrunNext = tt + 9 + R() * 12; }
      if (lastLoop) W.double(E.loop, us(tt), lt);
      lastLoop = tt;

      for (const m of M) {
        // first-order thermal model: heating from I^2, cooling toward 27 °C
        m.T += (m.k * m.I * m.I * 0.011 - (m.T - 27) / 420) * DT;
        const online = !(m.name === 'Intake' && tt >= CAN_DROP[0] && tt < CAN_DROP[1]) && !(m.name === 'Shooter4' && tt >= S4_OFF[0] && tt < S4_OFF[1]);
        if (m.online !== online) { W.bool(m.ids.con, us(tt), online); m.online = online; }
        const rebootOff = m.name === 'Shooter3' && tt >= REBOOT[0] && tt < REBOOT[1];
        if (m.name === 'Shooter3' && m.online2 !== !rebootOff) { W.bool(m.ids.con, us(tt), !rebootOff); m.online2 = !rebootOff; }
        if (!online || rebootOff) continue;
        const fl = m.type === 'fx'
          ? { Undervoltage: boNow, BridgeBrownout: boNow && m.name.startsWith('Drive'), SupplyCurrLimit: m.supLimited, StatorCurrLimit: m.staLimited,
              BootDuringEnable: m.name === 'Shooter3' && tt >= REBOOT[1] && tt < REBOOT[1] + 3.0 }
          : { Brownout: boNow, Stall: m.stall, HasReset: m.name === 'Intake' && tt >= CAN_DROP[1] && tt < CAN_DROP[1] + 3.0 };
        for (const f in m.fids) { const v = !!fl[f]; if (m.fstate[f] !== v) { W.bool(m.fids[f], us(tt), v); m.fstate[f] = v; } }
        W.double(m.ids.sup, us(tt), m.sup); W.double(m.ids.sta, us(tt), m.I);
        W.double(m.ids.bus, us(tt), V - 0.05 - m.sup * 0.004); W.double(m.ids.duty, us(tt), m.duty);
        W.double(m.ids.vel, us(tt), m.vel);
        if (logTemp) W.double(m.ids.temp, us(tt), Math.round(m.T * 2) / 2);
      }
      W.double(ARM.pos, us(tt), arm + (R() - 0.5) * 0.2); W.double(ARM.set, us(tt), armSet);
      W.double(CLIMB.pos, us(tt), climb); W.double(CLIMB.set, us(tt), climbSet);
      // turret aims at the speaker (robot-relative), hood follows distance
      let aim = Math.atan2(5.5 - tp[1], 1.4 - tp[0]) - tp[2]; aim = Math.atan2(Math.sin(aim), Math.cos(aim)) * 180 / Math.PI;
      const turSet = clamp(aim, -170, 170);
      tur += (turSet - tur) * (1 - Math.exp(-DT / 0.12));
      W.double(TUR.pos, us(tt), tur); W.double(TUR.set, us(tt), turSet);
      const hoodSet = clamp(18 + 4.5 * Math.hypot(tp[0] - 1.4, tp[1] - 5.5), 18, 48);
      hood += (hoodSet - hood) * (1 - Math.exp(-DT / 0.1));
      W.double(HOOD.pos, us(tt), hood); W.double(HOOD.set, us(tt), hoodSet);
      const mtime = isAuto && enabled ? AUTO[1] - tt : enabled ? TELE[1] - tt : -1;
      W.double(E.mtime, us(tt), Math.round(mtime * 10) / 10);
      for (const j of JS) {
        const on = dsUp && !(j === JS[1] && tt >= JS1_OFF[0] && tt < JS1_OFF[1]);
        if (j.last !== on) { W.bool(j.con, us(tt), on); W.string(j.name, us(tt), on ? (j === JS[0] ? 'Xbox Controller' : 'Controller (Xbox One For Windows)') : ''); j.last = on; }
      }
      CAMS.forEach((c, k) => {
        const on = !(k === 1 && tt >= CAM_OFF[0] && tt < CAM_OFF[1]);
        if (c.last !== on) { W.bool(c.con, us(tt), on); c.last = on; }
        if (!on) return;
        const seesTags = k === 0 ? (tp[0] < 5.8 || (tp[0] > 13 && tp[1] < 2.5)) : (tp[0] > 11.2 || (tp[0] < 3 && tp[1] > 6));
        W.double(c.tags, us(tt), seesTags ? (R() < 0.5 ? 2 : 1) : 0);
        const lag = k === 1 && tt >= CAM_LAG[0] && tt < CAM_LAG[1];
        W.double(c.lat, us(tt), lag ? 210 + R() * 40 : 24 + R() * 10);
        W.double(c.fps, us(tt), lag ? 9 : 30 + (R() - 0.5) * 2);
      });
    }
    return W.result();
  }
  return { generate, fileName: 'FRC_20260411_183207_NCCMP_Q42.wpilog' };
})();
if (typeof module !== 'undefined') module.exports = Sample;
