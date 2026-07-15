"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const matter_vacuum_accessory_1 = __importDefault(require("./matter_vacuum_accessory"));
const logger_1 = __importDefault(require("./logger"));
const settings_1 = require("./settings");
const crypto_1 = require("./crypto");
const DEP0040_CODE = "DEP0040";
let dep0040FilterInstalled = false;
const DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS = 6;
function installDeprecationWarningFilter() {
    if (dep0040FilterInstalled) {
        return;
    }
    dep0040FilterInstalled = true;
    const originalEmitWarning = process.emitWarning.bind(process);
    let dep0040Logged = false;
    process.emitWarning = ((warning, type, code, ctor) => {
        const warningCode = typeof warning === "object" && warning !== null && "code" in warning
            ? String(warning.code)
            : code;
        if (warningCode === DEP0040_CODE) {
            if (!dep0040Logged) {
                dep0040Logged = true;
                process.stderr.write("[Roborock Vacuum] Suppressed Node.js DEP0040 warning from upstream dependency.\n");
            }
            return;
        }
        originalEmitWarning(warning, type, code, ctor);
    });
}
installDeprecationWarningFilter();
const Roborock = require("../roborockLib/roborockAPI").Roborock;
/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
class RoborockPlatform {
    /**
     * This constructor is where you should parse the user config
     * and discover/register accessories with Homebridge.
     *
     * @param logger Homebridge logger
     * @param config Homebridge platform config
     * @param api Homebridge API
     */
    constructor(homebridgeLogger, config, api) {
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        // Used to track restored cached accessories
        this.accessories = [];
        this.matterAccessories = [];
        this.matterVacuums = new Map();
        this.matterUnavailableLogged = false;
        this.platformConfig = config;
        // Initialise logging utility
        this.log = new logger_1.default(homebridgeLogger, this.platformConfig.debugMode);
        // Create Roborock App communication module
        const username = this.platformConfig.email;
        const password = this.platformConfig.password;
        const baseURL = this.platformConfig.baseURL;
        const debugMode = this.platformConfig.debugMode;
        const transientWarningThrottleHours = this.normalizeTransientWarningThrottleHours(this.platformConfig.transientWarningThrottleHours);
        const storagePath = this.api.user.storagePath();
        const decryptedSession = this.platformConfig.encryptedToken
            ? (0, crypto_1.decryptSession)(this.platformConfig.encryptedToken, storagePath)
            : null;
        this.roborockAPI = new Roborock({
            username: username,
            password: password,
            debug: debugMode,
            baseURL: baseURL,
            skipDevices: this.platformConfig.skipDevices,
            enableMatterServiceArea: this.platformConfig.enableMatterServiceArea !== false,
            cloudOnlyMode: Boolean(this.platformConfig.cloudOnlyMode),
            log: this.log,
            userData: decryptedSession,
            storagePath: storagePath,
            errorLogThrottleMs: transientWarningThrottleHours * 60 * 60 * 1000,
        });
        /**
         * When this event is fired it means Homebridge has restored all cached accessories from disk.
         * Dynamic Platform plugins should only register new accessories after this event was fired,
         * in order to ensure they weren't added to homebridge already. This event can also be used
         * to start discovery of new accessories.
         */
        this.api.on("didFinishLaunching" /* APIEvent.DID_FINISH_LAUNCHING */, () => {
            this.log.debug("Finished launching and restored cached accessories.");
            this.configurePlugin();
        });
        if (this.platformConfig.enableMatter === false) {
            this.log.info("Matter-only edition: the legacy 'enableMatter' setting is ignored; robots are always published via Matter.");
        }
        this.api.on("shutdown" /* APIEvent.SHUTDOWN */, () => {
            this.log.debug("Shutting down...");
            // Stop Matter background work first so no heartbeat or deferred publish
            // fires into a bridge that is tearing down.
            for (const vacuum of this.matterVacuums.values()) {
                vacuum.dispose();
            }
            if (this.roborockAPI) {
                this.roborockAPI.stopService();
            }
        });
    }
    async configurePlugin() {
        await this.loginAndDiscoverDevices();
    }
    normalizeTransientWarningThrottleHours(value) {
        const parsed = typeof value === "number"
            ? value
            : typeof value === "string" && value.trim() !== ""
                ? Number(value)
                : DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;
        if (!Number.isFinite(parsed) || parsed < 0) {
            return DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS;
        }
        return parsed;
    }
    async loginAndDiscoverDevices() {
        if (!this.platformConfig.email) {
            this.log.error("Email is not configured - aborting plugin start. " +
                "Please set the field `email` in your config and restart Homebridge.");
            return;
        }
        if (!this.platformConfig.password && !this.platformConfig.encryptedToken) {
            this.log.error("Password is not configured - aborting plugin start. " +
                "Please set `password` or complete login in the Config UI.");
            return;
        }
        const self = this;
        self.roborockAPI.setDeviceNotify(function (id, homeData) {
            self.dispatchDeviceUpdate(id, homeData);
        });
        self.roborockAPI.startService(function () {
            self.log.info("Service started");
            //call the discoverDevices function
            self.discoverDevices();
        });
    }
    dispatchDeviceUpdate(id, homeData) {
        var _a;
        // HomeData payloads can be tens of kilobytes and arrive continuously.
        // Only pay the JSON.stringify cost when debug logging is actually on.
        if ((_a = this.platformConfig) === null || _a === void 0 ? void 0 : _a.debugMode) {
            this.log.debug(`${id} notifyDeviceUpdater:${JSON.stringify(homeData)}`);
        }
        if (typeof this.roborockAPI.recordRoborockDiagnosticMessage === "function") {
            this.roborockAPI.recordRoborockDiagnosticMessage(id, homeData);
        }
        const scopedDuid = this.getScopedLiveMessageDuid(id, homeData);
        if (scopedDuid) {
            this.notifyVacuumByDuid(scopedDuid, id, homeData);
            return;
        }
        if (this.isLiveDeviceMessage(id) &&
            !this.shouldAcceptUnscopedLiveMessage()) {
            this.log.debug(`Ignoring unscoped ${id} update because multiple Roborock vacuums are configured.`);
            return;
        }
        for (const vacuum of this.matterVacuums.values()) {
            this.notifyMatter(vacuum, id, homeData);
        }
    }
    notifyVacuumByDuid(duid, id, homeData) {
        const matterVacuum = this.matterVacuums.get(duid);
        if (matterVacuum) {
            this.notifyMatter(matterVacuum, id, homeData);
        }
    }
    notifyMatter(vacuum, id, homeData) {
        vacuum.notifyDeviceUpdater(id, homeData).catch((error) => {
            this.log.debug("Error updating Matter vacuum state: " + error);
        });
    }
    getScopedLiveMessageDuid(id, data) {
        if (!this.isLiveDeviceMessage(id)) {
            return null;
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return null;
        }
        const message = data;
        if (Object.prototype.hasOwnProperty.call(message, "duid") &&
            Object.prototype.hasOwnProperty.call(message, "payload") &&
            message.duid) {
            return String(message.duid);
        }
        return null;
    }
    isLiveDeviceMessage(id) {
        return id === "CloudMessage" || id === "LocalMessage";
    }
    shouldAcceptUnscopedLiveMessage() {
        return this.getConfiguredVacuumDuidCount() <= 1;
    }
    getConfiguredVacuumDuidCount() {
        const duids = new Set();
        const devices = typeof this.roborockAPI.getVacuumList === "function"
            ? this.roborockAPI.getVacuumList()
            : [];
        if (Array.isArray(devices)) {
            for (const device of devices) {
                if (device === null || device === void 0 ? void 0 : device.duid) {
                    duids.add(String(device.duid));
                }
            }
        }
        for (const duid of this.matterVacuums.keys()) {
            duids.add(duid);
        }
        return duids.size;
    }
    /**
     * This function is invoked when Homebridge restores cached accessories from disk at startup.
     * It should be used to set up event handlers for characteristics and update respective values.
     */
    configureAccessory(accessory) {
        this.log.info(`Loading accessory '${accessory.displayName}' from cache.`);
        // Store restored accessory in the cached accessories list
        // remove duplicates accessories
        try {
            const existingAccessory = this.accessories.find((a) => a.UUID === accessory.UUID);
            if (existingAccessory) {
                this.log.info(`Removing duplicate accessory '${existingAccessory.displayName}' from cache.`);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                    existingAccessory,
                ]);
            }
        }
        catch (e) {
            this.log.error("Error loading accessory from cache: " + e);
        }
        this.accessories.push(accessory);
    }
    /**
     * Homebridge 2 calls this for cached Matter accessories. Keep this optional
     * and runtime-typed so Homebridge 1.x users remain fully supported.
     */
    configureMatterAccessory(accessory) {
        var _a;
        this.log.info(`Loading Matter accessory '${accessory.displayName}' from cache.`);
        this.matterAccessories.push(accessory);
        const duid = this.getMatterAccessoryDuid(accessory);
        if (!duid) {
            return;
        }
        const matter = this.getMatterApi();
        if (!((_a = matter === null || matter === void 0 ? void 0 : matter.deviceTypes) === null || _a === void 0 ? void 0 : _a.RoboticVacuumCleaner)) {
            return;
        }
        accessory.deviceType = matter.deviceTypes.RoboticVacuumCleaner;
        this.applyMatterAccessoryIdentity(accessory, {
            duid,
            name: accessory.displayName,
        });
        this.createOrUpdateMatterVacuum({ duid, name: accessory.displayName }, accessory, true);
    }
    isSupportedDevice(model) {
        return this.roborockAPI.isSupportedVacuumModel(model);
    }
    /**
     * Fetches all of the user's devices from Roborock App and sets up handlers.
     *
     * Accessories must only be registered once. Previously created accessories
     * must not be registered again to prevent "duplicate UUID" errors.
     */
    async discoverDevices() {
        this.log.info("Discovering vacuum devices...");
        try {
            const self = this;
            if (self.roborockAPI.isInited()) {
                const devices = self.roborockAPI.getVacuumList();
                // Matter-only edition: this plugin publishes each robot exclusively
                // as a native Matter vacuum. No HomeKit (HAP) accessories are
                // registered.
                for (const device of devices) {
                    await self.discoverMatterVacuum(device);
                }
            }
            // At this point, we set up all devices from Roborock App, but we did not unregister
            // cached devices that do not exist on the Roborock App account anymore.
            // Matter-only migration: unregister every cached HomeKit accessory
            // (the legacy fan + helper switches) so robots appear exactly once —
            // as Matter vacuums — in Apple Home.
            if (this.accessories.length > 0) {
                this.log.info(`Matter-only edition: removing ${this.accessories.length} legacy HomeKit accessor${this.accessories.length === 1 ? "y" : "ies"} (robots are published via Matter only).`);
                this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
                    ...this.accessories,
                ]);
                this.accessories.length = 0;
            }
            await this.unregisterStaleMatterAccessories();
        }
        catch (error) {
            this.log.error("An error occurred during device discovery. " +
                "Turn on debug mode for more information.");
            this.log.debug(error);
        }
    }
    getMatterApi() {
        // Matter-only edition: Matter publication is unconditional; availability
        // depends solely on the Homebridge Matter API being present.
        const api = this.api;
        const matterEnabled = typeof api.isMatterEnabled === "function"
            ? api.isMatterEnabled()
            : Boolean(api.matter);
        if (!matterEnabled || !api.matter) {
            if (!this.matterUnavailableLogged) {
                this.matterUnavailableLogged = true;
                this.log.info("Matter vacuum exposure is enabled in plugin settings, but Matter is not enabled for this Homebridge bridge. The existing HomeKit accessory will continue to work.");
            }
            return null;
        }
        return api.matter;
    }
    async discoverMatterVacuum(device) {
        var _a;
        const matter = this.getMatterApi();
        if (!matter) {
            return;
        }
        if (!((_a = matter.deviceTypes) === null || _a === void 0 ? void 0 : _a.RoboticVacuumCleaner)) {
            this.log.warn("Matter is enabled, but this Homebridge version does not expose the robotic vacuum device type yet.");
            return;
        }
        const uuid = this.generateMatterUuid(device.duid);
        const existingAccessory = this.matterAccessories.find((accessory) => accessory.UUID === uuid);
        const accessory = existingAccessory ||
            this.createMatterAccessory(device, matter.deviceTypes.RoboticVacuumCleaner);
        const vacuum = this.createOrUpdateMatterVacuum(device, accessory, Boolean(existingAccessory));
        if (existingAccessory) {
            await matter.updatePlatformAccessories([accessory]);
            vacuum.scheduleMatterStateRefresh("cached accessory update", 1000);
            return;
        }
        this.log.info(`Adding Matter vacuum accessory '${accessory.displayName}' (${uuid}).`);
        await matter.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [
            accessory,
        ]);
        this.matterAccessories.push(accessory);
        vacuum.markRegistered();
        vacuum.scheduleMatterStateRefresh("accessory registration", 1000);
    }
    createMatterAccessory(device, deviceType) {
        const duid = String(device.duid);
        const accessory = {
            UUID: this.generateMatterUuid(duid),
            deviceType,
            context: { duid },
        };
        this.applyMatterAccessoryIdentity(accessory, device);
        return accessory;
    }
    applyMatterAccessoryIdentity(accessory, device) {
        const duid = String(device.duid);
        const displayName = this.roborockAPI.getVacuumDeviceInfo(duid, "name") ||
            device.name ||
            "Roborock Vacuum";
        const firmwareRevision = this.roborockAPI.getVacuumDeviceInfo(duid, "fv");
        accessory.displayName = displayName;
        // Mirror the name so Matter layers that read `name` for the node label show
        // the Roborock name instead of a generic "Matter Accessory" during pairing.
        accessory.name = displayName;
        accessory.serialNumber =
            this.roborockAPI.getVacuumDeviceInfo(duid, "sn") || duid;
        accessory.manufacturer = "Roborock";
        accessory.model =
            this.roborockAPI.getProductAttribute(duid, "model") || "Roborock Vacuum";
        accessory.context = { ...(accessory.context || {}), duid };
        if (firmwareRevision) {
            accessory.firmwareRevision = firmwareRevision;
        }
        else {
            delete accessory.firmwareRevision;
        }
    }
    createOrUpdateMatterVacuum(device, accessory, isRegistered) {
        const duid = String(device.duid);
        const existing = this.matterVacuums.get(duid);
        if (existing) {
            existing.updateMetadata(device);
            return existing;
        }
        const vacuum = new matter_vacuum_accessory_1.default(this, accessory, device, isRegistered);
        this.matterVacuums.set(duid, vacuum);
        return vacuum;
    }
    async unregisterStaleMatterAccessories() {
        var _a;
        const api = this.api;
        const matter = api.matter;
        if (!matter || typeof matter.unregisterPlatformAccessories !== "function") {
            return;
        }
        const currentMatterUuids = new Set(this.roborockAPI
            .getVacuumList()
            .filter((device) => this.isSupportedDevice(this.roborockAPI.getProductAttribute(device.duid, "model")))
            .map((device) => this.generateMatterUuid(device.duid)));
        const staleAccessories = this.matterAccessories.filter((accessory) => !currentMatterUuids.has(accessory.UUID));
        if (staleAccessories.length === 0) {
            return;
        }
        for (const accessory of staleAccessories) {
            this.log.info(`Unregistering stale Matter accessory "${accessory.displayName}" (${this.getMatterAccessoryDuid(accessory) || "unknown duid"}); the robot is skipped or no longer in the account.`);
        }
        await matter.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, staleAccessories);
        for (const accessory of staleAccessories) {
            const duid = this.getMatterAccessoryDuid(accessory);
            if (duid) {
                (_a = this.matterVacuums.get(duid)) === null || _a === void 0 ? void 0 : _a.dispose();
                this.matterVacuums.delete(duid);
            }
            const index = this.matterAccessories.findIndex((cachedAccessory) => cachedAccessory.UUID === accessory.UUID);
            if (index >= 0) {
                this.matterAccessories.splice(index, 1);
            }
        }
    }
    generateMatterUuid(duid) {
        var _a;
        const api = this.api;
        const uuidGenerator = ((_a = api.matter) === null || _a === void 0 ? void 0 : _a.uuid) || this.api.hap.uuid;
        return uuidGenerator.generate(`matter:roborock:${duid}`);
    }
    getMatterAccessoryDuid(accessory) {
        if (!(accessory === null || accessory === void 0 ? void 0 : accessory.context)) {
            return null;
        }
        if (typeof accessory.context === "string") {
            return accessory.context;
        }
        if (typeof accessory.context.duid === "string") {
            return accessory.context.duid;
        }
        return null;
    }
}
exports.default = RoborockPlatform;
//# sourceMappingURL=platform.js.map