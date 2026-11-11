"use strict";

// A Roborock robot on the LAN, for tests that drive the REAL localConnector
// and messageQueueHandler. Only the socket is replaced:
//
//   jest.mock("net", () => require("../test-support/fake-lan-robot").fakeNet);
//   jest.mock("dgram", () => require("../test-support/fake-lan-robot").fakeDgram);
//
// The robot answers the frames the plugin writes the way python-roborock
// expects a robot to: a hello or ping answer is a bare 17-byte header (version,
// seq, random, timestamp, protocol) echoing the request's seq, and an RPC reply
// is a real frame built and encrypted with the robot's local key by the
// plugin's own message builder, carrying `dps["102"]`.

const { EventEmitter } = require("events");

const HELLO_REQUEST = 0;
const HELLO_RESPONSE = 1;
const PING_REQUEST = 2;
const PING_RESPONSE = 3;
const GENERAL_REQUEST = 4;

/** @type {Map<string, FakeRobot>} robots by IP address */
const robotsByHost = new Map();

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.connecting = false;
    this.destroyed = false;
    /** @type {Buffer[]} */
    this.written = [];
    /** @type {FakeRobot | null} */
    this.robot = null;
  }

  connect(port, host, callback) {
    this.connecting = true;
    this.remotePort = port;
    this.remoteHost = host;
    Promise.resolve().then(() => {
      const robot = robotsByHost.get(host);
      this.connecting = false;
      if (this.destroyed) {
        return;
      }
      if (!robot || !robot.acceptsConnections) {
        const error = Object.assign(new Error(`connect ECONNREFUSED ${host}`), {
          code: "ECONNREFUSED",
        });
        this.destroyed = true;
        this.emit("error", error);
        this.emit("close", true);
        return;
      }
      this.robot = robot;
      robot.sockets.push(this);
      this.emit("connect");
      callback?.();
    });
    return this;
  }

  write(data) {
    if (this.destroyed) {
      return false;
    }
    const bytes = Buffer.from(data);
    this.written.push(bytes);
    const robot = this.robot;
    Promise.resolve().then(() => robot?.receive(this, bytes));
    return true;
  }

  /** The plugin closes it; like a real socket, 'close' follows. */
  destroy() {
    if (this.destroyed) {
      return this;
    }
    this.destroyed = true;
    Promise.resolve().then(() => this.emit("close", false));
    return this;
  }

  end() {
    return this.destroy();
  }

  setKeepAlive() {
    return this;
  }

  setNoDelay() {
    return this;
  }

  unref() {
    return this;
  }

  ref() {
    return this;
  }
}

class FakeDgramSocket extends EventEmitter {
  bind() {}
  close() {}
}

const fakeNet = { Socket: FakeSocket };
const fakeDgram = { createSocket: () => new FakeDgramSocket() };

/** A bare header answer, as a robot sends a hello or ping answer. */
function headerAnswer(version, seq, random, protocol) {
  const frame = Buffer.alloc(4 + 17);
  frame.writeUInt32BE(17, 0);
  frame.write(version, 4, "latin1");
  frame.writeUInt32BE(seq >>> 0, 7);
  frame.writeUInt32BE(random >>> 0, 11);
  frame.writeUInt32BE(1790000000, 15);
  frame.writeUInt16BE(protocol, 19);
  return frame;
}

class FakeRobot {
  /**
   * @param {any} api the Roborock adapter (its message module encodes replies)
   * @param {string} duid
   * @param {string} host
   */
  constructor(api, duid, host) {
    this.api = api;
    this.duid = duid;
    this.host = host;
    this.acceptsConnections = true;
    /** The version it answers a hello in, or null for none. */
    this.helloVersion = "1.0";
    this.answersPings = true;
    /** Whether it answers RPC requests at all. */
    this.answersRequests = true;
    /** @type {(request: {id: number, method: string, params: unknown}) => unknown} */
    this.result = () => ["ok"];
    /**
     * A refusal to send instead of a result, e.g. {code: -10007, message:
     * "invalid status"}; undefined sends the result.
     * @type {(request: {id: number, method: string, params: unknown}) => unknown}
     */
    this.refusal = () => undefined;
    /** @type {FakeSocket[]} */
    this.sockets = [];
    /** @type {Array<{socket: FakeSocket, protocol: number, seq: number, version: string}>} */
    this.headers = [];
    /** @type {Array<{socket: FakeSocket, id: number, method: string, params: unknown}>} */
    this.requests = [];
    robotsByHost.set(host, this);
  }

  /** The socket the plugin is using now. */
  get socket() {
    return this.sockets[this.sockets.length - 1];
  }

