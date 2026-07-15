import { PlatformConfig } from "homebridge";

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password?: string;
  debugMode: boolean;
  baseURL?: string;
  encryptedToken?: string;
  skipDevices?: string;
  transientWarningThrottleHours?: number;
  enableMatterServiceArea?: boolean;
  enableMatterPowerSource?: boolean;
  enableMatterCleanMode?: boolean;
  enableMatterExtendedOperationalStates?: boolean;
  enableMatterChargingDockedStates?: boolean;
  matterChargedBatteryThreshold?: number;
  cloudOnlyMode?: boolean;
  preferCloudForMatterCommands?: boolean;
}
