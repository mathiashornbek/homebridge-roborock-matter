"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

let mockClient;
jest.mock("mqtt", () => ({ connect: jest.fn(() => mockClient) }));

const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

async function setup() {
  const logs = { debug: [], info: [], warn: [], error: [] };
  const adapter = {
    config: {},
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
  return { logs, connector, client, emit };
}

describe("MQTT presence notifications", () => {
  test.each([true, false, 1, 0])(
    "first live report %s is informational exactly once",
    async (value) => {
      const { logs, connector, emit } = await setup();
      emit(value);
      emit(value);
      emit(value, { dup: true });
      expect(logs.info).toEqual([
        expect.stringContaining(
          `first live MQTT presence report is ${value ? "online" : "offline"}`
        ),
      ]);
      expect(logs.info[0]).toContain("Test Robot One");
      expect(logs.info[0]).not.toContain("back online");
      expect(logs.warn).toHaveLength(0);
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
        "does not by itself prove that local or cloud commands will fail"
      ),
    ]);
    expect(logs.info).toHaveLength(2);
    expect(logs.info[1]).toBe("Test Robot One is back online.");
  });
  test("each robot gets its own first live message", async () => {
    const { logs, emit } = await setup();
    emit(false);
    emit(true, {}, "robot-2");
    emit(true, {}, "robot-2");
    expect(logs.info).toHaveLength(2);
    expect(logs.info[0]).toContain("Test Robot One");
    expect(logs.info[1]).toContain("Test Robot Two");
  });
  test("client replacement retains the baseline and ignores retired-client traffic", async () => {
    const { logs, connector, client, emit } = await setup();
    emit(true);
    const next = new EventEmitter();
    mockClient = next;
    await connector.initUser({
      rriot: {
        u: "fixture-user",
        k: "fixture-key",
        s: "fixture-secret",
        r: { m: "mqtt://fixture.invalid" },
      },
    });
    await connector.initMQTT_Message();
    const topic = "rr/m/o/test-account/test-client/robot-1";
    client.emit(
      "message",
      topic,
      Buffer.from(JSON.stringify({ online: false }))
    );
    next.emit("message", topic, Buffer.from(JSON.stringify({ online: true })));
    expect(logs.info).toHaveLength(1);
    expect(logs.warn).toHaveLength(0);
    expect(connector.robotPresenceByDuid.get("robot-1")).toBe(true);
  });
});
