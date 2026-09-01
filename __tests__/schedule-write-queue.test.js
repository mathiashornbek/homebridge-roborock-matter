"use strict";

jest.mock("../src/hap_schedule_api.ts", () => ({
  getServerTimers: jest.fn(),
  updateServerTimer: jest.fn(),
  updateTimer: jest.fn(),
}));

const {
  isDefiniteScheduleThrottle,
  ScheduleAccountCoordinator,
  ScheduleWriteBatcher,
  ScheduleWriteQueue,
} = require("../src/hap_schedule_accessory.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("schedule throttle detection", () => {
  test.each([
    [{ status: 429 }],
    [{ response: { statusCode: 429 } }],
    [{ code: "429", message: "request refused" }],
    [new Error("Too many requests")],
    [{ cause: new Error("Roborock rate-limited this account") }],
  ])("recognizes an explicit throttle signal", (error) => {
    expect(isDefiniteScheduleThrottle(error)).toBe(true);
  });

  test.each([
    [new Error("Cloud request timed out after 10 seconds")],
    [new Error("MQTT connection offline")],
    [{ status: 503, message: "maintenance" }],
    [undefined],
  ])("does not classify an ambiguous failure as throttling", (error) => {
    expect(isDefiniteScheduleThrottle(error)).toBe(false);
  });
});

describe("account-wide schedule coordination", () => {
  test("serializes batches submitted by different vacuums", async () => {
    const coordinator = new ScheduleAccountCoordinator();
    const firstGate = deferred();
    const events = [];

    const first = coordinator.enqueue(
      async () => {
        events.push("vacuum-1-start");
        await firstGate.promise;
        events.push("vacuum-1-end");
        return "vacuum-1";
      },
      () => "vacuum-1-throttled"
    );
    const secondOperation = jest.fn(async () => {
      events.push("vacuum-2-start");
      return "vacuum-2";
    });
    const second = coordinator.enqueue(
      secondOperation,
      () => "vacuum-2-throttled"
    );

    await Promise.resolve();
    expect(events).toEqual(["vacuum-1-start"]);
    expect(secondOperation).not.toHaveBeenCalled();

    firstGate.resolve();
    await expect(first).resolves.toBe("vacuum-1");
    await expect(second).resolves.toBe("vacuum-2");
    expect(events).toEqual([
      "vacuum-1-start",
      "vacuum-1-end",
      "vacuum-2-start",
    ]);
  });

  test("a throttle from one vacuum rejects queued work for another without executing it", async () => {
    const coordinator = new ScheduleAccountCoordinator();
    const throttle = Object.assign(new Error("Too many requests"), {
      status: 429,
    });
    const secondOperation = jest.fn(async () => "sent");

    const first = coordinator.enqueue(
      async () => {
        coordinator.recordThrottle(throttle);
        return "vacuum-1-throttled";
      },
      () => "vacuum-1-cooldown"
    );
    const second = coordinator.enqueue(secondOperation, (error) => ({
      blocked: error,
    }));

    await expect(first).resolves.toBe("vacuum-1-throttled");
    await expect(second).resolves.toEqual({ blocked: throttle });
    expect(secondOperation).not.toHaveBeenCalled();
    expect(coordinator.cooldownRemainingMs()).toBeGreaterThan(60 * 60 * 1000);
    expect(coordinator.metricsSnapshot()).toMatchObject({
      throttleAvoidedOperations: 1,
    });
  });

  test("keeps separate cumulative request and avoidance counters", () => {
    const coordinator = new ScheduleAccountCoordinator();

    coordinator.recordRequest("read");
    coordinator.recordRequest("primaryWrite");
    coordinator.recordRequest("fallbackWrite");
    coordinator.recordAvoided("cache");
    coordinator.recordAvoided("backoff");
    coordinator.recordAvoided("coalesced");
    coordinator.recordAvoided("throttle");

    expect(coordinator.metricsSnapshot()).toEqual({
      scheduleReads: 1,
      primaryWrites: 1,
      fallbackWrites: 1,
      coalescedChanges: 1,
      cacheAvoidedReads: 1,
      backoffAvoidedReads: 1,
      throttleAvoidedOperations: 1,
    });
    expect(coordinator.policyDescription()).toContain(
      "cache=5m; batchWindow=500ms; writeSpacing=500ms; throttleCooldown=65m"
    );
  });
});

