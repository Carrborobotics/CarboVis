"""Fake robot: a real WPILib NT4 server (ntcore) publishing DogLog-style keys, for testing live mode and
the match view without hardware.

    pip install pyntcore robotpy-wpimath
    python tools/fake_robot_nt.py [seconds]

Then in the app: Match view (or Live) -> Simulation (127.0.0.1) -> Connect.

Every 30 s it cycles through problems so each status color shows up:
  5-7 s    operator controller unplugged         (blinking red controller icon)
  9-11 s   back camera latency spike             (red camera)
  12-16 s  back camera disconnected              (blinking red camera)
  20-23 s  intake roller drops off the CAN bus   (blinking red motor)
  24-27 s  kicker reports BootDuringEnable       (red motor)
  flywheel heats up over the run                 (yellow, then red)
"""
import math, sys, time
import ntcore
from wpimath.geometry import Pose2d, Rotation2d

inst = ntcore.NetworkTableInstance.getDefault()
inst.startServer(listen_address="127.0.0.1", port3=0, port4=5810)
keep = []  # publishers must stay alive


def dbl(name, unit=None):
    t = inst.getDoubleTopic("/Robot/" + name)
    p = t.publish()
    if unit:
        t.setProperty("unit", f'"{unit}"')
    return p


def boo(name):
    return inst.getBooleanTopic("/Robot/" + name).publish()


def string(name):
    return inst.getStringTopic("/Robot/" + name).publish()


ctrl = inst.getIntegerTopic("/FMSInfo/FMSControlData").publish()
event = inst.getStringTopic("/FMSInfo/EventName").publish()
red = inst.getBooleanTopic("/FMSInfo/IsRedAlliance").publish()
pose = inst.getStructTopic("/Robot/Drive/Pose", Pose2d).publish()
bat = dbl("SystemStats/BatteryVoltage", "volts")
cur = dbl("SystemStats/PowerDistribution/TotalCurrent", "amps")
brown = boo("SystemStats/BrownedOut")
canu = dbl("SystemStats/CANBus/Utilization")
loop_ms = dbl("System/LoopTimeMs", "ms")
match_time = dbl("DS/MatchTime", "s")
mech = {n: (dbl(f"Mechanisms/{n}/Position", u), dbl(f"Mechanisms/{n}/Setpoint", u)) for n, u in [("Turret", "deg"), ("Hood", "deg"), ("Rack", "rot")]}
joy = [(boo(f"DS/Joystick{p}/Connected"), string(f"DS/Joystick{p}/Name")) for p in (0, 1)]
cams = {n: dict(con=boo(f"Vision/{n}/Connected"), tags=dbl(f"Vision/{n}/TagCount"), lat=dbl(f"Vision/{n}/LatencyMs", "ms"), fps=dbl(f"Vision/{n}/FPS"))
        for n in ("FrontLeft", "BackRight")}

DRIVE = [(f"{m} {k}", cid, "Drivetrain") for m, base in (("FL", 1), ("FR", 3), ("BR", 5), ("BL", 7)) for k, cid in (("drive", base), ("steer", base + 1))]
MOTORS = DRIVE + [("Turret", 21, "rio"), ("Flywheel", 22, "rio"), ("Flywheel follower", 23, "rio"), ("Hood", 24, "rio"),
                  ("Kicker", 25, "rio"), ("Roller", 31, "rio"), ("Rack", 32, "rio"), ("Indexer", 33, "rio")]
M = {}
for name, cid, bus in MOTORS:
    p = "Motors/" + name + "/"
    M[name] = dict(
        temp=dbl(p + "TempC", "degC"), sup=dbl(p + "SupplyCurrentA", "A"), sta=dbl(p + "StatorCurrentA", "A"), vel=dbl(p + "VelocityRPM", "rpm"),
        con=boo(p + "Connected"), boot=boo(p + "Faults/BootDuringEnable"), lim=boo(p + "Faults/StatorCurrLimit"),
    )
    pubs = [inst.getIntegerTopic("/Robot/" + p + "CANId").publish(), string(p + "Controller"), string(p + "CANBus")]
    pubs[0].set(cid); pubs[1].set("TalonFX"); pubs[2].set(bus)
    keep += pubs

event.set("TESTING")
red.set(False)
dur = float(sys.argv[1]) if len(sys.argv) > 1 else 120
t0 = time.time()
while time.time() - t0 < dur:
    t = time.time() - t0
    c = t % 30
    enabled = t > 2
    auto = 2 < t < 22
    ctrl.set((0x01 if enabled else 0) | 0x20 | (0x02 if auto else 0))
    match_time.set(max(0.0, 22 - t) if auto else max(0.0, 162 - t) if enabled else -1)
    x = 3 + 2 * math.cos(t / 4); y = 4 + 1.5 * math.sin(t / 4); hdg = t / 4 + math.pi / 2
    pose.set(Pose2d(x, y, Rotation2d(hdg)))
    load = 60 + 40 * max(0, math.sin(t))
    bat.set(12.6 - 0.02 * load); cur.set(load); brown.set(False); canu.set(0.55 + 0.05 * math.sin(t)); loop_ms.set(20 + math.sin(t * 3))
    aim = math.degrees(math.atan2(5.5 - y, 1.4 - x) - hdg)
    aim = (aim + 180) % 360 - 180
    mech["Turret"][1].set(aim); mech["Turret"][0].set(aim - 3 * math.sin(t))
    mech["Hood"][1].set(30 + 10 * math.sin(t / 5)); mech["Hood"][0].set(30 + 10 * math.sin((t - 0.2) / 5))
    rack = 6.0 if math.sin(t / 3) > 0 else 0.2
    mech["Rack"][1].set(rack); mech["Rack"][0].set(rack * (0.9 + 0.1 * math.sin(t)))
    for p, (con, nm) in enumerate(joy):
        on = not (p == 1 and 5 < c < 7)
        con.set(on); nm.set(("Xbox Controller" if p == 0 else "Controller (Xbox One For Windows)") if on else "")
    for n, cam in cams.items():
        back = n == "BackRight"
        on = not (back and 12 < c < 16)
        cam["con"].set(on)
        if on:
            cam["tags"].set(2 if (x < 3.2) != back else 0)
            lag = back and 9 < c < 11
            cam["lat"].set(220 if lag else 28 + 4 * math.sin(t)); cam["fps"].set(8 if lag else 30)
    for i, (name, cid, bus) in enumerate(MOTORS):
        m = M[name]
        temp = 32 + (i % 5) * 3 + t * (0.35 if name == "Flywheel" else 0.15 if name == "Flywheel follower" else 0.02)
        sta = 20 + 10 * math.sin(t + i)
        online = not (name == "Roller" and 20 < c < 23)
        m["con"].set(online)
        if not online:
            continue
        m["temp"].set(round(temp * 2) / 2)
        m["sta"].set(sta); m["sup"].set(sta * 0.6)
        m["vel"].set(4800 + 30 * math.sin(t) if name.startswith("Flywheel") else 3000 if name in ("Roller", "Indexer") else 2000 * math.sin(t / 4))
        m["boot"].set(name == "Kicker" and 24 < c < 27)
        m["lim"].set(name == "Flywheel follower" and math.sin(t * 2) > 0.9)
    time.sleep(0.02)
