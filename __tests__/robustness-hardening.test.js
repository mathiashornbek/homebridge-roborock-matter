const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;
const { setTimeout: realSetTimeout } = require("node:timers");

function flush() {
  return new Promise((resolve) => realSetTimeout(resolve, 0));
}

afterEach(() => {
  jest.useRealTimers();
});

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createRoborock(options = {}) {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "roborock-api-test-")),
    ...options,
  });
}

describe("Roborock API status reads never throw", () => {
  test("getVacuumDeviceStatus returns an empty value when the device vanished after schema lookup", () => {
    const api = createRoborock();
    // Simulate the race where the schema id resolves but the device record is
    // gone from HomeData by the time the status read happens.
    api.getVacuumSchemaId = () => 42;

    expect(() => api.getVacuumDeviceStatus("ghost-device", "state")).not.toThrow();
    expect(api.getVacuumDeviceStatus("ghost-device", "state")).toBe("");
  });

  test("getVacuumDeviceStatus handles a device without deviceStatus", async () => {
    const api = createRoborock();
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          { id: "product-1", schema: [{ id: 121, code: "state" }] },
        ],
        devices: [{ duid: "device-1", productId: "product-1" }],
        receivedDevices: [],
      }),
      ack: true,
    });

    expect(api.getVacuumDeviceStatus("device-1", "state")).toBe("");
  });
});

describe("Roborock API commands before device initialization", () => {
  test("startCommand rejects with a classifiable not-ready error when awaiting a result", async () => {
    const api = createRoborock();
    api.bInited = true;

    await expect(
      api.startCommand("unknown-device", "app_start", null, {
        waitForResult: true,
      })
    ).rejects.toMatchObject({
      code: "ROBOROCK_DEVICE_NOT_READY",
      message: expect.stringContaining("is not initialized yet"),
    });
  });

  test("startCommand warns instead of throwing for fire-and-forget commands", async () => {
    const api = createRoborock();
    api.bInited = true;

    await expect(
      api.startCommand("unknown-device", "app_start", null)
    ).resolves.toBeUndefined();
    expect(api.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("is not initialized yet")
    );
  });

  test("getStatus skips quietly when the device runtime does not exist yet", async () => {
    const api = createRoborock();
    api.bInited = true;

    await expect(api.getStatus("unknown-device")).resolves.toBeUndefined();
    expect(api.log.debug).toHaveBeenCalledWith(
      expect.stringContaining("not initialized yet")
    );
    expect(api.log.error).not.toHaveBeenCalled();
  });
});

