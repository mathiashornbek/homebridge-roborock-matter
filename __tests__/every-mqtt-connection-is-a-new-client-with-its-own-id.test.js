"use strict";

/**
 * Every MQTT connection is a new client with an id of its own, opened after
 * python-roborock's back-off (mqtt/roborock_session.py `_run_reconnect_loop`:
 * a new client per connection, 10 s growing by 1.5, back to 10 s once
 * connected).
 *
 * On 3.39.0 the client id was the account-wide MQTT username, so any second
 * client of the account — another Homebridge, the ioBroker adapter, an
 * overlapping restart — took the session over (MQTT 3.1.1 [MQTT-3.1.4-2]);
 * mqtt.js reconnected the same client every second, and a session restart
 * ended the client and called reconnect() on the same object.
 *
 * Kept from 3.39.0: queueQoSZero off, QoS 0 publishes, and listeners that
 * ignore a client the connector has let go of (no removeAllListeners on an
 * mqtt.js client).
 */

const mockClients = [];
// While set, every connect attempt fails the way an unreachable broker does:
// the client closes right after it is created.
let mockBrokerAway = false;
jest.mock("mqtt", () => ({
  connect: jest.fn((url, options) => {
    const handlers = new Map();
    const client = {
      options,
      openedAt: Date.now(),
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
      removeAllListeners: jest.fn(),
    };
    mockClients.push(client);
    if (mockBrokerAway) {
      Promise.resolve().then(() => client.emit("close"));
    }
    return client;
  }),
}));

const mqtt = require("mqtt");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const ACCOUNT = { rriot: { u: "u", k: "k", s: "s", r: { m: "mqtts://b" } } };

function quietAdapter() {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map([["duid", "key"]]),
    devices: [{ duid: "duid" }],
    message: { _decodeMsg: jest.fn(() => null) },
    catchError: jest.fn(),
  };
}

async function startConnector(adapter = quietAdapter()) {
  const connector = new roborock_mqtt_connector(adapter);
  await connector.initUser(ACCOUNT);
  await connector.initMQTT_Subscribe();
  await connector.initMQTT_Message();
  return connector;
}

const current = () => mockClients.at(-1);

