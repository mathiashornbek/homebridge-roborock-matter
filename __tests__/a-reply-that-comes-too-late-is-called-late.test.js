"use strict";

/**
 * A reply that arrives after its request has timed out.
 *
 * Until 3.35.0 such a reply was dropped without a word on the local socket,
 * logged only at debug on the cloud, and — for a map frame — counted as
 * "discarded by the plugin, a bug here". The give-up line then told #24 and
 * #28 that the reply "is not arriving at all" for get_server_timer and
 * get_consumable, on the strength of a counter that only ever looks at map
 * frames. A robot that answers in 12 seconds and one that never answers read
 * the same.
 *
 * These drive the real message queue, the real local reply dispatcher and the
 * real MQTT message handler; only the wire and the cipher are faked.
 */

const mockCapturedHandlers = new Map();

jest.mock("mqtt", () => ({
  connect: jest.fn(() => ({
    on: (event, handler) => {
      mockCapturedHandlers.set(event, handler);
    },
    subscribe: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
  })),
}));

const { LateReplyTracker } = require("../roborockLib/lib/lateReplies");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-s8";

describe("the late-reply register", () => {
  test("a reply to a timed-out request is recognised and counted once", () => {
    let now = 1_000;
    const tracker = new LateReplyTracker({ now: () => now });
    tracker.noteTimedOut(41, DUID, "get_map_v1");

    now += 4_000;
    // The protocol-102 acknowledgement, then the protocol-301 payload.
    expect(tracker.noteReply(41, DUID)).toEqual({
      method: "get_map_v1",
      lateByMs: 4_000,
    });
    expect(tracker.noteReply(41, DUID)).not.toBeNull();
    expect(tracker.count(DUID, "get_map_v1")).toBe(1);
  });

  test("an id it never saw, another robot's id, or a stale one is not late", () => {
    let now = 0;
    const tracker = new LateReplyTracker({ now: () => now, windowMs: 1_000 });
    tracker.noteTimedOut(5, DUID, "get_timer");

    expect(tracker.noteReply(6, DUID)).toBeNull();
    expect(tracker.noteReply(5, "another-robot")).toBeNull();
    now += 5_000;
    expect(tracker.noteReply(5, DUID)).toBeNull();
    expect(tracker.count(DUID, "get_timer")).toBe(0);
  });

  test("it never holds more than its capacity", () => {
    const tracker = new LateReplyTracker({ capacity: 3 });
    for (let id = 0; id < 10; id += 1) {
      tracker.noteTimedOut(id, DUID, "get_timer");
    }
    expect(tracker.timedOut.size).toBe(3);
    expect(tracker.noteReply(0, DUID)).toBeNull();
    expect(tracker.noteReply(9, DUID)).not.toBeNull();
  });

  test("a robot that comes back online starts from nothing", () => {
    const tracker = new LateReplyTracker();
    tracker.noteTimedOut(1, DUID, "get_timer");
    tracker.noteReply(1, DUID);
    tracker.forgetDevice(DUID);
    expect(tracker.count(DUID, "get_timer")).toBe(0);
  });
});

describe("a late cloud reply is called late", () => {
  test("a protocol-102 reply for a request that already timed out is counted and said", async () => {
    const tracker = new LateReplyTracker();
    tracker.noteTimedOut(7, DUID, "get_server_timer");
    const adapter = {
      config: {},
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      localKeys: new Map([[DUID, "local-key"]]),
      devices: [{ duid: DUID }],
      pendingRequests: new Map(),
      setTimeout: jest.fn(),
      clearTimeout: jest.fn(),
      setStateAsync: jest.fn(),
      lateReplies: tracker,
      message: {
        _decodeMsg: jest.fn(() => ({
          protocol: 102,
          payload: JSON.stringify({
            dps: { 102: JSON.stringify({ id: 7, result: [] }) },
          }),
        })),
      },
    };

    mockCapturedHandlers.clear();
    const connector = new roborock_mqtt_connector(adapter);
    await connector.initUser({
      rriot: { u: "user-id", k: "key", s: "secret", r: { m: "mqtts://b" } },
    });
    await connector.initMQTT_Message();
    mockCapturedHandlers.get("message")(
      `rr/m/o/user-id/mqttuser/${DUID}`,
      Buffer.from("raw")
    );

    expect(tracker.count(DUID, "get_server_timer")).toBe(1);
    expect(
      adapter.log.debug.mock.calls.some(([line]) =>
        /Reply to get_server_timer \(cloud id 7\).*after the request had already timed out/.test(
          line
        )
      )
    ).toBe(true);
  });
});

describe("the give-up line tells slow from silent", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** The decoded local frame a robot sends back, as the dispatcher reads it. */
  function deliverLocalReply(api, id) {
    api.message._decodeMsg = jest.fn(() => ({
      protocol: 4,
      payload: JSON.stringify({
        t: 1727000000,
        dps: { 102: JSON.stringify({ id, result: [] }) },
      }),
    }));
    api.localConnector.processLocalSegment(DUID, 120, Buffer.alloc(120));
  }

  async function timeOut(api, method) {
    const request = api.messageQueueHandler
      .sendRequest(DUID, method, [])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    return request;
  }

  test("six timeouts with one reply arriving late says the robot is slow", async () => {
    const wire = createRealRoborockOnFakeWire({ transport: "local" });
    const { api, sent, log } = wire;
    api.unansweredMethods.govern(DUID, "get_server_timer");

    await timeOut(api, "get_server_timer");
    // The robot answers the first one — twelve seconds in, two after the wait.
    deliverLocalReply(api, sent[sent.length - 1].id);
    for (let i = 0; i < 5; i += 1) {
      await timeOut(api, "get_server_timer");
    }

    const giveUp = log.info.mock.calls
      .map(([line]) => line)
      .find((line) => /has not answered get_server_timer 6 times/.test(line));
    expect(giveUp).toMatch(/1 reply to get_server_timer did arrive/);
    expect(giveUp).not.toMatch(/map reply frame/);
  });

  test("six silent timeouts of a non-map request make no claim about map frames", async () => {
    const wire = createRealRoborockOnFakeWire({ transport: "local" });
    const { api, log } = wire;
    api.unansweredMethods.govern(DUID, "get_consumable");

    for (let i = 0; i < 6; i += 1) {
      await timeOut(api, "get_consumable");
    }

    const giveUp = log.info.mock.calls
      .map(([line]) => line)
      .find((line) => /has not answered get_consumable 6 times/.test(line));
    expect(giveUp).toMatch(/No late reply to get_consumable has arrived/);
    expect(giveUp).not.toMatch(/map reply frame/);
  });
});
