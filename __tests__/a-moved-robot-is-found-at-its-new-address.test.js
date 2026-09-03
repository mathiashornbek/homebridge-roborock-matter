"use strict";

// A robot's address is not a property of the robot, it is a DHCP lease.
//
// The local TCP transport learned the address once, at startup, from the UDP
// broadcast — and then kept it in a closure for the life of the process. Every
// reason a socket drops is served correctly by that: a blip, a reboot, someone
// carrying the robot out of range. Every reason except the one that lasts. When
// the lease moved the robot to a new address, the retry chain went on probing
// the old one, backing off to once every fifteen minutes, forever. Nothing
// looked broken from Apple Home — the cloud path carries every command and the
// fallback is automatic — so the only symptom was that the fast path never came
// back until somebody restarted Homebridge.
//
// These tests pin the class rather than the instance: the address a reconnect
// aims at is resolved when the timer fires, the UDP broadcast is re-consulted
// while a robot is failing, and the correction is written where every other
// caller reads it rather than kept private to this file.

const crypto = require("crypto");

jest.mock("dgram", () => {
  const { EventEmitter: Emitter } = require("events");
  return {
    createSocket: () => {
      const socket = new Emitter();
      socket.bind = jest.fn();
      socket.close = jest.fn();
      global.__discoverySockets.push(socket);
      return socket;
    },
  };
});

// EnhancedSocket extends net.Socket, so replacing net.Socket with an
// EventEmitter gives full control over connect/close without binding a real
// port or waiting on a real TCP timeout.
jest.mock("net", () => {
  const { EventEmitter: Emitter } = require("events");

  class FakeSocket extends Emitter {
    constructor() {
      super();
      this.connecting = false;
      this.destroyed = false;
      this.written = [];
      global.__fakeSockets.push(this);
    }

    connect(port, host, callback) {
      this.connecting = true;
      this.remotePort = port;
      this.remoteHost = host;
      this.__connectCallback = callback;
      return this;
    }

    write(data) {
      this.written.push(data);
      return true;
    }

    destroy() {
      this.destroyed = true;
      this.connecting = false;
      return this;
    }

    setKeepAlive() {
      return this;
    }
  }

  return { Socket: FakeSocket };
});

const { localConnector } = require("../roborockLib/lib/localConnector");

const DUID = "duid-lan-1";
const OLD_IP = "192.168.1.42";
const NEW_IP = "192.168.1.77";
// The same constant the connector uses to decrypt discovery datagrams. Hard
// coded rather than imported because the module does not export it, and a test
// that reached in for it would pass even if the wire format changed.
const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

/**
 * A discovery datagram exactly as a robot puts it on the wire: the 11 byte
 * header the parser declares, an AES-128-ECB payload under the broadcast
 * token, and a CRC the parser reads but does not check.
 *
 * Built for real instead of stubbing `getLocalDevices`, so these tests exercise
 * the same decrypt-and-parse path a live LAN does. A stub would have passed
 * over a payload the connector cannot actually read.
 */
function broadcastDatagram({ duid, ip }) {
  const cipher = crypto.createCipheriv("aes-128-ecb", BROADCAST_TOKEN, null);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify({ duid, ip }), "utf8"),
    cipher.final(),
  ]);

  const header = Buffer.alloc(11);
  header.write("1.0", 0, 3, "utf8");
  header.writeUInt32BE(1, 3);
  header.writeUInt16BE(0, 7);
  header.writeUInt16BE(payload.length, 9);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(0, 0);

  return Buffer.concat([header, payload, crc]);
}

/**
 * An adapter whose timers are recorded instead of scheduled, and whose
 * `localDevices` map is the real thing: the point of the fix is that a
 * correction lands in that map, because `getKnownLocalIp` and
 * `ensureLocalConnection` are what read it.
 */
