"use strict";

jest.mock("../src/hap_schedule_api.ts", () => ({
  getServerTimers: jest.fn(),
  updateServerTimer: jest.fn(),
  updateTimer: jest.fn(),
}));

const { getServerTimers } = require("../src/hap_schedule_api.ts");
const scheduleModule = require("../src/hap_schedule_accessory.ts");
const RoborockHapScheduleAccessory = scheduleModule.default;
const { ScheduleAccountCoordinator, scheduleFailureBackoffMs } = scheduleModule;

function makeCoordinator() {
  const coordinator = Object.create(RoborockHapScheduleAccessory.prototype);

  coordinator.platform = {
    roborockAPI: {},
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
    },
  };

  coordinator.duid = "device-1";
  coordinator.scheduleAccessories = new Map();
  coordinator.managerAccessory = {};
  coordinator.vacuumName = "Test Vacuum";
  coordinator.managerRemoved = false;
  coordinator.cachedSchedules = undefined;
  coordinator.lastScheduleRefreshAt = 0;
  coordinator.lastFailedRefreshAt = 0;
  coordinator.consecutiveRefreshFailures = 0;
  coordinator.nextRefreshAttemptAt = 0;
  coordinator.scheduleBackoffRandom = () => 0.5;
  coordinator.accountCoordinator = new ScheduleAccountCoordinator();
  coordinator.writeBatcher = { cancelPending: jest.fn() };
  coordinator.refreshInProgress = undefined;
  coordinator.refreshInProgressStartedAt = 0;
  coordinator.refreshGeneration = 0;
  coordinator.sync = jest.fn();

  return coordinator;
}

