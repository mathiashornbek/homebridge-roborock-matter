"use strict";

// A real `Roborock` adapter pointed at test-support/fake-roborock-cloud.js,
// with only the robot-facing first reads switched off (the fake answers the
// account, not the robots) and the MQTT broker replaced by the caller's
// mocked `mqtt` module.

const EventEmitter = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

/** An mqtt.js client stand-in that connects on the next turn. */
function fakeMqttClient() {
  const client = new EventEmitter();
  client.subscribe = jest.fn();
  client.publish = jest.fn();
  client.end = jest.fn();
  setImmediate(() => client.emit("connect", { returnCode: 0 }));
  return client;
}

/**
 * Switch off what talks to the robots: the first status poll and the network
 * probe go over MQTT, which the fake does not answer, and the broker
 * handshake is the fake client's "connect".
 */
function quiet(api) {
  api.initializeDeviceUpdates = jest.fn(async () => undefined);
  api.getNetworkInfo = jest.fn(async () => undefined);
  api.startB01StatusLoop = jest.fn();
  api.superviseDeviceIntervals = jest.fn();
  api.rr_mqtt_connector.waitUntilConnected = jest.fn(async () => true);
  return api;
}

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * @param {{config: {email: string}, host: string}} cloud
 * @param {Record<string, unknown>} [options] extra Roborock options
 */
function createAdapterOnFakeCloud(cloud, options = {}) {
  const api = new Roborock({
    username: cloud.config.email,
    baseURL: cloud.host,
    cloudOnlyMode: true,
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "fake-cloud-")),
    ...options,
  });
  return quiet(api);
}

/** Real-time wait for a condition that real network I/O will make true. */
async function waitFor(condition, what, timeoutMs = 5000) {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  while (!condition()) {
    if (process.hrtime.bigint() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Fake timers that leave real I/O and the clock waitFor reads alone. */
function useFakeTimersAroundRealIo() {
  jest.useFakeTimers({
    doNotFake: [
      "nextTick",
      "setImmediate",
      "queueMicrotask",
      "hrtime",
      "performance",
    ],
  });
}

const lines = (fn) => fn.mock.calls.map((call) => String(call[0]));

/** An S8 Pro Ultra product entry with the schema ids its status uses. */
const A70_PRODUCT = {
  id: "p-a70",
  model: "roborock.vacuum.a70",
  schema: [
    { id: 121, code: "state" },
    { id: 122, code: "battery" },
    { id: 123, code: "fan_power" },
    { id: 124, code: "water_box_mode" },
  ],
};

/** One robot as home data lists it, docked and charged. */
function robot(duid, name, extra = {}) {
  return {
    duid,
    name,
    productId: A70_PRODUCT.id,
    pv: "1.0",
    localKey: `${duid}-local-key`.slice(0, 16),
    online: true,
    sn: `SN-${duid}`,
    deviceStatus: { 121: 8, 122: 100, 123: 102, 124: 200 },
    ...extra,
  };
}

/** A home-data payload in the shape `v2/user/homes/{id}` answers with. */
function homeData({ devices = [], receivedDevices = [], rooms = [] } = {}) {
  return { products: [A70_PRODUCT], devices, receivedDevices, rooms };
}

module.exports = {
  A70_PRODUCT,
  createAdapterOnFakeCloud,
  homeData,
  robot,
  fakeMqttClient,
  lines,
  quiet,
  useFakeTimersAroundRealIo,
  waitFor,
};