function createAdapter() {
  const timers = new Map();
  let nextId = 1;

  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map([[DUID, "local-key"]]),
    localL01Nonces: new Map(),
    localDevices: { [DUID]: OLD_IP },
    remoteDevices: new Set(),
    remoteDeviceReasons: new Map(),
    describeDevice: (duid) => (duid === DUID ? "Kitchen" : String(duid)),
    isCloudOnlyModeEnabled: () => false,
    getKnownLocalIp(duid) {
      const known = this.localDevices[duid];
      return typeof known === "string" && known ? known : null;
    },
    markDeviceRemote: jest.fn(function (duid, reason) {
      this.remoteDevices.add(duid);
      this.remoteDeviceReasons.set(duid, reason);
      return Promise.resolve();
    }),
    clearRemoteDevice: jest.fn(function (duid) {
      this.remoteDeviceReasons.delete(duid);
      return this.remoteDevices.delete(duid);
    }),
    isRemoteDevice: jest.fn(function (duid) {
      return Promise.resolve(this.remoteDevices.has(duid));
    }),
    pendingRequests: new Map(),
    message: {
      _decodeMsg: jest.fn(),
      buildRoborockMessage: jest.fn(),
    },
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(true),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    __timers: timers,
    __fireTimer(id) {
      const timer = timers.get(id);
      timers.delete(id);
      return timer.callback();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Run createClient to completion with a socket that refuses the connection. */
async function connectFailing(connector, ip = OLD_IP) {
  const pending = connector.createClient(DUID, ip);
  await flush();
  const socket = global.__fakeSockets[global.__fakeSockets.length - 1];
  socket.connecting = false;
  socket.emit("error", new Error("connect ECONNREFUSED"));
  socket.emit("close");
  await pending;
  return socket;
}

/**
 * Let the discovery pass that the connector has open hear `datagrams`, then
 * close its listen window so the pass resolves.
 */
async function answerDiscovery(adapter, datagrams) {
  await flush();
  const socket =
    global.__discoverySockets[global.__discoverySockets.length - 1];
  expect(socket).toBeDefined();

  for (const datagram of datagrams) {
    socket.emit("message", datagram);
  }

  const windowTimer = [...adapter.__timers.entries()].find(
    ([, timer]) => timer.delayMs === 5000
  );
  expect(windowTimer).toBeDefined();
  adapter.__fireTimer(windowTimer[0]);
  await flush();
}

let adapter;
let connector;

beforeEach(() => {
  global.__fakeSockets = [];
  global.__discoverySockets = [];
  adapter = createAdapter();
  connector = new localConnector(adapter);
});

afterEach(() => {
  connector.clearLocalDevicedTimeout();
});

describe("a reconnect aims at the address the robot has now", () => {
  test("the target is resolved when the timer fires, not when it was armed", async () => {
    await connectFailing(connector, OLD_IP);

    // Something else — a discovery pass, a cloud network-info reply — has
    // already learned the new address by the time the retry comes due.
    adapter.localDevices[DUID] = NEW_IP;

    const socketsBefore = global.__fakeSockets.length;
    const timerId = connector.reconnectTimers.get(DUID);
    adapter.__fireTimer(timerId);
    await flush();

    expect(global.__fakeSockets.length).toBe(socketsBefore + 1);
    expect(
      global.__fakeSockets[global.__fakeSockets.length - 1].remoteHost
    ).toBe(NEW_IP);
  });

  test("a robot whose address has not moved is retried at the same one", async () => {
    await connectFailing(connector, OLD_IP);

    const timerId = connector.reconnectTimers.get(DUID);
    adapter.__fireTimer(timerId);
    await flush();

    expect(
      global.__fakeSockets[global.__fakeSockets.length - 1].remoteHost
    ).toBe(OLD_IP);
  });

  test("an adapter that knows no address falls back to the one the socket used", async () => {
    // A robot discovered by broadcast but never written into localDevices: the
    // fallback must be the captured address, never undefined. Connecting to
    // undefined is not a failed connect, it is a thrown TypeError inside a
    // timer callback.
    delete adapter.localDevices[DUID];

    await connectFailing(connector, OLD_IP);
    const timerId = connector.reconnectTimers.get(DUID);
    adapter.__fireTimer(timerId);
    await flush();

    expect(
      global.__fakeSockets[global.__fakeSockets.length - 1].remoteHost
    ).toBe(OLD_IP);
  });
});

describe("a failing robot has its address re-checked against the LAN", () => {
  test("the retry re-runs discovery and adopts the address broadcast now", async () => {
    await connectFailing(connector, OLD_IP);

    const timerId = connector.reconnectTimers.get(DUID);
    adapter.__fireTimer(timerId);
    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: DUID, ip: NEW_IP }),
    ]);

    // Written back to the adapter, not kept in this module: getKnownLocalIp
    // and ensureLocalConnection read that map, so a private correction would
    // leave every other caller on the dead address.
    expect(adapter.localDevices[DUID]).toBe(NEW_IP);
    expect(adapter.getKnownLocalIp(DUID)).toBe(NEW_IP);
  });

  test("the move is reported once, by name, with the two addresses", async () => {
    await connectFailing(connector, OLD_IP);

    adapter.__fireTimer(connector.reconnectTimers.get(DUID));
    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: DUID, ip: NEW_IP }),
    ]);

    const lines = adapter.log.info.mock.calls.map(([line]) => line);
    const moved = lines.filter((line) => line.includes(NEW_IP));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain("Kitchen");
    expect(moved[0]).toContain(OLD_IP);
    expect(moved[0]).not.toContain(DUID);
  });

  test("a discovery pass that hears nothing leaves the known address alone", async () => {
    await connectFailing(connector, OLD_IP);

    adapter.__fireTimer(connector.reconnectTimers.get(DUID));
    await answerDiscovery(adapter, []);

    expect(adapter.localDevices[DUID]).toBe(OLD_IP);
    expect(adapter.log.info).not.toHaveBeenCalled();
  });

  test("a broadcast from a different robot does not move this one", async () => {
    await connectFailing(connector, OLD_IP);

    adapter.__fireTimer(connector.reconnectTimers.get(DUID));
    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: "duid-someone-else", ip: NEW_IP }),
    ]);

    expect(adapter.localDevices[DUID]).toBe(OLD_IP);
  });

  test("re-discovery is skipped entirely in cloud-only mode", async () => {
    adapter.isCloudOnlyModeEnabled = () => true;

    await connectFailing(connector, OLD_IP);
    adapter.__fireTimer(connector.reconnectTimers.get(DUID));
    await flush();

    // No listen window, so no socket was bound: a cloud-only install must not
    // open a UDP port it has been configured out of using.
    expect(global.__discoverySockets).toHaveLength(0);
  });

  test("the re-check does not hold the reconnect attempt open", async () => {
    await connectFailing(connector, OLD_IP);

    const socketsBefore = global.__fakeSockets.length;
    adapter.__fireTimer(connector.reconnectTimers.get(DUID));
    await flush();

    // The correction is for the retry AFTER this one, which is at least a
    // minute out. Awaiting a five second listen before every attempt would
    // delay the recovery of the far commoner case: a robot that simply blipped
    // and is still at the address we have.
    expect(global.__fakeSockets.length).toBe(socketsBefore + 1);
  });
});

