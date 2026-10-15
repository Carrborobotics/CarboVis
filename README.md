# CarboVis — 7763 Match Logs

Match log viewer and live robot view for FRC 7763. Opens `.wpilog` files from the robot, connects live to
the robot over NetworkTables, and shows motor health, faults, power, the field path, mechanisms and a 3D
robot model, all keyed by CAN ID.

## Getting it

| Where | How | Updates |
|---|---|---|
| **Windows** (driver station, pit laptops) | Download `CarboVis-Setup-x.y.z.exe` from [the latest release](https://github.com/Carrborobotics/CarboVis/releases/latest) and run it. No admin rights needed. Windows may say "Windows protected your PC" because the installer isn't code-signed: click **More info → Run anyway**. | Automatic. New versions download in the background and install the next time CarboVis closes (or click **Restart to update**). |
| **Phones, Macs, Chromebooks, any browser** | <https://carrborobotics.github.io/CarboVis/>. On a phone, Share → **Add to Home Screen** installs it like an app. | Automatic, on the next visit. |

The installer adds **CarboVis** and **CarboVis Match View** (opens straight into the match view, sized to sit above
the FRC Driver Station) to the Desktop and Start menu, opens `.wpilog` files on double-click, and removes the
shortcuts from the old `install.ps1` installer. Saved robot setup from the old version doesn't carry over: use
**Export setup** in the old version and import it in CarboVis.

## Using it at the robot

- **Live view.** Connect the laptop to the robot (radio, ethernet or USB), deploy the robot code, then **Live** →
  Connect. Robot (radio/ethernet) `10.77.63.2`, USB tether `172.22.11.2`, robot simulation on this laptop
  `127.0.0.1`. It only reads NetworkTables (port 5810); it never sends anything to the robot.
- **Match view** (for the driver station during a match). Double-click **CarboVis Match View**, or press **M** in
  the app; Esc goes back. Top bar: match phase and time, robot comms, DS, FMS, controllers, cameras, CAN, battery.
  Middle: field (robot, path, turret aim), drive base, shooter/turret, intake/hopper (intake rollers, roller floor,
  the rack's two motors, kicker). Right: power, CAN bus and every active fault. Green = OK, yellow = needs attention,
  red = fault, blinking red = not connected. Anything not connected at all (robot comms, a controller, a camera, a
  motor) also flashes up as a big alert across the top. The layout follows the match: before it, the comms,
  controllers, cameras and battery are big tiles with a READY / NOT READY call; in auto the field leads; in teleop
  the shooter and hopper do. On a short screen the field becomes a mini-map. **Setup** in the match view changes the
  motor/camera mapping and the space left for the Driver Station (230 px by default).
- **Picking a match.** CarboVis opens on the newest match in the library. The match menu at the top (and in the
  match view's footer) lists recent matches and the two demo matches; **All logs…** opens the library.
- **Robot logs.** DogLog writes `.wpilog` files to the USB stick in the roboRIO (`logs` folder), or
  `/home/lvuser/logs` without a stick. Open one, drop it on the window, or Logs → **Import**; it's kept in the
  library and uploaded like a recording.
- **3D view.** Robot 3D tab → **Add CAD files** (Onshape `.glb`, an AdvantageScope robot folder, or `.stl`). The setup
  is saved on that computer; **Export setup** moves it to another one.

## How logs move between computers

```
 robot ──NT4──▶ driver station laptop (CarboVis)
                 │ records every match to Documents\CarboVis Logs
                 │ uploads each finished log when it has internet
                 ▼
          team library: the `logs` branch of this repo (Carrborobotics/CarboVis)
                 │   logs/<name>.wpilog.gz + index.json (match summaries)
                 ▼
     any computer or phone: CarboVis app or web version → Logs → Team
```

- **Recording (driver station).** While CarboVis is connected to the robot (Live or Match view) it writes
  everything the robot publishes to a `.wpilog`, using the robot's own clock and DogLog's names, so it opens like
  a robot log. One file per match (closes 3 s after teleop ends, named `FRC_<UTC time>_<EVENT>_<Q42>_DS.wpilog` from
  the FMS info) or per run off the field (closes 30 s after the robot is disabled). A comms drop keeps the same file;
  a robot reboot starts a new one; time connected without ever enabling is thrown away. Logs → Settings changes the
  mode (each enable / real matches only / everything / off). Recordings left open by a crash are recovered on the next
  start.
- **Uploading.** Each new log (recorded, opened or imported) is queued for the team library and uploaded when the
  laptop is online: retried every minute and when the network comes back, so it's fine to have no internet at the
  field. **Logs → This computer → Upload** does it by hand.
- **Team library.** The `logs` branch of this repo holds gzipped logs and an `index.json` of match summaries (these
  also fill the History tab). The branch has no history in common with the code, so uploads never add commits to
  `main` or start the Pages/release workflows. The repo is public, so viewing needs nothing; uploading needs a token,
  entered once per uploading laptop.
- **Nearby, no internet.** Logs → Settings → **Share on this network** serves the laptop's logs read-only on port
  5807 with a QR code for phones on the same Wi-Fi or switch. Other CarboVis computers on the network list it under
  **Nearby** automatically (UDP broadcast on 5808). Keep it off while the laptop is on the field network.

### One-time setup of the team library

1. Make a [fine-grained token](https://github.com/settings/personal-access-tokens/new): resource owner
   Carrborobotics, only the `CarboVis` repo, permission **Contents: Read and write**. (An org owner may have to
   approve it.)
2. On the driver station: CarboVis → Logs → Settings → paste the token → **Save and test**. It's stored encrypted
   for that Windows user. The first upload creates the `logs` branch.

That token can also push code and tags to this repo, and a pushed `v*` tag ships an update to every laptop. To keep
a lost or borrowed driver station laptop from doing that, add a ruleset (Settings → Rules) that restricts updates to
`main` and creation of `v*` tags, and make the token from an account that can't bypass it.

Each log is gzipped (about 2× smaller). GitHub caps a file at 100 MB, and a repo is happiest under a few GB, so
delete old practice logs from Logs → Team now and then. The logs branch is fetched by a plain `git clone`; to get just
the code, use `git clone --single-branch https://github.com/Carrborobotics/CarboVis.git`. Settings can point the
library at a different repo or branch.

## Releasing a new version

```
git tag v1.2.0
git push origin v1.2.0
```

`.github/workflows/release.yml` builds the Windows installer and publishes the release; installed copies update
themselves. Every push to `main` that touches `source/` also redeploys the web version
(`.github/workflows/pages.yml`; one-time setup: repo Settings → Pages → Source: **GitHub Actions**).

## Folders

| Folder | What's in it |
|---|---|
| `source/` | The app itself (one page, shared by the desktop app, the web version and claude.ai). Edit here. |
| `desktop/` | The Windows app: Electron shell (`main.js`, `preload.js`), installer and auto-update settings (`package.json`). |
| `robot-code/` | The robot-side telemetry: `MotorTelemetry.java`, `MatchTelemetry.java` (match view: match time, controllers, cameras) and `robot-telemetry.patch` (the changes made on the `claude` branch of 7763-Code-2026), plus `standalone-telemetry/` for projects that don't use DogLog. |
| `logging-needed/` | What the robot code still has to log for the match view (camera mounts, AprilTags seen, module angles, ...), written to hand straight to Claude. |
| `tools/` | `fake_robot_nt.py` (a fake robot for testing live mode without hardware) and a sample `.wpilog`. |

## Building

Needs Python 3 and Node.js.

```
python source/build.py          # -> desktop/web/ (the page + web-app files; also what GitHub Pages serves)
cd desktop
npm install
npm start                       # build the page and run the desktop app
npm run dist                    # build a Windows installer into desktop/dist/ (no publishing)
python ../source/build_web.py   # -> source/index.html (the claude.ai version; no document wrapper)
```

`source/vendor.js` is three.js 0.170.0 + @msgpack/msgpack bundled for offline use. To rebuild it (only
needed when upgrading those libraries): `cd source/vendor && npm install && npm run build`.

| File | Role |
|---|---|
| `page.html` | Markup and styles |
| `core.js` | `.wpilog` reader/writer, struct decoding, match analysis, fault detection |
| `nt4.js` | NetworkTables 4.1 client (read-only, WebSocket on port 5810) |
| `live.js` | Turns live NetworkTables values into the same data model as a log file |
| `recorder.js` | Driver station recording: encodes live NetworkTables values into a `.wpilog` as they arrive |
| `library.js` | Logs: this computer's folder, the team's GitHub library, nearby computers; recording and upload rules |
| `fakematch.js` | The made-up robot: live "Simulated match", and the two demo matches (recorded with `recorder.js`) |
| `matchview.js` | Match view: full-window live status above the Driver Station (mechanisms, cameras, controllers, faults) |
| `robot3d.js` | 3D robot: CAD import (.glb/.gltf/.stl, AdvantageScope folders), joints, motor tinting |
| `mechviz.js` | Shooter picture and hand-traced motor outlines |
| `sample.js` | Rough field layout (AprilTags) and camera mounts for the made-up robot |
| `app.js` | UI: every tab |
| `build.py` / `build_web.py` | Builds: app + web version / claude.ai version |
| `icons/` | Web-app icons (the desktop icon is `desktop/build/icon.ico`) |

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
| `DS/MatchTime`, `DS/Joystick<N>/Connected`, `DS/Joystick<N>/Name` | Match view: match timer, driver/operator controller icons (`robot-code/MatchTelemetry.java`; no operator controller → untick it in match view Setup) |
| `Vision/<cam>/Connected, TagCount, LatencyMs, FPS, Faults/<flag>` | Match view cameras. PhotonVision (`photonvision/<cam>/...`) and Limelight (`limelight-<name>/tv, tl, hb`) tables also work |
| `Drive/ModuleAngles` (`double[4]`, degrees, FL FR BL BR) | Optional: match view turns the swerve wheels |

## Testing live mode without a robot

Quickest: pick a demo from the match menu (top of the app, or the match view's footer):
- **Demo: clean match** (Q58): a tidy match where everything stays green.
- **Demo: everything breaks** (E4): things go wrong a few at a time, then the robot loses power. The match view
  plays it from the start.

Both are recorded by the same code the driver station uses (`source/fakematch.js` → `source/recorder.js`), so they
open like any recording. To watch the same failures arrive live: Match view (or Live) → **Simulated match**, which
runs that robot inside the page through a full match (8 s pre-match, 20 s auto, 140 s teleop, then the next one):

| Match time | What breaks |
|---|---|
| −7 to −2.5 s | Operator controller unplugged before the match (pre-match shows NOT READY) |
| 5–9 s | Back camera latency spike + hood CANcoder invalid |
| 12–17 s | Front camera offline + FL steer off CAN |
| 30–38 s | Intake rollers off CAN (then reboot) + roller floor jammed |
| 44–48 s | BL drive off CAN + flywheel follower at its current limit |
| 51–57 s | Kicker off CAN, then reboots |
| 60–62.5 s | Radio drops: no robot comms |
| 68–73 s | Driver controller unplugged + rack right off CAN |
| 78 s on | Turret overheats (yellow, then red) |
| 86–90 s | Both cameras offline |
| 96 s | Brownout while pushing |
| 100–101.8 s | Radio drops again |
| 106–110 s | Intake rollers stall + rack left at its current limit |
| 116–119.5 s | Battery connector working loose: voltage collapses, motors drop out |
| 119.5–139 s | Robot loses power and reboots (no comms) |
| 139–143 s | Robot back: every controller reports a reboot |
| 150–154 s | Operator controller unplugged + back camera offline |

The match view footer shows what breaks next. From the browser console, `FakeMatch.last.mt = 60` jumps the clock.

Against a real NetworkTables server instead:

```
pip install pyntcore robotpy-wpimath
python tools/fake_robot_nt.py 120
```

Then in the app: Live → Simulation (127.0.0.1) → Connect. Robot simulation from WPILib (Simulate Robot
Code) works the same way. Robot code in simulation has no cameras, so on 127.0.0.1 the app ignores any camera data it publishes
and works out what each camera would see from the robot's pose instead (match view Setup → Cameras turns this off).
