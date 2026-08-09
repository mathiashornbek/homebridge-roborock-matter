"use strict";

// The UDP discovery socket is bound to 0.0.0.0 and receives whatever the LAN
// broadcasts at it. These tests pin down that a hostile or simply malformed
// datagram can never take the Homebridge process down, and that a well-formed
// one is actually decoded — which it never was, because the PKCS#7 helper was
// called without `this.` and the resulting ReferenceError was swallowed.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

/** Build a well-formed Roborock discovery datagram. */
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
  const timers = [];
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    localKeys: new Map(),
    remoteDevices: new Set(),
    updateTransportDiagnostics: jest.fn().mockResolvedValue(undefined),
    catchError: jest.fn(),
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => clearTimeout(handle),
    __timers: timers,
  };
}

describe("UDP discovery is crash-safe", () => {
  afterEach(() => {
    const socket = global.__fakeDgramSocket;
    if (socket) socket.removeAllListeners();
  });

  test.each([
    ["a buffer far too short for the header", Buffer.from([1, 2, 3])],
    ["an empty datagram", Buffer.alloc(0)],
    [
      "a header declaring more payload than it carries",
      (() => {
        const b = Buffer.alloc(11);
        b.write("1.0", 0, "latin1");
        b.writeUInt16BE(60000, 9); // payloadLen far beyond the buffer
        return b;
      })(),
    ],
    ["random noise", crypto.randomBytes(40)],
  ])("does not throw on %s", (_label, datagram) => {
    const adapter = createAdapter();
    const connector = new localConnector(adapter);
    const promise = connector.getLocalDevices();
    const socket = global.__fakeDgramSocket;

    // EventEmitter re-throws synchronously, so this assertion is exactly the
    // "uncaught exception kills Homebridge" case.
    expect(() => socket.emit("message", datagram)).not.toThrow();

    connector.clearLocalDevicedTimeout();
    socket.emit("message", Buffer.alloc(0)); // still alive afterwards
    return expect(
      Promise.race([promise, Promise.resolve("pending")])
    ).resolves.toBeDefined();
  });

  test("a valid broadcast is decoded and the robot is registered", async () => {
    const adapter = createAdapter();
    adapter.localKeys.set("duid-abc", "some-local-key");
    const connector = new localConnector(adapter);
    const promise = connector.getLocalDevices();
    const socket = global.__fakeDgramSocket;

    socket.emit(
      "message",
      buildDiscoveryPacket({ duid: "duid-abc", ip: "192.168.1.50" })
    );

    // Fire the collection timeout immediately instead of waiting 5s.
    const devices = await new Promise((resolve) => {
      connector.clearLocalDevicedTimeout();
      promise.then(resolve);
      socket.close();
      // getLocalDevices resolves from its own timeout; emulate it.
      setImmediate(() => resolve(undefined));
    }).then((value) => value);

    expect(adapter.updateTransportDiagnostics).toHaveBeenCalledWith(
      "duid-abc",
      expect.objectContaining({
        localIp: "192.168.1.50",
        localDiscoveryState: "broadcast-detected",
      })
    );
    void devices;
  });
});

describe("decryptECB actually decrypts", () => {
  test("round-trips a padded payload instead of swallowing a ReferenceError", () => {
    const connector = new localConnector(createAdapter());
    const cipher = crypto.createCipheriv("aes-128-ecb", BROADCAST_TOKEN, null);
    const plaintext = JSON.stringify({ duid: "d", ip: "10.0.0.2" });
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);

    // Before the fix this returned null for every single packet, which is why
    // LAN discovery had never worked in any released version.
    expect(connector.decryptECB(encrypted, BROADCAST_TOKEN)).toBe(plaintext);
  });

  test("still returns null for genuinely undecryptable input", () => {
    const connector = new localConnector(createAdapter());
    expect(connector.decryptECB(Buffer.alloc(7), BROADCAST_TOKEN)).toBeNull();
    expect(connector.decryptECB(Buffer.alloc(16), Buffer.alloc(8))).toBeNull();
  });
});

describe("MQTT startup watchdog cannot crash the process", () => {
  const connectorSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "roborockLib",
      "lib",
      "roborock_mqtt_connector.js"
    ),
    "utf8"
  );

  test("never calls a restart() that does not exist on the adapter", () => {
    const { Roborock } = require("../roborockLib/roborockAPI");
    // The watchdog used to call this. It has never existed, so the call threw
    // a TypeError inside an async timer — an unhandled rejection that ends the
    // Homebridge process on Node >= 15.
    expect(typeof Roborock.prototype.restart).toBe("undefined");
    expect(connectorSource).not.toMatch(/adapter\s*\.\s*restart\s*\(/);
  });

  test("exposes a cancellable, idempotent watchdog handle", () => {
    const {
      roborock_mqtt_connector,
    } = require("../roborockLib/lib/roborock_mqtt_connector");
    const adapter = createAdapter();
    adapter.storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "mqtt-wd-"));
    const connector = new roborock_mqtt_connector(adapter);

    expect(typeof connector.clearInitialConnectTimeout).toBe("function");
    expect(connector.initialConnectTimeout).toBeNull();

    let fired = false;
    connector.initialConnectTimeout = setTimeout(() => {
      fired = true;
    }, 10);
    connector.clearInitialConnectTimeout();
    expect(connector.initialConnectTimeout).toBeNull();
    expect(() => connector.clearInitialConnectTimeout()).not.toThrow();

    return new Promise((resolve) =>
      setTimeout(() => {
        expect(fired).toBe(false);
        resolve();
      }, 30)
    );
  });
});