describe("discovery is single-flight, because the port is fixed", () => {
  test("two overlapping passes bind one socket and share one result", async () => {
    const first = connector.getLocalDevices();
    const second = connector.getLocalDevices();

    expect(second).toBe(first);

    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: DUID, ip: NEW_IP }),
    ]);

    expect(global.__discoverySockets).toHaveLength(1);
    expect(await first).toEqual({ [DUID]: NEW_IP });
    expect(await second).toEqual({ [DUID]: NEW_IP });
  });

  test("a completed pass releases the claim so the next one can listen", async () => {
    const first = connector.getLocalDevices();
    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: DUID, ip: OLD_IP }),
    ]);
    await first;

    const second = connector.getLocalDevices();
    expect(second).not.toBe(first);

    await answerDiscovery(adapter, [
      broadcastDatagram({ duid: DUID, ip: NEW_IP }),
    ]);

    expect(global.__discoverySockets).toHaveLength(2);
    expect(await second).toEqual({ [DUID]: NEW_IP });
  });

  test("a claim is released even when the pass fails, or nothing discovers again", async () => {
    const first = connector.getLocalDevices();
    await flush();

    const socket = global.__discoverySockets[0];
    socket.emit("error", new Error("EADDRINUSE"));
    await expect(first).rejects.toThrow("EADDRINUSE");

    expect(connector.getLocalDevices()).not.toBe(first);
  });
});