beforeEach(() => {
  jest.useFakeTimers();
  mockBrokerAway = false;
  mockClients.length = 0;
  mqtt.connect.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test("two connectors on one account connect with different client ids and the same credentials", async () => {
  const first = await startConnector();
  const second = await startConnector();

  const [a, b] = mqtt.connect.mock.calls.map(([, options]) => options);
  expect(a.clientId).toMatch(/^[0-9A-Za-z]{22}$/);
  expect(b.clientId).toMatch(/^[0-9A-Za-z]{22}$/);
  expect(a.clientId).not.toBe(b.clientId);
  expect(a.username).toBe(b.username);
  expect(a.password).toBe(b.password);
  // Not the username: that is shared by every client of the account.
  expect(a.clientId).not.toBe(a.username);
  first.disconnect();
  second.disconnect();
});

test("a dropped connection is replaced after 10 s by a new client with a new id; the old one is ended, never reconnected", async () => {
  const connector = await startConnector();
  const old = current();
  old.emit("connect", { sessionPresent: false });

  old.emit("close");
  await jest.advanceTimersByTimeAsync(9_999);
  expect(mockClients).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1);

  expect(mockClients).toHaveLength(2);
  expect(current().options.clientId).not.toBe(old.options.clientId);
  expect(old.end).toHaveBeenCalledWith(true);
  expect(old.reconnect).not.toHaveBeenCalled();
  // The new client gets the connector's listeners, and subscribes on connect.
  current().emit("connect", { sessionPresent: false });
  expect(connector.isConnected()).toBe(true);
  expect(current().subscribe).toHaveBeenCalledTimes(1);
  connector.disconnect();
});

test("while the broker stays away the attempts back off 10, 15, 22.5 s … up to 10 minutes, and start over after a connect", async () => {
  const connector = await startConnector();
  mockBrokerAway = true;
  current().emit("close");
  await jest.advanceTimersByTimeAsync(2 * 60 * 60_000);
  const openedAt = mockClients.map((client) => client.openedAt);
  const gaps = openedAt.slice(1).map((at, i) => (at - openedAt[i]) / 1000);
  expect(gaps.slice(0, 5)).toEqual([10, 15, 22.5, 33.75, 50.625]);
  expect(Math.max(...gaps)).toBe(600);
  expect(gaps.at(-1)).toBe(600);

  // Connected once, the next loss waits 10 s again.
  mockBrokerAway = false;
  const before = mockClients.length;
  await jest.advanceTimersByTimeAsync(600_000);
  current().emit("connect", { sessionPresent: false });
  current().emit("close");
  await jest.advanceTimersByTimeAsync(10_000);
  expect(mockClients.length).toBe(before + 2);
  connector.disconnect();
});

test("a session restart ends the client at once and connects a new one after the back-off", async () => {
  const connector = await startConnector();
  const old = current();
  old.emit("connect", { sessionPresent: false });

  await expect(connector.reconnectClient(true)).resolves.toBe(true);
  expect(old.end).toHaveBeenCalledWith(true);
  expect(old.reconnect).not.toHaveBeenCalled();
  expect(connector.isConnected()).toBe(false);

  await jest.advanceTimersByTimeAsync(10_000);
  expect(mockClients).toHaveLength(2);
  expect(current().options.clientId).not.toBe(old.options.clientId);
  connector.disconnect();
});

test("a client let go of cannot emit into the connector", async () => {
  const adapter = quietAdapter();
  const connector = await startConnector(adapter);
  const old = current();
  old.emit("connect", { sessionPresent: false });
  old.emit("close");
  await jest.advanceTimersByTimeAsync(10_000);
  current().emit("connect", { sessionPresent: false });
  const decoded = adapter.message._decodeMsg.mock.calls.length;

  old.emit("message", "rr/m/o/u/x/duid", Buffer.from("frame"));
  old.emit("close");
  old.emit("error", new Error("connack timeout"));

  expect(adapter.message._decodeMsg.mock.calls.length).toBe(decoded);
  expect(connector.isConnected()).toBe(true);
  expect(connector.reconnectTimer).toBeNull();
  connector.disconnect();
});

test("3.39.0's guarantees stay: no queued QoS 0 publishes, QoS 0, mqtt.js never reconnects by itself, no removeAllListeners", async () => {
  const connector = await startConnector();
  current().emit("connect", { sessionPresent: false });
  current().emit("packetreceive", { cmd: "suback", granted: [0] });
  connector.sendMessage("duid", Buffer.from("frame"));

  const { options } = current();
  expect(options.queueQoSZero).toBe(false);
  expect(options.reconnectPeriod).toBe(0);
  expect(current().publish.mock.calls[0][2]).toEqual({ qos: 0 });

  connector.disconnect();
  for (const client of mockClients) {
    expect(client.removeAllListeners).not.toHaveBeenCalled();
  }
});

test("shutting down during the back-off cancels the reconnect", async () => {
  const connector = await startConnector();
  current().emit("close");
  connector.disconnect();

  await jest.advanceTimersByTimeAsync(60_000);

  expect(mockClients).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test("waiting for the session resolves on the connect, or with false at the deadline", async () => {
  const connector = await startConnector();
  const waited = connector.waitUntilConnected(5_000);
  await jest.advanceTimersByTimeAsync(1_000);
  current().emit("connect", { sessionPresent: false });
  await expect(waited).resolves.toBe(true);

  current().emit("close");
  connector.clearReconnectTimer();
  const timedOut = connector.waitUntilConnected(5_000);
  await jest.advanceTimersByTimeAsync(5_000);
  await expect(timedOut).resolves.toBe(false);
  expect(connector.connectWaiters.size).toBe(0);
  connector.disconnect();
});
