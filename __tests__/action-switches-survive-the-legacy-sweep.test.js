"use strict";

// discoverDevices() has always ended with a sweep that unregisters every
// cached HAP accessory, without looking at what it was. That was correct for
// exactly as long as this plugin registered none: the Matter-only rebuild had
// to delete the legacy fan and helper-switch accessories, and a user who
// upgraded mid-way would otherwise keep a duplicate robot in Apple Home
// forever.
//
// The action switches are the first HAP accessories this plugin has published
// since. Shipped against the old sweep they would have been registered on
// startup and deleted on the next one — a switch that works until the first
// restart and then silently disappears from every automation that uses it —
// and the log line would have gone on calling them legacy accessories the
// whole time.
//
// The partition is on the context marker rather than the accessory's name,
// because a name is editable in the Home app and a marker is not.

const RoborockPlatform = require("../src/platform").default;
const { ACTION_SWITCH_KIND } = require("../src/action_switch_accessory");

function legacyAccessory(uuid, displayName) {
  return { UUID: uuid, displayName, context: {} };
}

function actionSwitch(duid, action, displayName) {
  return {
    UUID: `uuid-${duid}-${action}`,
    displayName,
    context: { duid, kind: ACTION_SWITCH_KIND, action },
  };
}

function createPlatform(accessories) {
  const platform = Object.create(RoborockPlatform.prototype);

  platform.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  platform.accessories = accessories;
  platform.unregistered = [];
  platform.api = {
    unregisterPlatformAccessories: jest.fn((_plugin, _platform, list) => {
      platform.unregistered.push(...list.map((entry) => entry.UUID));
    }),
  };

  return platform;
}

describe("the Matter-only sweep spares the action switches", () => {
  test("legacy accessories go, action switches stay", () => {
    const platform = createPlatform([
      legacyAccessory("uuid-legacy-fan", "Vicky"),
      actionSwitch("device-1", "dock", "Vicky Return to Dock"),
      legacyAccessory("uuid-legacy-pause", "Vicky Pause Cleaning"),
      actionSwitch("device-2", "pause", "Bob Pause"),
    ]);

    platform.removeLegacyHomeKitAccessories();

    expect(platform.unregistered.sort()).toEqual([
      "uuid-legacy-fan",
      "uuid-legacy-pause",
    ]);
    expect(platform.accessories.map((entry) => entry.UUID).sort()).toEqual([
      "uuid-device-1-dock",
      "uuid-device-2-pause",
    ]);
  });

  test("the log line counts what was actually removed", () => {
    const platform = createPlatform([
      legacyAccessory("uuid-legacy-fan", "Vicky"),
      actionSwitch("device-1", "dock", "Vicky Return to Dock"),
    ]);

    platform.removeLegacyHomeKitAccessories();

    // "removing 2 legacy HomeKit accessories" while deleting one of them and
    // keeping the other is the version of this bug that survives a green test
    // suite, because the accessory count is the only place the mistake shows.
    expect(platform.log.info).toHaveBeenCalledWith(
      expect.stringContaining("removing 1 legacy HomeKit accessory ")
    );
  });

  test("a cache holding only action switches is left completely alone", () => {
    const platform = createPlatform([
      actionSwitch("device-1", "dock", "Vicky Return to Dock"),
    ]);

    platform.removeLegacyHomeKitAccessories();

    expect(platform.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    expect(platform.log.info).not.toHaveBeenCalled();
    expect(platform.accessories).toHaveLength(1);
  });

  test("an accessory that merely looks like a switch is still swept", () => {
    // The tempting shortcut is to spare anything named "… Return to Dock".
    // A user who renames the legacy accessory to that in the Home app would
    // then keep it forever, and a user who renames the real switch to
    // "Hoover" would lose it.
    const platform = createPlatform([
      legacyAccessory("uuid-impostor", "Vicky Return to Dock"),
      { ...actionSwitch("device-1", "dock", "Hoover") },
    ]);

    platform.removeLegacyHomeKitAccessories();

    expect(platform.unregistered).toEqual(["uuid-impostor"]);
    expect(platform.accessories).toHaveLength(1);
    expect(platform.accessories[0].displayName).toBe("Hoover");
  });

  test.each([
    ["no context at all", undefined],
    ["a Matter accessory's context", { duid: "device-1" }],
    ["the marker but no duid", { kind: ACTION_SWITCH_KIND, action: "dock" }],
    ["the marker but no action", { kind: ACTION_SWITCH_KIND, duid: "d" }],
  ])("%s does not buy an accessory a reprieve", (_label, context) => {
    const platform = createPlatform([
      { UUID: "uuid-x", displayName: "Something", context },
    ]);

    platform.removeLegacyHomeKitAccessories();

    expect(platform.unregistered).toEqual(["uuid-x"]);
    expect(platform.accessories).toHaveLength(0);
  });
});
