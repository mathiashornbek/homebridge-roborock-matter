import { PlatformConfig } from "homebridge";

/**
 * The actions the optional HAP switches can perform.
 *
 * Apple Home does not offer the Matter vacuum's own commands as automation
 * actions — measured by pponce in issue #3 for docking. A plain HomeKit switch
 * is an automation action everywhere, so one switch per action is the way an
 * automation reaches these commands at all.
 *
 * Declared here, not next to the switch, so the accessory and the vacuum can
 * both name the same keys without importing each other.
 */
export const HOMEKIT_ACTION_KEYS = [
  "clean",
  "dock",
  "empty",
  "pause",
  "locate",
] as const;

export type HomeKitActionKey = (typeof HOMEKIT_ACTION_KEYS)[number];

export function isHomeKitActionKey(value: unknown): value is HomeKitActionKey {
  return (
    typeof value === "string" &&
    (HOMEKIT_ACTION_KEYS as readonly string[]).includes(value)
  );
}

/**
 * The robot states the optional read-only HAP sensors mirror.
 *
 * The switches above are inputs an automation *presses*. Apple Home will not
 * accept a Matter vacuum as an automation *trigger* at all — measured by
 * pponce in issue #3 and confirmed by him a second time — so nothing the robot
 * does can start an automation. A contact sensor is a trigger source in every
 * Home client, so mirroring the state onto one is the only way this works.
 *
 * The order is the order pponce ranked them in when asked which state he would
 * actually trigger on: docked first ("I'd use the docked feature on its own for
 * sure"), cleaning second. He also named the pair he wants them for — not
 * docked AND not cleaning means the robot is probably stuck somewhere — which
 * is why both ship together and why no third "stuck" sensor is guessed at: that
 * one is a timeout over these two, and it belongs in his automation where he
 * can pick the timeout, not in a plugin that would pick it for him.
 */
export const HOMEKIT_STATE_SENSOR_KEYS = [
  "docked",
  "cleaning",
  "waterTankEmpty",
] as const;

export type HomeKitStateSensorKey = (typeof HOMEKIT_STATE_SENSOR_KEYS)[number];

export function isHomeKitStateSensorKey(
  value: unknown
): value is HomeKitStateSensorKey {
  return (
    typeof value === "string" &&
    (HOMEKIT_STATE_SENSOR_KEYS as readonly string[]).includes(value)
  );
}

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password?: string;
  debugMode: boolean;
  baseURL?: string;
  encryptedToken?: string;
  skipDevices?: string;
  transientWarningThrottleHours?: number;
  enableMatterServiceArea?: boolean;
  enableLiveRoomTracking?: boolean;
  enableMatterPowerSource?: boolean;
  enableMatterCleanMode?: boolean;
  enableFanPowerCleanModes?: boolean;
  enableMatterExtendedOperationalStates?: boolean;
  enableMatterChargingDockedStates?: boolean;
  enableMatterFaultReporting?: boolean;
  enableMatterTankFaultReporting?: boolean;
  matterChargedBatteryThreshold?: number;
  cloudOnlyMode?: boolean;
  preferCloudForMatterCommands?: boolean;
  enableHomeKitActionSwitches?: boolean;
  homeKitActionSwitches?: string[];
  enableHomeKitStateSensors?: boolean;
  homeKitStateSensors?: string[];
  enableHomeKitScheduleSwitches?: boolean;
  enableHomeKitRoutineSwitches?: boolean;
}
