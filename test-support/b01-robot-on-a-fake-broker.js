"use strict";

/**
 * A real `Roborock` talking to scripted B01 robots through a fake MQTT broker.
 *
 * Everything between the broker and the plugin is production code: the MQTT
 * message handler, the B01 frame cipher in message.js, the send choke point and
 * the pending-request register. Only the broker is replaced.
 *
 * The robot side builds its frames with the plugin's own encoder. That is not
 * a shortcut: the B01 frame cipher is symmetric (AES-128-CBC keyed by the
 * robot's localKey, IV from the frame's random field), so a frame the plugin
 * can decode is byte for byte a frame a robot can send. Map payloads are built
 * with `encodeQ7MapPayload`, the exact inverse of b01Q7Adapter's decode chain,
 * around SCMap bytes serialized by python-roborock's own schema
 * (__tests__/testdata/b01_scmap_frames.json).
 *
 * Usage (the mock must be declared in the test file, jest hoists it):
 *
 *   jest.mock("mqtt", () =>
 *     require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
 *   );
 *   const { createB01Robots } = require("../test-support/b01-robot-on-a-fake-broker");
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const broker = {
  /** @type {Map<string, Function>} */
  handlers: new Map(),
  /** @type {Array<{topic: string, message: Buffer}>} */
  published: [],
};

const fakeMqttModule = {
  connect: jest.fn(() => {
    broker.handlers = new Map();
    broker.published = [];
    return {
      on: (/** @type {string} */ event, /** @type {Function} */ handler) => {
        broker.handlers.set(event, handler);
      },
      subscribe: jest.fn(),
      publish: jest.fn((topic, message, options, callback) => {
        broker.published.push({ topic, message });
        callback?.();
      }),
      end: jest.fn(),
      endAsync: jest.fn(async () => undefined),
      reconnect: jest.fn(),
    };
  }),
};

const Q7_MODEL = "roborock.vacuum.sc05";
const Q10_MODEL = "roborock.vacuum.ss07";

/**
 * Inverse of b01Q7Adapter.decodeMapPayload: SCMap -> zlib -> ascii hex ->
 * AES-128-ECB -> base64 text, which is what a Q7 puts in a protocol-301 frame.
 *
 * @param {Buffer} scMap
 * @param {Buffer} mapKey
 * @returns {Buffer}
 */
function encodeQ7MapPayload(scMap, mapKey) {
  const compressedHex = zlib.deflateSync(scMap).toString("hex");
  const cipher = crypto.createCipheriv("aes-128-ecb", mapKey, null);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(compressedHex, "ascii")),
    cipher.final(),
  ]);
  return Buffer.from(encrypted.toString("base64"), "ascii");
}

/**
 * A Q10 current-map packet (protocol 301, marker `01 01`) laid out as
 * python-roborock's b01_q10_map_parser reads one. The grid travels as a
 * literal-only LZ4 block, which is a valid block and needs no compressor; the
 * reference parser was checked to read these packets' rooms identically.
 *
 * @param {{mapId?: number, width?: number, height?: number,
 *          rooms: Array<{id: number, name: string}>}} options
 * @returns {Buffer}
 */
function buildQ10MapPacket({ mapId = 1, width = 8, height = 6, rooms }) {
  const grid = Buffer.alloc(width * height, 243);
  rooms.forEach((room, index) => {
    grid[index] = (room.id * 4) & 0xff;
  });
  const records = rooms.map((room) => {
    const record = Buffer.alloc(47);
    record.writeUInt16BE(room.id, 0);
    const name = Buffer.from(room.name);
    record[26] = name.length;
    name.copy(record, 27);
    return record;
  });
  const layout = Buffer.concat([
    grid,
    Buffer.from([1, rooms.length]),
    ...records,
  ]);
  const lengthBytes = [];
  if (layout.length < 15) {
    lengthBytes.push(layout.length << 4);
  } else {
    lengthBytes.push(0xf0);
    let rest = layout.length - 15;
    while (rest >= 255) {
      lengthBytes.push(255);
      rest -= 255;
    }
    lengthBytes.push(rest);
  }
  const block = Buffer.concat([Buffer.from(lengthBytes), layout]);
  const header = Buffer.alloc(29);
  header[0] = 1;
  header[1] = 1;
  header.writeUInt32BE(mapId, 2);
  header.writeUInt16BE(width, 7);
  header.writeUInt16BE(height, 9);
  header.writeUInt16BE(block.length, 27);
  // An empty erase-zone section, as an unedited map's tail begins.
  return Buffer.concat([header, block, Buffer.from([0, 0])]);
}

/** SCMap frames serialized by python-roborock's schema, by name. */
function scMapFrames() {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "..",
        "__tests__",
        "testdata",
        "b01_scmap_frames.json"
      ),
      "utf8"
    )
  );
  /** @type {Record<string, Buffer>} */
  const frames = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string" && /^[0-9a-f]+$/.test(value)) {
      frames[name] = Buffer.from(value, "hex");
    }
  }
  return { ...raw, frames };
}

