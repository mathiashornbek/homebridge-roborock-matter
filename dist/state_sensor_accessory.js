"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATE_SENSOR_KIND = exports.STATE_SENSOR_DEFINITIONS = void 0;
exports.getStateSensorDefinition = getStateSensorDefinition;
exports.isStateSensorAccessory = isStateSensorAccessory;
exports.stateSensorUuidSeed = stateSensorUuidSeed;
const hap_name_1 = require("./hap_name");
/**
 * Every state a sensor can mirror.
 *
 * Same shape as ACTION_SWITCH_DEFINITIONS on purpose: a fourth state is a row
 * here plus an arm in getHomeKitStateSensorValue, and nothing else.
 */
exports.STATE_SENSOR_DEFINITIONS = [
    {
        key: "docked",
        nameSuffix: "Docked",
        summary: "reads Closed while the robot is in its dock and Open once it leaves",
        restingState: true,
    },
    {
        key: "cleaning",
        nameSuffix: "Cleaning",
        summary: "reads Closed while the robot is on a cleaning run and Open when it is not",
        restingState: false,
    },
    {
        key: "waterTankEmpty",
        nameSuffix: "Water Tank Empty",
        summary: "reads Closed while the robot reports its clean-water tank empty and Open otherwise",
        restingState: false,
    },
    {
        key: "dirtyWaterTankFull",
        nameSuffix: "Dirty Water Tank Full",
        summary: "reads Closed while the dock reports its dirty-water tank full and Open otherwise",
        restingState: false,
    },
    {
        key: "cleaningFluidEmpty",
        nameSuffix: "Cleaning Fluid Empty",
        summary: "reads Closed while the dock reports its cleaning-fluid cartridge empty and Open otherwise",
        restingState: false,
    },
];
function getStateSensorDefinition(key) {
    return exports.STATE_SENSOR_DEFINITIONS.find((definition) => definition.key === key);
}
/**
 * The marker that keeps these accessories out of the Matter-only cleanup.
 *
 * Same reasoning as ACTION_SWITCH_KIND, and the same trap: discoverDevices()
 * unregisters every cached HAP accessory it does not recognise, so a new kind
 * that is not named in that partition is deleted on the first restart after it
 * was added — while the log line goes on calling it a legacy accessory.
 */
exports.STATE_SENSOR_KIND = "stateSensor";
function isStateSensorAccessory(accessory) {
    const context = accessory === null || accessory === void 0 ? void 0 : accessory.context;
    return Boolean(context &&
        typeof context === "object" &&
        context.kind === exports.STATE_SENSOR_KIND &&
        typeof context.duid === "string" &&
        typeof context.sensor === "string");
}
/** The UUID seed for one robot's sensor. Namespaced away from the switches'. */
function stateSensorUuidSeed(duid, sensor) {
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
class RoborockStateSensorAccessory {
    constructor(platform, accessory, definition, duid) {
        var _a;
        this.platform = platform;
        this.accessory = accessory;
        this.definition = definition;
        this.duid = duid;
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
        this.value = null;
        const cached = (_a = this.accessory.context) === null || _a === void 0 ? void 0 : _a.lastValue;
        if (typeof cached === "boolean") {
            this.value = cached;
        }
        this.configureAccessory();
    }
    get sensor() {
        return this.definition.key;
    }
    /**
     * Re-apply the identity and re-bind the handler.
     *
     * Called for cached accessories too: a cached PlatformAccessory arrives with
     * its services intact but no handlers, because those live in the closure of
     * the process that registered it and did not survive the restart.
     */
    configureAccessory() {
        const { Service, Characteristic } = this.platform;
        const name = this.accessory.displayName;
        const information = this.accessory.getService(Service.AccessoryInformation) ||
            this.accessory.addService(Service.AccessoryInformation);
        information
            .setCharacteristic(Characteristic.Name, name)
            .setCharacteristic(Characteristic.Manufacturer, "Roborock")
            .setCharacteristic(Characteristic.Model, `${this.platform.getVacuumModel(this.duid)} ${this.definition.nameSuffix}`)
            // The robot's own serial number belongs to the Matter accessory. Suffixing
            // it keeps Apple Home from treating the two as the same device.
            .setCharacteristic(Characteristic.SerialNumber, `${this.platform.getVacuumSerialNumber(this.duid)}-${this.definition.key}`);
        const service = this.accessory.getService(Service.ContactSensor) ||
            this.accessory.addService(Service.ContactSensor, name);
        service.displayName = name;
        service.setCharacteristic(Characteristic.Name, name);
        const contact = service.getCharacteristic(Characteristic.ContactSensorState);
        // Cached accessories are configured again on every launch, and a second
        // handler on the same characteristic would answer the same read twice.
        contact.removeAllListeners("get");
        contact.onGet(() => this.toCharacteristicValue(this.value));
        service.updateCharacteristic(Characteristic.ContactSensorState, this.toCharacteristicValue(this.value));
    }
    /** Follow a rename in the Roborock app through to Apple Home. */
    updateIdentity(vacuumName) {
        var _a;
        const name = (0, hap_name_1.hapName)(vacuumName, "Roborock Vacuum", this.definition.nameSuffix);
        if (this.accessory.displayName === name) {
            return;
        }
        this.accessory.displayName = name;
        (_a = this.accessory
            .getService(this.platform.Service.AccessoryInformation)) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.Name, name);
        const service = this.accessory.getService(this.platform.Service.ContactSensor);
        if (service) {
            service.displayName = name;
            service.updateCharacteristic(this.platform.Characteristic.Name, name);
        }
        this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    /**
     * Adopt the robot's current state.
     *
     * `null` means the robot has not reported anything usable yet, and is a
     * deliberate no-op rather than a value: see the comment on `value`.
     */
    refresh(next) {
        var _a;
        if (next === null || next === this.value) {
            return;
        }
        const first = this.value === null;
        this.value = next;
        // Persisted so the next restart answers reads from the last known state
        // instead of moving the sensor as soon as the robot reports in.
        if (this.accessory.context) {
            this.accessory.context.lastValue = next;
        }
        (_a = this.accessory
            .getService(this.platform.Service.ContactSensor)) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.toCharacteristicValue(next));
        // Once per change, at debug: three robots times two sensors on a 15 s poll
        // would otherwise be the loudest thing in the log.
        this.platform.log.debug(`${this.accessory.displayName} is now ${next ? "Closed" : "Open"}${first ? " (first reading since startup)" : ""}.`);
    }
    dispose() {
        // Nothing scheduled and nothing subscribed: the platform pushes into
        // refresh(). Kept so both HAP accessory kinds are torn down the same way.
    }
    toCharacteristicValue(value) {
        // No reading yet: answer with this sensor's own resting state, which is
        // the one it will not have to move away from when the robot reports in.
        // See the comment on restingState — a single shared default was wrong for
        // every sensor except "docked".
        const resolved = value === null ? this.definition.restingState : value;
        return resolved ? CONTACT_DETECTED : CONTACT_NOT_DETECTED;
    }
}
exports.default = RoborockStateSensorAccessory;
//# sourceMappingURL=state_sensor_accessory.js.map