describe("per-vacuum schedule write queue", () => {
  test("runs different schedule operations in submission order without overlap", async () => {
    const queue = new ScheduleWriteQueue();
    const firstGate = deferred();
    const events = [];
    let active = 0;
    let maximumActive = 0;

    const first = queue.enqueue(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      events.push("first-start");
      await firstGate.promise;
      events.push("first-end");
      active--;
      return "first-result";
    });

    const second = queue.enqueue(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      events.push("second-start");
      active--;
      return "second-result";
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);

    firstGate.resolve();

    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toBe("second-result");
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
    expect(maximumActive).toBe(1);
  });

  test("a rejected operation does not poison later queued work", async () => {
    const queue = new ScheduleWriteQueue();
    const expected = new Error("primary write failed");
    const laterOperation = jest.fn(async () => "recovered");

    const failed = queue.enqueue(async () => {
      throw expected;
    });
    const later = queue.enqueue(laterOperation);

    await expect(failed).rejects.toBe(expected);
    await expect(later).resolves.toBe("recovered");
    expect(laterOperation).toHaveBeenCalledTimes(1);
  });

  test("shutdown cancellation skips pending work but permits future initialization", async () => {
    const queue = new ScheduleWriteQueue();
    const firstGate = deferred();
    const pendingOperation = jest.fn(async () => "stale");
    const futureOperation = jest.fn(async () => "future");

    const inFlight = queue.enqueue(async () => {
      await firstGate.promise;
      return "in-flight";
    });
    const pending = queue.enqueue(pendingOperation);

    await Promise.resolve();
    queue.cancelPending();
    firstGate.resolve();

    await expect(inFlight).resolves.toBe("in-flight");
    await expect(pending).resolves.toBeUndefined();
    expect(pendingOperation).not.toHaveBeenCalled();

    await expect(queue.enqueue(futureOperation)).resolves.toBe("future");
    expect(futureOperation).toHaveBeenCalledTimes(1);
  });

  test("separate vacuum queues do not block one another", async () => {
    const slowVacuumQueue = new ScheduleWriteQueue();
    const otherVacuumQueue = new ScheduleWriteQueue();
    const slowGate = deferred();
    const events = [];

    const slow = slowVacuumQueue.enqueue(async () => {
      events.push("slow-start");
      await slowGate.promise;
      events.push("slow-end");
    });
    const other = otherVacuumQueue.enqueue(async () => {
      events.push("other-complete");
    });

    await other;
    expect(events).toEqual(["slow-start", "other-complete"]);

    slowGate.resolve();
    await slow;
    expect(events).toEqual(["slow-start", "other-complete", "slow-end"]);
  });
});

describe("per-vacuum schedule write coalescing", () => {
  function makeBatcher(windowMs = 500) {
    return new ScheduleWriteBatcher(
      async (values) => {
        const failures = new Map();
        for (const value of values) {
          try {
            await value.operation();
          } catch (error) {
            failures.set(value.key, error);
          }
        }
        return failures;
      },
      (value) => value.key,
      windowMs
    );
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("repeated changes to one schedule keep only the final operation", async () => {
    const batcher = makeBatcher();
    const firstOperation = jest.fn(async () => undefined);
    const finalOperation = jest.fn(async () => undefined);

    const first = batcher.enqueue({
      key: "schedule-1",
      operation: firstOperation,
    });
    const final = batcher.enqueue({
      key: "schedule-1",
      operation: finalOperation,
    });

    await expect(first).resolves.toBe(false);
    expect(firstOperation).not.toHaveBeenCalled();
    expect(finalOperation).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(500);

    await expect(final).resolves.toBe(true);
    expect(firstOperation).not.toHaveBeenCalled();
    expect(finalOperation).toHaveBeenCalledTimes(1);
  });

  test("distinct schedules retain first-seen order within one batch", async () => {
    const batcher = makeBatcher();
    const events = [];

    const second = batcher.enqueue({
      key: "schedule-2",
      operation: async () => events.push("schedule-2-final"),
    });
    const firstVersion = batcher.enqueue({
      key: "schedule-1",
      operation: async () => events.push("schedule-1-stale"),
    });
    const finalVersion = batcher.enqueue({
      key: "schedule-1",
      operation: async () => events.push("schedule-1-final"),
    });

    await expect(firstVersion).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(500);

    await expect(Promise.all([second, finalVersion])).resolves.toEqual([
      true,
      true,
    ]);
    expect(events).toEqual(["schedule-2-final", "schedule-1-final"]);
  });

  test("shutdown before dispatch resolves pending requests without sending", async () => {
    const batcher = makeBatcher();
    const operation = jest.fn(async () => undefined);
    const result = batcher.enqueue({ key: "schedule-1", operation });

    batcher.cancelPending();
    await jest.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });
});
