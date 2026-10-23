"use strict";

/**
 * The give-up register (lib/unansweredMethodBreaker.js) stops asking a robot a
 * question after six unanswered requests in a row, and says "This is the robot
 * or the Roborock cloud declining to reply, not a connection failure". That is
 * only true when each of those requests went out on a link that stayed up. A
 * request whose link went away under it — the plugin's own MQTT session
 * restart, a dropped LAN socket — says nothing about the robot.
 *
 * On 3.39.0 a cloud request in flight across a session restart was counted
 * whenever the NEW session was up by its timeout, because only "connected
 * now" was read, not "the link it went out on".
 *
 * Real adapter, real connector and message queue; only mqtt.js is replaced by
 * a client whose events the test emits.
 */

const mockClients = [];
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const handlers = new Map();
    const client = {
      handlers,
      on: jest.fn((event, handler) => {
        handlers.set(event, [...(handlers.get(event) || []), handler]);
        return client;
      }),
      emit: (event, ...args) =>
        (handlers.get(event) || []).forEach((handler) => handler(...args)),
      subscribe: jest.fn(),
      publish: jest.fn(),
      end: jest.fn(),
      endAsync: jest.fn(async () => {}),
      reconnect: jest.fn(),
    };
    mockClients.push(client);
    return client;
  }),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

const DUID = "duid-a70";
const METHOD = "get_multi_maps_list";

let api;

beforeEach(async () => {
  jest.useFakeTimers({ now: new Date("2026-10-23T08:00:00Z") });
  mockClients.length = 0;
  api = new Roborock({
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "artefact-")),
  });
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      devices: [{ duid: DUID, name: "Stueetage", online: true, pv: "1.0" }],
      receivedDevices: [],
      products: [],
    }),
    ack: true,
  });
  api.localKeys = new Map([[DUID, "abcdEFGHijklMNOP"]]);
  await api.rr_mqtt_connector.initUser({
    rriot: { u: "u", k: "k", s: "s", r: { m: "mqtts://broker.invalid" } },
  });
  await api.rr_mqtt_connector.initMQTT_Subscribe();
  await api.rr_mqtt_connector.initMQTT_Message();
  mockClients.at(-1).emit("connect", { sessionPresent: false });
  api.unansweredMethods.govern(DUID, METHOD);
});

afterEach(() => {
  api.rr_mqtt_connector.disconnect();
  jest.clearAllTimers();
  jest.useRealTimers();
});

/** The connector's next client, once its back-off has run, connects. */
async function nextLinkComesUp() {
  await jest.advanceTimersByTimeAsync(
    api.rr_mqtt_connector.reconnectDelays.initialMs
  );
  mockClients.at(-1).emit("connect", { sessionPresent: false });
}

async function mapListRead({ replaceLinkAfterMs = null } = {}) {
  if (!api.rr_mqtt_connector.isConnected()) {
    await nextLinkComesUp();
  }
  const sentAt = Date.now();
  const request = api.messageQueueHandler
    .sendRequest(DUID, METHOD, [])
    .catch((error) => error);
  if (replaceLinkAfterMs !== null) {
    await jest.advanceTimersByTimeAsync(replaceLinkAfterMs);
    mockClients.at(-1).emit("close");
    await nextLinkComesUp();
  }
  await jest.advanceTimersByTimeAsync(
    Math.max(0, sentAt + 10_000 - Date.now())
  );
  return request;
}

test("reads whose MQTT link was replaced under them never close the method", async () => {
  // A link replaced quickly enough for the new one to be up before the
  // request's own timeout: with the 10 s back-off, what a load_multi_map
  // (30 s) or a caller's longer budget sees across a session restart.
  api.rr_mqtt_connector.reconnectDelays.initialMs = 1_000;
  api.rr_mqtt_connector.reconnectDelayMs = 1_000;
  for (let i = 0; i < 8; i += 1) {
    const error = await mapListRead({ replaceLinkAfterMs: 2_000 });
    expect(error.message).toMatch(/timed out/);
    expect(error.transportWasUp).toBe(false);
  }
  // Each replacement was a new client.
  expect(mockClients).toHaveLength(9);

  expect(api.unansweredMethods.shouldSkip(DUID, METHOD)).toBe(false);
  expect(
    api.log.info.mock.calls.some(([line]) => /has not answered/.test(line))
  ).toBe(false);
});

test("reads on a link that stayed up close it after six, and the line says the link stayed up", async () => {
  for (let i = 0; i < 6; i += 1) {
    await mapListRead();
  }

  expect(api.unansweredMethods.shouldSkip(DUID, METHOD)).toBe(true);
  const line = api.log.info.mock.calls
    .map(([text]) => String(text))
    .find((text) => /has not answered/.test(text));
  expect(line).toMatch(/connection that stayed up/);
});
