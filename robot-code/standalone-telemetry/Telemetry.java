package frc.robot.telemetry;

import edu.wpi.first.math.geometry.Pose2d;
import edu.wpi.first.util.datalog.BooleanLogEntry;
import edu.wpi.first.util.datalog.DataLog;
import edu.wpi.first.util.datalog.DoubleArrayLogEntry;
import edu.wpi.first.util.datalog.DoubleLogEntry;
import edu.wpi.first.util.datalog.StructLogEntry;
import edu.wpi.first.wpilibj.DataLogManager;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.PowerDistribution;
import edu.wpi.first.wpilibj.PowerDistribution.ModuleType;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.Timer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;

/**
 * On-robot telemetry for the 7763 log viewer.
 *
 * <p>Writes straight to the WPILib DataLog (.wpilog) — not NetworkTables — so logging costs no
 * radio bandwidth and works with no laptop attached. DataLogManager saves to a USB stick in a
 * "logs" folder if one is plugged into the controller, otherwise to the controller's own storage.
 *
 * <p>Key convention (the viewer depends on these exact names):
 *
 * <pre>
 *   Robot/Pose                         struct:Pose2d  (m, m, rad)
 *   Robot/Pose/&lt;name&gt;                  struct:Pose2d  (vision estimates, path targets...)
 *   Mechanisms/&lt;name&gt;/Position         double, unit in metadata
 *   Mechanisms/&lt;name&gt;/Setpoint         double, unit in metadata
 *   Motors/&lt;name&gt;/TempC                double  °C
 *   Motors/&lt;name&gt;/SupplyCurrentA       double  A   (battery side)
 *   Motors/&lt;name&gt;/StatorCurrentA       double  A   (motor side)
 *   Motors/&lt;name&gt;/BusVoltageV          double  V
 *   Motors/&lt;name&gt;/DutyCycle            double  -1..1
 *   Motors/&lt;name&gt;/VelocityRPM          double  rpm
 *   Motors/&lt;name&gt;/Connected            boolean
 *   Motors/&lt;name&gt;/Faults/&lt;Flag&gt;       boolean   (controller's own fault/warning flags)
 *   Motors/&lt;name&gt;/SupplyLimitA         double  A, logged once (configured limit, optional)
 *   Motors/&lt;name&gt;/StatorLimitA         double  A, logged once (configured limit, optional)
 *   Power/BatteryV, Power/TotalCurrentA, Power/TotalPowerW, Power/PDHTempC
 *   Power/ChannelCurrentsA             double[]  (index = PDH channel)
 *   System/BrownedOut, System/CANBusUtilization, System/CANTxFullCount,
 *   System/CANRxErrorCount, System/CANTxErrorCount, System/LoopTimeMs
 *   DS:enabled, DS:autonomous, DS:fms, DS:ds ...  (written by DriverStation.startDataLog)
 * </pre>
 *
 * <p>Usage, in Robot.java:
 *
 * <pre>
 *   robotInit():      Telemetry.start();
 *                     Telemetry.registerMotor("DriveFL", new TalonFXSource(driveFL), 60, 90); // supply, stator limit A
 *                     Telemetry.registerMotor("Intake", new SparkSource(intakeSpark));
 *                     Telemetry.registerMechanism("Arm", "deg", arm::getAngleDeg, arm::getGoalDeg);
 *                     Telemetry.registerPose("Robot/Pose", drive::getPose);
 *   robotPeriodic():  Telemetry.update();   // call LAST, after CommandScheduler.run()
 * </pre>
 */
public final class Telemetry {
  private Telemetry() {}

  /** One motor controller. Adapters: {@link TalonFXSource}, {@link SparkSource}. */
  public interface MotorSource {
    /** Pull the newest cached values. Return false if the device did not answer. */
    boolean refresh();

    double tempC();

    double supplyCurrentA();

    double statorCurrentA();

    double busVoltageV();

    double dutyCycle();

    double velocityRPM();

