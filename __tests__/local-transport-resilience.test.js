"use strict";

// The local TCP transport is the fast path for every command, and it is the
// part of the plugin that talks to an appliance on a home LAN: chunks arrive
// split at arbitrary offsets, firmwares disagree about payload shapes, and the
// robot disappears from the network whenever someone picks it up. These tests
// pin down that none of that can permanently kill the channel — the four ways
// it used to (a poison frame retaining the buffer forever, a corrupt length
// prefix stalling completion forever, a chunk boundary inside a length prefix
// desyncing the stream, and a failed reconnect never re-arming).

const { EventEmitter } = require("events");

jest.mock("dgram", () => {
  const { EventEmitter: Emitter } = require("events");
  return {
    createSocket: () => {
      const socket = new Emitter();
      socket.bind = jest.fn();
      socket.close = jest.fn();
      return socket;
    },
  };
});

// EnhancedSocket extends net.Socket, so replacing net.Socket with an
// EventEmitter gives full control over connect/data/close without binding a
// real port or waiting on a real TCP timeout.
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

const LOCAL_RECONNECT_DELAY_MS = 60000;
const DUID = "duid-lan-1";
const IP = "192.168.1.42";

/**
 * An adapter whose timers are recorded instead of scheduled, so reconnect
 * delays can be asserted and fired without waiting a minute of wall clock.
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
    remoteDevices: new Set(),
    remoteDeviceReasons: new Map(),
    markDeviceRemote: jest.fn(function (duid, reason) {
      this.remoteDevices.add(duid);
      this.remoteDeviceReasons.set(duid, reason);
      return Promise.resolve();
    }),
    clearRemoteDevice: jest.fn(function (duid) {
      this.remoteDeviceReasons.delete(duid);
      return this.remoteDevices.delete(duid);
    }),
    pendingRequests: new Map(),
    message: {
      _decodeMsg: jest.fn(),
      buildRoborockMessage: jest.fn(),
    },
    getRobotVersion: jest.fn().mockResolvedValue("1.0"),
    onlineChecker: jest.fn().mockResolvedValue(false),
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
    __pendingDelays() {
      return [...timers.values()].map((timer) => timer.delayMs);
    },
    __fireTimer(id) {
      const timer = timers.get(id);
      timers.delete(id);
      return timer.callback();
    },
  };
}

/** Length-prefixed frame, exactly as the robot puts it on the wire. */
function frame(bodyText) {
  const body = Buffer.from(bodyText, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length, 0);
  return Buffer.concat([prefix, body]);
}

/** A frame whose decoded form resolves pending request `id`. */
function replyFrame(id) {
  return frame(JSON.stringify({ kind: "reply", id, pad: "xxxxxxxxxxxx" }));
}

/** A frame whose decoded payload is not JSON, so processing it throws. */
function poisonFrame() {
  return frame(JSON.stringify({ kind: "poison", pad: "xxxxxxxxxxxx" }));
}

/** Decoder that turns the frame bodies above into Roborock-shaped messages. */
function decodeMsg(body) {
  const spec = JSON.parse(body.toString("utf8"));

  if (spec.kind === "poison") {
    // A mis-decrypted payload: decryption "worked", the plaintext is garbage.
    return { protocol: 4, payload: "not json at all" };
  }

  if (spec.kind === "objectDps") {
    // Some firmwares hand back dps["102"] already parsed.
    return {
      protocol: 4,
      payload: JSON.stringify({
        dps: { 102: { id: spec.id, result: ["ok"] } },
      }),
    };
  }

  return {
    protocol: 4,
    payload: JSON.stringify({
      dps: { 102: JSON.stringify({ id: spec.id, result: ["ok"] }) },
    }),
  };
}

