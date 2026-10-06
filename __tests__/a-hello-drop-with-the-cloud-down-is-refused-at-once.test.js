"use strict";

/**
 * Found in the final review of 3.36.0-beta.1: the re-check after
 * awaitLocalNegotiation only covers the case where MQTT is up. With MQTT down,
 * the stale `localConnectionState` read before the wait still says
 * "connected", so the request is built for, and written into, the socket that
 * closed during the hello, and is counted as a mute-socket timeout.
 *
 * Fixture copied from a-hello-belongs-to-its-own-socket.test.js.
 *
 * Drives the REAL createClient / negotiateLocalProtocol / messageQueueHandler
 * against a real TCP listener on 127.0.0.1. The plugin always dials 58867, and
 * that port is NOT used here: another suite relies on nothing listening there,
 * and jest runs suites side by side (the 3.36.0-beta.1 gate on macOS failed
 * exactly that way). The fake robot listens on a free port and the dial is
 * redirected to it. Only the robot is fake.
 */

const net = require("net");
const { message } = require("../roborockLib/lib/message");
const { localConnector } = require("../roborockLib/lib/localConnector");
const {
  messageQueueHandler,
} = require("../roborockLib/lib/messageQueueHandler");

jest.setTimeout(20_000);

const HOST = "127.0.0.1";
const PLUGIN_PORT = 58867;
let robotPort = 0;

// Send the plugin's fixed-port dial to the fake robot's free port.
const realConnect = net.Socket.prototype.connect;
beforeAll(() => {
  jest.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
    ...args
  ) {
    if (args[0] === PLUGIN_PORT && args[1] === HOST && robotPort) {
      args[0] = robotPort;
    }
    return realConnect.apply(this, args);
  });
});
afterAll(() => {
  jest.restoreAllMocks();
});
const DUID = "duid-review";
const LOCAL_KEY = "abcdEFGHijklMNOP";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 17-byte HELLO_RESPONSE, as a robot answers a hello. */
function helloAnswer(version, seq, ackNonce) {
  const body = Buffer.alloc(17);
  body.write(version, 0, "latin1");
  body.writeUInt32BE(seq, 3);
  body.writeUInt32BE(ackNonce, 7);
  body.writeUInt32BE(Math.floor(Date.now() / 1000), 11);
  body.writeUInt16BE(1, 15);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(17, 0);
  return Buffer.concat([prefix, body]);
}

/**
 * @param {(conn: {index: number, socket: net.Socket, frames: any[]}, frame: {version: string, protocol: number, seq: number}) => void} onFrame
 */
async function startRobot(onFrame) {
  const connections = [];
  const server = net.createServer((socket) => {
    const conn = { index: connections.length, socket, frames: [] };
    connections.push(conn);
    let buf = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const body = buf.subarray(4, 4 + n);
        buf = buf.subarray(4 + n);
        const frame = {
          version: body.toString("latin1", 0, 3),
          seq: body.readUInt32BE(3),
          protocol: body.readUInt16BE(15),
        };
        conn.frames.push(frame);
        onFrame(conn, frame);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  robotPort = server.address().port;
  return { server, connections };
}

function makeAdapter(pv) {
  let id = 100;
  const adapter = {
    localKeys: new Map([[DUID, LOCAL_KEY]]),
    localL01Nonces: new Map(),
    pendingRequests: new Map(),
    config: {},
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    rr_mqtt_connector: {
      getEndpoint: () => "JCQojItV",
      isConnected: () => true,
      sendMessage: jest.fn(),
    },
    nonce: Buffer.alloc(16, 1),
    getRobotVersion: async () => pv,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    describeDevice: () => "Review robot",
    devices: [{ duid: DUID }],
    updateTransportDiagnostics: async () => {},
    catchError: () => {},
    clearRemoteDevice: () => false,
    markDeviceRemote: async () => {},
    onlineChecker: async () => true,
    isRemoteDevice: async () => false,
    getRequestId: () => id++,
    getKnownLocalIp: () => HOST,
    isCloudOnlyModeEnabled: () => true, // keeps re-discovery out of the test
  };
  adapter.message = new message(adapter);
  adapter.localConnector = new localConnector(adapter);
  adapter.messageQueueHandler = new messageQueueHandler(adapter);
  return adapter;
}

let robot;
let adapter;
afterEach(async () => {
  adapter?.localConnector.clearReconnectTimer(DUID);
  adapter?.localConnector.destroyAllClients();
  for (const conn of robot?.connections || []) conn.socket.destroy();
  await new Promise((resolve) =>
    robot ? robot.server.close(resolve) : resolve()
  );
  robot = undefined;
  adapter = undefined;
  robotPort = 0;
});

test("with MQTT down, a request whose socket closed during the hello is refused, not written into the dead socket", async () => {
  robot = await startRobot((conn) => {
    if (conn.index === 0) conn.socket.destroy();
  });
  adapter = makeAdapter("1.0");
  adapter.rr_mqtt_connector.isConnected = () => false;
  adapter.noteLocalRequestTimedOut = jest.fn();
  const connector = adapter.localConnector;
  await connector.createClient(DUID, HOST);
  expect(connector.isConnected(DUID)).toBe(true);
  const writes = [];
  const realSend = connector.sendMessage.bind(connector);
  connector.sendMessage = (duid, msg) => {
    writes.push({ connected: Boolean(connector.isConnected(duid)) });
    return realSend(duid, msg);
  };

  const t0 = Date.now();
  const outcome = await adapter.messageQueueHandler
    .sendRequest(DUID, "get_prop", ["get_status"], false, false, {
      requestTimeoutMs: 1000,
    })
    .then(
      (value) => ({ value }),
      (error) => ({ error })
    );
  const elapsed = Date.now() - t0;

  expect({
    error: outcome.error?.message,
    writesIntoClosedSocket: writes.filter((w) => !w.connected).length,
    countedAsMuteSocket: adapter.noteLocalRequestTimedOut.mock.calls.length,
    slowerThan1s: elapsed > 1000,
  }).toEqual({
    error: expect.stringMatching(/No local connection/),
    writesIntoClosedSocket: 0,
    countedAsMuteSocket: 0,
    slowerThan1s: false,
  });
});
