package frc.robot.telemetry;

import com.revrobotics.REVLibError;
import com.revrobotics.RelativeEncoder;
import com.revrobotics.spark.SparkBase;

/**
 * REV SPARK MAX / SPARK Flex (NEO, NEO Vortex, NEO 550).
 *
 * <p>The SPARK reports output (stator) current only. Supply current is estimated as
 * |duty cycle| x stator current, which is exact for an ideal PWM bridge and reads a few percent
 * low in practice because it ignores controller losses.
 *
 * <p>Velocity is whatever units the encoder conversion factor gives (rpm if you never set one).
 *
 * <p>Faults and warnings are both logged. REV calls things like stall, overcurrent and "has reset"
 * warnings; the viewer treats each flag by name, so the distinction is kept in the name.
 * Written against the REVLib 2025/2026 Java API, where getFaults()/getWarnings() return the
 * Faults/Warnings objects directly.
 */
public final class SparkSource implements Telemetry.MotorSource {
  private static final String[] FAULT_NAMES = {
    // faults
    "Other", "MotorType", "Sensor", "CAN", "Temperature", "GateDriver", "ESCEeprom", "Firmware",
    // warnings
    "Brownout", "Overcurrent", "ESCEepromWarning", "ExtEeprom", "SensorWarning", "Stall",
    "HasReset", "OtherWarning",
  };

  private final SparkBase spark;
  private final RelativeEncoder encoder;
  private final boolean[] flags = new boolean[FAULT_NAMES.length];
  private double temp, stator, bus, duty, vel;

  public SparkSource(SparkBase spark) {
    this.spark = spark;
    this.encoder = spark.getEncoder();
  }

  @Override
  public boolean refresh() {
    // These read the periodic status-frame cache; none of them block on CAN.
    temp = spark.getMotorTemperature();
    stator = spark.getOutputCurrent();
    bus = spark.getBusVoltage();
    duty = spark.getAppliedOutput();
    vel = encoder.getVelocity();

    SparkBase.Faults f = spark.getFaults();
    SparkBase.Warnings w = spark.getWarnings();
    flags[0] = f.other; flags[1] = f.motorType; flags[2] = f.sensor; flags[3] = f.can;
    flags[4] = f.temperature; flags[5] = f.gateDriver; flags[6] = f.escEeprom; flags[7] = f.firmware;
    flags[8] = w.brownout; flags[9] = w.overcurrent; flags[10] = w.escEeprom; flags[11] = w.extEeprom;
    flags[12] = w.sensor; flags[13] = w.stall; flags[14] = w.hasReset; flags[15] = w.other;

    // Best available "is it alive" signal in REVLib. Verify on the bench by unplugging CAN.
    return spark.getLastError() == REVLibError.kOk;
  }

  @Override public double tempC() { return temp; }
  @Override public double supplyCurrentA() { return Math.abs(duty) * stator; }
  @Override public double statorCurrentA() { return stator; }
  @Override public double busVoltageV() { return bus; }
  @Override public double dutyCycle() { return duty; }
  @Override public double velocityRPM() { return vel; }
  @Override public String[] faultNames() { return FAULT_NAMES; }
  @Override public boolean fault(int i) { return flags[i]; }
}
