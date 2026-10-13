package frc.robot.telemetry;

import com.ctre.phoenix6.BaseStatusSignal;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.hardware.TalonFX;
import edu.wpi.first.units.measure.AngularVelocity;
import edu.wpi.first.units.measure.Current;
import edu.wpi.first.units.measure.Temperature;
import edu.wpi.first.units.measure.Voltage;
import java.util.List;

/** Phoenix 6 TalonFX (Kraken X60/X44, Falcon 500). */
public final class TalonFXSource implements Telemetry.MotorSource {
  // Live (non-sticky) faults that mean something went wrong or the motor was being limited.
  // Limit switches and soft limits are left out: hitting those is normal operation.
  private static final String[] FAULT_NAMES = {
    "Hardware", "ProcTemp", "DeviceTemp", "Undervoltage", "BootDuringEnable", "BridgeBrownout",
    "OverSupplyV", "UnstableSupplyV", "StatorCurrLimit", "SupplyCurrLimit",
    "RemoteSensorDataInvalid", "FusedSensorOutOfSync", "UnlicensedFeatureInUse",
  };

  private final StatusSignal<Temperature> temp;
  private final StatusSignal<Current> supply, stator;
  private final StatusSignal<Voltage> bus;
  private final StatusSignal<Double> duty;
  private final StatusSignal<AngularVelocity> vel;
  private final List<StatusSignal<Boolean>> faults;
  private final BaseStatusSignal[] all;

  public TalonFXSource(TalonFX motor) {
    temp = motor.getDeviceTemp();
    supply = motor.getSupplyCurrent();
    stator = motor.getStatorCurrent();
    bus = motor.getSupplyVoltage();
    duty = motor.getDutyCycle();
    vel = motor.getVelocity();
    faults =
        List.of(
            motor.getFault_Hardware(), motor.getFault_ProcTemp(), motor.getFault_DeviceTemp(),
            motor.getFault_Undervoltage(), motor.getFault_BootDuringEnable(),
            motor.getFault_BridgeBrownout(), motor.getFault_OverSupplyV(),
            motor.getFault_UnstableSupplyV(), motor.getFault_StatorCurrLimit(),
            motor.getFault_SupplyCurrLimit(), motor.getFault_RemoteSensorDataInvalid(),
            motor.getFault_FusedSensorOutOfSync(), motor.getFault_UnlicensedFeatureInUse());

    BaseStatusSignal[] base = {temp, supply, stator, bus, duty, vel};
    all = new BaseStatusSignal[base.length + faults.size()];
    System.arraycopy(base, 0, all, 0, base.length);
    for (int i = 0; i < faults.size(); i++) all[base.length + i] = faults.get(i);

    // Only raises rates; if you call optimizeBusUtilization() do it BEFORE constructing this.
    BaseStatusSignal.setUpdateFrequency(50, supply, stator, bus, duty, vel);
    temp.setUpdateFrequency(4);
    // 10 Hz catches current-limit events longer than ~0.1 s. The viewer also derives
    // "at limit" from the 50 Hz current data, so short events still show up there.
    BaseStatusSignal.setUpdateFrequency(10, faults.toArray(new BaseStatusSignal[0]));
  }

  @Override
  public boolean refresh() {
    // Non-blocking: grabs whatever frames have already arrived.
    return BaseStatusSignal.refreshAll(all).isOK();
  }

  @Override public double tempC() { return temp.getValueAsDouble(); }
  @Override public double supplyCurrentA() { return supply.getValueAsDouble(); }
  @Override public double statorCurrentA() { return stator.getValueAsDouble(); }
  @Override public double busVoltageV() { return bus.getValueAsDouble(); }
  @Override public double dutyCycle() { return duty.getValueAsDouble(); }
  @Override public double velocityRPM() { return vel.getValueAsDouble() * 60.0; } // rot/s -> rpm
  @Override public String[] faultNames() { return FAULT_NAMES; }
  @Override public boolean fault(int i) { return faults.get(i).getValue(); }
}
