"use strict";

/**
 * The local hello (3.36.0).
 *
 * Two S8 owners (#24, #28) saw the same thing: the robot accepts the LAN
 * connection and then answers nothing, while python-roborock — the library
 * Home Assistant uses — gets answers from the same robots. The audit found
 * the plugin never asked: python-roborock opens every local connection with a
 * hello, first in "1.0" and then in "L01", and encrypts by whichever the robot
 * answers. This plugin trusted the account's `pv` for the LAN, sent no hello
 * for "1.0" at all, put requests on datapoint 4 instead of 101, and accepted a
 * reply only on protocol 4.
 *
 * Measured against a fake robot built from python-roborock 7.12.0's own codec
 * in 5 firmware variants, the plugin went from 1 answered to 5. These tests
 * pin the pieces of that, on the plugin's real connector.
 */

const { message } = require("../roborockLib/lib/message");
const {
  localConnector,
  buildHelloFrame,
} = require("../roborockLib/lib/localConnector");
const {
  isRpcReplyFrame,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-s8";
const LOCAL_KEY = "abcdEFGHijklMNOP";

/** A hello answer as a robot sends it: a bare 17-byte header. */
function helloAnswer(version, random) {
  const frame = Buffer.alloc(17);
  frame.write(version, 0, "latin1");
  frame.writeUInt32BE(1, 3);
  frame.writeUInt32BE(random, 7);
  frame.writeUInt32BE(1790000000, 11);
  frame.writeUInt16BE(1, 15);
  return frame;
}

function makeAdapter({ pv = "1.0" } = {}) {
  const logs = [];
  const adapter = {
    localKeys: new Map([[DUID, LOCAL_KEY]]),
    localL01Nonces: new Map(),
    pendingRequests: new Map(),
    config: {},
    log: {
      debug: (m) => logs.push(["debug", m]),
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
      error: (m) => logs.push(["error", m]),
    },
    rr_mqtt_connector: { getEndpoint: () => "JCQojItV" },
    nonce: Buffer.alloc(16, 1),
    getRobotVersion: async () => pv,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    describeDevice: () => "S8",
    devices: [{ duid: DUID }],
    updateTransportDiagnostics: async () => {},
    catchError: () => {},
  };
  adapter.message = new message(adapter);
  adapter.localConnector = new localConnector(adapter);
  const written = [];
  adapter.localConnector.localClients[DUID] = {
    connected: true,
    write: (buffer) => written.push(Buffer.from(buffer)),
  };
  return { adapter, connector: adapter.localConnector, written, logs };
}

/** The version and protocol of each frame the plugin wrote. */
function frames(written) {
  return written.map((buffer) => ({
    version: buffer.toString("latin1", 4, 7),
    protocol: buffer.readUInt16BE(4 + 15),
    length: buffer.readUInt32BE(0),
  }));
}

describe("the hello frame is python-roborock's, byte for byte", () => {
  test.each([
    ["1.0", "00000015312e3000000001000030396ab13b800000b7ceb8fa"],
    ["L01", "000000154c303100000001000030396ab13b800000be9ac646"],
  ])("%s", (version, expectedHex) => {
    // Expected bytes produced by python-roborock 7.12.0:
    // create_local_encoder(...)(RoborockMessage(protocol=HELLO_REQUEST,
    //   version, random=12345, seq=1, timestamp=1790000000))
    expect(buildHelloFrame(version, 12345, 1790000000).toString("hex")).toBe(
      expectedHex
    );
  });
});

describe("negotiation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("a robot that answers 1.0 is spoken to in 1.0, after one hello", async () => {
    const { connector, written } = makeAdapter();
    const negotiation = connector.negotiateLocalProtocol(DUID);
    await jest.advanceTimersByTimeAsync(0);

    expect(frames(written)).toEqual([
      { version: "1.0", protocol: 0, length: 21 },
    ]);
    connector.processLocalSegment(DUID, 17, helloAnswer("1.0", 999));

    await expect(negotiation).resolves.toBe("1.0");
    expect(connector.getNegotiatedVersion(DUID)).toBe("1.0");
  });

  test("a robot that only answers L01 gets L01 and its nonces, though its account says 1.0", async () => {
    const { adapter, connector, written, logs } = makeAdapter({ pv: "1.0" });
    const negotiation = connector.negotiateLocalProtocol(DUID);
    await jest.advanceTimersByTimeAsync(5_000); // the 1.0 hello goes unanswered
    expect(frames(written).map((f) => f.version)).toEqual(["1.0", "L01"]);

    connector.processLocalSegment(DUID, 17, helloAnswer("L01", 777777));
    await expect(negotiation).resolves.toBe("L01");

    const l01Hello = written[1];
    expect(adapter.localL01Nonces.get(DUID)).toEqual({
      connectNonce: l01Hello.readUInt32BE(4 + 7),
      ackNonce: 777777,
    });
    expect(
      logs.some(
        ([level, line]) =>
          level === "info" && /speaks the L01 protocol on the LAN/.test(line)
      )
    ).toBe(true);

    // And a LOCAL frame is now L01, while a CLOUD frame keeps the account's.
    const local = await adapter.message.buildRoborockMessage(
      DUID,
      4,
      1790000000,
      '{"dps":{"101":"{}"}}'
    );
    const cloud = await adapter.message.buildRoborockMessage(
      DUID,
      101,
      1790000000,
      '{"dps":{"101":"{}"}}'
    );
    expect(local.toString("latin1", 0, 3)).toBe("L01");
    expect(cloud.toString("latin1", 0, 3)).toBe("1.0");
  });

  test("an answer in the wrong version does not settle the hello", async () => {
    const { connector } = makeAdapter();
    const negotiation = connector.negotiateLocalProtocol(DUID);
    await jest.advanceTimersByTimeAsync(0);
    connector.processLocalSegment(DUID, 17, helloAnswer("L01", 5)); // asked 1.0
    await jest.advanceTimersByTimeAsync(5_000);
    connector.processLocalSegment(DUID, 17, helloAnswer("L01", 6)); // asked L01
    await expect(negotiation).resolves.toBe("L01");
  });

  test("a robot that answers no hello keeps today's behaviour, and says so once", async () => {
    const { adapter, connector, logs } = makeAdapter();
    const negotiation = connector.negotiateLocalProtocol(DUID);
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(negotiation).resolves.toBeNull();

    expect(connector.getNegotiatedVersion(DUID)).toBeUndefined();
    const local = await adapter.message.buildRoborockMessage(
      DUID,
      4,
      1790000000,
      '{"dps":{"101":"{}"}}'
    );
    expect(local.toString("latin1", 0, 3)).toBe("1.0");
    expect(
      logs.filter(
        ([level, line]) => level === "info" && /answered no hello/.test(line)
      )
    ).toHaveLength(1);
  });

  test("a closed socket settles the hello and forgets what was agreed", async () => {
    const { connector } = makeAdapter();
    const negotiation = connector.negotiateLocalProtocol(DUID);
    await jest.advanceTimersByTimeAsync(0);
    connector.processLocalSegment(DUID, 17, helloAnswer("1.0", 1));
    await negotiation;

    connector.forgetNegotiation(DUID);
    expect(connector.getNegotiatedVersion(DUID)).toBeUndefined();
    // The next connection asks the version that worked first.
    expect(connector.preferredVersions.get(DUID)).toBe("1.0");
  });

  test("a B01 or A01 robot is never sent a hello", async () => {
    for (const pv of ["B01", "A01"]) {
      const { connector, written } = makeAdapter({ pv });
      await expect(connector.negotiateLocalProtocol(DUID)).resolves.toBeNull();
      expect(written).toEqual([]);
    }
  });
});