describe("messageQueueHandler build failures", () => {
  function createAdapter(overrides = {}) {
    return {
      isRemoteDevice: jest.fn().mockResolvedValue(false),
      getRobotVersion: jest.fn().mockResolvedValue("1.0"),
      onlineChecker: jest.fn().mockResolvedValue(true),
      rr_mqtt_connector: {
        isConnected: jest.fn().mockReturnValue(true),
        sendMessage: jest.fn(),
      },
      config: {},
      localConnector: {
        isConnected: jest.fn().mockReturnValue(false),
        sendMessage: jest.fn(),
        clearChunkBuffer: jest.fn(),
      },
      message: {
        buildPayload: jest.fn().mockResolvedValue("payload"),
        buildRoborockMessage: jest.fn().mockResolvedValue(null),
      },
      getRequestId: jest.fn().mockReturnValue(7),
      pendingRequests: new Map(),
      setTimeout: jest.fn((callback) => setTimeout(callback, 5000)),
      clearTimeout: jest.fn((timeout) => clearTimeout(timeout)),
      log: { info: jest.fn(), debug: jest.fn() },
      updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
      catchError: jest.fn(),
      ...overrides,
    };
  }

  test("sendRequest rejects instead of resolving undefined when the message cannot be built", async () => {
    const adapter = createAdapter();
    const handler = new messageQueueHandler(adapter);

    await expect(
      handler.sendRequest("device-1", "app_start", [])
    ).rejects.toThrow(/was not sent/);
    expect(adapter.catchError).toHaveBeenCalled();
    expect(adapter.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
  });
});

function createMatterPlatform({
  status = {},
  matterUpdates = [],
  capabilities = { canVacuum: true, canMop: false },
  appStart = jest.fn().mockResolvedValue(undefined),
  getStatus = jest.fn().mockResolvedValue(undefined),
  updateAccessoryState = jest.fn(async (uuid, cluster, attributes) => {
    matterUpdates.push({ uuid, cluster, attributes });
  }),
} = {}) {
  return {
    platformConfig: {
      enableMatter: true,
      enableMatterServiceArea: true,
      enableMatterPowerSource: true,
      enableMatterCleanMode: true,
      enableMatterExtendedOperationalStates: false,
      preferCloudForMatterCommands: false,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({ updateAccessoryState }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Test Vacuum" : "",
      getProductAttribute: () => "roborock.vacuum.a70",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => capabilities,
      app_start: appStart,
      app_stop: jest.fn().mockResolvedValue(undefined),
      app_pause: jest.fn().mockResolvedValue(undefined),
      app_charge: jest.fn().mockResolvedValue(undefined),
      applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
      find_me: jest.fn().mockResolvedValue(undefined),
      app_segment_clean_by_ids: jest.fn().mockResolvedValue(undefined),
      load_multi_map: jest.fn().mockResolvedValue(undefined),
      getStatus,
    },
  };
}

function createMatterAccessory(platform, isRegistered = true) {
  const accessory = { UUID: "uuid-1", context: { duid: "device-1" } };
  const vacuum = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    isRegistered
  );
  return { accessory, vacuum };
}

describe("Matter dispatch of device-not-ready command failures", () => {
  test("logs a calm warning, no error, and rolls the optimistic state back", async () => {
    const matterUpdates = [];
    const notReady = Object.assign(
      new Error(
        "Roborock device device-1 is not initialized yet; the plugin is still starting up."
      ),
      { code: "ROBOROCK_DEVICE_NOT_READY" }
    );
    const platform = createMatterPlatform({
      matterUpdates,
      status: { state: 8, charge_status: 1, battery: 100 },
      appStart: jest.fn().mockRejectedValue(notReady),
    });
    const { accessory } = createMatterAccessory(platform);

    await accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await flush();
    await flush();

    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("before the Roborock connection finished")
    );
    expect(platform.log.error).not.toHaveBeenCalled();

    const lastOperationalState = [...matterUpdates]
      .reverse()
      .find((update) => update.cluster === "rvcOperationalState");
    expect(lastOperationalState.attributes.operationalState).toBe(0);
  });
});

describe("Matter clean mode capability fallback", () => {
  test("builds clusters without throwing when the API returns undefined capabilities", () => {
    const platform = createMatterPlatform({ capabilities: undefined });
    const { accessory } = createMatterAccessory(platform, false);

    expect(accessory.clusters.rvcCleanMode.supportedModes).toHaveLength(1);
  });
});

describe("Matter heartbeat resilience", () => {
  test("re-arms after a failed heartbeat publish instead of dying", async () => {
    jest.useFakeTimers();

    const matterUpdates = [];
    let failNextPublish = false;
    const updateAccessoryState = jest.fn(async (uuid, cluster, attributes) => {
      if (failNextPublish) {
        throw new Error("transient matter failure");
      }
      matterUpdates.push({ uuid, cluster, attributes });
    });
    const platform = createMatterPlatform({ matterUpdates, updateAccessoryState });
    const { vacuum } = createMatterAccessory(platform);

    // Successful publish arms the heartbeat.
    await vacuum.updateMatterStateFromRoborock();
    const updatesAfterFirstPublish = matterUpdates.length;
    expect(updatesAfterFirstPublish).toBeGreaterThan(0);

    // First heartbeat fires and fails.
    failNextPublish = true;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(matterUpdates.length).toBe(updatesAfterFirstPublish);

    // Without the fix the chain is dead here. With the fix, the next
    // heartbeat still fires and publishes once the transient failure clears.
    failNextPublish = false;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(matterUpdates.length).toBeGreaterThan(updatesAfterFirstPublish);
  });

  test("dispose stops the heartbeat and all further publishes", async () => {
    jest.useFakeTimers();

    const matterUpdates = [];
    const platform = createMatterPlatform({ matterUpdates });
    const { vacuum } = createMatterAccessory(platform);

    await vacuum.updateMatterStateFromRoborock();
    const updatesBeforeDispose = matterUpdates.length;
    expect(updatesBeforeDispose).toBeGreaterThan(0);

    vacuum.dispose();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(matterUpdates.length).toBe(updatesBeforeDispose);

    await vacuum.updateMatterStateFromRoborock();
    expect(matterUpdates.length).toBe(updatesBeforeDispose);
  });
});

