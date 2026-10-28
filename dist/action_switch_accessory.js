"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTION_SWITCH_KIND = exports.ACTION_SWITCH_DEFINITIONS = void 0;
exports.getActionSwitchDefinition = getActionSwitchDefinition;
exports.isActionSwitchAccessory = isActionSwitchAccessory;
exports.actionSwitchUuidSeed = actionSwitchUuidSeed;
const hap_name_1 = require("./hap_name");
const timers_1 = require("./timers");
/**
 * How long a pressed switch stays on before it falls back to off.
 *
 * These are momentary switches: the press is the command, and there is no
 * "docking" state worth mirroring back. The alternative — holding the switch
 * on until the robot reaches the dock — would be a second state machine racing
 * the same laggy Roborock snapshot that issues #4 and #12 were about, for no
 * gain to the automation that pressed it.
 *
 * 1.5 s is long enough that the Home app draws the press and an automation
 * records it, and short enough that the switch is ready for the next one.
 */
const SWITCH_AUTO_RESET_MS = 1500;
/**
 * Every action a switch can expose.
 *
 * The table is the extension point. A new action is a row here plus an arm
 * in runHomeKitAction — no new class, no new registration path, no second
 * partition rule in the platform's accessory sweep.
 */
exports.ACTION_SWITCH_DEFINITIONS = [
    {
        key: "clean",
        nameSuffix: "Start Cleaning",
        summary: "starts the same clean the Home tile's play button would, rooms included",
    },
    {
        key: "dock",
        nameSuffix: "Return to Dock",
        summary: "sends the robot back to its dock",
    },
    {
        key: "empty",
        nameSuffix: "Empty Bin",
        summary: "starts the auto-empty dock while the robot is docked",
    },
    {
        key: "pause",
        nameSuffix: "Pause",
        summary: "pauses the current clean",
    },
    {
        key: "locate",
        nameSuffix: "Find",
        summary: "makes the robot announce where it is",
    },
];
function getActionSwitchDefinition(key) {
    return exports.ACTION_SWITCH_DEFINITIONS.find((definition) => definition.key === key);
}
/**
 * The marker that keeps these accessories out of the Matter-only cleanup.
 *
 * discoverDevices() unregisters every cached HAP accessory it does not
 * recognise, because the Matter-only rebuild had to remove the old fan and
 * helper switches and a user who upgraded mid-way could otherwise keep a
 * duplicate robot in Apple Home forever. That sweep predates these switches
 * and would delete them on the first restart after they were added, so the
 * partition is written into the accessory itself rather than inferred from
 * its name — a name is user-editable and a duid is not.
 */
exports.ACTION_SWITCH_KIND = "actionSwitch";
function isActionSwitchAccessory(accessory) {
    const context = accessory === null || accessory === void 0 ? void 0 : accessory.context;
    return Boolean(context &&
        typeof context === "object" &&
        context.kind === exports.ACTION_SWITCH_KIND &&
        typeof context.duid === "string" &&
        typeof context.action === "string");
}
/** The UUID seed for one robot's switch. Namespaced away from Matter's. */
function actionSwitchUuidSeed(duid, action) {
    return `hap:roborock:action:${duid}:${action}`;
}
class RoborockActionSwitchAccessory {
    constructor(platform, accessory, definition, duid) {
        this.platform = platform;
        this.accessory = accessory;
        this.definition = definition;
        this.duid = duid;
        this.resetTimer = null;
        this.configureAccessory();
    }
    /**
     * Re-apply the identity and re-bind the handlers.
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
        const service = this.accessory.getService(Service.Switch) ||
            this.accessory.addService(Service.Switch, name);
        service.displayName = name;
        service.setCharacteristic(Characteristic.Name, name);
        const on = service.getCharacteristic(Characteristic.On);
        // Cached accessories are configured again on every launch, and a second
        // set of handlers on the same characteristic would run the command twice.
        on.removeAllListeners("get");
        on.removeAllListeners("set");
        on.onGet(() => false).onSet((value) => this.handlePress(value));
        // Whatever the cache remembered, the switch starts off: it is momentary,
        // and an accessory restored in the on position would tell an automation
        // that a command it never sent is still running.
        service.updateCharacteristic(Characteristic.On, false);
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
        const service = this.accessory.getService(this.platform.Service.Switch);
        if (service) {
            service.displayName = name;
            service.updateCharacteristic(this.platform.Characteristic.Name, name);
        }
        this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    dispose() {
        if (this.resetTimer) {
            (0, timers_1.clearTimer)(this.resetTimer);
            this.resetTimer = null;
        }
    }
    /**
     * One press.
     *
     * Nothing here is allowed to throw: an error out of a HAP set handler is
     * shown to the user as a failed accessory rather than as the thing that
     * actually went wrong, and the command path already logs its own failures
     * with the robot's name and the transport it used.
     */
    async handlePress(value) {
        if (!value) {
            // The switch turning itself off again. Not a command.
            return;
        }
        this.scheduleReset();
        try {
            const vacuum = this.platform.getMatterVacuum(this.duid);
            if (!vacuum) {
                this.platform.log.warn(`${this.accessory.displayName} was pressed, but the robot behind it is not set up yet. Try again once startup has finished.`);
                return;
            }
            if (!vacuum.supportsHomeKitAction(this.definition.key)) {
                this.platform.log.warn(`${this.accessory.displayName} was pressed, but ${vacuum.getDisplayName()} does not support that command.`);
                return;
            }
            await vacuum.runHomeKitAction(this.definition.key);
        }
        catch (error) {
            this.platform.log.error(`Unable to run ${this.accessory.displayName}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    scheduleReset() {
        if (this.resetTimer) {
            (0, timers_1.clearTimer)(this.resetTimer);
        }
        const timer = (0, timers_1.scheduleTimer)(() => {
            var _a;
            this.resetTimer = null;
            (_a = this.accessory
                .getService(this.platform.Service.Switch)) === null || _a === void 0 ? void 0 : _a.updateCharacteristic(this.platform.Characteristic.On, false);
        }, SWITCH_AUTO_RESET_MS);
        (0, timers_1.unrefTimer)(timer);
        this.resetTimer = timer;
    }
}
exports.default = RoborockActionSwitchAccessory;
//# sourceMappingURL=action_switch_accessory.js.map