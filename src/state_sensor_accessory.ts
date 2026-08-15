import { PlatformAccessory } from "homebridge";

import RoborockPlatform from "./platform";
import { HomeKitStateSensorKey } from "./types";

export type StateSensorDefinition = {
  key: HomeKitStateSensorKey;
  /** Appended to the robot's name: "Vicky Docked". */
  nameSuffix: string;
  /** What "detected" means, for the line written when the sensor appears. */
  summary: string;
  /**
   * What the sensor reads before the robot has reported anything.
   *
   * A HAP sensor must answer a read immediately, and at startup there is
   * nothing to answer with. Whatever is answered is the value the sensor will
   * MOVE AWAY FROM when real data lands, and a move is what an automation
   * triggers on — so this has to be the state that is overwhelmingly the true
   * one, per sensor. It is not a shared default: "docked" resting true is the
   * resting state of every robot on a dock, while "cleaning" resting true would
   * announce a finished cleaning on every restart of a robot that was doing
   * nothing. That was live for both shipped sensors until this field existed.
   */
  restingState: boolean;
};

/**
 * Every state a sensor can mirror.
 *
 * Same shape as ACTION_SWITCH_DEFINITIONS on purpose: a fourth state is a row
 * here plus an arm in getHomeKitStateSensorValue, and nothing else.
 */
export const STATE_SENSOR_DEFINITIONS: readonly StateSensorDefinition[] = [
  {
    key: "docked",
    nameSuffix: "Docked",
    summary:
      "reads Closed while the robot is in its dock and Open once it leaves",
    restingState: true,
  },
  {
    key: "cleaning",
    nameSuffix: "Cleaning",
    summary:
      "reads Closed while the robot is on a cleaning run and Open when it is not",
    restingState: false,
  },
  {
    key: "waterTankEmpty",
    nameSuffix: "Water Tank Empty",
    summary:
      "reads Closed while the robot reports its clean-water tank empty and Open otherwise",
    restingState: false,
  },
];

export function getStateSensorDefinition(
  key: string
): StateSensorDefinition | undefined {
  return STATE_SENSOR_DEFINITIONS.find((definition) => definition.key === key);
}

/** The context every state-sensor accessory carries in the Homebridge cache. */
export type StateSensorContext = {
  duid: string;
  kind: typeof STATE_SENSOR_KIND;
  sensor: HomeKitStateSensorKey;
};

/**
 * The marker that keeps these accessories out of the Matter-only cleanup.
 *
 * Same reasoning as ACTION_SWITCH_KIND, and the same trap: discoverDevices()
 * unregisters every cached HAP accessory it does not recognise, so a new kind
 * that is not named in that partition is deleted on the first restart after it
 * was added — while the log line goes on calling it a legacy accessory.
 */
export const STATE_SENSOR_KIND = "stateSensor" as const;

export function isStateSensorAccessory(accessory: {
  context?: unknown;
}): boolean {
  const context = accessory?.context as Partial<StateSensorContext> | undefined;
  return Boolean(
    context &&
      typeof context === "object" &&
      context.kind === STATE_SENSOR_KIND &&
      typeof context.duid === "string" &&
      typeof context.sensor === "string"
  );
}

/** The UUID seed for one robot's sensor. Namespaced away from the switches'. */
export function stateSensorUuidSeed(
  duid: string,
  sensor: HomeKitStateSensorKey
): string {
  return `hap:roborock:state:${duid}:${sensor}`;
}

/**
 * The characteristic values, named.
 *
 * ContactSensorState is 0 for detected ("Closed" in the Home app) and 1 for not
 * detected ("Open"). Detected means the state the sensor is named after is
 * true — "Docked" is Closed while the robot is docked — and the rule is the
 * same for every sensor so that one polarity holds across the whole feature.
 */
const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;

export default class RoborockStateSensorAccessory {
  /**
   * The last value that came from real robot data, or null while none has.
   *
   * A HAP sensor has to answer a read immediately, and at startup there is
   * nothing honest to answer with: the robot's first snapshot can arrive
   * seconds later. Robots on this account have been measured reporting no
   * usable state for 27 seconds after a restart (a Q7 startup symptom seen on
   * fourteen separate runs), and a sensor that filled that gap with a guess
   * would move — which is exactly what an automation triggers on. So the gap is
   * answered from the Homebridge cache instead, and the characteristic is not
   * written until the robot has actually said something.
   */
  private value: boolean | null = null;