describe("catchError formatting without context", () => {
  test("logs the raw message when no attribute/duid is provided", async () => {
    const api = createRoborock();
    await api.catchError("Something specific went wrong");

    expect(api.log.error).toHaveBeenCalledWith("Something specific went wrong");
    const rendered = api.log.error.mock.calls.map((call) => call[0]).join("\n");
    expect(rendered).not.toContain("undefined on robot undefined");
  });

  test("keeps the contextual format when attribute and duid are provided", async () => {
    const api = createRoborock();
    await api.catchError("boom", "get_status", "device-1", "roborock.vacuum.a70");

    expect(api.log.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Failed to execute get_status on robot device-1 (roborock.vacuum.a70)"
      )
    );
  });
});

describe("Matter dispatch also classifies upstream not-initialized errors", () => {
  test("treats 'Vacuum <duid> is not initialized.' as a calm startup race", async () => {
    const matterUpdates = [];
    const upstreamNotReady = new Error("Vacuum device-1 is not initialized.");
    const platform = createMatterPlatform({
      matterUpdates,
      status: { state: 8, charge_status: 1, battery: 100 },
      appStart: jest.fn().mockRejectedValue(upstreamNotReady),
    });
    const { accessory } = createMatterAccessory(platform);

    await accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
    await flush();
    await flush();

    expect(platform.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("before the Roborock connection finished")
    );
    expect(platform.log.error).not.toHaveBeenCalled();
  });
});

describe("Matter charging/docked tile states (opt-in)", () => {
  function platformWithChargingFlag(status, enabled) {
    const matterUpdates = [];
    const platform = createMatterPlatform({ matterUpdates, status });
    platform.platformConfig.enableMatterChargingDockedStates = enabled;
    return { platform, matterUpdates };
  }

  function lastOperationalStateUpdate(matterUpdates) {
    return [...matterUpdates]
      .reverse()
      .find((update) => update.cluster === "rvcOperationalState");
  }

  test("publishes Charging (65) for a charging robot when enabled", async () => {
    const { platform, matterUpdates } = platformWithChargingFlag(
      { state: 8, charge_status: 1, battery: 90 },
      true
    );
    const { vacuum } = createMatterAccessory(platform);

    await vacuum.updateMatterStateFromRoborock();

    const update = lastOperationalStateUpdate(matterUpdates);
    expect(update.attributes.operationalState).toBe(65);
    const advertised = update.attributes.operationalStateList.map(
      (entry) => entry.operationalStateId
    );
    expect(advertised).toEqual(expect.arrayContaining([65, 66]));
  });

  test("publishes Docked (66) for a fully charged robot when enabled", async () => {
    const { platform, matterUpdates } = platformWithChargingFlag(
      { state: 100, charge_status: 0, battery: 100 },
      true
    );
    const { vacuum } = createMatterAccessory(platform);

    await vacuum.updateMatterStateFromRoborock();

    expect(
      lastOperationalStateUpdate(matterUpdates).attributes.operationalState
    ).toBe(66);
  });

  test("keeps reporting Stopped and a basic state list when disabled (default)", async () => {
    const { platform, matterUpdates } = platformWithChargingFlag(
      { state: 8, charge_status: 1, battery: 90 },
      false
    );
    const { vacuum } = createMatterAccessory(platform);

    await vacuum.updateMatterStateFromRoborock();

    const update = lastOperationalStateUpdate(matterUpdates);
    expect(update.attributes.operationalState).toBe(0);
    const advertised = update.attributes.operationalStateList.map(
      (entry) => entry.operationalStateId
    );
    expect(advertised).not.toContain(65);
    expect(advertised).not.toContain(66);
  });
});

