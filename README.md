# CarboVis — 7763 Match Logs

Match log viewer and live robot view for FRC 7763. Opens `.wpilog` files from the robot, connects live to
the robot over NetworkTables, and shows motor health, faults, power, the field path, mechanisms and a 3D
robot model, all keyed by CAN ID.

## Folders

| Folder | What's in it |
|---|---|
| `app/` | The driver station app. Double-click `Install 7763 Match Logs.cmd` on each laptop (no admin, no internet). See `app/README.txt`. |
| `robot-code/` | The robot-side telemetry: `MotorTelemetry.java`, `MatchTelemetry.java` (match view: match time, controllers, cameras) and `robot-telemetry.patch` (the changes made on the `claude` branch of 7763-Code-2026), plus `standalone-telemetry/` for projects that don't use DogLog. |
| `logging-needed/` | What the robot code still has to log for the match view (camera mounts, AprilTags seen, module angles, ...), written to hand straight to Claude. |
| `source/` | Source for the app. Edit here and rebuild. |
| `tools/` | `fake_robot_nt.py` (a fake robot for testing live mode without hardware) and a sample `.wpilog`. |

## Rebuilding the app after editing `source/`

Needs Python 3.

```
cd source
python build_desktop.py     # -> app/FRC7763-Match-Logs.html (offline driver station app)
python build_web.py         # -> source/index.html (the claude.ai version; no document wrapper)
```

Then run the installer again on each laptop to update it.

`source/vendor.js` is three.js 0.170.0 + @msgpack/msgpack bundled for offline use. To rebuild it (only
needed when upgrading those libraries): `cd source/vendor && npm install && npm run build`.

| File | Role |
|---|---|
| `page.html` | Markup and styles |
| `core.js` | `.wpilog` reader/writer, struct decoding, match analysis, fault detection |
| `nt4.js` | NetworkTables 4.1 client (read-only, WebSocket on port 5810) |
| `live.js` | Turns live NetworkTables values into the same data model as a log file |
| `fakematch.js` | Simulated match: a made-up robot running in the page (Live / Match view → "Simulated match"), with scripted faults on each mechanism |
| `matchview.js` | Match view: full-window live status above the Driver Station (mechanisms, cameras, controllers, faults) |
| `robot3d.js` | 3D robot: CAD import (.glb/.gltf/.stl, AdvantageScope folders), joints, motor tinting |
| `mechviz.js` | Shooter picture and hand-traced motor outlines |
| `sample.js` | Generates the sample match shown on first open |
| `app.js` | UI: every tab |

## Keys the app looks for

DogLog writes everything under `/Robot/`; the app strips that prefix, so these are the names after it.

| Key | Used for |
|---|---|
| `Motors/<name>/TempC, SupplyCurrentA, StatorCurrentA, BusVoltageV, DutyCycle, VelocityRPM, Connected` | Motors tab, report, mechanism and 3D coloring |
| `Motors/<name>/Faults/<flag>` | Faults tab (controller fault flags) |
| `Motors/<name>/CANId, CANBus, Controller, SupplyLimitA, StatorLimitA` | CAN IDs and current-limit lines |
| `Mechanisms/<name>/Position, Setpoint` | Mechanisms tab, 3D joints |
| `Drive/Pose` (or `Robot/Pose`) — `Pose2d` struct | Field tab |
| `SystemStats/...` (DogLog extras + `DogLog.setPdh`) | Battery, total current, brownouts, PDH channels, CAN load |
| `System/LoopTimeMs` | Loop overruns |
| `DS:*` (DogLog `withCaptureDs`) / `FMSInfo/FMSControlData` (live) | Auto / teleop / disabled phases |
| `DS/MatchTime`, `DS/Joystick<N>/Connected`, `DS/Joystick<N>/Name` | Match view: match timer, driver/operator controller icons (`robot-code/MatchTelemetry.java`) |
| `Vision/<cam>/Connected, TagCount, LatencyMs, FPS, Faults/<flag>` | Match view cameras. PhotonVision (`photonvision/<cam>/...`) and Limelight (`limelight-<name>/tv, tl, hb`) tables also work |
| `Drive/ModuleAngles` (`double[4]`, degrees, FL FR BL BR) | Optional: match view turns the swerve wheels |

## Testing live mode without a robot

Quickest: in the app, Match view (or Live) → **Simulated match**. It runs a fake robot inside the page through a
full match (4 s pre-match, 20 s auto, 140 s teleop, then the next match), with faults at set times:

| Match time | What breaks |
|---|---|
| 12–15 s | Back camera latency spike (red) |
| 38–41 s | BL drive off CAN (blinking) |
| 52–56 s | Flywheel follower at its stator limit (yellow) |
| 66–73 s | Intake roller off CAN, then reboots |
| 84–89 s | Front camera disconnected (blinking) |
| 97–100 s | Hood CANcoder invalid (red) |
| 102–106 s | Kicker off CAN, then reboots |
| 110–114 s | Indexer jam at its current limit (yellow) |
| 122–125 s | Operator controller unplugged |
| 131 s | Brownout |
| 136 s on | Turret overheats (yellow, then red) |
| 150–151.5 s | Driver Station link drops |

The match view footer shows what breaks next. From the browser console, `FakeMatch.last.mt = 60` jumps the clock.

Against a real NetworkTables server instead:

```
pip install pyntcore robotpy-wpimath
python tools/fake_robot_nt.py 120
```

Then in the app: Live → Simulation (127.0.0.1) → Connect. Robot simulation from WPILib (Simulate Robot
Code) works the same way.
