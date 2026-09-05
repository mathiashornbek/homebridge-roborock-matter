import {
  API,
  APIEvent,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from "homebridge";

import RoborockMatterVacuumAccessory from "./matter_vacuum_accessory";
import RoborockActionSwitchAccessory, {
  ACTION_SWITCH_KIND,
  ActionSwitchContext,
  actionSwitchUuidSeed,
  getActionSwitchDefinition,
  isActionSwitchAccessory,
} from "./action_switch_accessory";
import RoborockStateSensorAccessory, {
  STATE_SENSOR_KIND,
  StateSensorContext,
  getStateSensorDefinition,
  isStateSensorAccessory,
  stateSensorUuidSeed,
} from "./state_sensor_accessory";
import RoborockHapScheduleAccessory, {
  isHapRoutineAccessory,
  isHapScheduleAccessory,
  ScheduleAccountCoordinator,
} from "./hap_schedule_accessory";

import RoborockPlatformLogger from "./logger";
import {
  HomeKitActionKey,
  HomeKitStateSensorKey,
  isHomeKitActionKey,
  isHomeKitStateSensorKey,
  RoborockPlatformConfig,
} from "./types";
import { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME, PLUGIN_NAME } from "./settings";
import { decryptSession } from "./crypto";
import { readFileSync } from "node:fs";

const DEP0040_CODE = "DEP0040";
let dep0040FilterInstalled = false;
const DEFAULT_TRANSIENT_WARNING_THROTTLE_HOURS = 6;

function installDeprecationWarningFilter(): void {
  if (dep0040FilterInstalled) {
    return;
  }

  dep0040FilterInstalled = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  let dep0040Logged = false;

  process.emitWarning = ((
    warning: string | Error,
    type?: string,
    code?: string,
    ctor?: Function
  ): void => {
    const warningCode =
      typeof warning === "object" && warning !== null && "code" in warning
        ? String((warning as { code?: string }).code)
        : code;

    if (warningCode === DEP0040_CODE) {
      if (!dep0040Logged) {
        dep0040Logged = true;
        process.stderr.write(
          "[Roborock Vacuum] Suppressed Node.js DEP0040 warning from upstream dependency.\n"
        );
      }
      return;
    }

    (originalEmitWarning as (...args: unknown[]) => void)(
      warning,
      type,
      code,
      ctor
    );
  }) as typeof process.emitWarning;
}

installDeprecationWarningFilter();

const Roborock = require("../roborockLib/roborockAPI").Roborock;
const { getModelNameWithoutBrand } =
  require("../roborockLib/lib/deviceFeatures") as {
    getModelNameWithoutBrand: (model: unknown) => string | null;
  };
const { redactSecrets } = require("../roborockLib/lib/redactSecrets") as {
  redactSecrets: (value: unknown) => unknown;
};

/**
 * Roborock App Platform Plugin for Homebridge
 * Based on https://github.com/homebridge/homebridge-plugin-template
 */
export default class RoborockPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  // Used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  private readonly matterAccessories: any[] = [];
  private readonly matterVacuums: Map<string, RoborockMatterVacuumAccessory> =
    new Map();
  /** Optional HAP action switches, keyed `<duid>:<action>`. */
  private readonly actionSwitches: Map<string, RoborockActionSwitchAccessory> =
    new Map();
  /** Optional read-only HAP state sensors, keyed `<duid>:<sensor>`. */
  private readonly stateSensors: Map<string, RoborockStateSensorAccessory> =
    new Map();
  /** Optional HAP schedule accessories, keyed by vacuum duid. */
  private readonly hapScheduleAccessories: Map<
    string,
    RoborockHapScheduleAccessory
  > = new Map();
  private readonly scheduleAccountCoordinator: ScheduleAccountCoordinator;
  private schedulePolicyLogged = false;
  private matterUnavailableLogged = false;
  private hapPairingHintLogged = false;

  public readonly roborockAPI: any;
  public readonly log: RoborockPlatformLogger;

  public platformConfig: RoborockPlatformConfig;

  /**
   * This constructor is where you should parse the user config
   * and discover/register accessories with Homebridge.
   *
   * @param logger Homebridge logger
   * @param config Homebridge platform config
   * @param api Homebridge API
   */
  constructor(
    homebridgeLogger: Logger,
    config: PlatformConfig,
    // Public because the action-switch accessories build their services from
    // this.api.hap; everything else on the platform is still reached through
    // the narrow helpers below.
    public readonly api: API
  ) {
    this.platformConfig = config as RoborockPlatformConfig;

    // Initialise logging utility
    this.log = new RoborockPlatformLogger(
      homebridgeLogger,
      this.platformConfig.debugMode
    );
    this.scheduleAccountCoordinator = new ScheduleAccountCoordinator();
    // Create Roborock App communication module

    const username = this.platformConfig.email;
    const password = this.platformConfig.password;
    const baseURL = this.platformConfig.baseURL;
    const debugMode = this.platformConfig.debugMode;
    const transientWarningThrottleHours =
      this.normalizeTransientWarningThrottleHours(
        this.platformConfig.transientWarningThrottleHours
      );

    const storagePath = this.api.user.storagePath();
    const decryptedSession = this.platformConfig.encryptedToken
      ? decryptSession(this.platformConfig.encryptedToken, storagePath)
      : null;

    this.roborockAPI = new Roborock({
      username: username,
      password: password,
      debug: debugMode,
      baseURL: baseURL,
      skipDevices: this.platformConfig.skipDevices,
      enableMatterServiceArea:
        this.platformConfig.enableMatterServiceArea !== false,
      enableLiveRoomTracking:
        this.platformConfig.enableLiveRoomTracking !== false,
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
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      this.log.debug("Finished launching and restored cached accessories.");
      this.configurePlugin();
    });

    if (this.platformConfig.enableMatter === false) {
      this.log.info(
        "Matter-only edition: the legacy 'enableMatter' setting is ignored; robots are always published via Matter."
      );
    }

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.debug("Shutting down...");

      // EVERY STEP IS INDEPENDENT, BECAUSE THIS USED TO BE A STRAIGHT LINE.
      //
      // One throwing `dispose()` skipped everything after it, including
      // `stopService()` — which is the step that stops the polling intervals
      // and closes both transports. A shutdown that half-runs is worse than
      // one that fails loudly: the bridge goes away and the plugin's timers
      // and sockets do not.
      const step = (what: string, run: () => void): void => {
        try {
          run();
        } catch (error) {
          this.log.debug(
            `Shutdown step "${what}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      };

      // Stop Matter background work first so no heartbeat or deferred publish
      // fires into a bridge that is tearing down.
      for (const vacuum of this.matterVacuums.values()) {
        step("matter vacuum dispose", () => vacuum.dispose());
      }

      for (const actionSwitch of this.actionSwitches.values()) {
        step("action switch dispose", () => actionSwitch.dispose());
      }

      for (const stateSensor of this.stateSensors.values()) {
        step("state sensor dispose", () => stateSensor.dispose());
      }

      for (const schedule of this.hapScheduleAccessories.values()) {
        step("schedule shutdown", () => schedule.shutdown());
      }

      if (this.roborockAPI) {
        step("stopService", () => {
          void Promise.resolve(this.roborockAPI.stopService()).catch(
            (error) => {
              this.log.debug(
                `stopService rejected during shutdown: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
          );
        });
      }
    });
  }

  async configurePlugin() {
    await this.loginAndDiscoverDevices();
  }

  private normalizeTransientWarningThrottleHours(value: unknown): number {
    const parsed =
      typeof value === "number"
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
      this.log.error(
        "Email is not configured - aborting plugin start. " +
          "Please set the field `email` in your config and restart Homebridge."
      );
      return;
    }

    if (!this.platformConfig.password && !this.platformConfig.encryptedToken) {
      this.log.error(
        "Password is not configured - aborting plugin start. " +
          "Please set `password` or complete login in the Config UI."
      );
      return;
    }

    const self = this;

    self.roborockAPI.setDeviceNotify(function (id, homeData) {
      self.dispatchDeviceUpdate(id, homeData);
    });

    // Belt and braces: no rejection from the service startup may ever
    // escape as an unhandled rejection (Homebridge 2 / Node 22+ would
    // treat that as a plugin crash).
    Promise.resolve(
      self.roborockAPI.startService(function () {
        // startService() invokes this callback on the failure path too — the
        // getHomeDetail catch logs and falls through — so an unconditional
        // "Service started" asserted success directly underneath the line
        // saying it had failed.
        if (self.roborockAPI.isInited()) {
          self.log.debug("Roborock service started.");
        } else {
          self.log.warn(
            "Roborock startup did not complete, so no robots were loaded this time. The reason is in the line above. Anything already paired in Apple Home is left alone, and the plugin tries again on the next Homebridge restart."
          );
        }
        self.discoverDevices();
      })
    ).catch((error: unknown) => {
      self.log.error(
        `Roborock service failed to start: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  private dispatchDeviceUpdate(id: string, homeData: unknown): void {
    // HomeData payloads can be tens of kilobytes and arrive continuously.
    // Only pay the JSON.stringify cost when debug logging is actually on —
    // and never print the robots' localKeys or serials: this is the line
    // people paste into GitHub issues, and until 3.29.0 it carried both.
    if (this.platformConfig?.debugMode) {
      this.log.debug(
        `${id} notifyDeviceUpdater:${JSON.stringify(redactSecrets(homeData))}`
      );
    }
    if (
      typeof this.roborockAPI.recordRoborockDiagnosticMessage === "function"
    ) {
      this.roborockAPI.recordRoborockDiagnosticMessage(id, homeData);
    }

    if (id === "DeviceCapabilities") {
      this.reconcileActionSwitchesAfterCapabilityUpdate(homeData);
      return;
    }

    const scopedDuid = this.getScopedLiveMessageDuid(id, homeData);
    if (scopedDuid) {
      this.notifyVacuumByDuid(scopedDuid, id, homeData);
      return;
    }

    if (
      this.isLiveDeviceMessage(id) &&
      !this.shouldAcceptUnscopedLiveMessage()
    ) {
      this.log.debug(
        `Ignoring unscoped ${id} update because multiple Roborock vacuums are configured.`
      );
      return;
    }

    for (const vacuum of this.matterVacuums.values()) {
      this.notifyMatter(vacuum, id, homeData);
    }
  }

  /**
   * Re-run the existing action-switch reconciliation after a live status poll
   * has finished applying model capabilities such as an S7's auto-empty dock.
   */
  private reconcileActionSwitchesAfterCapabilityUpdate(data: unknown): void {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return;
    }

    const duid = String((data as Record<string, unknown>).duid ?? "");
    if (!duid || !this.matterVacuums.has(duid)) {
      return;
    }

    const devices =
      typeof this.roborockAPI.getVacuumList === "function"
        ? this.roborockAPI.getVacuumList()
        : [];
    this.syncActionSwitches(Array.isArray(devices) ? devices : [], duid);
  }

  private notifyVacuumByDuid(
    duid: string,
    id: string,
    homeData: unknown
  ): void {
    const matterVacuum = this.matterVacuums.get(duid);
    if (matterVacuum) {
      this.notifyMatter(matterVacuum, id, homeData);
    }
  }

  private notifyMatter(
    vacuum: RoborockMatterVacuumAccessory,
    id: string,
    homeData: unknown
  ): void {
    vacuum.notifyDeviceUpdater(id, homeData).catch((error) => {
      this.log.debug("Error updating Matter vacuum state: " + error);
    });
  }

  private getScopedLiveMessageDuid(id: string, data: unknown): string | null {
    if (!this.isLiveDeviceMessage(id)) {
      return null;
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }

    const message = data as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(message, "duid") &&
      Object.prototype.hasOwnProperty.call(message, "payload") &&
      message.duid
    ) {
      return String(message.duid);
    }

    return null;
  }

  private isLiveDeviceMessage(id: string): boolean {
    return id === "CloudMessage" || id === "LocalMessage";
  }

  public shouldAcceptUnscopedLiveMessage(): boolean {
    return this.getConfiguredVacuumDuidCount() <= 1;
  }

  private getConfiguredVacuumDuidCount(): number {
    const duids = new Set<string>();
    const devices =
      typeof this.roborockAPI.getVacuumList === "function"
        ? this.roborockAPI.getVacuumList()
        : [];

    if (Array.isArray(devices)) {
      for (const device of devices) {
        if (device?.duid) {
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
  configureAccessory(accessory: PlatformAccessory) {
    // Once per cached accessory, and Homebridge already summarises the cache
    // restore. Three robots with three switches each would be nine info lines
    // saying nothing happened. (3.6.0 demoted the Matter twin below and lost
    // this one to a failed batch edit — caught in the field the same hour.)
    this.log.debug(`Loading accessory '${accessory.displayName}' from cache.`);

    // Store restored accessory in the cached accessories list
    // remove duplicates accessories

    try {
      const existingAccessory = this.accessories.find(
        (a) => a.UUID === accessory.UUID
      );
      if (existingAccessory) {
        this.log.info(
          `Removing duplicate accessory '${existingAccessory.displayName}' from cache.`
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          existingAccessory,
        ]);
      }
    } catch (e) {
      this.log.error("Error loading accessory from cache: " + e);
    }

    this.accessories.push(accessory);
  }

  /**
   * Homebridge 2 calls this for cached Matter accessories. Keep this optional
   * and runtime-typed so Homebridge 1.x users remain fully supported.
   */
  configureMatterAccessory(accessory: any) {
    // Once per cached accessory, and Homebridge already summarises the cache
    // restore. Three robots with three switches each would be nine info lines
    // saying nothing happened.
    this.log.debug(
      `Loading Matter accessory '${accessory.displayName}' from cache.`
    );
    this.matterAccessories.push(accessory);

    const duid = this.getMatterAccessoryDuid(accessory);
    if (!duid) {
      return;
    }

    const matter = this.getMatterApi();
    if (!matter?.deviceTypes?.RoboticVacuumCleaner) {
      return;
    }

    accessory.deviceType = matter.deviceTypes.RoboticVacuumCleaner;
    this.applyMatterAccessoryIdentity(accessory, {
      duid,
      name: accessory.displayName,
    });
    this.createOrUpdateMatterVacuum(
      { duid, name: accessory.displayName },
      accessory,
      true
    );
  }

  isSupportedDevice(model: string): boolean {
    return this.roborockAPI.isSupportedVacuumModel(model);
  }

  /**
   * Fetches all of the user's devices from Roborock App and sets up handlers.
   *
   * Accessories must only be registered once. Previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices() {
    this.log.debug("Discovering vacuum devices...");

    try {
      const self = this;
      let devices: any[] = [];

      this.log.debug(
        `Discovery state: roborockAPI.isInited()=${self.roborockAPI.isInited()}`
      );

      if (self.roborockAPI.isInited()) {
        devices = self.roborockAPI.getVacuumList();

        this.log.debug(
          `Discovery retrieved ${
            Array.isArray(devices) ? devices.length : "non-array"
          } device(s) from getVacuumList().`
        );

        // Every robot is published as a native Matter vacuum. The only HAP
        // accessories this plugin registers are the opt-in action switches
        // below; the robot itself never appears over HomeKit.
        for (const device of devices) {
          await self.discoverMatterVacuum(device);
        }
      } else {
        this.log.warn(
          "Discovery skipped Matter/schedule setup because Roborock API is not initialized."
        );
      }

      // At this point, we set up all devices from Roborock App, but we did not unregister
      // cached devices that do not exist on the Roborock App account anymore.
      // Matter-only migration: unregister every cached HomeKit accessory
      // (the legacy fan + helper switches) so robots appear exactly once —
      // as Matter vacuums — in Apple Home.
      this.removeLegacyHomeKitAccessories();

      const knownDevices = Array.isArray(devices) ? devices : [];
      this.syncHapSchedules(knownDevices);
      this.syncActionSwitches(knownDevices);
      this.syncStateSensors(knownDevices);
      // After both syncs, so the count is the total a user has to find in
      // Apple Home rather than one kind's share of it.
      this.logHapPairingHint();

      await this.unregisterStaleMatterAccessories();
    } catch (error) {
      this.log.error(
        "An error occurred during device discovery. " +
          "Turn on debug mode for more information."
      );
      this.log.debug(error);
    }
  }

  /**
   * Bring the HAP schedule accessories in line with the current Roborock
   * account. Schedule accessories are intentionally kept separate from
   * Mathias's Matter implementation and from the HAP action switches.
   *
   * An empty device list is treated as untrustworthy because it can result
   * from a temporary Roborock/cloud failure. Never remove schedule
   * accessories merely because discovery returned no devices.
   */
  /**
   * Schedule groups are controlled by the same Home app switch master as the
   * other optional HAP switches. "schedules" is intentionally not part of
   * HomeKitActionKey because it does not represent a Roborock command.
   */
  private shouldExposeHapSchedules(): boolean {
    return (
      this.platformConfig.enableHomeKitActionSwitches === true &&
      this.platformConfig.enableHomeKitScheduleSwitches === true
    );
  }

  /**
   * Routine switches ride on the same coordinator and the same master
   * setting as the schedules: one momentary switch per Routine in the app,
   * grouped in a "<robot> Routines" accessory (#22).
   */
  private shouldExposeHapRoutines(): boolean {
    return (
      this.platformConfig.enableHomeKitActionSwitches === true &&
      this.platformConfig.enableHomeKitRoutineSwitches === true
    );
  }

  private removeHapScheduleAccessories(): void {
    const scheduleAccessories = this.accessories.filter(
      (accessory) =>
        isHapScheduleAccessory(accessory) || isHapRoutineAccessory(accessory)
    );

    for (const schedule of this.hapScheduleAccessories.values()) {
      schedule.removeRoutineServices();
      schedule.removeScheduleServices();
    }

    this.hapScheduleAccessories.clear();

    for (const accessory of scheduleAccessories) {
      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }

    if (scheduleAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        scheduleAccessories
      );
    }
  }

  /** Unregister every "<robot> Routines" accessory and drop its switches. */
  private removeHapRoutineAccessories(): void {
    for (const schedule of this.hapScheduleAccessories.values()) {
      schedule.removeRoutineServices();
    }

    const routineAccessories = this.accessories.filter((accessory) =>
      isHapRoutineAccessory(accessory)
    );
    for (const accessory of routineAccessories) {
      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }
    if (routineAccessories.length > 0) {
      this.api.unregisterPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        routineAccessories
      );
    }
  }

  private routineAccessoryUuid(duid: string): string {
    return this.api.hap.uuid.generate(`hap:roborock:routines:${duid}`);
  }

  /**
   * Hand a robot's coordinator its "<robot> Routines" accessory — the cached
   * one when Homebridge restored it, a fresh unregistered one otherwise — and
   * let the coordinator say, after every scene reading, whether the accessory
   * has switches. It is registered the first time it has one and unregistered
   * when a trustworthy reading says the account has none, so an empty
   * accessory never shows up as a tile with nothing on it.
   */
  private attachRoutineAccessory(
    duid: string,
    vacuumName: string,
    schedule: RoborockHapScheduleAccessory
  ): void {
    const uuid = this.routineAccessoryUuid(duid);
    let accessory = this.accessories.find(
      (cached) => cached.UUID === uuid && isHapRoutineAccessory(cached)
    );
    if (!accessory) {
      accessory = new this.api.platformAccessory(
        `${vacuumName} Routines`,
        uuid
      );
    }
    const routineAccessory = accessory;

    schedule.attachRoutineAccessory(routineAccessory, (count) => {
      const registered = this.accessories.includes(routineAccessory);
      if (count > 0 && !registered) {
        this.accessories.push(routineAccessory);
        this.log.info(
          `Adding HAP routine accessory '${routineAccessory.displayName}' with ${count} switch${count === 1 ? "" : "es"}.`
        );
        this.api.registerPlatformAccessories(
          HAP_PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          [routineAccessory]
        );
      } else if (count === 0 && registered) {
        const index = this.accessories.indexOf(routineAccessory);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
        this.log.info(
          `Removing HAP routine accessory '${routineAccessory.displayName}': the account has no Routines for this robot.`
        );
        this.api.unregisterPlatformAccessories(
          HAP_PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          [routineAccessory]
        );
      }
    });
  }

  private syncHapSchedules(devices: any[]): void {
    const exposeSchedules = this.shouldExposeHapSchedules();
    const exposeRoutines = this.shouldExposeHapRoutines();

    // The master HAP-switch setting owns the entire HAP switch surface.
    // If it is disabled, schedule accessories must be completely removed
    // rather than merely having their dynamic services disposed.
    if (!this.platformConfig.enableHomeKitActionSwitches) {
      this.removeHapScheduleAccessories();
      return;
    }

    if (!exposeRoutines) {
      this.removeHapRoutineAccessories();
    }

    // The schedules sub-setting only controls schedule exposure. Keep the
    // coordinator cached so schedules can be rebuilt when re-enabled.
    if (!exposeSchedules) {
      for (const schedule of this.hapScheduleAccessories.values()) {
        schedule.setScheduleExposure(false);
        schedule.removeScheduleServices();
      }

      if (!exposeRoutines) {
        return;
      }
    }

    if (!this.schedulePolicyLogged) {
      this.schedulePolicyLogged = true;
      this.log.info(this.scheduleAccountCoordinator.policyDescription());
    }

    // An empty device list is normally a temporary Roborock/cloud failure.
    // Never remove schedule accessories because discovery temporarily
    // returned no devices.
    if (devices.length === 0) {
      return;
    }

    const wanted = new Map<string, { duid: string; vacuumName: string }>();

    for (const device of devices) {
      const duid = String(device?.duid ?? "");
      if (!duid) {
        continue;
      }

      wanted.set(duid, {
        duid,
        vacuumName: this.getVacuumDisplayName(duid, device),
      });
    }

    // Remove schedule groups only when we have a trustworthy non-empty
    // account result and the robot genuinely disappeared.
    const obsolete = this.accessories.filter((accessory) => {
      if (
        !isHapScheduleAccessory(accessory) &&
        !isHapRoutineAccessory(accessory)
      ) {
        return false;
      }

      const context = accessory.context as { duid?: string };
      return !context.duid || !wanted.has(context.duid);
    });

    if (obsolete.length > 0) {
      for (const accessory of obsolete) {
        const duid = (accessory.context as { duid?: string }).duid;

        if (duid) {
          const schedule = this.hapScheduleAccessories.get(duid);
          schedule?.removeRoutineServices();
          schedule?.removeScheduleServices();
          this.hapScheduleAccessories.delete(duid);
        }

        const index = this.accessories.indexOf(accessory);
        if (index >= 0) {
          this.accessories.splice(index, 1);
        }
      }

      this.api.unregisterPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        obsolete
      );
    }

    for (const [duid, target] of wanted) {
      let schedule = this.hapScheduleAccessories.get(duid);

      if (schedule) {
        schedule.setScheduleExposure(exposeSchedules);
        if (exposeRoutines) {
          this.attachRoutineAccessory(duid, target.vacuumName, schedule);
        }
        void schedule
          .initialize(target.vacuumName)
          .then((result) => {
            if (result.success && result.hasSchedules) {
              return;
            }

            if (!result.success) {
              this.log.info(
                `Schedule restoration attempt for ${target.vacuumName}: refresh failed; invoking restoreScheduleHandlersFromAccessory().`
              );

              const restored = schedule!.restoreScheduleHandlersFromAccessory();

              this.log.info(
                `Schedule restoration result for ${target.vacuumName}: restored=${restored}.`
              );

              this.log.debug(
                `Unable to refresh Roborock schedules for ${target.vacuumName}; preserving restored schedule accessories.`
              );
              return;
            }

            const accessory = this.accessories.find(
              (candidate) =>
                candidate.UUID ===
                  this.api.hap.uuid.generate(
                    `hap:roborock:schedules:${duid}`
                  ) && isHapScheduleAccessory(candidate)
            );

            this.removeHapScheduleAccessory(duid, accessory);
          })
          .catch((error: unknown) => {
            const restored = schedule!.restoreScheduleHandlersFromAccessory();

            if (!restored) {
              const accessory = this.accessories.find(
                (candidate) =>
                  candidate.UUID ===
                    this.api.hap.uuid.generate(
                      `hap:roborock:schedules:${duid}`
                    ) && isHapScheduleAccessory(candidate)
              );

              this.removeHapScheduleAccessory(duid, accessory);
            }

            this.log.debug(
              `Unable to refresh Roborock schedules for ${target.vacuumName}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        continue;
      }

      const uuid = this.api.hap.uuid.generate(`hap:roborock:schedules:${duid}`);

      let accessory = this.accessories.find(
        (cached) => cached.UUID === uuid && isHapScheduleAccessory(cached)
      );

      const isNew = !accessory;

      if (!accessory) {
        accessory = new this.api.platformAccessory(
          `${target.vacuumName} schedules`,
          uuid
        );
      }

      schedule = new RoborockHapScheduleAccessory(
        this,
        accessory,
        duid,
        this.scheduleAccountCoordinator
      );
      schedule.setScheduleExposure(exposeSchedules);

      this.hapScheduleAccessories.set(duid, schedule);

      if (exposeRoutines) {
        this.attachRoutineAccessory(duid, target.vacuumName, schedule);
      }

      void schedule
        .initialize(target.vacuumName)
        .then((result) => {
          if (!result.success) {
            this.log.info(
              `Schedule startup restoration attempt for ${target.vacuumName}: refresh failed; invoking restoreScheduleHandlersFromAccessory().`
            );

            const restored = schedule!.restoreScheduleHandlersFromAccessory();

            this.log.info(
              `Schedule startup restoration result for ${target.vacuumName}: restored=${restored}.`
            );

            if (!restored && !this.coordinatorKeepsRoutines(schedule!)) {
              this.hapScheduleAccessories.delete(duid);
            }

            return;
          }

          if (!result.hasSchedules) {
            if (!this.coordinatorKeepsRoutines(schedule!)) {
              this.hapScheduleAccessories.delete(duid);
            }
            return;
          }

          if (!this.accessories.includes(accessory!)) {
            this.accessories.push(accessory!);
          }

          if (isNew) {
            this.log.info(
              `Adding HAP schedule accessory '${target.vacuumName} schedules'.`
            );

            this.api.registerPlatformAccessories(
              HAP_PLUGIN_IDENTIFIER,
              PLATFORM_NAME,
              [accessory!]
            );
          }
        })
        .catch((error: unknown) => {
          // A first-time offline/error response must not create a broken
          // "Not Supported" schedule tile.
          this.removeHapScheduleAccessory(duid, accessory);

          this.log.error(
            `Unable to initialize Roborock schedules for ${target.vacuumName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    }
  }

  /**
   * A coordinator whose schedule half came back empty still has work when it
   * drives a Routines accessory, so it must stay in the map — dropping it
   * would orphan the routine switches' handlers.
   */
  private coordinatorKeepsRoutines(
    schedule: RoborockHapScheduleAccessory
  ): boolean {
    return this.shouldExposeHapRoutines() && schedule.routineCount > 0;
  }

  private removeHapScheduleAccessory(
    duid: string,
    accessory?: PlatformAccessory
  ): void {
    const schedule = this.hapScheduleAccessories.get(duid);
    schedule?.removeScheduleServices();
    if (!schedule || !this.coordinatorKeepsRoutines(schedule)) {
      this.hapScheduleAccessories.delete(duid);
    }

    if (!accessory) {
      return;
    }

    const index = this.accessories.indexOf(accessory);
    if (index >= 0) {
      this.accessories.splice(index, 1);
      this.api.unregisterPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        [accessory]
      );
    }
  }

  /**
   * Unregister every cached HAP accessory that is not one of ours.
   *
   * This sweep is older than the action switches and used to take the whole
   * cache without looking: the Matter-only rebuild removed the legacy fan and
   * helper-switch accessories, and a user who upgraded mid-way would otherwise
   * keep a duplicate robot in Apple Home forever. Registering a new HAP
   * accessory under that rule would have deleted it on the very next restart —
   * and the log line would have gone on calling it a legacy accessory while it
   * did so. The partition is by the context marker, not by name, because a
   * name is user-editable in the Home app and the marker is not.
   *
   * It asks isOwnHapAccessory rather than naming one kind: the sweep predates
   * every accessory this plugin registers and will predate the next one too, so
   * "is it one of ours" is the question that stays right. Adding the state
   * sensors against a check for action switches specifically would have
   * reproduced the original bug exactly one release later.
   */
  private removeLegacyHomeKitAccessories(): void {
    const legacy = this.accessories.filter(
      (accessory) => !this.isOwnHapAccessory(accessory)
    );

    if (legacy.length === 0) {
      return;
    }

    this.log.info(
      `Matter-only edition: removing ${legacy.length} legacy HomeKit accessor${legacy.length === 1 ? "y" : "ies"} (robots are published via Matter only).`
    );
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, legacy);

    for (const accessory of legacy) {
      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }
  }

  /**
   * Whether a cached HAP accessory is one this plugin registered.
   *
   * The single answer to that question, so every sweep and every sync asks it
   * the same way. Each kind's own sync then narrows to its own kind — a state
   * sensor must survive the action-switch sync and the other way round, and
   * before this existed the switch sync would have unregistered every sensor on
   * sight, because a sensor has no `action` in its context and therefore looked
   * like a switch for an action nobody had enabled.
   */
  private isOwnHapAccessory(accessory: { context?: unknown }): boolean {
    return (
      isActionSwitchAccessory(accessory) ||
      isStateSensorAccessory(accessory) ||
      isHapScheduleAccessory(accessory) ||
      isHapRoutineAccessory(accessory)
    );
  }

  /**
   * Which action switches the user has asked for.
   *
   * Off unless the master switch is explicitly on: this adds accessories to
   * somebody's Home app, which is not something a plugin update should do by
   * itself. With the master on and no list saved, "dock" is the default,
   * because that is the one Apple Home cannot do any other way (issue #3).
   */
  private getEnabledActionSwitchKeys(): HomeKitActionKey[] {
    if (this.platformConfig.enableHomeKitActionSwitches !== true) {
      return [];
    }

    const configured = this.platformConfig.homeKitActionSwitches;
    if (!Array.isArray(configured)) {
      return ["dock"];
    }

    return [...new Set(configured.filter(isHomeKitActionKey))];
  }

  /**
   * Bring the registered action switches in line with the config and the
   * account, adding what is missing and removing what is no longer wanted.
   */
  private syncActionSwitches(
    devices: any[],
    capabilityConfirmedForDuid?: string
  ): void {
    const enabled = this.getEnabledActionSwitchKeys();

    // Only this kind. The shared this.accessories list also carries the state
    // sensors, and every rule below is about actions.
    const mine = this.accessories.filter((accessory) =>
      isActionSwitchAccessory(accessory)
    );

    // The disabled path costs one config read and one length check. Nothing
    // below runs, no accessory is built, and nothing is scheduled.
    if (enabled.length === 0 && mine.length === 0) {
      return;
    }

    // A cached switch has already acquired HomeKit identity outside this
    // process: its custom name, room, Home View choice and automations all
    // belong to that accessory UUID. Some S7 HomeData payloads omit dock
    // capability until the first live status poll, so absence here is not yet
    // proof that an existing Empty Bin switch is obsolete.
    const cachedKeys = new Set(
      mine.map((accessory) => {
        const context = accessory.context as Partial<ActionSwitchContext>;
        return `${context?.duid}:${context?.action}`;
      })
    );

    const wanted = new Map<
      string,
      { duid: string; action: HomeKitActionKey; vacuumName: string }
    >();

    for (const device of devices) {
      const duid = String(device?.duid ?? "");
      if (!duid) {
        continue;
      }

      const vacuum = this.matterVacuums.get(duid);
      const vacuumName = this.getVacuumDisplayName(duid, device);

      for (const action of enabled) {
        const definition = getActionSwitchDefinition(action);
        if (!definition) {
          continue;
        }

        const key = `${duid}:${action}`;
        if (vacuum && !vacuum.supportsHomeKitAction(action)) {
          const preservePendingEmptyBin =
            action === "empty" &&
            capabilityConfirmedForDuid !== duid &&
            cachedKeys.has(key);

          if (!preservePendingEmptyBin) {
            this.log.debug(
              `Not publishing the ${definition.nameSuffix} switch for ${vacuumName}: the robot does not support that command.`
            );
            continue;
          }

          this.log.debug(
            `Preserving the cached ${definition.nameSuffix} switch for ${vacuumName} until live dock capability is known.`
          );
        }

        wanted.set(key, { duid, action, vacuumName });
      }
    }

    // An empty device list is almost always a temporary cloud or network
    // failure rather than an emptied account — the same trap
    // unregisterStaleMatterAccessories documents. Removing a switch a
    // disabled setting no longer asks for is safe either way, because that
    // decision comes from the config and not from the cloud.
    const accountIsTrustworthy = devices.length > 0;
    const obsolete = mine.filter((accessory) => {
      const context = accessory.context as Partial<ActionSwitchContext>;
      const key = `${context?.duid}:${context?.action}`;
      if (wanted.has(key)) {
        return false;
      }

      const stillEnabled =
        typeof context?.action === "string" &&
        enabled.includes(context.action as HomeKitActionKey);

      return !stillEnabled || accountIsTrustworthy;
    });

    if (obsolete.length > 0) {
      this.removeActionSwitches(obsolete);
    }

    for (const [key, target] of wanted) {
      const existing = this.actionSwitches.get(key);
      if (existing) {
        // The robot may have been renamed in the Roborock app since the last
        // start; the switch follows it rather than keeping the old name.
        existing.updateIdentity(target.vacuumName);
        continue;
      }

      this.addActionSwitch(key, target.duid, target.action, target.vacuumName);
    }
  }

  /**
   * Which read-only state sensors the user has asked for.
   *
   * Same opt-in shape as the switches, and off unless explicitly on for the
   * same reason: this adds accessories to somebody's Home app. With the master
   * on and no list saved, "docked" is the default — that is the one pponce
   * ranked first in issue #3 when asked which state he would trigger on, and
   * the one he said he would use on its own.
   */
  private getEnabledStateSensorKeys(): HomeKitStateSensorKey[] {
    if (this.platformConfig.enableHomeKitStateSensors !== true) {
      return [];
    }

    const configured = this.platformConfig.homeKitStateSensors;
    if (!Array.isArray(configured)) {
      return ["docked"];
    }

    return [...new Set(configured.filter(isHomeKitStateSensorKey))];
  }

  /**
   * Bring the registered state sensors in line with the config and the account.
   *
   * A near-copy of syncActionSwitches, and deliberately not shared with it. The
   * two differ in the parts that matter — no capability gate here, because
   * every robot has a dock and a run mode, whereas `locate` is optional — and
   * folding them into one generic sweep would put a partition rule on the same
   * accessory list that both kinds depend on for their own survival. That
   * partition is exactly what removeLegacyHomeKitAccessories got wrong once
   * already, and the duplication is cheaper than getting it wrong for a third
   * accessory kind.
   */
  private syncStateSensors(devices: any[]): void {
    const enabled = this.getEnabledStateSensorKeys();

    const mine = this.accessories.filter((accessory) =>
      isStateSensorAccessory(accessory)
    );

    if (enabled.length === 0 && mine.length === 0) {
      return;
    }

    const wanted = new Map<
      string,
      { duid: string; sensor: HomeKitStateSensorKey; vacuumName: string }
    >();

    for (const device of devices) {
      const duid = String(device?.duid ?? "");
      if (!duid) {
        continue;
      }

      const vacuumName = this.getVacuumDisplayName(duid, device);

      for (const sensor of enabled) {
        if (!getStateSensorDefinition(sensor)) {
          continue;
        }

        wanted.set(`${duid}:${sensor}`, { duid, sensor, vacuumName });
      }
    }

    // Same trap as the switches: an empty device list is far more often a
    // temporary cloud failure than an emptied account, so a sensor is only
    // removed on the cloud's word when the cloud said something.
    const accountIsTrustworthy = devices.length > 0;
    const obsolete = mine.filter((accessory) => {
      const context = accessory.context as Partial<StateSensorContext>;
      const key = `${context?.duid}:${context?.sensor}`;
      if (wanted.has(key)) {
        return false;
      }

      const stillEnabled =
        typeof context?.sensor === "string" &&
        enabled.includes(context.sensor as HomeKitStateSensorKey);

      return !stillEnabled || accountIsTrustworthy;
    });

    if (obsolete.length > 0) {
      this.removeStateSensors(obsolete);
    }

    for (const [key, target] of wanted) {
      const existing = this.stateSensors.get(key);
      if (existing) {
        existing.updateIdentity(target.vacuumName);
        continue;
      }

      this.addStateSensor(key, target.duid, target.sensor, target.vacuumName);
    }

    // A sensor registered from cache has no reading yet and answers from the
    // value it persisted. Ask the robot once here so a robot that was already
    // polled before discovery finished does not wait for the next poll.
    for (const duid of new Set(
      [...wanted.values()].map((target) => target.duid)
    )) {
      this.refreshStateSensorsForRobot(duid);
    }
  }

  /**
   * Push the robot's current state into its sensors.
   *
   * Called from the vacuum's publish path rather than on a timer of its own: a
   * second poller would be a second source of truth for the same values, and
   * the publish path is the one place every Roborock-driven change already
   * passes through. Cheap enough to call unconditionally — refresh() returns
   * immediately when the value has not moved, which is the common case.
   */
  refreshStateSensorsForRobot(duid: string): void {
    if (this.stateSensors.size === 0) {
      return;
    }

    const vacuum = this.matterVacuums.get(duid);
    if (!vacuum) {
      return;
    }

    for (const [key, sensor] of this.stateSensors) {
      if (!key.startsWith(`${duid}:`)) {
        continue;
      }

      sensor.refresh(vacuum.getHomeKitStateSensorValue(sensor.sensor));
    }
  }

  private removeStateSensors(accessories: PlatformAccessory[]): void {
    for (const accessory of accessories) {
      const context = accessory.context as Partial<StateSensorContext>;
      this.log.info(
        `Removing the '${accessory.displayName}' sensor; it is no longer enabled or its robot is gone.`
      );

      const key = `${context?.duid}:${context?.sensor}`;
      this.stateSensors.get(key)?.dispose();
      this.stateSensors.delete(key);

      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }

    this.api.unregisterPlatformAccessories(
      HAP_PLUGIN_IDENTIFIER,
      PLATFORM_NAME,
      accessories
    );
  }

  private addStateSensor(
    key: string,
    duid: string,
    sensor: HomeKitStateSensorKey,
    vacuumName: string
  ): void {
    const definition = getStateSensorDefinition(sensor);
    if (!definition) {
      return;
    }

    const name = `${vacuumName} ${definition.nameSuffix}`;

    const uuid = this.api.hap.uuid.generate(stateSensorUuidSeed(duid, sensor));
    const context: StateSensorContext = {
      duid,
      kind: STATE_SENSOR_KIND,
      sensor,
    };

    let accessory = this.accessories.find((cached) => cached.UUID === uuid);
    const isNew = !accessory;

    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.accessories.push(accessory);
    }

    accessory.displayName = name;
    // Merge rather than replace: a cached sensor carries the last value it
    // reported, and dropping that would make the sensor move on the first poll
    // after every restart — the thing an automation triggers on.
    accessory.context = { ...(accessory.context ?? {}), ...context };

    const stateSensor = new RoborockStateSensorAccessory(
      this,
      accessory,
      definition,
      duid
    );
    this.stateSensors.set(key, stateSensor);

    if (isNew) {
      this.log.info(`Adding the '${name}' sensor — it ${definition.summary}.`);
      this.api.registerPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        [accessory]
      );
    }
  }

  /**
   * The `_bridge` block for this platform, read from config.json.
   *
   * It cannot be read from the config object Homebridge hands the platform:
   * childBridgeFork deletes the key before the plugin is loaded, with the
   * comment "some plugins do not like unknown config". 3.5.3 assumed it was
   * there, and the line it produced on a child bridge confidently pointed the
   * user at the main Homebridge QR code — the exact wrong instruction, in the
   * release written to stop exactly that. Measured on a live server within
   * minutes of shipping.
   *
   * So it is read from disk, from the platform block whose `platform` matches
   * this one. The schema is singular, so there is exactly one. Anything
   * unexpected returns null and the caller says the honest general thing
   * rather than a confident specific one.
   */
  private readOwnBridgeConfig(): {
    name?: string;
    hap?: { enabled?: boolean };
  } | null {
    try {
      const configPath = this.api.user?.configPath?.();
      if (!configPath) {
        return null;
      }

      const raw = readFileSync(configPath, "utf8");
      const platforms = JSON.parse(raw)?.platforms;
      if (!Array.isArray(platforms)) {
        return null;
      }

      const own = platforms.find(
        (entry) => entry?.platform === PLATFORM_NAME
      ) as Record<string, unknown> | undefined;
      const bridge = own?._bridge;

      return bridge && typeof bridge === "object"
        ? (bridge as { name?: string; hap?: { enabled?: boolean } })
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Say, once per start, which QR code makes this plugin's HAP accessories
   * appear.
   *
   * This is the single most likely way the feature disappoints somebody, and
   * it disappoints them silently: the accessories register, the log says they
   * were added, Homebridge is happy — and Apple Home never shows them, because
   * they go out over HAP while this plugin's users have only ever paired the
   * robot over Matter. A Matter-only setup can also carry
   * `hap: { enabled: false }` on the plugin's child bridge, which was
   * reasonable while this plugin published nothing over HAP; in that state no
   * QR code anywhere helps until HAP is switched back on.
   *
   * It counts both kinds and is called once after both syncs, because the
   * problem it warns about is a property of the bridge, not of the accessory:
   * a user with the sensors on and the switches off is in exactly the same
   * situation, and a hint tied to one feature would have left them without it.
   */
  private logHapPairingHint(): void {
    const parts: string[] = [];
    if (this.actionSwitches.size > 0) {
      parts.push(
        `${this.actionSwitches.size} switch${this.actionSwitches.size === 1 ? "" : "es"}`
      );
    }
    if (this.stateSensors.size > 0) {
      parts.push(
        `${this.stateSensors.size} sensor${this.stateSensors.size === 1 ? "" : "s"}`
      );
    }

    // A user who never turned either feature on must not be told how to pair
    // accessories that do not exist.
    if (parts.length === 0) {
      return;
    }

    if (this.hapPairingHintLogged) {
      return;
    }
    this.hapPairingHintLogged = true;

    const published = `${parts.join(" and ")} for the robots`;
    const where =
      "Homebridge UI -> Plugins -> homebridge-roborock-matter -> Child Bridge Config";
    const notThese =
      "not the main Homebridge QR code, and not the robot's Matter pairing code, which covers the vacuum only";
    const bridge = this.readOwnBridgeConfig();

    if (!bridge) {
      // Either the plugin runs on the main bridge, or the config could not be
      // read. Both get the same line, because the alternative is asserting one
      // of them and being wrong half the time.
      this.log.info(
        `${published} published over HomeKit, which is a different pairing from the robot's Matter one. If they do not show up in Apple Home, the bridge carrying them is not paired yet: on a child bridge that is ${where} -> Connect to HomeKit, and otherwise it is the QR code on the Homebridge UI status page. Either way it is ${notThese}.`
      );
      return;
    }

    const bridgeName = bridge.name || "this plugin's child bridge";

    if (bridge.hap?.enabled === false) {
      this.log.warn(
        `${published} published, but HAP is turned OFF for '${bridgeName}', so Apple Home cannot see them at all and no QR code will help until that changes. ${where} -> Enable HAP, then restart Homebridge. After the restart, pair the bridge from that same screen with Connect to HomeKit and scan THAT QR code — ${notThese}.`
      );
      return;
    }

    this.log.info(
      `${published} published on '${bridgeName}'. A child bridge is paired with Apple Home separately from the rest of Homebridge, so if they do not show up: ${where} -> Connect to HomeKit, and scan THAT QR code — ${notThese}.`
    );
  }

  private removeActionSwitches(accessories: PlatformAccessory[]): void {
    for (const accessory of accessories) {
      const context = accessory.context as Partial<ActionSwitchContext>;
      this.log.info(
        `Removing the '${accessory.displayName}' switch; it is no longer enabled or its robot is gone.`
      );

      const key = `${context?.duid}:${context?.action}`;
      this.actionSwitches.get(key)?.dispose();
      this.actionSwitches.delete(key);

      const index = this.accessories.indexOf(accessory);
      if (index >= 0) {
        this.accessories.splice(index, 1);
      }
    }

    this.api.unregisterPlatformAccessories(
      HAP_PLUGIN_IDENTIFIER,
      PLATFORM_NAME,
      accessories
    );
  }

  private addActionSwitch(
    key: string,
    duid: string,
    action: HomeKitActionKey,
    vacuumName: string
  ): void {
    const definition = getActionSwitchDefinition(action);
    if (!definition) {
      return;
    }

    const name = `${vacuumName} ${definition.nameSuffix}`;

    const uuid = this.api.hap.uuid.generate(actionSwitchUuidSeed(duid, action));
    const context: ActionSwitchContext = {
      duid,
      kind: ACTION_SWITCH_KIND,
      action,
    };

    let accessory = this.accessories.find((cached) => cached.UUID === uuid);
    const isNew = !accessory;

    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.accessories.push(accessory);
    }

    accessory.displayName = name;
    accessory.context = context;

    const actionSwitch = new RoborockActionSwitchAccessory(
      this,
      accessory,
      definition,
      duid
    );
    this.actionSwitches.set(key, actionSwitch);

    if (isNew) {
      this.log.info(
        `Adding the '${name}' switch — one press ${definition.summary}.`
      );
      this.api.registerPlatformAccessories(
        HAP_PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        [accessory]
      );
    }
  }

  getMatterVacuum(duid: string): RoborockMatterVacuumAccessory | undefined {
    return this.matterVacuums.get(duid);
  }

  /**
   * The model as a human should read it: "Qrevo S", not
   * "roborock.vacuum.a104" (#10).
   *
   * De-branded, because every caller sets `manufacturer = "Roborock"` on the
   * same accessory — see the note on getModelNameWithoutBrand.
   *
   * Display only — see the note on MODEL_MARKETING_NAMES. Anything that
   * *compares* a model must keep reading `getProductAttribute` directly, and a
   * test enumerates that rule rather than trusting this comment.
   */
  getVacuumModel(duid: string): string {
    const reported = this.roborockAPI.getProductAttribute(duid, "model");
    return getModelNameWithoutBrand(reported) || reported || "Roborock Vacuum";
  }

  getVacuumSerialNumber(duid: string): string {
    return this.roborockAPI.getVacuumDeviceInfo(duid, "sn") || duid;
  }

  private getVacuumDisplayName(duid: string, device?: any): string {
    return (
      this.roborockAPI.getVacuumDeviceInfo(duid, "name") ||
      this.matterVacuums.get(duid)?.getDisplayName() ||
      device?.name ||
      "Roborock Vacuum"
    );
  }

  getMatterApi(): any | null {
    // Matter-only edition: Matter publication is unconditional; availability
    // depends solely on the Homebridge Matter API being present.
    const api = this.api as any;
    const matterEnabled =
      typeof api.isMatterEnabled === "function"
        ? api.isMatterEnabled()
        : Boolean(api.matter);

    if (!matterEnabled || !api.matter) {
      if (!this.matterUnavailableLogged) {
        this.matterUnavailableLogged = true;
        this.log.info(
          "Matter vacuum exposure is enabled in plugin settings, but Matter is not enabled for this Homebridge bridge, so no vacuum will appear in Apple Home. This plugin is Matter-only — there is no HomeKit accessory to fall back to. Enable Matter for this bridge in the Homebridge UI (Settings -> Matter) and restart."
        );
      }

      return null;
    }

    return api.matter;
  }

  private async discoverMatterVacuum(device: any): Promise<void> {
    const matter = this.getMatterApi();
    if (!matter) {
      return;
    }

    if (!matter.deviceTypes?.RoboticVacuumCleaner) {
      this.log.warn(
        "Matter is enabled, but this Homebridge version does not expose the robotic vacuum device type yet."
      );
      return;
    }

    const uuid = this.generateMatterUuid(device.duid);
    const existingAccessory = this.matterAccessories.find(
      (accessory) => accessory.UUID === uuid
    );
    const accessory =
      existingAccessory ||
      this.createMatterAccessory(
        device,
        matter.deviceTypes.RoboticVacuumCleaner
      );
    const vacuum = this.createOrUpdateMatterVacuum(
      device,
      accessory,
      Boolean(existingAccessory)
    );

    if (existingAccessory) {
      await matter.updatePlatformAccessories([accessory]);
      await this.deliverKnownLiveStatus(String(device.duid), vacuum);
      vacuum.scheduleMatterStateRefresh("cached accessory update", 1000);
      return;
    }

    this.log.info(
      `Adding Matter vacuum accessory '${accessory.displayName}' (${uuid}).`
    );
    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
    this.matterAccessories.push(accessory);
    vacuum.markRegistered();
    await this.deliverKnownLiveStatus(String(device.duid), vacuum);
    vacuum.scheduleMatterStateRefresh("accessory registration", 1000);
  }

  /**
   * Hand an accessory that has just become usable the robot's real status, if
   * one is already known.
   *
   * The robot's status can be known a full poll gap before anything is able to
   * display it. Discovery runs in the startService callback, so a status that
   * arrives first is dropped by whichever gate it reaches — no accessory for
   * the duid yet, or an accessory whose `registered` is still false — and
   * nothing redelivers it. The tile then fell back on the HomeData snapshot and
   * stated a status the robot was not in until the next poll tick corrected it:
   * measured at 28 seconds after every restart, on both Q7s on the
   * maintainer's own account, publishing operationalState=0 runMode=0
   * cleanMode=0 for a robot that had already reported itself charging in its
   * dock one second earlier.
   *
   * Replayed on the live-message channel instead of being published from here,
   * so this frame is interpreted by the same code that interprets every other
   * frame. There is no second opinion about the same bytes to keep in step.
   *
   * Called AFTER markRegistered() for exactly the reason the bug exists: a seed
   * delivered while `registered` is false is dropped without a trace, and the
   * resulting test looks green because nothing happens.
   *
   * Both discovery paths get it, not just the one that was measured. A cached
   * accessory is re-attached after the same callback and has the same hole,
   * differing only in that the guard which drops the frame is the missing map
   * entry rather than the registration flag.
   */
  private async deliverKnownLiveStatus(
    duid: string,
    vacuum: RoborockMatterVacuumAccessory
  ): Promise<void> {
    const api = this.roborockAPI as unknown as {
      getLastKnownLiveStatus?: (duid: string) => unknown;
    };
    if (typeof api.getLastKnownLiveStatus !== "function") {
      return;
    }

    const status = api.getLastKnownLiveStatus(duid);
    if (!status) {
      return;
    }

    try {
      await vacuum.notifyDeviceUpdater("CloudMessage", {
        duid,
        payload: [status],
      });
    } catch (error) {
      // A seed is an optimisation over waiting for the next tick, never a
      // precondition for discovery: a robot that fails to take it must still
      // finish being discovered.
      this.log.debug(
        `Unable to seed ${this.roborockAPI.describeDevice(duid)} from its last known status: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private createMatterAccessory(device: any, deviceType: unknown): any {
    const duid = String(device.duid);
    const accessory = {
      UUID: this.generateMatterUuid(duid),
      deviceType,
      context: { duid },
    };

    this.applyMatterAccessoryIdentity(accessory, device);
    return accessory;
  }

  private applyMatterAccessoryIdentity(accessory: any, device: any): void {
    const duid = String(device.duid);
    const displayName =
      this.roborockAPI.getVacuumDeviceInfo(duid, "name") ||
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
    accessory.model = this.getVacuumModel(duid);
    accessory.features = {
      ...(accessory.features || {}),
      rvcCleanMode: {
        ...(accessory.features?.rvcCleanMode || {}),
        directModeChange: this.platformConfig.enableMatterCleanMode !== false,
      },
    };
    accessory.context = { ...(accessory.context || {}), duid };

    if (firmwareRevision) {
      accessory.firmwareRevision = firmwareRevision;
    } else {
      delete accessory.firmwareRevision;
    }
  }

  private createOrUpdateMatterVacuum(
    device: any,
    accessory: any,
    isRegistered: boolean
  ): RoborockMatterVacuumAccessory {
    const duid = String(device.duid);
    const existing = this.matterVacuums.get(duid);

    if (existing) {
      existing.updateMetadata(device);
      return existing;
    }

    const vacuum = new RoborockMatterVacuumAccessory(
      this,
      accessory,
      device,
      isRegistered
    );
    this.matterVacuums.set(duid, vacuum);
    // Attached once, for the vacuum's whole life: this is the only place a
    // vacuum is constructed and they are never replaced. Costs nothing when no
    // state sensors are configured, because the refresh returns immediately.
    vacuum.setStateListener(() => this.refreshStateSensorsForRobot(duid));
    return vacuum;
  }

  private async unregisterStaleMatterAccessories(): Promise<void> {
    const api = this.api as any;
    const matter = api.matter;
    if (!matter || typeof matter.unregisterPlatformAccessories !== "function") {
      return;
    }

    // A failed startup surfaces here as "the account has no robots": when
    // getHomeDetail() throws (Roborock maintenance, a rate-limited response,
    // or plain DNS failure — EAI_AGAIN hit this log twice in three weeks) the
    // error is caught and logged, but the discovery callback still runs, so
    // getVacuumList() returns an empty array. Treating that as "everything is
    // stale" unregisters every Matter accessory, and because Matter locks the
    // mode list at commissioning, the user then has to re-pair every single
    // robot — a destructive, non-recoverable outcome triggered by one bad
    // cloud response. Leaving a genuinely removed robot in place until the
    // next successful discovery is by far the cheaper mistake.
    if (!this.roborockAPI.isInited()) {
      this.log.debug(
        "Skipping stale-accessory cleanup: the Roborock API is not initialised yet, so the device list cannot be trusted."
      );
      return;
    }

    const knownDevices = this.roborockAPI.getVacuumList();
    if (!Array.isArray(knownDevices) || knownDevices.length === 0) {
      this.log.warn(
        "Skipping stale-accessory cleanup: the Roborock account reported no robots. " +
          "This is almost always a temporary cloud or network failure, and unregistering " +
          "the Matter accessories here would force you to re-pair every robot. If you have " +
          "genuinely removed all robots from your account, remove the accessories manually."
      );
      return;
    }

    const currentMatterUuids = new Set(
      knownDevices
        .filter((device) =>
          this.isSupportedDevice(
            this.roborockAPI.getProductAttribute(device.duid, "model")
          )
        )
        .map((device) => this.generateMatterUuid(device.duid))
    );

    const staleAccessories = this.matterAccessories.filter(
      (accessory) => !currentMatterUuids.has(accessory.UUID)
    );

    if (staleAccessories.length === 0) {
      return;
    }

    for (const accessory of staleAccessories) {
      this.log.info(
        `Unregistering stale Matter accessory "${accessory.displayName}" (${this.getMatterAccessoryDuid(accessory) || "unknown duid"}); the robot is skipped or no longer in the account.`
      );
    }

    await matter.unregisterPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      staleAccessories
    );

    for (const accessory of staleAccessories) {
      const duid = this.getMatterAccessoryDuid(accessory);
      if (duid) {
        this.matterVacuums.get(duid)?.dispose();
        this.matterVacuums.delete(duid);
      }

      const index = this.matterAccessories.findIndex(
        (cachedAccessory) => cachedAccessory.UUID === accessory.UUID
      );
      if (index >= 0) {
        this.matterAccessories.splice(index, 1);
      }
    }
  }

  private generateMatterUuid(duid: string): string {
    const api = this.api as any;
    const uuidGenerator = api.matter?.uuid || this.api.hap.uuid;
    return uuidGenerator.generate(`matter:roborock:${duid}`);
  }

  private getMatterAccessoryDuid(accessory: any): string | null {
    if (!accessory?.context) {
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