  /** @param {FakeSocket} socket @param {Buffer} bytes */
  async receive(socket, bytes) {
    let offset = 0;
    while (offset + 4 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const frame = bytes.subarray(offset + 4, offset + 4 + length);
      offset += 4 + length;
      const version = frame.toString("latin1", 0, 3);
      const seq = frame.readUInt32BE(3);
      const protocol = frame.readUInt16BE(15);
      if (protocol === HELLO_REQUEST || protocol === PING_REQUEST) {
        this.headers.push({ socket, protocol, seq, version });
        const answers =
          protocol === HELLO_REQUEST
            ? this.helloVersion === version
            : this.answersPings;
        if (answers && !socket.destroyed) {
          socket.emit(
            "data",
            headerAnswer(
              version,
              seq,
              protocol === HELLO_REQUEST ? 54321 : 1,
              protocol === HELLO_REQUEST ? HELLO_RESPONSE : PING_RESPONSE
            )
          );
        }
        continue;
      }
      if (protocol !== GENERAL_REQUEST) {
        continue;
      }
      const decoded = this.api.message._decodeMsg(frame, this.duid);
      const inner = JSON.parse(JSON.parse(decoded.payload).dps["101"]);
      this.requests.push({ socket, ...inner });
      if (!this.answersRequests) {
        continue;
      }
      const refusal = this.refusal(inner);
      if (refusal !== undefined) {
        await this.reply(socket, inner.id, undefined, refusal);
        continue;
      }
      const result = this.result(inner);
      if (result === undefined) {
        continue;
      }
      await this.reply(socket, inner.id, result);
    }
  }

  /** Send an RPC reply frame on `socket`. */
  async reply(socket, id, result, error = undefined) {
    const bytes = await this.replyBytes(id, result, error);
    if (!socket.destroyed) {
      socket.emit("data", bytes);
    }
  }

  /** An RPC reply frame, length prefix included, as the robot sends it. */
  async replyBytes(id, result, error = undefined) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      dps: {
        102: JSON.stringify(
          error === undefined ? { id, result } : { id, error }
        ),
      },
      t: timestamp,
    });
    const frame = await this.api.message.buildRoborockMessage(
      this.duid,
      GENERAL_REQUEST,
      timestamp,
      payload
    );
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(frame.length, 0);
    return Buffer.concat([prefix, frame]);
  }

  /** The robot ends the connection (a FIN): 'end', then 'close'. */
  closeConnection(socket = this.socket) {
    socket.destroyed = true;
    socket.emit("end");
    socket.emit("close", false);
  }

  /** The robot drops off the network: the socket stays open and silent. */
  vanish() {
    this.helloVersion = null;
    this.answersPings = false;
    this.answersRequests = false;
  }

  /** Forget this robot, so the next test starts on an empty LAN. */
  remove() {
    robotsByHost.delete(this.host);
  }
}

/**
 * A real Roborock adapter with one V1 robot on the fake LAN. Its MQTT side is
 * a stub: `sendMessage` records cloud frames, and `answerCloud` settles one as
 * the MQTT receiver would.
 *
 * @param {{duid?: string, host?: string, name?: string, localKey?: string, pv?: string}} [options]
 */
async function createLanRig({
  duid = "duid-a70",
  host = "192.168.1.42",
  name = "Stueetage",
  localKey = "abcdEFGHijklMNOP",
  pv = "1.0",
} = {}) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { Roborock } = require("../roborockLib/roborockAPI");
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "fake-lan-")),
  });
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      devices: [{ duid, name, online: true, pv }],
      receivedDevices: [],
      products: [],
    }),
    ack: true,
  });
  api.localKeys = new Map([[duid, localKey]]);
  api.localDevices = { [duid]: host };
  api.rr_mqtt_connector.isConnected = jest.fn(() => true);
  api.rr_mqtt_connector.sendMessage = jest.fn();
  // Fake only the broker state, not the readiness waiter. LAN outage tests
  // must exercise the real gate, including its deadlines and cancellation.
  api.rr_mqtt_connector.readiness.isReady = () =>
    api.rr_mqtt_connector.isConnected();
  const robot = new FakeRobot(api, duid, host);

  /** The requests published over MQTT, decoded. */
  const cloudRequests = () =>
    api.rr_mqtt_connector.sendMessage.mock.calls.map(([target, frame]) => {
      const decoded = api.message._decodeMsg(frame, target);
      return JSON.parse(JSON.parse(decoded.payload).dps["101"]);
    });

  /** Answer the cloud request with this id, as the MQTT receiver does. */
  const answerCloud = (id, result) => {
    const entry = api.pendingRequests.get(id);
    if (!entry) {
      throw new Error(`no cloud request ${id} is waiting`);
    }
    api.clearTimeout(entry.timeout);
    api.pendingRequests.delete(id);
    entry.resolve(result);
  };

  /** Open the robot's socket and let its hello settle. */
  const connect = async () => {
    const connecting = api.localConnector.createClient(duid, host);
    await jest.advanceTimersByTimeAsync(0);
    await connecting;
    await jest.advanceTimersByTimeAsync(0);
    return robot.socket;
  };

  return { api, log, robot, duid, host, cloudRequests, answerCloud, connect };
}

module.exports = {
  createLanRig,
  FakeRobot,
  FakeSocket,
  fakeNet,
  fakeDgram,
  HELLO_REQUEST,
  PING_REQUEST,
  GENERAL_REQUEST,
};
