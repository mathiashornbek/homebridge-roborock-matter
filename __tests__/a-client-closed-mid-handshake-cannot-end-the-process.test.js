"use strict";

/**
 * A client closed while its MQTT handshake is still in flight leaves nothing
 * behind that can end the process (3.39.0).
 *
 * mqtt.js arms a CONNACK timer (connectTimeout, 30 s by default) when it
 * sends CONNECT and cancels it from its own 'close' listener. The plugin's
 * disconnect used to call removeAllListeners(), which removed that listener
 * too. A client closed mid-handshake — initUser on a startService retry
 * during a network outage — then emitted "connack timeout" 30 s later with no
 * 'error' listener left, and an 'error' event nobody listens to throws: the
 * child bridge died. The 3.39.0 release run caught it, because the publish
 * workflow runs the suite in band and the timer outlived it.
 */

const net = require("net");
const { EventEmitter } = require("events");
// Real mqtt.js unless a test hands the connector a client of its own.
jest.mock("mqtt", () => {
  const actual = jest.requireActual("mqtt");
  return { ...actual, connect: jest.fn(actual.connect) };
});
const mqtt = require("mqtt");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const userAt = (url) => ({ rriot: { k: "k", u: "u", s: "s", r: { m: url } } });

function quietLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

afterEach(() => jest.useRealTimers());

test("a client closed mid-handshake leaves no timer that can fire into nobody", async () => {
  // Accepts the TCP connection and never answers CONNECT.
  const sockets = [];
  const broker = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => broker.listen(0, "127.0.0.1", resolve));
  jest.useFakeTimers({
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
  });
  const connector = new roborock_mqtt_connector({ log: quietLog() });
  try {
    const accepted = new Promise((resolve) =>
      broker.once("connection", resolve)
    );
    await connector.initUser(
      userAt(`mqtt://127.0.0.1:${broker.address().port}`)
    );
    await connector.initMQTT_Subscribe();
    const socket = await accepted;
    const closed = new Promise((resolve) => socket.once("close", resolve));

    connector.disconnect();
    // The broker hangs up too. Waiting for the client's close alone hung now
    // and then on macOS under load, when the client was let go of before its
    // own connect event had run.
    socket.destroy();
    await closed;
    for (let turn = 0; turn < 50 && jest.getTimerCount() > 0; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(jest.getTimerCount()).toBe(0);
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
  } finally {
    connector.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
  }
});

function fakeClient() {
  return Object.assign(new EventEmitter(), {
    end: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
  });
}

test("the events of a client the plugin has let go of change nothing", async () => {
  const old = fakeClient();
  const current = fakeClient();
  mqtt.connect.mockReturnValueOnce(old).mockReturnValueOnce(current);
  const log = quietLog();
  const connector = new roborock_mqtt_connector({ log });
  try {
    const start = async () => {
      await connector.initUser(userAt("mqtt://broker.invalid"));
      await connector.initMQTT_Subscribe();
      await connector.initMQTT_Message();
    };
    await start();
    old.emit("connect", {});
    // Its SUBACK has not arrived yet.
    const [, whenSubscribed] = old.subscribe.mock.calls[0];
    // A startService retry.
    await start();
    current.emit("connect", {});
    expect(connector.isConnected()).toBe(true);

    expect(() => old.emit("error", new Error("connack timeout"))).not.toThrow();
    old.emit("close");
    old.emit("offline");
    old.emit("connect", {});
    // What mqtt.js does with the old client's unanswered SUBSCRIBE.
    whenSubscribed(new Error("Connection closed"));

    expect(old.end).toHaveBeenCalledWith(true);
    expect(old.subscribe).toHaveBeenCalledTimes(1);
    expect(connector.isConnected()).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  } finally {
    connector.disconnect();
  }
});

test("a request sent after shutdown is refused, not thrown", async () => {
  const connector = new roborock_mqtt_connector({ log: quietLog() });
  // A real mqtt.js client that never connects (nothing listens on port 1).
  await connector.initUser(userAt("mqtt://127.0.0.1:1"));
  connector.disconnect();

  const refused = jest.fn();
  expect(() =>
    connector.sendMessage("duid", Buffer.from("frame"), refused)
  ).not.toThrow();
  expect(refused).toHaveBeenCalledWith(expect.any(Error));
});

test("a session restart that shutdown overtakes does not bring the client back", async () => {
  const client = fakeClient();
  mqtt.connect.mockReturnValueOnce(client);
  const connector = new roborock_mqtt_connector({ log: quietLog() });
  await connector.initUser(userAt("mqtt://broker.invalid"));
  client.reconnect = jest.fn();
  // Homebridge stops while the old link is being closed.
  client.end = jest.fn(() => connector.disconnect());

  await expect(connector.reconnectClient(true)).resolves.toBe(false);
  expect(client.reconnect).not.toHaveBeenCalled();
  expect(connector.reconnectTimer).toBeNull();
});