/**
 * @param {{
 *   robots: Array<{duid: string, name?: string, model: string, sn?: string,
 *                  localKey?: string, deviceStatus?: Record<string, unknown>}>,
 *   config?: Record<string, unknown>,
 * }} options
 */
async function createB01Robots({ robots, config = {} }) {
  const { Roborock } = require("../roborockLib/roborockAPI");
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "b01-broker-")),
    ...config,
  });

  const homeData = {
    products: [...new Set(robots.map((robot) => robot.model))].map((model) => ({
      id: `product-${model}`,
      model,
      schema: [
        { id: 120, code: "error_code" },
        { id: 121, code: "state" },
        { id: 122, code: "battery" },
      ],
    })),
    devices: robots.map((robot) => ({
      duid: robot.duid,
      name: robot.name ?? robot.duid,
      productId: `product-${robot.model}`,
      pv: "B01",
      sn: robot.sn ?? `SN-${robot.duid}`,
      localKey: robot.localKey ?? "0123456789abcdef",
      online: true,
      deviceStatus: robot.deviceStatus ?? {},
    })),
    receivedDevices: [],
    rooms: [],
  };
  await api.setStateAsync("HomeData", {
    val: JSON.stringify(homeData),
    ack: true,
  });
  api.devices = api.getAllHomeDevices();
  await api.refreshLocalKeysFromHomeData(homeData);
  for (const robot of robots) {
    api.vacuums[robot.duid] = api.vacuums[robot.duid] || {};
  }

  await api.rr_mqtt_connector.initUser({
    rriot: { u: "user", k: "key", s: "secret", r: { m: "mqtts://broker" } },
  });
  await api.rr_mqtt_connector.initMQTT_Message();
  api.rr_mqtt_connector.connected = true;

  /** What the plugin published to one robot, decoded with its own decoder. */
  function sentTo(/** @type {string} */ duid) {
    return broker.published
      .filter(({ topic }) => topic.endsWith(`/${duid}`))
      .map(({ message }) => {
        const decoded = api.message._decodeMsg(message, duid);
        return JSON.parse(String(decoded.payload));
      });
  }

  /**
   * One frame from a robot, through the real MQTT message handler.
   * @param {string} duid
   * @param {number} protocol
   * @param {Buffer | string} payload
   */
  async function robotSends(duid, protocol, payload) {
    const frame = await api.message.buildRoborockMessage(
      duid,
      protocol,
      Math.floor(Date.now() / 1000),
      Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    );
    broker.handlers.get("message")(`rr/m/o/user/mqttuser/${duid}`, frame);
  }

  /**
   * The Q7 answer to the most recent RPC request sent to `duid`, correlated
   * by its msgId as a real Q7 does (dps 10001, a JSON string).
   * @param {string} duid
   * @param {unknown} data
   * @param {{code?: number}} [options]
   */
  async function q7Answers(duid, data, { code = 0 } = {}) {
    const request = sentTo(duid)
      .map((payload) => payload?.dps?.["10000"])
      .filter(Boolean)
      .pop();
    if (!request) {
      throw new Error("nothing was sent to robot " + duid);
    }
    await robotSends(
      duid,
      102,
      JSON.stringify({
        t: Math.floor(Date.now() / 1000),
        dps: {
          10001: JSON.stringify({
            msgId: request.msgId,
            code,
            method: request.method,
            data,
          }),
        },
      })
    );
    return request;
  }

  /**
   * Resolve once the plugin has published `count` frames to `duid`. The send
   * path awaits several lookups before it publishes, so a test that answers
   * a request has to wait for the request to exist first.
   * @param {string} duid
   * @param {number} [count]
   */
  async function waitForSent(duid, count = 1) {
    for (let turn = 0; turn < 200; turn += 1) {
      if (sentTo(duid).length >= count) {
        return sentTo(duid);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`the plugin never sent ${count} frame(s) to robot ` + duid);
  }

  /** A datapoint push, as a Q10 (and python's Q10 simulator) sends one. */
  async function pushes(/** @type {string} */ duid, dps) {
    await robotSends(duid, 102, JSON.stringify({ dps }));
  }

  /** A protocol-301 frame carrying raw bytes (a Q10 map packet). */
  async function mapPacket(/** @type {string} */ duid, packet) {
    await robotSends(duid, 301, packet);
  }

  /** A protocol-301 map frame carrying a Q7 SCMap. */
  async function q7MapFrame(/** @type {string} */ duid, scMap) {
    const b01 = require("../roborockLib/lib/b01Q7Adapter");
    const device = homeData.devices.find((entry) => entry.duid === duid);
    const robot = robots.find((entry) => entry.duid === duid);
    const mapKey = b01.createMapKey(device.sn, robot.model);
    await robotSends(duid, 301, encodeQ7MapPayload(scMap, mapKey));
  }

  return {
    api,
    log,
    broker,
    homeData,
    sentTo,
    robotSends,
    q7Answers,
    pushes,
    q7MapFrame,
    mapPacket,
    waitForSent,
  };
}

module.exports = {
  buildQ10MapPacket,
  fakeMqttModule,
  createB01Robots,
  encodeQ7MapPayload,
  scMapFrames,
  Q7_MODEL,
  Q10_MODEL,
};