describe("HomeData parse memoization and skip enforcement", () => {
  test("returns the same parsed object while HomeData is unchanged, reparses on change", async () => {
    const api = createRoborock();
    const payload = JSON.stringify({
      products: [],
      devices: [{ duid: "device-1", sn: "SN1", name: "Vac 1" }],
      receivedDevices: [],
    });
    await api.setStateAsync("HomeData", { val: payload, ack: true });

    const first = api.getStoredHomeData();
    const second = api.getStoredHomeData();
    expect(second).toBe(first);

    const changed = JSON.stringify({
      products: [],
      devices: [{ duid: "device-2", sn: "SN2", name: "Vac 2" }],
      receivedDevices: [],
    });
    await api.setStateAsync("HomeData", { val: changed, ack: true });
    const third = api.getStoredHomeData();
    expect(third).not.toBe(first);
    expect(third.devices[0].duid).toBe("device-2");
  });

  test("skipDevices removes robots from the device list by duid and by serial", async () => {
    const api = createRoborock({ skipDevices: "device-skip, SNIGNORED" });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [],
        devices: [
          { duid: "device-keep", sn: "SN1", name: "Keeper" },
          { duid: "device-skip", sn: "SN2", name: "Skipped by duid" },
          { duid: "device-3", sn: "SNIGNORED", name: "Skipped by serial" },
        ],
        receivedDevices: [],
      }),
      ack: true,
    });

    const devices = api.getAllHomeDevices();
    expect(devices.map((device) => device.duid)).toEqual(["device-keep"]);
  });

  test("ignored set is cached per config identity", () => {
    const api = createRoborock({ skipDevices: "a, b" });
    const first = api.getIgnoredDeviceSet();
    const second = api.getIgnoredDeviceSet();
    expect(second).toBe(first);

    api.config.skipDevices = "a, b, c";
    const third = api.getIgnoredDeviceSet();
    expect(third).not.toBe(first);
    expect(third.has("c")).toBe(true);
  });
});

describe("Charged battery threshold discriminates Charging vs Docked", () => {
  function platformWithThreshold(status, threshold) {
    const matterUpdates = [];
    const platform = createMatterPlatform({ matterUpdates, status });
    platform.platformConfig.enableMatterChargingDockedStates = true;
    platform.platformConfig.matterChargedBatteryThreshold = threshold;
    return { platform, matterUpdates };
  }

  function lastOpState(matterUpdates) {
    return [...matterUpdates]
      .reverse()
      .find((update) => update.cluster === "rvcOperationalState").attributes
      .operationalState;
  }

  test("keeps showing Charging below the threshold even when the robot claims fully charged", async () => {
    const { platform, matterUpdates } = platformWithThreshold(
      { state: 100, charge_status: 0, battery: 85 },
      90
    );
    const { vacuum } = createMatterAccessory(platform);
    await vacuum.updateMatterStateFromRoborock();
    expect(lastOpState(matterUpdates)).toBe(65);
  });

  test("switches to Docked at the threshold even while the robot still reports charging", async () => {
    const { platform, matterUpdates } = platformWithThreshold(
      { state: 8, charge_status: 1, battery: 92 },
      90
    );
    const { vacuum } = createMatterAccessory(platform);
    await vacuum.updateMatterStateFromRoborock();
    expect(lastOpState(matterUpdates)).toBe(66);
  });

  test("defaults to charging-until-100 when no threshold is configured", async () => {
    const { platform, matterUpdates } = platformWithThreshold(
      { state: 8, charge_status: 1, battery: 99 },
      undefined
    );
    const { vacuum } = createMatterAccessory(platform);
    await vacuum.updateMatterStateFromRoborock();
    expect(lastOpState(matterUpdates)).toBe(65);
  });

  test("falls back to the state-based value when battery is unavailable", async () => {
    const { platform, matterUpdates } = platformWithThreshold(
      { state: 100, charge_status: 0 },
      90
    );
    const { vacuum } = createMatterAccessory(platform);
    await vacuum.updateMatterStateFromRoborock();
    expect(lastOpState(matterUpdates)).toBe(66);
  });
});

describe("Service Area cluster omission without rooms (pairing conformance)", () => {
  test("omits the serviceArea cluster entirely when no rooms are available", () => {
    const platform = createMatterPlatform();
    platform.platformConfig.enableMatterServiceArea = true;
    const { accessory } = createMatterAccessory(platform, false);

    expect(accessory.clusters.serviceArea).toBeUndefined();
  });

  test("exposes the serviceArea cluster when rooms exist", () => {
    const platform = createMatterPlatform();
    platform.platformConfig.enableMatterServiceArea = true;
    platform.roborockAPI.getRoomMappingsForDevice = () => [
      { segmentId: 16, mapId: 0, name: "Stue" },
    ];
    const { accessory } = createMatterAccessory(platform, false);

    expect(accessory.clusters.serviceArea).toBeDefined();
    expect(accessory.clusters.serviceArea.supportedAreas).toHaveLength(1);
  });
});
