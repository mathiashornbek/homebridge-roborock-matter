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
  matterChargedBatteryThreshold?: number;
  cloudOnlyMode?: boolean;
  preferCloudForMatterCommands?: boolean;
  enableHomeKitActionSwitches?: boolean;
  homeKitActionSwitches?: string[];
}
