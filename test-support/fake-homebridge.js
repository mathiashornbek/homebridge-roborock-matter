"use strict";

// The Homebridge API object a platform plugin is constructed with, built from
// Homebridge's own pieces where they exist: the real hap-nodejs (Service,
// Characteristic, uuid, HapStatusError) and the real PlatformAccessory class
// from the Homebridge dev dependency. Only the bridge side — registration,
// the Matter API, the event bus — is recorded rather than run.

const path = require("path");

const homebridgeDir = path.dirname(require.resolve("homebridge/package.json"));
const hap = require(require.resolve("hap-nodejs", { paths: [homebridgeDir] }));
const { PlatformAccessory } = require(
  path.join(homebridgeDir, "lib", "platformAccessory")
);

/**
 * @param {{storagePath: string}} options
 */
function createFakeHomebridge({ storagePath }) {
  const listeners = new Map();
  const matter = {
    deviceTypes: { RoboticVacuumCleaner: "RoboticVacuumCleaner" },
    uuid: hap.uuid,
    registered: [],
    registerPlatformAccessories: jest.fn(async (_plugin, _platform, list) => {
      matter.registered.push(...list);
    }),
    updatePlatformAccessories: jest.fn(async () => undefined),
    unregisterPlatformAccessories: jest.fn(async () => undefined),
    updateAccessoryState: jest.fn(async () => undefined),
  };

  const api = {
    hap,
    platformAccessory: PlatformAccessory,
    user: { storagePath: () => storagePath },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) || []), listener]);
      return api;
    },
    isMatterEnabled: () => true,
    matter,
    registerPlatformAccessories: jest.fn(),
    updatePlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
  };

  function emit(event) {
    for (const listener of listeners.get(event) || []) {
      listener();
    }
  }

  const homebridgeLog = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  };

  return { api, emit, matter, hap, PlatformAccessory, homebridgeLog };
}

module.exports = { createFakeHomebridge };