    /** Names of the fault flags this controller reports. Fixed for the life of the source. */
    default String[] faultNames() {
      return new String[0];
    }

    /** State of fault flag i (index into faultNames()) as of the last refresh(). */
    default boolean fault(int i) {
      return false;
    }
  }

  // Temperature changes slowly; logging it every loop just bloats the file.
  private static final int TEMP_DECIMATION = 10; // 50 Hz loop -> 5 Hz temperature

  private static DataLog log;
  private static PowerDistribution pdh;
  private static final List<Motor> motors = new ArrayList<>();
  private static final List<Mechanism> mechanisms = new ArrayList<>();
  private static final Map<String, PoseChannel> poses = new HashMap<>();
  private static long loopCount = 0;
  private static double lastLoopStart = Double.NaN;

  private static DoubleLogEntry batteryV, totalCurrent, totalPower, pdhTemp, loopTime;
  private static DoubleLogEntry canUtil, canTxFull, canRxErr, canTxErr;
  private static DoubleArrayLogEntry channelCurrents;
  private static BooleanLogEntry brownedOut;

  /** Start logging. pdhCanId = 1 is the REV PDH default. */
  public static void start() {
    start(1, ModuleType.kRev);
  }

  public static void start(int pdhCanId, ModuleType type) {
    DataLogManager.start();
    log = DataLogManager.getLog();
    // DS control words (enabled/auto/test/estop/fms/ds attached). Joysticks off to save space.
    DriverStation.startDataLog(log, false);

    pdh = new PowerDistribution(pdhCanId, type);

    batteryV = dbl("Power/BatteryV", "V");
    totalCurrent = dbl("Power/TotalCurrentA", "A");
    totalPower = dbl("Power/TotalPowerW", "W");
    pdhTemp = dbl("Power/PDHTempC", "degC");
    channelCurrents = new DoubleArrayLogEntry(log, "Power/ChannelCurrentsA", meta("A"));

    brownedOut = new BooleanLogEntry(log, "System/BrownedOut");
    canUtil = dbl("System/CANBusUtilization", "raw");
    canTxFull = dbl("System/CANTxFullCount", "count");
    canRxErr = dbl("System/CANRxErrorCount", "count");
    canTxErr = dbl("System/CANTxErrorCount", "count");
    loopTime = dbl("System/LoopTimeMs", "ms");
  }

  public static void registerMotor(String name, MotorSource source) {
    registerMotor(name, source, Double.NaN, Double.NaN);
  }

  /**
   * Same, plus the current limits you configured on this controller, so the viewer can show when
   * the motor is running at its limit. Pass Double.NaN for a limit you don't use. The values are
   * logged once; they are not read back from the device.
   */
  public static void registerMotor(
      String name, MotorSource source, double supplyLimitA, double statorLimitA) {
    requireStarted();
    motors.add(new Motor(name, source));
    if (!Double.isNaN(supplyLimitA)) dbl("Motors/" + name + "/SupplyLimitA", "A").append(supplyLimitA);
    if (!Double.isNaN(statorLimitA)) dbl("Motors/" + name + "/StatorLimitA", "A").append(statorLimitA);
  }

  /** setpoint may be null if the mechanism has no closed-loop goal. */
  public static void registerMechanism(
      String name, String unit, DoubleSupplier position, DoubleSupplier setpoint) {
    requireStarted();
    mechanisms.add(new Mechanism(name, unit, position, setpoint));
  }

  /** key is "Robot/Pose" for the main odometry pose, "Robot/Pose/<name>" for anything else. */
  public static void registerPose(String key, Supplier<Pose2d> pose) {
    requireStarted();
    poses.put(key, new PoseChannel(StructLogEntry.create(log, key, Pose2d.struct), pose));
  }

  /** One-off pose (e.g. each accepted vision measurement). */
  public static void logPose(String key, Pose2d pose) {
    requireStarted();
    poses
        .computeIfAbsent(key, k -> new PoseChannel(StructLogEntry.create(log, k, Pose2d.struct), null))
        .entry
        .append(pose);
  }

