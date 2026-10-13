7763 Match Logs - driver station app
====================================

INSTALL (each laptop, once; run it again to update)
  1. Unzip this folder anywhere.
  2. Double-click "Install 7763 Match Logs.cmd".
     It copies the app to %LOCALAPPDATA%\FRC7763MatchLogs and adds a
     "7763 Match Logs" shortcut to the Desktop and Start menu.
  No admin rights and no internet needed. It runs in its own window using the
  Edge (or Chrome) that's already on the laptop.

LIVE VIEW
  Connect the laptop to the robot (radio, ethernet or USB), deploy the robot
  code, then click "Live" in the top bar and Connect.
    Robot (radio/ethernet): 10.77.63.2      USB tether: 172.22.11.2
    Robot simulation on this laptop: 127.0.0.1
  It only reads NetworkTables (port 5810). It never sends anything to the robot.

MATCH VIEW (for the driver station during a match)
  Double-click "7763 Match View". It opens full width, above the FRC Driver
  Station, and connects to the robot on its own. Or press M (or "Match view")
  in the normal app. Esc goes back.
    Top bar: match phase and time, robot comms, DS, FMS, driver and operator
    controllers, both cameras, CAN, and battery.
    Middle: drive base (with both cameras), shooter/turret, intake/indexer.
    Right: power, CAN bus, and every fault that is active right now.
  Colors: green = OK, yellow = needs attention (warm, at a current limit,
  camera sees no tag), red = fault, blinking red = not connected at all.
  Motors and cameras are matched by name; "Setup" in the match view changes
  any of it and the space left for the Driver Station (230 px by default).

SIMULATED MATCH (no robot needed)
  In the match view footer or the Live panel, click "Simulated match". A
  made-up robot plays a full match inside the app, and each mechanism faults
  at a different time. The footer says what breaks next. Use it to practice
  reading the match view or to show it off.

LOG FILES
  Robot logs (.wpilog) are written by DogLog to the USB stick in the roboRIO
  (logs folder), or /home/lvuser/logs on the roboRIO when there's no stick.
  Click "Open .wpilog" or drag a file onto the window.

3D VIEW
  Robot 3D tab -> "Add CAD files". Use an Onshape .glb export, an
  AdvantageScope robot folder (model.glb + config.json), or .stl files.
  The setup is saved on this laptop; "Export setup" moves it to another one.
