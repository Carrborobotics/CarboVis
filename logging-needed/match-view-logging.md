# What the robot needs to log for the match view

The robot code doesn't log these yet. This file lists exactly what CarboVis's match view (the live viewer)
reads, so it can be handed to Claude with a prompt like:

> Add the logging in `logging-needed/match-view-logging.md` to our robot code. Use DogLog. Keep the key
> names, types, units and sign conventions exactly as written.

Everything goes through **DogLog** (`DogLog.log(key, value)`), which writes the `.wpilog` and publishes to
NetworkTables for the live view. DogLog puts keys under `/Robot/`; the app strips that prefix, so the keys
below are written without it. Log everything **every loop** (from `robotPeriodic`) unless it says otherwise.

Coordinate conventions (WPILib standard): **x = forward, y = left, angles in degrees, counter-clockwise
positive (left of center is positive).**

---

## 1. Cameras: where they're mounted and which AprilTags they see (new)

`<cam>` is the camera's name, e.g. `FrontLeft`, `BackRight`. Use the same name for all of a camera's keys.

| Key | Type | What it is |
|---|---|---|
| `Vision/<cam>/RobotToCamera` | `double[6]` | Camera mount: `{x m, y m, z m, roll°, pitch°, yaw°}`, robot center to camera. The same `Transform3d` the pose estimator uses. Yaw 0 = facing forward, 90 = facing left. Logging it once at startup is enough, but every loop is fine. |
| `Vision/<cam>/TagIds` | `long[]` (or `int[]` / `double[]`) | IDs of the AprilTags in the latest result. |
| `Vision/<cam>/TagYawDeg` | `double[]` | For each tag, the horizontal angle from the camera's center line to the tag, in degrees. **Positive = tag is to the LEFT.** |
| `Vision/<cam>/TagDistanceM` | `double[]` | For each tag, the flat (floor-plane) distance from the camera to the tag, in meters. |

Rules:
- The three tag arrays are the same length and in the same order (element `i` of each is the same tag).
- When the camera sees no tags, log **empty arrays**, not nothing. The match view hides a camera's tags if
  these keys stop updating for 2 s.
- If there's no new result this loop, log the arrays from the latest result again.

How to compute them:
- **PhotonVision:** for each target in the latest `PhotonPipelineResult`, take
  `Transform3d t = target.getBestCameraToTarget()` (x forward, y left):
  - `TagIds[i] = target.getFiducialId()`
  - `TagYawDeg[i] = Math.toDegrees(Math.atan2(t.getY(), t.getX()))`
  - `TagDistanceM[i] = Math.hypot(t.getX(), t.getY())`
  - Don't use `target.getYaw()` directly: PhotonVision's yaw is positive to the right, so it would be
    mirrored. If you do use it, log `-target.getYaw()`.
- **Limelight** (`LimelightHelpers.getRawFiducials(name)`): `TagIds[i] = f.id`,
  `TagYawDeg[i] = -f.txnc` (txnc is positive to the right), `TagDistanceM[i] = f.distToCamera`.
- `RobotToCamera` from the mount `Transform3d m`:
  `{m.getX(), m.getY(), m.getZ(), Math.toDegrees(m.getRotation().getX()), Math.toDegrees(m.getRotation().getY()), Math.toDegrees(m.getRotation().getZ())}`

## 2. Camera health (shows each camera green/yellow/red)

Already written in `robot-code/MatchTelemetry.java` (`MatchTelemetry.camera(...)`), but not yet called from
the robot code.

| Key | Type | What it is |
|---|---|---|
| `Vision/<cam>/Connected` | `boolean` | Camera/coprocessor is reachable (`PhotonCamera.isConnected()`). |
| `Vision/<cam>/TagCount` | `double` | Number of tags in the latest result (0 = none). |
| `Vision/<cam>/LatencyMs` | `double` | Pipeline latency in ms (optional). |
| `Vision/<cam>/FPS` | `double` | Frames per second (optional). |
| `Vision/<cam>/Faults/<flag>` | `boolean` | Any named camera problem, true while active (optional). |

## 3. Swerve drive

| Key | Type | What it is |
|---|---|---|
| `Drive/ModuleAngles` | `double[4]` | Each module's wheel angle relative to the robot, in degrees, CCW positive, 0 = wheel pointing forward. Order: **front-left, front-right, back-left, back-right.** From `module.getState().angle.getDegrees()`. |
| `Drive/Pose` | `Pose2d` (struct) | Robot pose from the pose estimator. The match view uses it for heading and speed. |

## 4. Match, controllers and power

`DS/*` is already written in `robot-code/MatchTelemetry.java` (`MatchTelemetry.update()`), but not called
yet. The power and CAN keys are DogLog's built-in extras.

| Key | Type | What it is |
|---|---|---|
| `DS/MatchTime` | `double` | `DriverStation.getMatchTime()`, seconds left in the period. |
| `DS/Joystick0/Connected`, `DS/Joystick1/Connected` | `boolean` | Driver (port 0) and operator (port 1) controllers plugged in. |
| `DS/Joystick0/Name`, `DS/Joystick1/Name` | `string` | Controller name, or `""` when unplugged. |
| `SystemStats/...` | (DogLog) | Turn on DogLog's extras: `DogLog.setOptions(new DogLogOptions().withCaptureDs(true).withLogExtras(true))` and `DogLog.setPdh(new PowerDistribution())`. That gives battery voltage, total current, brownouts, CAN utilization and errors, and the DS enabled/auto/teleop state. |
| `System/LoopTimeMs` | `double` | Robot loop time in ms. |

## 5. Motors and mechanisms

Already written in `robot-code/MotorTelemetry.java` and `robot-code/robot-telemetry.patch` (the `claude`
branch of 7763-Code-2026). Those still need to be merged into the robot code.

| Key | Type | What it is |
|---|---|---|
| `Motors/<name>/TempC, SupplyCurrentA, StatorCurrentA, BusVoltageV, DutyCycle, VelocityRPM` | `double` | Per-motor health. |
| `Motors/<name>/Connected` | `boolean` | Motor is on the CAN bus. |
| `Motors/<name>/Faults/<flag>` | `boolean` | Controller fault flags. |
| `Motors/<name>/CANId, CANBus, Controller, SupplyLimitA, StatorLimitA` | `long` / `string` / `double` | Motor identity and current limits (once at startup is enough). |
| `Mechanisms/Turret/Position`, `Setpoint` | `double` (deg) | Turret angle and goal. |
| `Mechanisms/Hood/Position`, `Setpoint` | `double` | Hood position and goal. |
| `Mechanisms/Rack/Position`, `Setpoint` | `double` (rot) | Intake extension and goal. |

Motor names should include where they are (e.g. `DriveFL`, `SteerBR`, `Turret`, `Flywheel1`, `Kicker`,
`Intake`, `Indexer1`) so the match view can assign them by itself.

---

## Checking it worked

Deploy, open CarboVis, connect live (or open the match's `.wpilog`) and go to the match view:
- Each camera sits on the bumper where its `RobotToCamera` puts it, facing the right way (Setup will say
  "Auto (logged RobotToCamera)").
- Hold a tag in front of a camera: a tag marker with its ID and distance shows up on that side. Move it left
  and the marker moves left. If it moves the wrong way, the yaw sign is flipped.
- Turn the wheels: each module in the drawing turns the same way as the real one.
