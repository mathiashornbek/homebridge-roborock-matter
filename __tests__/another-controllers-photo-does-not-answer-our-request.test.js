"use strict";

/**
 * The photo path was dead — nothing in the plugin asks for a photo:
 * `get_photo` was reachable only through `startCommand(duid, "get_photo")`,
 * which nothing in src/ or the settings page calls, and its result was sent
 * to `adapter.socket`, which is always null. But its receiving half was live:
 * a protocol-301 frame starting with "ROBOROCK" was taken as a photo whose
 * request id is the single byte at offset 8, and resolved whatever request of
 * ours had that id. The Roborock app fetching an obstacle photo publishes
 * exactly such a blob on the robot's shared topic (python-roborock reads its
 * id as a little-endian uint32 at bytes 8–11), and ids below 256 are in use
 * for the first ~2 hours after every start and every wrap.
 *
 * Real connector, real frame encryption and decoding; only mqtt.js is faked.
 */

const mockHandlers = new Map();
jest.mock("mqtt", () => ({
  connect: jest.fn(() => {
    const client = {
      on: jest.fn((event, handler) => {
        mockHandlers.set(event, handler);
        return client;
      }),
      subscribe: jest.fn(),
      publish: jest.fn(),
      end: jest.fn(),
    };
    return client;
  }),
}));

const { message } = require("../roborockLib/lib/message");
const {
  roborock_mqtt_connector,
  describeDroppedFrames,
  resetFrameCounters,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-a70";

test("an obstacle photo another controller asked for does not answer our request with the same low id", async () => {
  resetFrameCounters();
  const settled = [];
  const adapter = {
    log: { debug() {}, info() {}, warn() {}, error: jest.fn() },
    config: {},
    localKeys: new Map([[DUID, "abcdEFGHijklMNOP"]]),
    devices: [{ duid: DUID }],
    nonce: Buffer.alloc(16, 1),
    getRobotVersion: async () => "1.0",
    pendingRequests: new Map([
      [
        42,
        {
          resolve: (value) => settled.push(["resolved", value]),
          reject: (error) => settled.push(["rejected", error]),
          timeout: null,
          method: "get_prop",
        },
      ],
    ]),
    clearTimeout() {},
    setStateAsync: async () => {},
    noteCloudMessageReceived() {},
  };
  adapter.message = new message(adapter);
  const connector = new roborock_mqtt_connector(adapter);
  adapter.rr_mqtt_connector = connector;
  await connector.initUser({
    rriot: { k: "k", u: "u", s: "s", r: { m: "mqtt://broker.invalid" } },
  });
  await connector.initMQTT_Message();

  // The app's blob: "ROBOROCK", then its own request id 0x1234002a as a
  // little-endian uint32 — whose low byte is 42.
  const blob = Buffer.alloc(80);
  blob.write("ROBOROCK", 0, "latin1");
  blob.writeUInt32LE(0x1234002a, 8);
  const frame = await adapter.message.buildRoborockMessage(
    DUID,
    301,
    1790000000,
    blob
  );
  mockHandlers.get("message")(`rr/m/o/u/user/${DUID}`, frame);

  expect(settled).toEqual([]);
  expect(adapter.pendingRequests.has(42)).toBe(true);
  // It is another controller's frame, counted as such.
  expect(describeDroppedFrames(DUID).byReason["addressed-elsewhere"]).toBe(1);
  connector.disconnect();
});
