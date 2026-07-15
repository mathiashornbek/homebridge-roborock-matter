const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

function createAccessory({
  enableFanPowerCleanModes = false,
  canMop = true,
  canControlFanPower = true,
  canMaxPlusFanPower = false,
  canControlWater = false,
} = {}) {
  const platform = {
    platformConfig: { enableMatter: true, enableFanPowerCleanModes },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => null,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Test Q7" : "",
      getProductAttribute: () => "roborock.vacuum.sc05",
      getVacuumDeviceStatus: () => "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => 0,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop,
        canControlFanPower,
        canMaxPlusFanPower,
        canControlWater,
      }),
    },
  };
  const accessory = { UUID: "uuid-cm", context: { duid: "duid-q7" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-q7" },
    false
  );
  return { instance };
}

describe("opt-in fan-power clean modes", () => {
  test("default off: only the three base modes are announced (existing behavior)", () => {
    const { instance } = createAccessory();
    const cluster = instance.buildCleanModeCluster();
    expect(cluster.supportedModes.map((mode) => mode.mode)).toEqual([0, 1, 2]);
  });

  test("enabled with fan-power control: Quiet/Balanced/Turbo/Max variants are appended", () => {
    const { instance } = createAccessory({ enableFanPowerCleanModes: true });
    const cluster = instance.buildCleanModeCluster();
    const modes = cluster.supportedModes;

    expect(modes.map((mode) => mode.mode)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const byMode = new Map(modes.map((mode) => [mode.mode, mode]));
    expect(byMode.get(3).label).toBe("Quiet Vacuum");
    expect(byMode.get(6).label).toBe("Max Vacuum");
    // Every variant carries the RVC Vacuum tag; Quiet/Max add the matching
    // ModeBase common tag.
    // Every variant carries a DISTINCT intensity tag: Apple Home renders
    // localized names from tags (not labels), so tag-less modes would all
    // display as plain "Vacuum".
    expect(byMode.get(3).modeTags).toEqual([{ value: 16385 }, { value: 2 }]);
    expect(byMode.get(4).modeTags).toEqual([{ value: 16385 }, { value: 0 }]);
    expect(byMode.get(5).modeTags).toEqual([{ value: 16385 }, { value: 1 }]);
    expect(byMode.get(6).modeTags).toEqual([{ value: 16385 }, { value: 7 }]);
    // Labels are unique (Matter conformance).
    const labels = modes.map((mode) => mode.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("enabled but the robot has no fan-power control: no variants", () => {
    const { instance } = createAccessory({
      enableFanPowerCleanModes: true,
      canControlFanPower: false,
    });
    const cluster = instance.buildCleanModeCluster();
    expect(cluster.supportedModes.map((mode) => mode.mode)).toEqual([0, 1, 2]);
  });

  test("selecting a fan-power mode maps to base vacuum type with pinned suction", () => {
    const { instance } = createAccessory({ enableFanPowerCleanModes: true });

    expect(instance.getRoborockCleanModeSettings(3)).toEqual({
      cleanMode: 0,
      fanPower: 101,
    });
    expect(instance.getRoborockCleanModeSettings(6)).toEqual({
      cleanMode: 0,
      fanPower: 104,
    });
    // Base modes keep their existing behavior: mop pins fan power off (105).
    expect(instance.getRoborockCleanModeSettings(1)).toEqual({
      cleanMode: 1,
      fanPower: 105,
    });
  });

  test("fan-power modes count as vacuum-family for the water rule", () => {
    const { instance } = createAccessory({
      enableFanPowerCleanModes: true,
      canControlWater: true,
    });
    const settings = instance.getRoborockCleanModeSettings(5);
    expect(settings.cleanMode).toBe(0);
    expect(settings.fanPower).toBe(103);
    // Pure vacuuming turns the water box off, exactly like base Vacuum mode.
    expect(settings.waterBoxMode).toBe(
      instance.getRoborockCleanModeSettings(0).waterBoxMode
    );
  });

  test("Max+ appears only for robots with a verified fifth suction level (B01/Q7)", () => {
    const b01 = createAccessory({
      enableFanPowerCleanModes: true,
      canMaxPlusFanPower: true,
    });
    const b01Modes = b01.instance.buildCleanModeCluster().supportedModes;
    const maxPlus = b01Modes.find((mode) => mode.mode === 7);
    expect(maxPlus.label).toBe("Max+ Vacuum");
    // RVC Vacuum tag + DeepClean tag (closest semantic match for the boost).
    expect(maxPlus.modeTags).toEqual([{ value: 16385 }, { value: 16384 }]);
    expect(b01.instance.getRoborockCleanModeSettings(7)).toEqual({
      cleanMode: 0,
      fanPower: 108,
    });
    expect(b01.instance.getCleanModeLabel(7)).toBe("Max+ Vacuum");

    // Classic robots without the capability never see mode 7.
    const classic = createAccessory({ enableFanPowerCleanModes: true });
    expect(
      classic.instance.buildCleanModeCluster().supportedModes.map((m) => m.mode)
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("currentMode follows the robot's live fan power (app-side changes reflected)", () => {
    const { instance } = createAccessory({
      enableFanPowerCleanModes: true,
      canMaxPlusFanPower: true,
    });

    // Robot reports Turbo (103) — e.g. changed in the Roborock app.
    instance.rememberLiveStatus("fan_power", 103);
    expect(instance.buildCleanModeCluster().currentMode).toBe(5);

    // Max+ (108) resolves to the Q7-only variant.
    instance.rememberLiveStatus("fan_power", 108);
    expect(instance.buildCleanModeCluster().currentMode).toBe(7);

    // A pending Matter selection wins until it has been applied.
    instance.selectedCleanMode = 6;
    instance.selectedCleanModeNeedsApply = true;
    expect(instance.buildCleanModeCluster().currentMode).toBe(6);
    instance.selectedCleanModeNeedsApply = false;
    expect(instance.buildCleanModeCluster().currentMode).toBe(7);

    // Mop-family selections are never overridden by fan power.
    instance.selectedCleanMode = 1;
    expect(instance.buildCleanModeCluster().currentMode).toBe(1);

    // Unknown fan power falls back to the selection.
    instance.selectedCleanMode = 0;
    instance.rememberLiveStatus("fan_power", 106);
    expect(instance.buildCleanModeCluster().currentMode).toBe(0);
  });

  test("live fan power derivation is inert while the feature is disabled", () => {
    const { instance } = createAccessory();
    instance.rememberLiveStatus("fan_power", 103);
    expect(instance.buildCleanModeCluster().currentMode).toBe(0);
  });

  test("labels used in logs match the announced mode labels", () => {
    const { instance } = createAccessory({ enableFanPowerCleanModes: true });
    expect(instance.getCleanModeLabel(3)).toBe("Quiet Vacuum");
    expect(instance.getCleanModeLabel(5)).toBe("Turbo Vacuum");
    expect(instance.getCleanModeLabel(1)).toBe("Mop");
  });
});
