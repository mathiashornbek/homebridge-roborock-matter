"use strict";

// A schedule write batch runs *inside* the account-wide serial queue, and it
// verifies itself afterwards by refreshing. That verification refresh is told
// the queue is already held so it reads directly instead of queueing behind
// itself.
//
// But `refreshDetailed` may adopt a refresh that is already in flight. If that
// in-flight refresh was started by an ordinary HomeKit read — which does not
// hold the queue — it is sitting in the queue *behind* the batch. Adopting it
// makes the batch wait for work that cannot start until the batch finishes.
//
// Nothing below the queue can time this out: the queued read never issues, so
// there is no request to expire. Both promises stay pending forever, the
// HomeKit switch never answers, and the account queue is wedged for every
// vacuum on the account until Homebridge restarts.

jest.mock("../src/hap_schedule_api.ts", () => ({
  // The pure helpers (id prefixes, scene decoding) are the real ones; only
  // the calls that would reach the cloud are mocked. The scene reading
  // answers "no routines" so these tests stay about the device-side timers.
  ...jest.requireActual("../src/hap_schedule_api.ts"),
  getServerTimers: jest.fn(),
  updateServerTimer: jest.fn(),
  updateTimer: jest.fn(),
  getCloudScenes: jest.fn(async () => []),
  setCloudSceneScheduleEnabled: jest.fn(),
  executeCloudScene: jest.fn(),
}));

const {
  getServerTimers,
  updateServerTimer,
} = require("../src/hap_schedule_api.ts");
const scheduleModule = require("../src/hap_schedule_accessory.ts");
const RoborockHapScheduleAccessory = scheduleModule.default;
const { ScheduleAccountCoordinator } = scheduleModule;

// Older than the 5 minute schedule cache, so refreshIfNeeded really refreshes.
const OLDER_THAN_CACHE_MS = 6 * 60 * 1000;
const DEADLOCK_GUARD_MS = 250;

function makeCoordinator() {
  const coordinator = Object.create(RoborockHapScheduleAccessory.prototype);

  coordinator.platform = {
    roborockAPI: {},
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };

  coordinator.duid = "device-1";
  coordinator.scheduleAccessories = new Map();
  coordinator.routineSwitches = new Map();
  coordinator.managerAccessory = {};
  coordinator.vacuumName = "Test Vacuum";
  coordinator.managerRemoved = false;
  coordinator.disposed = false;
  coordinator.cachedSchedules = [
    { id: "timer-1", enabled: false, timer: ["timer-1", "off"] },
  ];
  coordinator.lastScheduleRefreshAt = Date.now() - OLDER_THAN_CACHE_MS;
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

  // The verification delay and the write spacing are real waits that this test
  // is not about; collapse them so the ordering under test is what is measured.
  coordinator.waitForScheduleVerification = () => Promise.resolve();
  coordinator.waitForScheduleWriteSpacing = () => Promise.resolve();

  return coordinator;
}

// Resolves with the sentinel instead of hanging the suite, so a deadlock is
// reported as a failed assertion rather than as a jest timeout.
function withDeadlockGuard(promise, sentinel) {
  let guardTimer;
  const guard = new Promise((resolve) => {
    guardTimer = setTimeout(() => resolve(sentinel), DEADLOCK_GUARD_MS);
  });

  return Promise.race([promise, guard]).finally(() => {
    clearTimeout(guardTimer);
  });
}

describe("a schedule write batch and a concurrent HomeKit read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("the batch does not wait on a refresh queued behind itself", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([["timer-1", "on"]]);

    // This is the `onGet` handler of any schedule switch: a plain HomeKit read
    // that fires while the write is still in flight.
    updateServerTimer.mockImplementation(async () => {
      void coordinator.refreshIfNeeded();
    });

    const outcome = await withDeadlockGuard(
      coordinator.executeScheduleWriteBatch([
        { scheduleId: "timer-1", enabled: true },
      ]),
      "DEADLOCK"
    );

    expect(outcome).not.toBe("DEADLOCK");
    expect(outcome.size).toBe(0);
  });

  test("the account queue still runs work submitted after such a batch", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([["timer-1", "on"]]);
    updateServerTimer.mockImplementation(async () => {
      void coordinator.refreshIfNeeded();
    });

    await withDeadlockGuard(
      coordinator.executeScheduleWriteBatch([
        { scheduleId: "timer-1", enabled: true },
      ]),
      "DEADLOCK"
    );

    const laterWork = jest.fn(async () => "ran");
    const outcome = await withDeadlockGuard(
      coordinator.accountCoordinator.enqueue(laterWork, () => "throttled"),
      "QUEUE WEDGED"
    );

    expect(outcome).toBe("ran");
    expect(laterWork).toHaveBeenCalledTimes(1);
  });

  test("the superseded refresh does not spend a second cloud read", async () => {
    const coordinator = makeCoordinator();

    getServerTimers.mockResolvedValue([["timer-1", "on"]]);
    updateServerTimer.mockImplementation(async () => {
      void coordinator.refreshIfNeeded();
    });

    await withDeadlockGuard(
      coordinator.executeScheduleWriteBatch([
        { scheduleId: "timer-1", enabled: true },
      ]),
      "DEADLOCK"
    );

    // Let the queue drain whatever the displaced refresh left behind.
    await coordinator.accountCoordinator.enqueue(
      async () => undefined,
      () => undefined
    );

    // Only the batch's own verification read may reach the cloud. The refresh
    // the HomeKit read started was superseded before it ran, and a superseded
    // refresh cannot change any state, so issuing it is pure waste.
    expect(getServerTimers).toHaveBeenCalledTimes(1);
  });
});
