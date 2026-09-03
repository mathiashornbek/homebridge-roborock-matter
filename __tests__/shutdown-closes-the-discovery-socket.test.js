"use strict";

// Shutdown used to disarm the one thing that ended a discovery pass.
//
// `clearLocalDevicedTimeout` is the only local-transport hook the adapter's
// `clearTimersAndIntervals` calls, and `clearTimersAndIntervals` is only ever
// called from `stopService`. It cleared `localDevicesTimeout` — but that timer
// is precisely the callback that calls `closeServer()` and `resolve(devices)`.
// So a discovery pass that was in the air when Homebridge shut down:
//
//   1. never closed its UDP socket, leaving a bound handle holding the event
//      loop open, against `stopService`'s own stated goal that the process
//      should be able to exit rather than only be killed;
//   2. never settled its promise, so every caller awaiting `getLocalDevices`
//      hung until the process was killed — the same defect `stopService`
//      already fixes for `pendingRequests`;
//   3. never released the `discoveryInFlight` single-flight claim, because
//      that claim is released in the promise's own `finally`.
//
// It has to close the socket, not merely forget the timer: dropping the claim
// while leaving the socket bound would let a NEW pass try to bind the same
// fixed port (58866) and fail with EADDRINUSE, which is worse than the leak.
//
// The `dgram` mock is what makes (1) observable at all — a real socket's
// close is invisible from the outside.

const crypto = require("crypto");

jest.mock("dgram", () => {
  const { EventEmitter } = require("events");
  return {
    createSocket: () => {
      const socket = new EventEmitter();
      socket.bind = jest.fn();
      socket.close = jest.fn();
      global.__fakeDgramSocket = socket;
      return socket;
    },
  };
});

const { localConnector } = require("../roborockLib/lib/localConnector");

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

/**
 * Build a real Roborock discovery datagram rather than stubbing the parser, so
 * these tests travel the same decrypt-and-parse path a live LAN would.
 */
function buildDiscoveryPacket(payloadObject) {
  const cipher = crypto.createCipheriv("aes-128-ecb", BROADCAST_TOKEN, null);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payloadObject), "utf8")),
    cipher.final(),
  ]);

  // version(3) seq(4) protocol(2) payloadLen(2) payload crc32(4)
  const header = Buffer.alloc(11);
  header.write("1.0", 0, "latin1");
  header.writeUInt32BE(1, 3);
  header.writeUInt16BE(0, 7);
  header.writeUInt16BE(encrypted.length, 9);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(0, 0);
  return Buffer.concat([header, encrypted, crc]);
}

function createAdapter() {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map(),
    localDevices: {},
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

/**
 * Resolve to the promise's value if it settles promptly, or to the marker if
 * it is still pending. Real timers, and well under the 5s collection window,
 * so a pass that was NOT ended by shutdown reads as pending.
 */
function settlesWithin(promise, ms = 50) {
  const pending = Symbol("pending");
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(pending), ms)),
  ]).then((value) => ({ settled: value !== pending, value }));
}

describe("shutdown ends the in-flight discovery pass", () => {
  afterEach(() => {
    const socket = global.__fakeDgramSocket;
    if (socket) socket.removeAllListeners();
    global.__fakeDgramSocket = undefined;
  });

  test("closes the discovery socket", async () => {
    const connector = new localConnector(createAdapter());
    const promise = connector.getLocalDevices();
    const socket = global.__fakeDgramSocket;

    expect(socket.close).not.toHaveBeenCalled();

    connector.clearLocalDevicedTimeout();

    expect(socket.close).toHaveBeenCalledTimes(1);
    await promise;
  });

  test("settles the promise, so nothing awaiting discovery hangs", async () => {
    const connector = new localConnector(createAdapter());
    const promise = connector.getLocalDevices();

    connector.clearLocalDevicedTimeout();

    const outcome = await settlesWithin(promise);
    expect(outcome.settled).toBe(true);
  });

  test("keeps the addresses it already heard instead of discarding them", async () => {
    const adapter = createAdapter();
    adapter.localKeys.set("duid-abc", "some-local-key");
    const connector = new localConnector(adapter);
    const promise = connector.getLocalDevices();

    global.__fakeDgramSocket.emit(
      "message",
      buildDiscoveryPacket({ duid: "duid-abc", ip: "192.168.1.50" })
    );

    connector.clearLocalDevicedTimeout();

    // Resolved, not rejected: a rejection would reach `catchError` and log an
    // error line for an ordinary shutdown. And the address is a fact that was
    // already measured and written to diagnostics, so inventing `{}` here
    // would throw away a true measurement.
    await expect(promise).resolves.toEqual({ "duid-abc": "192.168.1.50" });
    expect(adapter.catchError).not.toHaveBeenCalled();
  });

  test("releases the single-flight claim", async () => {
    const connector = new localConnector(createAdapter());
    const promise = connector.getLocalDevices();

    expect(connector.discoveryInFlight).not.toBeNull();

    connector.clearLocalDevicedTimeout();
    await promise;

    expect(connector.discoveryInFlight).toBeNull();
  });

  test("is a no-op when no pass is in flight, as on a cloud-only install", () => {
    const connector = new localConnector(createAdapter());

    // A cloud-only install never calls getLocalDevices, so there is no socket
    // and no promise. Shutdown must not throw looking for them.
    expect(() => connector.clearLocalDevicedTimeout()).not.toThrow();
    expect(global.__fakeDgramSocket).toBeUndefined();
  });

  test("does not close the socket twice when shutdown runs twice", async () => {
    const connector = new localConnector(createAdapter());
    const promise = connector.getLocalDevices();
    const socket = global.__fakeDgramSocket;

    connector.clearLocalDevicedTimeout();
    connector.clearLocalDevicedTimeout();
    await promise;

    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  test("a pass that finished on its own is not torn down again", async () => {
    // Fake timers are installed before the pass is armed, so the 5s collection
    // window is the one being advanced rather than a real timer left behind.
    jest.useFakeTimers({ doNotFake: ["nextTick"] });
    try {
      const connector = new localConnector(createAdapter());
      const promise = connector.getLocalDevices();
      const socket = global.__fakeDgramSocket;

      jest.advanceTimersByTime(5000);
      await promise;

      expect(socket.close).toHaveBeenCalledTimes(1);

      connector.clearLocalDevicedTimeout();

      // Still one: the completed pass cleared its own teardown handle, so
      // shutdown has nothing left to reach for.
      expect(socket.close).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
