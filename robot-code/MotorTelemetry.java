package frc.robot.subsystems;

import java.util.ArrayList;
import java.util.List;

import com.ctre.phoenix6.BaseStatusSignal;
import com.ctre.phoenix6.CANBus;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.configs.TalonFXConfiguration;
import com.ctre.phoenix6.hardware.TalonFX;

import dev.doglog.DogLog;

/**
 * Per-motor health telemetry for the 7763 Match Logs app (log files and the live view).
 *
 * <p>Every TalonFX made by {@link Talons#create} registers itself here (CtreSwerve registers its own).
 * Each loop {@link #update()} logs, through DogLog (so it reaches both the .wpilog and NetworkTables):
 *
 * <pre>
 *   Motors/&lt;name&gt;/TempC, SupplyCurrentA, StatorCurrentA, BusVoltageV, DutyCycle, VelocityRPM, Connected
 *   Motors/&lt;name&gt;/Faults/&lt;flag&gt;       live (non-sticky) fault flags, refreshed at 10 Hz
 *   Motors/&lt;name&gt;/CANId, CANBus, Controller, SupplyLimitA, StatorLimitA   logged once
 * </pre>
 *
 * The app finds motors by these names, so keep the "Motors/" layout. Nothing here changes a status
 * signal's update rate: it reads whatever the motors already send.
 */
public final class MotorTelemetry {
    private MotorTelemetry() {}

    /** Problems and "being limited" flags. Limit switches / soft limits are left out (normal operation). */
    private static final String[] FAULT_NAMES = {
        "Hardware", "ProcTemp", "DeviceTemp", "Undervoltage", "BootDuringEnable", "BridgeBrownout",
        "OverSupplyV", "UnstableSupplyV", "StatorCurrLimit", "SupplyCurrLimit", "RemoteSensorDataInvalid",
        "UnlicensedFeatureInUse",
    };
    private static final int FAULT_EVERY_N_LOOPS = 5; // 50 Hz loop -> faults at 10 Hz

    private static final class Motor {
        final String key;
        final TalonFX motor;
        final StatusSignal<?> temp, supply, stator, bus, duty, rotorVel;
        final BaseStatusSignal[] fast;
        final List<StatusSignal<Boolean>> faults;
        final BaseStatusSignal[] faultArray;
        final int canId;
        final String canBus;
        final double supplyLimitA, statorLimitA;
        boolean staticLogged = false;

        Motor(String name, int canId, CANBus bus, TalonFX motor, double supplyLimitA, double statorLimitA) {
            this.key = "Motors/" + name + "/";
            this.motor = motor;
            this.canId = canId;
            this.canBus = bus == null ? "" : bus.getName();
            this.supplyLimitA = supplyLimitA;
            this.statorLimitA = statorLimitA;
            temp = motor.getDeviceTemp();
            supply = motor.getSupplyCurrent();
            stator = motor.getStatorCurrent();
            this.bus = motor.getSupplyVoltage();
            duty = motor.getDutyCycle();
            rotorVel = motor.getRotorVelocity();
            fast = new BaseStatusSignal[] {temp, supply, stator, this.bus, duty, rotorVel};
            faults = List.of(
                    motor.getFault_Hardware(), motor.getFault_ProcTemp(), motor.getFault_DeviceTemp(),
                    motor.getFault_Undervoltage(), motor.getFault_BootDuringEnable(), motor.getFault_BridgeBrownout(),
                    motor.getFault_OverSupplyV(), motor.getFault_UnstableSupplyV(), motor.getFault_StatorCurrLimit(),
                    motor.getFault_SupplyCurrLimit(), motor.getFault_RemoteSensorDataInvalid(),
                    motor.getFault_UnlicensedFeatureInUse());
            faultArray = faults.toArray(BaseStatusSignal[]::new);
        }
    }

    private static final List<Motor> MOTORS = new ArrayList<>();
    private static long loops = 0;

    /** Register a motor. cfg may be null; its enabled current limits are logged so the app can show them. */
    public static void register(String name, int canId, CANBus bus, TalonFX motor, TalonFXConfiguration cfg) {
        double supply = Double.NaN, stator = Double.NaN;
        if (cfg != null) {
            if (cfg.CurrentLimits.SupplyCurrentLimitEnable) supply = cfg.CurrentLimits.SupplyCurrentLimit;
            if (cfg.CurrentLimits.StatorCurrentLimitEnable) stator = cfg.CurrentLimits.StatorCurrentLimit;
        }
        MOTORS.add(new Motor(name, canId, bus, motor, supply, stator));
    }

    /** Call once per loop from robotPeriodic. Non-blocking: reads the newest frames that have arrived. */
    public static void update() {
        boolean doFaults = (loops++ % FAULT_EVERY_N_LOOPS) == 0;
        for (Motor m : MOTORS) {
            if (!m.staticLogged) {
                DogLog.log(m.key + "CANId", (long) m.canId);
                DogLog.log(m.key + "CANBus", m.canBus);
                DogLog.log(m.key + "Controller", "TalonFX");
                if (!Double.isNaN(m.supplyLimitA)) DogLog.log(m.key + "SupplyLimitA", m.supplyLimitA, "A");
                if (!Double.isNaN(m.statorLimitA)) DogLog.log(m.key + "StatorLimitA", m.statorLimitA, "A");
                m.staticLogged = true;
            }
            boolean connected = m.motor.isConnected();
            DogLog.log(m.key + "Connected", connected);
            if (!connected) continue; // the last values would be stale; don't log them as new
            BaseStatusSignal.refreshAll(m.fast);
            DogLog.log(m.key + "TempC", m.temp.getValueAsDouble(), "degC");
            DogLog.log(m.key + "SupplyCurrentA", m.supply.getValueAsDouble(), "A");
            DogLog.log(m.key + "StatorCurrentA", m.stator.getValueAsDouble(), "A");
            DogLog.log(m.key + "BusVoltageV", m.bus.getValueAsDouble(), "V");
            DogLog.log(m.key + "DutyCycle", m.duty.getValueAsDouble());
            DogLog.log(m.key + "VelocityRPM", m.rotorVel.getValueAsDouble() * 60.0, "rpm");
            if (doFaults) {
                BaseStatusSignal.refreshAll(m.faultArray);
                for (int i = 0; i < FAULT_NAMES.length; i++) {
                    DogLog.log(m.key + "Faults/" + FAULT_NAMES[i], Boolean.TRUE.equals(m.faults.get(i).getValue()));
                }
            }
        }
    }
}