  constructor(
    private readonly platform: RoborockPlatform,
    public readonly accessory: PlatformAccessory,
    private readonly definition: StateSensorDefinition,
    private readonly duid: string
  ) {
    const cached = (
      this.accessory.context as Partial<StateSensorContext> & {
        lastValue?: unknown;
      }
    )?.lastValue;
    if (typeof cached === "boolean") {
      this.value = cached;
    }

    this.configureAccessory();
  }

  get sensor(): HomeKitStateSensorKey {
    return this.definition.key;
  }

  get summary(): string {
    return this.definition.summary;
  }

  /**
   * Re-apply the identity and re-bind the handler.
   *
   * Called for cached accessories too: a cached PlatformAccessory arrives with
   * its services intact but no handlers, because those live in the closure of
   * the process that registered it and did not survive the restart.
   */
  configureAccessory(): void {
    const { Service, Characteristic } = this.platform;
    const name = this.accessory.displayName;

    const information =
      this.accessory.getService(Service.AccessoryInformation) ||
      this.accessory.addService(Service.AccessoryInformation);
    information
      .setCharacteristic(Characteristic.Manufacturer, "Roborock")
      .setCharacteristic(
        Characteristic.Model,
        `${this.platform.getVacuumModel(this.duid)} ${this.definition.nameSuffix}`
      )
      // The robot's own serial number belongs to the Matter accessory. Suffixing
      // it keeps Apple Home from treating the two as the same device.
      .setCharacteristic(
        Characteristic.SerialNumber,
        `${this.platform.getVacuumSerialNumber(this.duid)}-${this.definition.key}`
      );

    const service =
      this.accessory.getService(Service.ContactSensor) ||
      this.accessory.addService(Service.ContactSensor, name);

    service.setCharacteristic(Characteristic.Name, name);

    const contact = service.getCharacteristic(
      Characteristic.ContactSensorState
    );
    // Cached accessories are configured again on every launch, and a second
    // handler on the same characteristic would answer the same read twice.
    contact.removeAllListeners("get");
    contact.onGet(() => this.toCharacteristicValue(this.value));

    service.updateCharacteristic(
      Characteristic.ContactSensorState,
      this.toCharacteristicValue(this.value)
    );
  }

  /** Follow a rename in the Roborock app through to Apple Home. */
  updateIdentity(vacuumName: string): void {
    const name = `${vacuumName} ${this.definition.nameSuffix}`;
    if (this.accessory.displayName === name) {
      return;
    }

    this.accessory.displayName = name;
    this.accessory
      .getService(this.platform.Service.ContactSensor)
      ?.updateCharacteristic(this.platform.Characteristic.Name, name);
  }

  /**
   * Adopt the robot's current state.
   *
   * `null` means the robot has not reported anything usable yet, and is a
   * deliberate no-op rather than a value: see the comment on `value`.
   */
  refresh(next: boolean | null): void {
    if (next === null || next === this.value) {
      return;
    }

    const first = this.value === null;
    this.value = next;

    // Persisted so the next restart answers reads from the last known state
    // instead of moving the sensor as soon as the robot reports in.
    if (this.accessory.context) {
      (this.accessory.context as { lastValue?: boolean }).lastValue = next;
    }

    this.accessory
      .getService(this.platform.Service.ContactSensor)
      ?.updateCharacteristic(
        this.platform.Characteristic.ContactSensorState,
        this.toCharacteristicValue(next)
      );

    // Once per change, at debug: three robots times two sensors on a 15 s poll
    // would otherwise be the loudest thing in the log.
    this.platform.log.debug(
      `${this.accessory.displayName} is now ${next ? "Closed" : "Open"}${
        first ? " (first reading since startup)" : ""
      }.`
    );
  }

  dispose(): void {
    // Nothing scheduled and nothing subscribed: the platform pushes into
    // refresh(). Kept so both HAP accessory kinds are torn down the same way.
  }

  private toCharacteristicValue(value: boolean | null): number {
    // No reading yet: answer with this sensor's own resting state, which is
    // the one it will not have to move away from when the robot reports in.
    // See the comment on restingState — a single shared default was wrong for
    // every sensor except "docked".
    const resolved = value === null ? this.definition.restingState : value;

    return resolved ? CONTACT_DETECTED : CONTACT_NOT_DETECTED;
  }
}
