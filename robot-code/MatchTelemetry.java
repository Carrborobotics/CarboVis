package frc.robot.subsystems;

import dev.doglog.DogLog;
import edu.wpi.first.wpilibj.DriverStation;

/**
 * Extra keys for the 7763 Match Logs app's Match view: match time, controller connections and camera health.
 * Everything goes through DogLog, so it reaches both the .wpilog and NetworkTables (live view).
 *
 * <pre>
 *   DS/MatchTime                         seconds left in the current period (-1 when unknown)
 *   DS/Joystick0/Connected, Name         driver controller (USB port 0)
 *   DS/Joystick1/Connected, Name         operator controller (USB port 1)
 *   Vision/&lt;cam&gt;/Connected               camera is talking to the robot
 *   Vision/&lt;cam&gt;/TagCount                AprilTags used in the latest result (0 = none in view)
 *   Vision/&lt;cam&gt;/LatencyMs, FPS          optional: shown red when latency is high or FPS is low
 *   Vision/&lt;cam&gt;/Faults/&lt;flag&gt;          optional: any true flag shows the camera red
 * </pre>
 *
 * Match view colors: green = connected and seeing a tag, yellow = connected with no tag, red = fault,
 * blinking red = not connected. Name cameras after where they sit ("FrontLeft", "BackRight") and the
 * match view places them on the drive base by itself.
 *
 * <p>Usage, in Robot.robotPeriodic() after MotorTelemetry.update():
 *
 * <pre>
 *   MatchTelemetry.update();
 *   // PhotonVision (one call per camera, PhotonCamera frontLeft = new PhotonCamera("FrontLeft")):
 *   //   var r = frontLeft.getLatestResult();
 *   //   MatchTelemetry.camera("FrontLeft", frontLeft.isConnected(), r.getTargets().size(),
 *   //       r.metadata.getLatencyMillis(), Double.NaN);
 *   // Limelight (LimelightHelpers): connected when the heartbeat ("hb") keeps changing; the match view
 *   //   also reads limelight-name/tv, tl and hb straight from NetworkTables, so nothing is required here.
 * </pre>
 */
public final class MatchTelemetry {
    private MatchTelemetry() {}

    private static final int CONTROLLER_PORTS = 2; // driver + operator; raise it to watch more ports

    /** Call once per loop from robotPeriodic. */
    public static void update() {
        DogLog.log("DS/MatchTime", DriverStation.getMatchTime(), "s");
        for (int port = 0; port < CONTROLLER_PORTS; port++) {
            boolean connected = DriverStation.isJoystickConnected(port);
            DogLog.log("DS/Joystick" + port + "/Connected", connected);
            DogLog.log("DS/Joystick" + port + "/Name", connected ? DriverStation.getJoystickName(port) : "");
        }
    }

    /**
     * Log one camera's health. Call every loop for each camera.
     *
     * @param name      camera name, e.g. "FrontLeft"
     * @param connected whether the camera/coprocessor is reachable
     * @param tagCount  AprilTags in the latest result (0 when none)
     * @param latencyMs pipeline latency, or Double.NaN if unknown
     * @param fps       frames per second, or Double.NaN if unknown
     */
    public static void camera(String name, boolean connected, int tagCount, double latencyMs, double fps) {
        String key = "Vision/" + name + "/";
        DogLog.log(key + "Connected", connected);
        DogLog.log(key + "TagCount", connected ? tagCount : 0);
        if (!Double.isNaN(latencyMs)) DogLog.log(key + "LatencyMs", latencyMs, "ms");
        if (!Double.isNaN(fps)) DogLog.log(key + "FPS", fps);
    }

    /** Raise or clear a named camera fault (for example "PoseRejected" or "Overheating"). */
    public static void cameraFault(String name, String fault, boolean active) {
        DogLog.log("Vision/" + name + "/Faults/" + fault, active);
    }
}