describe("requests and replies", () => {
  test("a local request goes on datapoint 101, as python-roborock sends it", async () => {
    const { adapter } = makeAdapter();
    const payload = JSON.parse(
      await adapter.message.buildPayload(DUID, 4, 11, "get_prop", [
        "get_status",
      ])
    );
    expect(Object.keys(payload.dps)).toEqual(["101"]);
    expect(JSON.parse(payload.dps["101"])).toEqual({
      id: 11,
      method: "get_prop",
      params: ["get_status"],
    });
  });

  test.each([4, 5, 102])(
    "a local reply on protocol %i resolves its request",
    async (protocol) => {
      const { adapter, connector } = makeAdapter();
      const resolve = jest.fn();
      adapter.pendingRequests.set(11, {
        resolve,
        reject: jest.fn(),
        timeout: null,
        method: "get_prop",
      });
      adapter.message._decodeMsg = () => ({
        protocol,
        payload: JSON.stringify({
          dps: { 102: JSON.stringify({ id: 11, result: [{ state: 8 }] }) },
        }),
      });
      connector.processLocalSegment(DUID, 120, Buffer.alloc(120));
      expect(resolve).toHaveBeenCalledWith([{ state: 8 }]);
    }
  );

  test("a cloud frame on protocol 4 or 5 carrying datapoint 102 is a reply", () => {
    const reply = JSON.stringify({ dps: { 102: '{"id":7,"result":["ok"]}' } });
    expect(isRpcReplyFrame({ protocol: 102, payload: reply })).toBe(true);
    expect(isRpcReplyFrame({ protocol: 5, payload: reply })).toBe(true);
    expect(isRpcReplyFrame({ protocol: 4, payload: reply })).toBe(true);
    expect(
      isRpcReplyFrame({
        protocol: 5,
        payload: JSON.stringify({ dps: { 121: 8 } }),
      })
    ).toBe(false);
    expect(isRpcReplyFrame({ protocol: 301, payload: reply })).toBe(false);
    expect(isRpcReplyFrame({ protocol: 5, payload: "not json" })).toBe(false);
  });
});