/** Register a pending request and return a promise for its resolution. */
function expectRequest(adapter, id) {
  return new Promise((resolve) => {
    adapter.pendingRequests.set(id, { resolve, timeout: 0 });
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Run createClient to completion with a socket that connects successfully. */
async function connect(connector) {
  const pending = connector.createClient(DUID, IP);
  await flush();
  const socket = global.__fakeSockets[global.__fakeSockets.length - 1];
  socket.connecting = false;
  socket.emit("connect");
  await socket.__connectCallback();
  await pending;
  return socket;
}

/** Run createClient to completion with a socket that refuses the connection. */
async function connectFailing(connector) {
  const pending = connector.createClient(DUID, IP);
  await flush();
  const socket = global.__fakeSockets[global.__fakeSockets.length - 1];
  socket.connecting = false;
  socket.emit("error", new Error("connect ECONNREFUSED"));
  socket.emit("close");
  await pending;
  return socket;
}

let adapter;
let connector;

beforeEach(() => {
  global.__fakeSockets = [];
  adapter = createAdapter();
  adapter.message._decodeMsg.mockImplementation(decodeMsg);
  connector = new localConnector(adapter);
});

afterEach(() => {
  for (const duid of Object.keys(connector.localClients)) {
    connector.clearReconnectTimer(duid);
  }
});

describe("a malformed frame cannot wedge the channel", () => {
  test("the chunk buffer is released even when a frame throws", async () => {
    const socket = await connect(connector);

    socket.emit("data", poisonFrame());

    // Before the fix clearChunkBuffer was only reached after the parse loop,
    // so the throwing frame stayed in the buffer.
    expect(socket.chunkBuffer.length).toBe(0);
  });

  test("a poison frame is not reprocessed forever and later replies survive", async () => {
    const socket = await connect(connector);
    const reply = expectRequest(adapter, 4242);

    socket.emit("data", poisonFrame());
    socket.emit("data", replyFrame(4242));

    // With the buffer retained, chunk two was concatenated onto the poison
    // frame, re-threw at the same offset, and this reply never arrived.
    await expect(reply).resolves.toEqual(["ok"]);
    expect(socket.chunkBuffer.length).toBe(0);
  });

  test("repeated poison frames do not grow the buffer without bound", async () => {
    const socket = await connect(connector);

    let previous = 0;
    for (let i = 0; i < 25; i++) {
      socket.emit("data", poisonFrame());
      expect(socket.chunkBuffer.length).toBe(0);
      expect(socket.chunkBuffer.length).toBeLessThanOrEqual(previous + 4);
      previous = socket.chunkBuffer.length;
    }
  });

  test("a poison frame does not swallow the frames behind it in the same chunk", async () => {
    const socket = await connect(connector);
    const reply = expectRequest(adapter, 77);

    socket.emit("data", Buffer.concat([poisonFrame(), replyFrame(77)]));

    await expect(reply).resolves.toEqual(["ok"]);
  });

  test("an already-parsed dps 102 object resolves instead of throwing", async () => {
    const socket = await connect(connector);
    const reply = expectRequest(adapter, 9);

    socket.emit(
      "data",
      frame(JSON.stringify({ kind: "objectDps", id: 9, pad: "xxxxxxxxxxxx" }))
    );

    await expect(reply).resolves.toEqual(["ok"]);
    expect(socket.chunkBuffer.length).toBe(0);
  });
});

describe("a corrupt length prefix resyncs instead of stalling", () => {
  /** A frame announcing a length no real Roborock message can have. */
  function garbageLengthChunk() {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(0xffffffff, 0);
    return Buffer.concat([prefix, Buffer.from("partial body", "utf8")]);
  }

  test("the buffer is dropped and the desync is reported once", async () => {
    const socket = await connect(connector);

    socket.emit("data", garbageLengthChunk());

    // Before the fix checkComplete answered false for this buffer forever.
    expect(socket.chunkBuffer.length).toBe(0);
    expect(adapter.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("out of sync")
    );

    // A peer stuck in this state must not fill the log with one warning per
    // chunk for as long as it is connected.
    socket.emit("data", garbageLengthChunk());
    expect(adapter.log.warn).toHaveBeenCalledTimes(1);
  });

  test("the buffer stops growing across repeated garbage chunks", async () => {
    const socket = await connect(connector);

    for (let i = 0; i < 20; i++) {
      socket.emit("data", garbageLengthChunk());
    }

    expect(socket.chunkBuffer.length).toBe(0);
  });

  test("the next well-formed reply is delivered after a desync", async () => {
    const socket = await connect(connector);
    const reply = expectRequest(adapter, 1234);

    socket.emit("data", garbageLengthChunk());
    socket.emit("data", replyFrame(1234));

    await expect(reply).resolves.toEqual(["ok"]);
  });

  test("a plausible but still-incomplete frame keeps waiting", async () => {
    const socket = await connect(connector);
    const reply = expectRequest(adapter, 55);
    const whole = replyFrame(55);

    // Split inside the PAYLOAD: this case always worked and must keep working.
    socket.emit("data", whole.subarray(0, 9));
    expect(socket.chunkBuffer.length).toBe(9);
    expect(adapter.log.warn).not.toHaveBeenCalled();

    socket.emit("data", whole.subarray(9));
    await expect(reply).resolves.toEqual(["ok"]);
  });
});

describe("a chunk boundary inside a length prefix keeps framing aligned", () => {
  test.each([1, 2, 3])(
    "a trailing %s-byte partial header is preserved",
    async (partialHeaderBytes) => {
      const socket = await connect(connector);
      const first = expectRequest(adapter, 101);
      const second = expectRequest(adapter, 202);

      const stream = Buffer.concat([replyFrame(101), replyFrame(202)]);
      const splitAt = replyFrame(101).length + partialHeaderBytes;

      socket.emit("data", stream.subarray(0, splitAt));
      await expect(first).resolves.toEqual(["ok"]);
      // The old bound (offset + 4 <= length) declared this complete and threw
      // the partial header away, misaligning everything that followed.
      expect(socket.chunkBuffer.length).toBe(partialHeaderBytes);

      socket.emit("data", stream.subarray(splitAt));
      await expect(second).resolves.toEqual(["ok"]);
      expect(socket.chunkBuffer.length).toBe(0);
    }
  );

  test("byte-at-a-time delivery still decodes every frame", async () => {
    const socket = await connect(connector);
    const first = expectRequest(adapter, 1);
    const second = expectRequest(adapter, 2);
    const stream = Buffer.concat([replyFrame(1), replyFrame(2)]);

    for (const byte of stream) {
      socket.emit("data", Buffer.from([byte]));
    }

    await expect(first).resolves.toEqual(["ok"]);
    await expect(second).resolves.toEqual(["ok"]);
    expect(socket.chunkBuffer.length).toBe(0);
  });

  test("checkComplete does not claim a partial header is a complete frame set", () => {
    const stream = Buffer.concat([replyFrame(1), replyFrame(2)]);
    const withPartialHeader = stream.subarray(0, replyFrame(1).length + 2);

    expect(connector.checkComplete(Buffer.alloc(0))).toBe(true);
    expect(connector.checkComplete(replyFrame(1))).toBe(true);
    expect(connector.scanChunkBuffer(withPartialHeader)).toEqual({
      status: "complete",
      consumed: replyFrame(1).length,
      declaredLength: 0,
    });
  });
});

describe("a failed local reconnect re-arms itself", () => {
  test("a refused connect schedules another attempt", async () => {
    await connectFailing(connector);

    // Before the fix the close/error listeners were attached after the connect
    // promise settled, so a failed connect scheduled nothing at all and the
    // robot stayed on the cloud path until Homebridge restarted.
    expect(connector.reconnectTimers.has(DUID)).toBe(true);
    expect(adapter.__pendingDelays()).toContain(LOCAL_RECONNECT_DELAY_MS);
  });

  test("repeated failures back off instead of hammering the robot", async () => {
    const delays = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      await connectFailing(connector);
      const timerId = connector.reconnectTimers.get(DUID);
      delays.push(adapter.__timers.get(timerId).delayMs);
      adapter.__timers.delete(timerId);
      connector.reconnectTimers.delete(DUID);
      delete connector.localClients[DUID];
    }

    expect(delays).toEqual([60000, 120000, 240000, 480000, 900000, 900000]);
  });

  test("firing the retry timer actually reconnects, and success resets the back-off", async () => {
    await connectFailing(connector);
    await connectFailing(connector);
    expect(connector.reconnectAttempts.get(DUID)).toBe(2);

    const socketsBefore = global.__fakeSockets.length;
    const timerId = connector.reconnectTimers.get(DUID);
    adapter.__fireTimer(timerId);
    await flush();

    // The timer really re-enters createClient rather than only logging.
    expect(global.__fakeSockets.length).toBe(socketsBefore + 1);
    const socket = global.__fakeSockets[global.__fakeSockets.length - 1];
    expect(socket.remoteHost).toBe(IP);
    socket.connecting = false;
    socket.emit("connect");
    await socket.__connectCallback();
    await flush();

    expect(connector.reconnectAttempts.has(DUID)).toBe(false);

    // A normal disconnect after a healthy connection keeps the old delay.
    socket.emit("close");
    const closeTimerId = connector.reconnectTimers.get(DUID);
    expect(adapter.__timers.get(closeTimerId).delayMs).toBe(
      LOCAL_RECONNECT_DELAY_MS
    );
  });

  test("the retry timer is tracked so it can be cleared on shutdown", async () => {
    await connectFailing(connector);

    expect(connector.reconnectTimers.has(DUID)).toBe(true);
    connector.clearReconnectTimer(DUID);
    expect(connector.reconnectTimers.has(DUID)).toBe(false);
    expect(adapter.__timers.size).toBe(0);
  });

  test("shutdown cancels the pending retry", async () => {
    await connectFailing(connector);
    expect(connector.reconnectTimers.has(DUID)).toBe(true);

    // clearLocalDevicedTimeout is the hook the adapter's
    // clearTimersAndIntervals calls; a retry armed up to 15 minutes out must
    // not survive it.
    connector.clearLocalDevicedTimeout();

    expect(connector.reconnectTimers.size).toBe(0);
    expect(connector.reconnectAttempts.size).toBe(0);
    expect(adapter.__timers.size).toBe(0);
  });

  test("resetClient clears the back-off so the next connect starts fresh", async () => {
    await connectFailing(connector);
    await connectFailing(connector);
    expect(connector.reconnectAttempts.get(DUID)).toBe(2);

    await connector.resetClient(DUID, "local-key-changed");

    expect(connector.reconnectAttempts.has(DUID)).toBe(false);
    expect(connector.reconnectTimers.has(DUID)).toBe(false);

    await connectFailing(connector);
    const timerId = connector.reconnectTimers.get(DUID);
    expect(adapter.__timers.get(timerId).delayMs).toBe(
      LOCAL_RECONNECT_DELAY_MS
    );
  });
});

describe("EnhancedSocket wiring", () => {
  test("is an EventEmitter whose connected flag follows the socket lifecycle", async () => {
    const socket = await connect(connector);

    expect(socket).toBeInstanceOf(EventEmitter);
    expect(connector.isConnected(DUID)).toBe(true);

    socket.emit("close");
    expect(connector.isConnected(DUID)).toBe(false);
  });
});