describe("HAP schedule coordinator cache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("backoff jitter is bounded around each progressive delay", () => {
    expect(scheduleFailureBackoffMs(1, 0)).toBe(54_000);
    expect(scheduleFailureBackoffMs(1, 0.5)).toBe(60_000);
    expect(scheduleFailureBackoffMs(1, 1)).toBe(66_000);
    expect(scheduleFailureBackoffMs(5, 0.5)).toBe(3_600_000);
    expect(scheduleFailureBackoffMs(99, 0.5)).toBe(3_600_000);
  });

  test("fresh cache does not make another cloud request", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now();

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);

    expect(getServerTimers).not.toHaveBeenCalled();
    expect(coordinator.sync).not.toHaveBeenCalled();
  });

  test("stale cache makes one cloud request and updates the snapshot", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 301000;

    getServerTimers.mockResolvedValue([
      ["timer-1", "off"],
      ["timer-2", "on"],
    ]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(getServerTimers).toHaveBeenCalledWith(
      coordinator.platform.roborockAPI,
      "device-1",
      {
        requestTimeoutMs: 10000,
      }
    );
    expect(coordinator.sync).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).toHaveBeenCalledWith([
      {
        id: "timer-1",
        enabled: false,
        timer: ["timer-1", "off"],
      },
      {
        id: "timer-2",
        enabled: true,
        timer: ["timer-2", "on"],
      },
    ]);
  });

  test("concurrent refreshes share one in-flight cloud request", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 301000;

    let resolveRequest;
    getServerTimers.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const first = coordinator.refreshIfNeeded();
    const second = coordinator.refresh();
    const third = coordinator.refreshIfNeeded();

    await Promise.resolve();
    expect(getServerTimers).toHaveBeenCalledTimes(1);

    resolveRequest([["timer-1", "off"]]);

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      true,
      true,
      true,
    ]);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).toHaveBeenCalledTimes(1);
  });

  test("failed refresh preserves existing schedule accessories", async () => {
    const coordinator = makeCoordinator();

    const existingSchedule = {
      id: "timer-existing",
      enabled: true,
      timer: ["timer-existing", "on"],
    };

    const existingChild = {
      updateIdentity: jest.fn(),
      dispose: jest.fn(),
    };

    coordinator.scheduleAccessories.set(existingSchedule.id, existingChild);

    getServerTimers.mockRejectedValue(new Error("cloud timeout"));

    await expect(coordinator.refresh()).resolves.toBe(true);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.sync).not.toHaveBeenCalled();
    expect(coordinator.scheduleAccessories.has("timer-existing")).toBe(true);
    expect(coordinator.scheduleAccessories.get("timer-existing")).toBe(
      existingChild
    );
  });

  test("failed startup refresh reattaches handlers to restored schedule services", () => {
    const coordinator = makeCoordinator();

    coordinator.platform.Service = {
      Switch: {
        UUID: "switch-uuid",
      },
    };

    coordinator.platform.Characteristic = {
      On: "On",
    };

    const restoredService = {
      UUID: "switch-uuid",
      subtype: "roborock-schedule-timer-2",
      getCharacteristic: jest.fn().mockReturnValue({
        value: true,
      }),
    };

    coordinator.managerAccessory = {
      services: [restoredService],
    };

    coordinator.sync = jest.fn();

    expect(coordinator.restoreScheduleHandlersFromAccessory()).toBe(true);

    expect(coordinator.sync).toHaveBeenCalledWith([
      {
        id: "timer-2",
        enabled: true,
        timer: ["timer-2", "on"],
      },
    ]);
  });

  test("failed refresh backoff suppresses repeated cloud requests and later retries", async () => {
    const coordinator = makeCoordinator();

    coordinator.cachedSchedules = [
      {
        id: "timer-existing",
        enabled: true,
        timer: ["timer-existing", "on"],
      },
    ];
    coordinator.lastScheduleRefreshAt = Date.now() - 301000;

    getServerTimers.mockRejectedValueOnce(new Error("cloud timeout"));

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(false);
    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.lastFailedRefreshAt).toBeGreaterThan(0);

    // The failed refresh should suppress another cloud request during backoff,
    // while preserving the existing cached schedule state.
    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);
    expect(getServerTimers).toHaveBeenCalledTimes(1);

    // Simulate the first one-minute backoff having expired.
    coordinator.nextRefreshAttemptAt = Date.now() - 1;

    getServerTimers.mockResolvedValueOnce([["timer-existing", "off"]]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);
    expect(getServerTimers).toHaveBeenCalledTimes(2);

    expect(coordinator.cachedSchedules).toEqual([
      {
        id: "timer-existing",
        enabled: false,
        timer: ["timer-existing", "off"],
      },
    ]);
    expect(coordinator.consecutiveRefreshFailures).toBe(0);
    expect(coordinator.nextRefreshAttemptAt).toBe(0);
  });

  test("five-minute cache absorbs frequent independent readers", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([["timer-1", "on"]]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);

    for (let reader = 0; reader < 20; reader++) {
      await expect(coordinator.refreshIfNeeded()).resolves.toBe(true);
    }

    expect(getServerTimers).toHaveBeenCalledTimes(1);
  });

  test("failure backoff progresses and caps at one hour before jitter", async () => {
    const coordinator = makeCoordinator();
    const now = 1_000_000;

    jest.spyOn(Date, "now").mockReturnValue(now);
    getServerTimers.mockRejectedValue(new Error("cloud cap"));

    const expectedDelays = [60_000, 120_000, 300_000, 900_000, 3_600_000];

    for (const [index, expectedDelay] of expectedDelays.entries()) {
      coordinator.nextRefreshAttemptAt = 0;
      await expect(coordinator.refresh()).resolves.toBe(false);
      expect(coordinator.consecutiveRefreshFailures).toBe(index + 1);
      expect(coordinator.nextRefreshAttemptAt).toBe(now + expectedDelay);
    }

    coordinator.nextRefreshAttemptAt = 0;
    await expect(coordinator.refresh()).resolves.toBe(false);
    expect(coordinator.consecutiveRefreshFailures).toBe(6);
    expect(coordinator.nextRefreshAttemptAt).toBe(now + 3_600_000);
  });

  test("refreshAndGetSchedule returns the full refreshed snapshot entry", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([
      ["timer-1", "off"],
      ["timer-2", "on"],
    ]);

    const result = await coordinator.refreshAndGetSchedule("timer-2");

    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.cachedSchedules).toEqual([
      {
        id: "timer-1",
        enabled: false,
        timer: ["timer-1", "off"],
      },
      {
        id: "timer-2",
        enabled: true,
        timer: ["timer-2", "on"],
      },
    ]);
    expect(result).toEqual({
      id: "timer-2",
      enabled: true,
      timer: ["timer-2", "on"],
    });
  });

  test("refreshAndGetSchedule coalesces with an in-flight refresh", async () => {
    const coordinator = makeCoordinator();

    let resolveRequest;
    getServerTimers.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const first = coordinator.refreshIfNeeded();
    const verification = coordinator.refreshAndGetSchedule("timer-1", 0);

    await Promise.resolve();
    expect(getServerTimers).toHaveBeenCalledTimes(1);

    resolveRequest([["timer-1", "off"]]);

    await expect(Promise.all([first, verification])).resolves.toEqual([
      true,
      {
        id: "timer-1",
        enabled: false,
        timer: ["timer-1", "off"],
      },
    ]);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
  });

  test("verification bypasses a pre-write refresh and older completion cannot overwrite it", async () => {
    const coordinator = makeCoordinator();

    let resolveOld;
    let resolveNew;

    getServerTimers
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveNew = resolve;
        })
      );

    const oldRefresh = coordinator.refresh();

    const oldStartedAt = coordinator.refreshInProgressStartedAt;
    const oldGeneration = coordinator.refreshGeneration;

    expect(oldStartedAt).toBeGreaterThan(0);
    await Promise.resolve();

    const verification = coordinator.refreshDetailed(oldStartedAt + 1, true);

    await Promise.resolve();
    expect(getServerTimers).toHaveBeenCalledTimes(2);
    expect(coordinator.refreshGeneration).toBeGreaterThan(oldGeneration);

    resolveNew([["timer-1", "on"]]);

    await expect(verification).resolves.toEqual({
      success: true,
      hasSchedules: true,
    });

    expect(coordinator.cachedSchedules).toEqual([
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ]);

    // The old pre-write request completes after the newer verification
    // refresh and must not overwrite the post-write snapshot.
    resolveOld([["timer-1", "off"]]);

    await expect(oldRefresh).resolves.toBe(false);

    expect(coordinator.cachedSchedules).toEqual([
      {
        id: "timer-1",
        enabled: true,
        timer: ["timer-1", "on"],
      },
    ]);

    expect(coordinator.sync).toHaveBeenCalledTimes(1);

    // The superseded pre-write request failing later must not poison the
    // newer successful refresh with failure-backoff state.
    expect(coordinator.lastFailedRefreshAt).toBe(0);
  });

  test("stopped coordinator does not sync when an in-flight refresh completes", async () => {
    const coordinator = makeCoordinator();

    let resolveRequest;
    getServerTimers.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const refresh = coordinator.refresh();

    await Promise.resolve();
    expect(getServerTimers).toHaveBeenCalledTimes(1);

    coordinator.stopRuntime =
      RoborockHapScheduleAccessory.prototype.stopRuntime.bind(coordinator);
    coordinator.shutdown =
      RoborockHapScheduleAccessory.prototype.shutdown.bind(coordinator);

    coordinator.platform.api = {
      updatePlatformAccessories: jest.fn(),
    };
    coordinator.managerAccessory = {
      services: [],
    };

    coordinator.shutdown();

    resolveRequest([["timer-1", "on"]]);

    await expect(refresh).resolves.toBe(false);

    expect(coordinator.sync).not.toHaveBeenCalled();
    expect(coordinator.cachedSchedules).toBeUndefined();
    expect(coordinator.lastScheduleRefreshAt).toBe(0);
  });

  test("successful empty snapshot is cached as empty", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([]);

    await expect(coordinator.refresh()).resolves.toBe(false);
    expect(getServerTimers).toHaveBeenCalledTimes(1);
    expect(coordinator.cachedSchedules).toEqual([]);
    expect(coordinator.sync).toHaveBeenCalledWith([]);

    await expect(coordinator.refreshIfNeeded()).resolves.toBe(false);

    expect(getServerTimers).toHaveBeenCalledTimes(1);
  });
});
