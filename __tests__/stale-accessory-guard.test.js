"use strict";

// A failed startup reaches unregisterStaleMatterAccessories as "the account
// has no robots": startService() logs "Failed to get home details" and still
// invokes the discovery callback, so getVacuumList() returns []. Unregistering
// on that basis removes every Matter accessory, and because Matter locks the
// mode list at commissioning the user must re-pair every robot — destructive
// and not fixed by a restart. Mathias' own Homebridge log hit that catch twice
// in three weeks (2026-07-21 and 2026-07-22, both DNS EAI_AGAIN).

const RoborockPlatform = require("../src/platform").default;

function createPlatform({ inited = true, devices = [] } = {}) {
  const platform = Object.create(RoborockPlatform.prototype);

  platform.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  platform.roborockAPI = {
    isInited: jest.fn(() => inited),
    getVacuumList: jest.fn(() => devices),
    getProductAttribute: jest.fn(() => "roborock.vacuum.a70"),
  };
  platform.unregisterCalls = [];
  platform.api = {
    matter: {
      unregisterPlatformAccessories: jest.fn(async (_p, _n, accessories) => {
        platform.unregisterCalls.push(accessories.map((a) => a.UUID));
      }),
    },
  };
  platform.isSupportedDevice = jest.fn(() => true);
  platform.generateMatterUuid = jest.fn((duid) => `uuid-${duid}`);
  platform.getMatterAccessoryDuid = jest.fn(
    (accessory) => accessory.context?.duid
  );
  platform.matterAccessories = [
    {
      UUID: "uuid-device-1",
      displayName: "Vicky",
      context: { duid: "device-1" },
    },
    {
      UUID: "uuid-device-2",
      displayName: "Bob",
      context: { duid: "device-2" },
    },
  ];
  platform.matterVacuums = new Map([
    ["device-1", { dispose: jest.fn() }],
    ["device-2", { dispose: jest.fn() }],
  ]);

  return platform;
}

describe("stale Matter accessories are never removed on bad data", () => {
  test("an empty device list does NOT unregister anything", async () => {
    const platform = createPlatform({ inited: true, devices: [] });

    await platform.unregisterStaleMatterAccessories();

    expect(
      platform.api.matter.unregisterPlatformAccessories
    ).not.toHaveBeenCalled();
    expect(platform.matterAccessories).toHaveLength(2);
    expect(platform.matterVacuums.size).toBe(2);
    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reported no robots")
    );
  });

  test("an uninitialised API does NOT unregister anything", async () => {
    const platform = createPlatform({
      inited: false,
      devices: [{ duid: "device-1" }],
    });

    await platform.unregisterStaleMatterAccessories();

    expect(
      platform.api.matter.unregisterPlatformAccessories
    ).not.toHaveBeenCalled();
    expect(platform.matterAccessories).toHaveLength(2);
  });

  test("a non-array device list does NOT unregister anything", async () => {
    const platform = createPlatform({ inited: true, devices: undefined });

    await platform.unregisterStaleMatterAccessories();

    expect(
      platform.api.matter.unregisterPlatformAccessories
    ).not.toHaveBeenCalled();
  });

  test("a genuinely removed robot is still cleaned up", async () => {
    // The feature must keep working: device-2 is gone from the account while
    // device-1 is still there.
    const platform = createPlatform({
      inited: true,
      devices: [{ duid: "device-1" }],
    });

    await platform.unregisterStaleMatterAccessories();

    expect(platform.unregisterCalls).toEqual([["uuid-device-2"]]);
    expect(platform.matterAccessories.map((a) => a.UUID)).toEqual([
      "uuid-device-1",
    ]);
    expect(platform.matterVacuums.has("device-2")).toBe(false);
    expect(platform.matterVacuums.has("device-1")).toBe(true);
  });

  test("nothing happens when every accessory is still current", async () => {
    const platform = createPlatform({
      inited: true,
      devices: [{ duid: "device-1" }, { duid: "device-2" }],
    });

    await platform.unregisterStaleMatterAccessories();

    expect(
      platform.api.matter.unregisterPlatformAccessories
    ).not.toHaveBeenCalled();
    expect(platform.matterAccessories).toHaveLength(2);
  });
});
