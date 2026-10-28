"use strict";

/**
 * A cloud request, byte for byte and QoS for QoS, the way python-roborock
 * 7.12.0 sends it (3.39.0).
 *
 * The oldest open bug here is `get_map_v1` going unanswered over the cloud on
 * some classic robots (the maintainer's S8 Pro Ultra a70, #28's, #9's a75)
 * while python-roborock — Home Assistant's library — gets maps from them. A
 * side-by-side reading found two differences left on that path:
 *
 *  - QoS 1 on every publish. python-roborock publishes V1 and B01 requests at
 *    QoS 0 (`mqtt/session.py`: `AT_MOST_ONCE`; only A01 appliances use 1).
 *    QoS 1 also made mqtt.js replay an un-acknowledged Start or Dock after a
 *    reconnect, long after the plugin had given up on it.
 *  - The security nonce in uppercase hex. python-roborock's
 *    `SecurityData.to_dict` sends lowercase.
 *
 * The expected payload below was produced by python-roborock 7.12.0 itself:
 *
 *   RequestMessage(request_id=7143, method=RoborockCommand.GET_MAP_V1,
 *     params=[], timestamp=1790000000)._as_payload(
 *     security_data=SecurityData(endpoint="ENDPOINT",
 *       nonce=bytes.fromhex("00112233445566778899aabbccddeeff")))
 */

jest.mock("mqtt");

const mqtt = require("mqtt");
const { message } = require("../roborockLib/lib/message");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const PYTHON_ROBOROCK_PAYLOAD =
  '{"dps":{"101":"{\\"id\\":7143,\\"method\\":\\"get_map_v1\\",\\"params\\":[],\\"security\\":{\\"endpoint\\":\\"ENDPOINT\\",\\"nonce\\":\\"00112233445566778899aabbccddeeff\\"}}"},"t":1790000000}';

test("the map request payload is python-roborock's, character for character", async () => {
  jest.useFakeTimers({ now: 1790000000 * 1000 });
  try {
    const adapter = {
      nonce: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      rr_mqtt_connector: { getEndpoint: () => "ENDPOINT" },
      getRobotVersion: async () => "1.0",
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const payload = await new message(adapter).buildPayload(
      "duid",
      101,
      7143,
      "get_map_v1",
      [],
      true,
      false
    );

    expect(payload).toBe(PYTHON_ROBOROCK_PAYLOAD);
  } finally {
    jest.useRealTimers();
  }
});

// python-roborock's MQTT strategy encodes EVERY V1 request with its security
// data (devices/rpc/v1_channel.py `_create_mqtt_rpc_strategy`), not only the
// map requests; its local strategy encodes none. Produced by python-roborock
// 7.13.0:
//
//   RequestMessage("get_prop", params=["get_status"], timestamp=1790000000,
//     request_id=7143)._as_payload(security_data=SecurityData(
//     endpoint="ENDPOINT", nonce=bytes.fromhex("00112233445566778899aabbccddeeff")))
const PYTHON_ROBOROCK_STATUS_PAYLOAD =
  '{"dps":{"101":"{\\"id\\":7143,\\"method\\":\\"get_prop\\",\\"params\\":[\\"get_status\\"],\\"security\\":{\\"endpoint\\":\\"ENDPOINT\\",\\"nonce\\":\\"00112233445566778899aabbccddeeff\\"}}"},"t":1790000000}';

describe("an ordinary request carries the security block over the cloud only", () => {
  const adapter = {
    nonce: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    rr_mqtt_connector: { getEndpoint: () => "ENDPOINT" },
    getRobotVersion: async () => "1.0",
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  beforeEach(() => jest.useFakeTimers({ now: 1790000000 * 1000 }));
  afterEach(() => jest.useRealTimers());

  test("over MQTT, a status read is python-roborock's, character for character", async () => {
    const payload = await new message(adapter).buildPayload(
      "duid",
      101,
      7143,
      "get_prop",
      ["get_status"],
      false,
      false
    );

    expect(payload).toBe(PYTHON_ROBOROCK_STATUS_PAYLOAD);
  });

  test("over the LAN it carries none", async () => {
    const payload = await new message(adapter).buildPayload(
      "duid",
      4,
      7143,
      "get_prop",
      ["get_status"],
      false,
      false
    );

    expect(JSON.parse(JSON.parse(payload).dps["101"])).toEqual({
      id: 7143,
      method: "get_prop",
      params: ["get_status"],
    });
  });
});

test("every request is published at QoS 0, as python-roborock publishes it", async () => {
  const client = {
    on: jest.fn(),
    subscribe: jest.fn(),
    publish: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
  };
  mqtt.connect.mockReturnValue(client);
  const connector = new roborock_mqtt_connector({
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await connector.initUser({
    rriot: { k: "k", u: "u", s: "s", r: { m: "mqtt://broker.invalid" } },
  });

  await connector.initMQTT_Subscribe();
  client.on.mock.calls.find(([event]) => event === "connect")[1]({});
  client.subscribe.mock.calls.at(-1)[1](null, [{ qos: 1 }]);
  connector.sendMessage("duid", Buffer.from("frame"));

  expect(client.publish).toHaveBeenCalledTimes(1);
  expect(client.publish.mock.calls[0][2]).toEqual({ qos: 0 });
  connector.disconnect();
});

// mqtt.js queues a QoS 0 publish made while disconnected and sends the queue
// on the next connect, unless queueQoSZero is off. Checked on the real client
// with the options the plugin passes.
test("a publish made while the link is down is dropped, not queued for later", async () => {
  mqtt.connect.mockClear();
  mqtt.connect.mockReturnValue({
    on: jest.fn(),
    subscribe: jest.fn(),
    end: jest.fn(),
    removeAllListeners: jest.fn(),
  });
  const connector = new roborock_mqtt_connector({
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await connector.initUser({
    rriot: { k: "k", u: "u", s: "s", r: { m: "mqtt://broker.invalid" } },
  });
  const options = mqtt.connect.mock.calls[0][1];
  expect(options.queueQoSZero).toBe(false);

  const realMqtt = jest.requireActual("mqtt");
  const real = realMqtt.connect("mqtt://127.0.0.1:1", {
    ...options,
    reconnectPeriod: 0,
    connectTimeout: 50,
  });
  real.on("error", () => {});
  try {
    real.publish("rr/m/i/u/x/duid", Buffer.from("Start"), { qos: 0 });
    expect(real.queue).toHaveLength(0);
  } finally {
    real.end(true);
    connector.disconnect();
  }
});