  /** Call once per loop from robotPeriodic(). */
  public static void update() {
    if (log == null) return;
    double now = Timer.getFPGATimestamp();
    if (!Double.isNaN(lastLoopStart)) loopTime.append((now - lastLoopStart) * 1000.0);
    lastLoopStart = now;
    boolean logTemp = (loopCount++ % TEMP_DECIMATION) == 0;

    // update() only writes a record when the value changed, append() always writes.
    double v = pdh.getVoltage();
    double i = pdh.getTotalCurrent();
    batteryV.append(v);
    totalCurrent.append(i);
    totalPower.append(v * i);
    channelCurrents.append(pdh.getAllCurrents());
    if (logTemp) pdhTemp.update(pdh.getTemperature());

    brownedOut.update(RobotController.isBrownedOut());
    var can = RobotController.getCANStatus();
    canUtil.append(can.percentBusUtilization);
    canTxFull.update(can.txFullCount);
    canRxErr.update(can.receiveErrorCount);
    canTxErr.update(can.transmitErrorCount);

    for (Motor m : motors) m.log(logTemp);
    for (Mechanism m : mechanisms) m.log();
    for (PoseChannel p : poses.values()) if (p.supplier != null) p.entry.append(p.supplier.get());
  }

  // ---------------------------------------------------------------------------------------------

  private static final class Motor {
    final MotorSource src;
    final DoubleLogEntry temp, supply, stator, bus, duty, vel;
    final BooleanLogEntry connected;
    final BooleanLogEntry[] faults;

    Motor(String name, MotorSource src) {
      this.src = src;
      String p = "Motors/" + name + "/";
      temp = dbl(p + "TempC", "degC");
      supply = dbl(p + "SupplyCurrentA", "A");
      stator = dbl(p + "StatorCurrentA", "A");
      bus = dbl(p + "BusVoltageV", "V");
      duty = dbl(p + "DutyCycle", "fraction");
      vel = dbl(p + "VelocityRPM", "rpm");
      connected = new BooleanLogEntry(log, p + "Connected");
      String[] names = src.faultNames();
      faults = new BooleanLogEntry[names.length];
      for (int i = 0; i < names.length; i++) faults[i] = new BooleanLogEntry(log, p + "Faults/" + names[i]);
    }

    void log(boolean logTemp) {
      boolean ok = src.refresh();
      connected.update(ok);
      if (!ok) return; // don't write stale values as if they were fresh
      supply.append(src.supplyCurrentA());
      stator.append(src.statorCurrentA());
      bus.append(src.busVoltageV());
      duty.append(src.dutyCycle());
      vel.append(src.velocityRPM());
      if (logTemp) temp.update(src.tempC());
      // update() writes only when a flag changes, so fault logging costs almost nothing
      for (int i = 0; i < faults.length; i++) faults[i].update(src.fault(i));
    }
  }

  private static final class Mechanism {
    final DoubleSupplier position, setpoint;
    final DoubleLogEntry posEntry, setEntry;

    Mechanism(String name, String unit, DoubleSupplier position, DoubleSupplier setpoint) {
      this.position = position;
      this.setpoint = setpoint;
      posEntry = dbl("Mechanisms/" + name + "/Position", unit);
      setEntry = setpoint == null ? null : dbl("Mechanisms/" + name + "/Setpoint", unit);
    }

    void log() {
      posEntry.append(position.getAsDouble());
      if (setEntry != null) setEntry.update(setpoint.getAsDouble());
    }
  }

  private record PoseChannel(StructLogEntry<Pose2d> entry, Supplier<Pose2d> supplier) {}

  private static DoubleLogEntry dbl(String key, String unit) {
    return new DoubleLogEntry(log, key, meta(unit));
  }

  private static String meta(String unit) {
    return "{\"unit\":\"" + unit + "\"}";
  }

  private static void requireStarted() {
    if (log == null) throw new IllegalStateException("Call Telemetry.start() first");
  }
}
