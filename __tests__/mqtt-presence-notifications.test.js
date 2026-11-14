"use strict";

const { EventEmitter } = require("node:events");

let mockClient;
jest.mock("mqtt", () => ({ connect: jest.fn(() => mockClient) }));

const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");
const {
  UnreachableEpisodes,
  describeOutage,
} = require("../roborockLib/lib/unreachableEpisodes");

async function setup({
  b01 = false,
  cloudOnly = false,
  clock = undefined,
} = {}) {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const adapter = {
    config: {},
    ...(clock
      ? {
          now: () => clock.now,
          unreachableEpisodes: new UnreachableEpisodes(() => clock.now),
        }
      : {}),
    isB01Device: () => b01,
    isCloudOnlyModeEnabled: () => cloudOnly,
    localKeys: new Map([
      ["robot-1", "test-key"],
      ["robot-2", "test-key"],
    ]),
    describeDevice: (duid) =>
      duid === "robot-1" ? "Test Robot One" : "Test Robot Two",
    log: Object.fromEntries(
      Object.keys(logs).map((level) => [
        level,
        (message) => logs[level].push(message),
      ])
    ),
    message: {
      _decodeMsg: (payload) => ({ protocol: 500, payload }),
    },
  };
  const connector = new roborock_mqtt_connector(adapter);
  const client = new EventEmitter();
  client.end = jest.fn();
  mockClient = client;
  await connector.initUser({
    rriot: {
      u: "fixture-user",
      k: "fixture-key",
      s: "fixture-secret",
      r: { m: "mqtt://fixture.invalid" },
    },
  });
  await connector.initMQTT_Message();
  const emit = (online, packet = {}, duid = "robot-1") =>
    client.emit(
      "message",
      `rr/m/o/test-account/test-client/${duid}`,
      Buffer.from(JSON.stringify({ online })),
      packet
    );
  return { logs, connector, client, emit, adapter };
}

describe("MQTT presence notifications", () => {
  test.each([{ b01: true }, { cloudOnly: true }])(
    "cloud-only robots do not get a LAN reassurance (%j)",
    async (options) => {
      const { logs, emit } = await setup(options);
      emit(false);
      emit(true);
      emit(false);
      expect(logs.warn).toHaveLength(2);
      for (const line of logs.warn) {
        expect(line).toContain("Cloud commands may fail.");
        expect(line).not.toContain("LAN");
      }
    }
  );
  test.each([true, false, 1, 0])(
    "first live report %s uses the appropriate severity exactly once",
    async (value) => {
      const { logs, connector, emit } = await setup();
      emit(value);
      emit(value);
      emit(value, { dup: true });
      const firstLogs = value ? logs.info : logs.warn;
      expect(firstLogs).toEqual([
        expect.stringContaining(
          `first live MQTT presence report is ${value ? "online" : "offline"}`
        ),
      ]);
      expect(firstLogs[0]).toContain("Test Robot One");
      expect(firstLogs[0]).not.toContain("back online");
      expect(value ? logs.warn : logs.info).toHaveLength(0);
      expect(connector.robotPresenceByDuid.get("robot-1")).toBe(Boolean(value));
    }
  );
  test("retained snapshots never establish or replace the live baseline", async () => {
    const { logs, connector, emit } = await setup();
    emit(false, { retain: true, dup: true });
    expect(logs.info).toHaveLength(0);
    expect(logs.warn).toHaveLength(0);
    expect(connector.robotPresenceByDuid.has("robot-1")).toBe(false);
    expect(logs.debug.at(-1)).toContain("retain=true; dup=true");
    expect(logs.debug.join("\n")).not.toMatch(
      /test-account|test-client|test-key|rr\/m\/o/
    );
    emit(true);
    emit(false, { retain: true });
    expect(connector.robotPresenceByDuid.get("robot-1")).toBe(true);
    expect(logs.info).toHaveLength(1);
    expect(logs.warn).toHaveLength(0);
  });
  test("subsequent changes including DUP are logged once and scoped to cloud presence", async () => {
    const { logs, emit } = await setup();
    emit(true);
    emit(false, { dup: true });
    emit(false);
    emit(true, { dup: true });
    emit(true);
    expect(logs.warn).toEqual([
      expect.stringContaining(
        "Cloud commands may fail. LAN commands may still work."
      ),
    ]);
    expect(logs.info).toHaveLength(2);
    expect(logs.info[1]).toMatch(
      /^Test Robot One is back online after \d+ s\.$/
    );
  });
  test("each robot gets its own first live message", async () => {
    const { logs, emit } = await setup();
    emit(false);
    emit(true, {}, "robot-2");
    emit(true, {}, "robot-2");
    expect(logs.warn).toHaveLength(1);
    expect(logs.info).toHaveLength(1);
    expect(logs.warn[0]).toContain("Test Robot One");
    expect(logs.info[0]).toContain("Test Robot Two");
  });

  describe("as part of a robot dropping off the network", () => {
    test("a robot already known to be off the network is told at info, not as a second warning", async () => {
      const clock = { now: 1_000_000 };
      const { logs, emit, adapter } = await setup({ clock });
      emit(true);
      adapter.unreachableEpisodes.open("robot-1", "lan"); // its LAN went first
      clock.now += 15_000;
      emit(false);
      expect(logs.warn).toEqual([]);
      expect(logs.info.at(-1)).toBe(
        "Test Robot One also reports itself offline to the Roborock cloud, so it has dropped off the network (Wi-Fi, power or a restart). The plugin says so when it is back."
      );
      clock.now += 30_000;
      emit(true);
      // Measured from the first symptom, the LAN, not from this report.
      expect(logs.info.at(-1)).toBe(
        "Test Robot One is back online after 45 s."
      );
      expect(adapter.unreachableEpisodes.isOpen("robot-1")).toBe(false);
    });

    test("an offline report that comes first warns and opens the episode", async () => {
      const clock = { now: 1_000_000 };
      const { logs, emit, adapter } = await setup({ clock, b01: true });
      emit(true);
      emit(false);
      expect(logs.warn).toHaveLength(1);
      expect(adapter.unreachableEpisodes.isOpen("robot-1")).toBe(true);
      clock.now += 3 * 60_000;
      emit(true);
      expect(logs.info.at(-1)).toBe(
        "Test Robot One is back online after 3 min."
      );
    });

    test("another robot's episode does not change this robot's lines", async () => {
      const clock = { now: 1_000_000 };
      const { logs, emit, adapter } = await setup({ clock });
      emit(true, {}, "robot-2");
      adapter.unreachableEpisodes.open("robot-1", "lan");
      emit(false, {}, "robot-2");
      expect(logs.warn).toEqual([
        expect.stringContaining(
          "Test Robot Two reports itself offline via MQTT."
        ),
      ]);
    });
  });

  test.each([
    [0, "1 s"],
    [45_000, "45 s"],
    [89_000, "89 s"],
    [3 * 60_000, "3 min"],
    [125 * 60_000, "2 h 5 min"],
    [180 * 60_000, "3 h"],
  ])("an outage of %i ms reads as %s", (ms, text) => {
    expect(describeOutage(ms)).toBe(text);
  });
});
