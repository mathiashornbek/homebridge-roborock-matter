"use strict";

const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const net = require("net");
const dgram = require("dgram");
const { describeDevice } = require("./describeDevice");
const {
  describeReplyRefusal,
  createRefusalError,
} = require("./describeReplyRefusal");

const PORT = 58866;
const TIMEOUT = 5000; // 5 Sekunden Timeout
const LOCAL_RECONNECT_DELAY_MS = 60000;
const LOCAL_CONNECT_TIMEOUT_MS = 4000;
// A failed connect attempt now re-arms itself, so the delay has to grow: a
// robot that is unplugged for a week must not be probed every minute for a
// week. Doubling from LOCAL_RECONNECT_DELAY_MS keeps the first retries
// responsive (60s, 2m, 4m, 8m) and the cap keeps a permanently absent robot
// down to four probes an hour.
const LOCAL_RECONNECT_MAX_DELAY_MS = 900000;

// Upper bound for a plausible local TCP frame. Everything the robot sends over
// the LAN socket is a single Roborock message: a 19 byte header, an AES
// payload and a CRC. The largest of those by far is a protocol-301 map blob,
// which lands in the low tens of kB, so 1 MiB leaves two orders of magnitude of
// headroom. A declared length past this is never a real frame — it is a
// corrupted length prefix or a stream that has lost frame alignment — and
// without a ceiling those bytes can never arrive, so the completeness check
// would answer "not yet" forever while the buffer grew without bound.
const MAX_LOCAL_FRAME_BYTES = 1048576;

const BROADCAST_TOKEN = Buffer.from("qWKYcdQWrbm9hPqe", "utf8");

// Some adapters provide their own setTimeout/clearTimeout (e.g. to keep timers
// on the same event loop / for testability). Fall back to the global timer
// functions when the adapter doesn't provide them.
function getTimerFns(adapter) {
  return {
    setTimer:
      typeof adapter.setTimeout === "function"
        ? adapter.setTimeout.bind(adapter)
        : setTimeout,
    clearTimer:
      typeof adapter.clearTimeout === "function"
        ? adapter.clearTimeout.bind(adapter)
        : clearTimeout,
  };
}

class EnhancedSocket extends net.Socket {
  constructor(options) {
    super(options);
    this.connected = false;
    this.chunkBuffer = Buffer.alloc(0);
    // Whether a stream desync has already been reported for this socket, so a
    // permanently broken peer produces one warning instead of one per chunk.
    this.desyncReported = false;

    this.on("connect", () => {
      this.connected = true;
    });

    this.on("close", () => {
      this.connected = false;
    });

    this.on("error", () => {
      this.connected = false;
    });

    this.on("end", () => {
      this.connected = false;
    });
  }
}

const localMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint16("protocol")
  .uint16("payloadLen")
  .buffer("payload", {
    length: "payloadLen",
  })
  .uint32("crc32");

const shortMessageParser = new Parser()
  .endianess("big")
  .string("version", {
    length: 3,
  })
  .uint32("seq")
  .uint32("random")
  .uint32("timestamp")
  .uint16("protocol");

class localConnector {
  constructor(adapter) {
    this.adapter = adapter;

    this.localClients = {};
    /**
     * Robots with a `createClient` in flight. See the comment there: the
     * client map cannot serve as the guard because it is assigned only after
     * the connect settles.
     * @type {Set<string>}
     */
    this.pendingClientConnects = new Set();
    this.l01HandshakeWaiters = new Map();
    this.reconnectTimers = new Map();
    this.connectPromises = new Map();
    // Consecutive failed local connects per duid, used to back the retry delay
    // off. Reset the moment a connect succeeds.
    this.reconnectAttempts = new Map();
    /**
     * The discovery pass currently listening, if any. See getLocalDevices for
     * why there can only be one.
     * @type {Promise<Record<string, string>>|null}
     */
    this.discoveryInFlight = null;
    /**
     * Tear down the listening discovery pass: close its socket and settle its
     * promise. Set while a pass is in the air, cleared the moment it ends by
     * any route, so shutdown can never reach for a pass that is already gone.
     *
     * A single slot is enough only because `getLocalDevices` is single-flight;
     * two overlapping passes would clobber it and leak the first socket.
     * @type {(() => void)|null}
     */
    this.closeDiscoveryPass = null;
  }

  /**
   * Delay before the next reconnect for `duid`, growing with the number of
   * consecutive failures. The first retry after a healthy connection is still
   * LOCAL_RECONNECT_DELAY_MS, because a successful connect zeroes the counter.
   * @param {string} duid
   * @returns {number}
   */
  nextReconnectDelay(duid) {
    const attempt = (this.reconnectAttempts.get(duid) || 0) + 1;
    this.reconnectAttempts.set(duid, attempt);
    return Math.min(
      LOCAL_RECONNECT_DELAY_MS * Math.pow(2, attempt - 1),
      LOCAL_RECONNECT_MAX_DELAY_MS
    );
  }

  clearReconnectTimer(duid) {
    const timer = this.reconnectTimers.get(duid);
    if (!timer) {
      return;
    }

    if (typeof this.adapter.clearTimeout === "function") {
      this.adapter.clearTimeout(timer);
    } else {
      clearTimeout(timer);
    }
    this.reconnectTimers.delete(duid);
  }

  scheduleReconnect(duid, ip, delayMs = LOCAL_RECONNECT_DELAY_MS) {
    this.clearReconnectTimer(duid);
    const { setTimer } = getTimerFns(this.adapter);
    // createClient can reject before its own try/catch takes over (the
    // awaited diagnostics write happens first, and the failure handler awaits
    // more of them). A bare timer callback that rejects is an unhandled
    // rejection, which Node terminates the process for by default — so a full
    // SD card at the moment a reconnect fires would take Homebridge down.
    // Reconnect failures are expected and already logged inside createClient;
    // swallowing them here only prevents the crash.
    const timer = setTimer(() => {
      this.reconnectTimers.delete(duid);
      // The address is re-read here rather than taken from the closure. See
      // reconnectTargetFor.
      Promise.resolve()
        .then(() => this.createClient(duid, this.reconnectTargetFor(duid, ip)))
        .catch((error) => {
          this.adapter.log.debug(
            `Local reconnect attempt for ${duid} failed: ${error?.message || error}`
          );
        });
      // Deliberately not awaited before the attempt above: the correction it
      // produces is for the retry AFTER this one, which is at least a minute
      // out, and a robot that merely blipped is still at the address we hold.
      // Making every attempt wait five seconds for a listen window would slow
      // the common case down to fix the rare one.
      void this.refreshLocalIpFromBroadcast(duid);
    }, delayMs);
    this.reconnectTimers.set(duid, timer);
  }

  /**
   * The address the next reconnect should aim at.
   *
   * `scheduleReconnect` used to close over the address the socket was built
   * with, and that is right for every reason a local socket drops but the one
   * that lasts: a DHCP lease that moved the robot. That robot sat reachable at
   * a new address while the retry chain probed the old one — backing off to
   * once every fifteen minutes, for the life of the process. Nothing looked
   * broken, because a failed local connect falls back to the cloud
   * automatically and every command still worked; the only symptom was that
   * the fast path never returned until Homebridge was restarted.
   *
   * The captured address stays the fallback. An adapter that knows no address
   * for this robot must not turn a failed connect into a `connect(undefined)`,
   * which is a thrown TypeError inside a timer callback rather than a
   * connection failure the retry logic understands.
   *
   * @param {string} duid
   * @param {string} fallbackIp the address the socket was originally built with
   * @returns {string}
   */
  reconnectTargetFor(duid, fallbackIp) {
    const known = this.adapter.getKnownLocalIp?.(duid);

    return typeof known == "string" && known ? known : fallbackIp;
  }

  /**
   * Re-run LAN discovery and adopt whatever address `duid` broadcasts now.
   *
   * The UDP broadcast is the one signal that means "this robot is on THIS LAN
   * at THIS address", which is exactly what a local connection needs to know —
   * so it, and not the cloud's `get_network_info`, is the right source for a
   * correction. (`get_network_info` cannot serve here anyway: a robot whose
   * local connect just failed has already been marked remote, and that mark is
   * what gates the write of its address.)
   *
   * A pass that hears nothing changes nothing, and neither does one that hears
   * the address we already hold: writing diagnostics unconditionally would let
   * a background re-check overwrite the `tcp-connected` reason of a reconnect
   * that had meanwhile succeeded.
   *
   * @param {string} duid
   * @returns {Promise<string|null>} the new address, or null if nothing changed
   */
  async refreshLocalIpFromBroadcast(duid) {
    if (this.adapter.isCloudOnlyModeEnabled?.()) {
      return null;
    }

    let discovered;
    try {
      const devices = await this.getLocalDevices();
      discovered = devices?.[duid];
    } catch (error) {
      this.adapter.log.debug(
        `Re-discovery for ${duid} found nothing usable: ${error?.message || error}`
      );
      return null;
    }

    if (typeof discovered != "string" || !discovered) {
      return null;
    }

    const previous = this.adapter.localDevices?.[duid];
    if (previous === discovered) {
      return null;
    }

    // Written back to the adapter rather than kept here, because
    // `getKnownLocalIp` and `ensureLocalConnection` read that map: a
    // correction only this module knew about would leave every other caller
    // aiming at the dead address.
    if (this.adapter.localDevices) {
      this.adapter.localDevices[duid] = discovered;
    }

    if (previous) {
      this.adapter.log.info(
        `${describeDevice(this.adapter, duid)} is answering at a new local address ` +
          `(${previous} → ${discovered}), so the local connection will be remade there. ` +
          `A DHCP lease that moves is normal; reserve the address on the router if you ` +
          `would rather it did not.`
      );
    }

    await this.adapter.updateTransportDiagnostics(duid, {
      localIp: discovered,
      localDiscoveryState: "rediscovered",
      lastTransportReason: "udp-broadcast-rediscovery",
    });

    return discovered;
  }

  async ensureConnected(duid, ip) {
    if (!ip) {
      return false;
    }

    if (this.isConnected(duid)) {
      return true;
    }

    const pending = this.connectPromises.get(duid);
    if (pending) {
      await pending;
      return Boolean(this.isConnected(duid));
    }

    const connectPromise = this.createClient(duid, ip)
      .catch((error) => {
        this.adapter.log.debug(
          `Immediate local reconnect failed for ${duid}: ${error.message || error}`
        );
      })
      .finally(() => {
        this.connectPromises.delete(duid);
      });

    this.connectPromises.set(duid, connectPromise);
    await connectPromise;
    return Boolean(this.isConnected(duid));
  }

  async resetClient(duid, reason = "local-client-reset") {
    this.clearReconnectTimer(duid);
    // A deliberate reset is not a connection failure: whatever reconnects next
    // must start from the base delay instead of inheriting a long back-off.
    this.reconnectAttempts.delete(duid);
    const client = this.localClients[duid];
    if (!client) {
      return;
    }

    if (this.localClients[duid] === client) {
      delete this.localClients[duid];
    }

    const waiter = this.l01HandshakeWaiters.get(duid);
    if (waiter) {
      this.adapter.clearTimeout(waiter.timeout);
      this.l01HandshakeWaiters.delete(duid);
      waiter.reject(
        new Error(
          `TCP client reset during L01 handshake for ${describeDevice(this.adapter, duid)}`
        )
      );
    }

    this.adapter.localL01Nonces.delete(duid);
    client.destroy();
    await this.adapter.updateTransportDiagnostics(duid, {
      tcpConnectionState: "disconnected",
      lastTransport: "cloud",
      lastTransportReason: reason,
    });
  }

  async markLocalConnected(duid) {
    // The robot answered, so the back-off starts over for the next outage.
    this.reconnectAttempts.delete(duid);

    if (this.adapter.clearRemoteDevice(duid)) {
      this.adapter.log.debug(
        `Local TCP connected for ${duid}; clearing remote fallback marker.`
      );
    }

    await this.adapter.updateTransportDiagnostics(duid, {
      tcpConnectionState: "connected",
      isRemote: false,
      remoteReason: null,
      lastTransport: "local",
      lastTransportReason: "tcp-connected",
    });
  }

  /**
   * ONE SOCKET PER ROBOT AT A TIME.
   *
   * `this.localClients[duid]` is only assigned once the connect promise has
   * settled, far below. The single-flight guard in `ensureConnected` does not
   * cover this function, and `scheduleReconnect` calls it directly — so a
   * reconnect timer firing while a connect was in flight built a second
   * socket, and the later assignment quietly orphaned the first. Its `close`
   * handler checks the map and correctly declines to reconnect, so there was
   * no storm, but the file descriptor stayed open and its `data` handler kept
   * firing for the life of the process.
   *
   * The claim is released in a `finally`. A claim that leaked would be worse
   * than the leak it prevents: that robot could never reconnect again.
   *
   * @param {string} duid
   * @param {string} ip
   */
  async createClient(duid, ip) {
    if (this.pendingClientConnects.has(duid)) {
      return;
    }
    this.pendingClientConnects.add(duid);
    try {
      await this.createClientUnguarded(duid, ip);
    } finally {
      this.pendingClientConnects.delete(duid);
    }
  }

  /** @param {string} duid @param {string} ip */
  async createClientUnguarded(duid, ip) {
    this.clearReconnectTimer(duid);
    const existingClient = this.localClients[duid];
    if (existingClient?.connected || existingClient?.connecting) {
      return;
    }

    const client = new EnhancedSocket();
    await this.adapter.updateTransportDiagnostics(duid, {
      localIp: ip,
      tcpConnectionState: "connecting",
      lastTransport: "local-pending",
    });

    // Wrap the connect method in a promise to await its completion
    let connectFailed = false;
    await new Promise((resolve, reject) => {
      let settled = false;
      const { setTimer, clearTimer } = getTimerFns(this.adapter);
      const timeout = setTimer(() => {
        if (settled) {
          return;
        }

        settled = true;
        client.destroy();
        reject(
          new Error(
            `Timed out connecting local TCP client for ${describeDevice(this.adapter, duid)} at ${ip}`
          )
        );
      }, LOCAL_CONNECT_TIMEOUT_MS);
      const finish = (callback, value) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimer(timeout);
        callback(value);
      };

      client
        .connect(58867, ip, async () => {
          this.adapter.log.debug(`tcp client for ${duid} connected`);
          await this.markLocalConnected(duid);
          this.ensureL01Handshake(duid).catch((error) => {
            this.adapter.log.debug(
              `L01 handshake on connect failed for ${duid}: ${error.message}`
            );
          });
          finish(resolve);
        })
        .on("error", (error) => {
          this.adapter.log.debug(
            `error on tcp client for ${duid}. ${error.message}`
          );
          finish(reject, error);
        });
    }).catch(async (error) => {
      connectFailed = true;
      const online = await this.adapter.onlineChecker(duid);
      await this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "connect-failed",
        lastTransport: "cloud",
        lastTransportReason: online
          ? "tcp-connect-failed"
          : "device-offline-during-connect",
      });
      if (online) {
        // if the device is online, we can assume that the device is a remote device
        this.adapter.log.debug(
          `error on tcp client for ${duid}. Marking this device as remote device. Connecting via MQTT instead ${error.message}`
        );
        await this.adapter.markDeviceRemote(
          duid,
          "marked-remote-after-connect-failure"
        );
        // this.adapter.catchError(`Failed to create tcp client: ${error.stack}`, `function createClient`, duid);
      }
    });

    client.on("data", (message) => {
      this.handleLocalData(duid, client, message);
    });

    client.on("close", () => {
      if (this.localClients[duid] !== client) {
        return;
      }
      this.adapter.log.debug(
        `tcp client for ${duid} disconnected, attempting to reconnect...`
      );
      this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "disconnected",
        lastTransport: "cloud",
        lastTransportReason: "tcp-disconnected",
      });
      const waiter = this.l01HandshakeWaiters.get(duid);
      if (waiter) {
        this.adapter.clearTimeout(waiter.timeout);
        this.l01HandshakeWaiters.delete(duid);
        waiter.reject(
          new Error(
            `TCP client closed during L01 handshake for ${describeDevice(this.adapter, duid)}`
          )
        );
      }
      this.adapter.localL01Nonces.delete(duid);
      this.scheduleReconnect(duid, ip, this.nextReconnectDelay(duid));
      client.connected = false;
    });

    client.on("error", (error) => {
      this.adapter.log.debug(
        `error on tcp client for ${duid}. ${error.message}`
      );
      this.adapter.updateTransportDiagnostics(duid, {
        tcpConnectionState: "error",
        lastTransportReason: `tcp-error: ${error.message}`,
      });
    });

    this.localClients[duid] = client;

    if (connectFailed) {
      // The close/error listeners above are attached only now, after the
      // connect promise settled. On a FAILED connect both events already fired
      // into a socket with no listeners, so nothing would ever schedule a
      // retry: an unplugged robot stayed on the cloud path until Homebridge was
      // restarted, even after it came back. Re-arm here instead, backing off so
      // a permanently absent robot is not probed every minute forever.
      const delayMs = this.nextReconnectDelay(duid);
      this.adapter.log.debug(
        `Local connect for ${duid} at ${ip} failed; retrying in ${Math.round(delayMs / 1000)}s.`
      );
      this.scheduleReconnect(duid, ip, delayMs);
    }
  }

  /**
   * Process one TCP chunk for `duid`.
   *
   * Lives outside the `data` listener so the framing and the buffer
   * bookkeeping have exactly one home and can be exercised directly.
   *
   * @param {string} duid
   * @param {EnhancedSocket} client
   * @param {Buffer} message
   */
  handleLocalData(duid, client, message) {
    try {
      if (client.chunkBuffer.length == 0) {
        this.adapter.log.debug(`new chunk started`);
        client.chunkBuffer = message;
      } else {
        this.adapter.log.debug(`new chunk received`);
        client.chunkBuffer = Buffer.concat([client.chunkBuffer, message]);
      }
      // this.adapter.log.debug(`new chunk received: ${message.toString("hex")}`);

      const scan = this.scanChunkBuffer(client.chunkBuffer);

      if (scan.status == "desync") {
        // Waiting for a frame this size is waiting forever, so every later
        // chunk would just be appended to a buffer that can never complete.
        // Throw the buffer away and re-align on whatever arrives next.
        const dropped = client.chunkBuffer.length;
        client.chunkBuffer = Buffer.alloc(0);
        const reason = `Local TCP stream for ${describeDevice(this.adapter, duid)} is out of sync: a frame of ${scan.declaredLength} bytes was announced at offset ${scan.consumed} (max ${MAX_LOCAL_FRAME_BYTES}). Dropping ${dropped} buffered bytes and resyncing.`;
        if (client.desyncReported) {
          this.adapter.log.debug(reason);
        } else {
          client.desyncReported = true;
          this.adapter.log.warn(reason);
        }
        return;
      }

      if (scan.status != "complete") {
        return;
      }

      const buffer = client.chunkBuffer;
      let offset = 0;

      try {
        if (scan.consumed > 0) {
          this.adapter.log.debug(
            `Chunk buffer data is complete. Processing...`
          );
        }
        // this.adapter.log.debug(`chunkBuffer: ${buffer.toString("hex")}`);
        while (offset < scan.consumed) {
          const segmentLength = buffer.readUInt32BE(offset);
          const currentBuffer = buffer.subarray(
            offset + 4,
            offset + segmentLength + 4
          );
          offset += 4 + segmentLength;

          try {
            this.processLocalSegment(duid, segmentLength, currentBuffer);
          } catch (error) {
            // One frame the robot sent in a shape we cannot read (a payload
            // that is not JSON after decryption, a dps["102"] with unexpected
            // contents) must not take the frames queued behind it in the same
            // chunk down with it.
            this.adapter.log.debug(
              `Discarding an unprocessable local frame for ${duid}: ${error?.message || error}`
            );
          }
        }
      } finally {
        // Consume unconditionally. When this only ran on the success path, a
        // single frame that threw skipped the reset, so the next chunk was
        // concatenated onto the retained bytes, re-processed the same poison
        // frame, threw at the same offset again — forever. The buffer grew
        // without bound and every later local reply for this robot was lost
        // with no way back short of restarting Homebridge.
        const remainder = buffer.length - scan.consumed;
        // subarray keeps the entire parent chunk alive, so the 1-3 byte tail is
        // copied out rather than viewed.
        client.chunkBuffer =
          remainder > 0
            ? Buffer.from(buffer.subarray(scan.consumed))
            : Buffer.alloc(0);
        if (scan.consumed > 0) {
          client.desyncReported = false;
        }
      }
    } catch (error) {
      // Nothing above should reach this, but if it ever does the buffer still
      // has to go: a retained buffer is what turns one bad chunk into a
      // permanently dead local channel.
      client.chunkBuffer = Buffer.alloc(0);
      this.adapter.catchError(
        `Failed to process local tcp data: ${error.stack}`,
        `function handleLocalData`,
        duid
      );
    }
  }

  /**
   * Decode and dispatch a single framed segment.
   * @param {string} duid
   * @param {number} segmentLength
   * @param {Buffer} currentBuffer
   */
  processLocalSegment(duid, segmentLength, currentBuffer) {
    // length of 17 does not contain any useful data.
    // It seems to be protocol handshake metadata.
    if (segmentLength == 17) {
      try {
        const shortMessage = shortMessageParser.parse(currentBuffer);
        if (shortMessage.version == "L01" && shortMessage.protocol == 1) {
          const currentNonces = this.adapter.localL01Nonces.get(duid) || {};
          this.adapter.localL01Nonces.set(duid, {
            connectNonce: currentNonces.connectNonce,
            ackNonce: shortMessage.random,
          });

          const waiter = this.l01HandshakeWaiters.get(duid);
          if (waiter) {
            this.adapter.clearTimeout(waiter.timeout);
            this.l01HandshakeWaiters.delete(duid);
            waiter.resolve(true);
          }
        }
      } catch (error) {
        this.adapter.log.debug(
          `Failed parsing short local message for ${duid}: ${error.message}`
        );
      }
      return;
    }

    const data = this.adapter.message._decodeMsg(currentBuffer, duid);
    if (!data || data.protocol != 4) {
      return;
    }

    const dps = JSON.parse(data.payload).dps;
    if (!dps) {
      return;
    }

    // Most firmwares put a JSON string in dps["102"], but some hand back an
    // already-parsed object. The old double JSON.parse turned that second case
    // into "[object Object]" and threw, which is one of the two ways a single
    // frame used to wedge the whole channel.
    const raw = dps["102"];
    const parsed_102 = typeof raw == "string" ? JSON.parse(raw) : raw;
    if (!parsed_102) {
      return;
    }

    const id = parsed_102.id;
    const result = parsed_102.result;

    if (this.adapter.pendingRequests.has(id)) {
      const refusal = describeReplyRefusal(parsed_102);
      this.adapter.log.debug(
        typeof result === "undefined"
          ? `Local message with protocol 4 and id ${id} received. No result; reply was ${JSON.stringify(parsed_102)}`
          : `Local message with protocol 4 and id ${id} received. Result: ${JSON.stringify(result)}`
      );
      const { resolve, reject, timeout, method } =
        this.adapter.pendingRequests.get(id);
      this.adapter.clearTimeout(timeout);
      this.adapter.pendingRequests.delete(id);
      // Proof that this socket is not mute, so any run of timeouts counted
      // against it starts over. A refusal still proves the socket answers —
      // it is the request that failed, not the transport.
      if (this.adapter.noteLocalRequestSucceeded) {
        this.adapter.noteLocalRequestSucceeded(duid);
      }
      if (refusal && typeof reject === "function") {
        reject(
          createRefusalError(
            `The robot refused ${method || "the request"} (local id ${id}): ${refusal}`,
            parsed_102
          )
        );
        return;
      }
      resolve(result);

      if (this.adapter.deviceNotify !== undefined) {
        this.adapter.deviceNotify("LocalMessage", {
          duid,
          payload: result,
        });
      }
    }
  }

  /**
   * Walk the length-prefixed frames in `buffer` without decoding them.
   *
   * `consumed` is the offset just past the last WHOLE frame, so the caller can
   * keep everything after it. That tail is what used to be lost: both loops
   * were bounded by `offset + 4 <= length`, so a chunk ending 1-3 bytes into a
   * length prefix was reported complete and those bytes were dropped, which
   * misaligned every frame that followed on that connection.
   *
   * @param {Buffer} buffer
   * @returns {{status: "complete" | "incomplete" | "desync", consumed: number, declaredLength: number}}
   */
  scanChunkBuffer(buffer) {
    let offset = 0;

    while (offset + 4 <= buffer.length) {
      const segmentLength = buffer.readUInt32BE(offset);

      if (segmentLength > MAX_LOCAL_FRAME_BYTES) {
        return {
          status: "desync",
          consumed: offset,
          declaredLength: segmentLength,
        };
      }

      const nextOffset = offset + 4 + segmentLength;
      if (nextOffset > buffer.length) {
        // The payload is still in flight; wait for the rest of it.
        return {
          status: "incomplete",
          consumed: offset,
          declaredLength: segmentLength,
        };
      }

      offset = nextOffset;
    }

    return { status: "complete", consumed: offset, declaredLength: 0 };
  }

  checkComplete(buffer) {
    return this.scanChunkBuffer(buffer).status == "complete";
  }

  clearChunkBuffer(duid) {
    if (this.localClients[duid]) {
      this.localClients[duid].chunkBuffer = Buffer.alloc(0);
    }
  }

  sendMessage(duid, message) {
    const client = this.localClients[duid];
    if (client) {
      client.write(message);
    }
  }

  isConnected(duid) {
    if (this.localClients[duid]) {
      return this.localClients[duid].connected;
    }
  }

  async ensureL01Handshake(duid) {
    const version = await this.adapter.getRobotVersion(duid);
    if (version != "L01") {
      return;
    }

    const client = this.localClients[duid];
    if (!client || !client.connected) {
      return;
    }

    const existingNonces = this.adapter.localL01Nonces.get(duid);
    if (
      existingNonces &&
      typeof existingNonces.connectNonce == "number" &&
      typeof existingNonces.ackNonce == "number"
    ) {
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const handshakeMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      1,
      timestamp,
      Buffer.alloc(0)
    );
    if (!handshakeMessage) {
      throw new Error(
        `Failed to build protocol 1 handshake message for ${describeDevice(this.adapter, duid)}`
      );
    }

    const connectNonce = handshakeMessage.readUInt32BE(7);
    this.adapter.localL01Nonces.set(duid, {
      connectNonce,
      ackNonce: undefined,
    });

    if (this.l01HandshakeWaiters.has(duid)) {
      const waiter = this.l01HandshakeWaiters.get(duid);
      this.adapter.clearTimeout(waiter.timeout);
      this.l01HandshakeWaiters.delete(duid);
    }

    const handshakePromise = new Promise((resolve, reject) => {
      const timeout = this.adapter.setTimeout(() => {
        this.l01HandshakeWaiters.delete(duid);
        reject(
          new Error(
            `Timed out waiting for L01 handshake response for ${describeDevice(this.adapter, duid)}`
          )
        );
      }, 3000);

      this.l01HandshakeWaiters.set(duid, { resolve, reject, timeout });
    });

    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(handshakeMessage.length, 0);
    const fullMessage = Buffer.concat([lengthBuffer, handshakeMessage]);
    client.write(fullMessage);

    await handshakePromise;
  }

  /**
   * Listen for the robots' UDP broadcasts and answer duid → address.
   *
   * SINGLE-FLIGHT, because the listen socket binds a fixed port. Startup runs
   * one pass, and a failing reconnect now runs one of its own, so two can
   * genuinely overlap — and the second `bind` would fail with EADDRINUSE,
   * which reaches `catchError` and rejects a discovery that had nothing wrong
   * with it. A caller that arrives while a pass is listening joins that pass
   * instead of opening a second one.
   *
   * The claim is released in a `finally`, including on rejection: a claim that
   * leaked would be worse than the collision it prevents, because nothing
   * would ever discover again.
   *
   * @returns {Promise<Record<string, string>>}
   */
  getLocalDevices() {
    if (this.discoveryInFlight) {
      return this.discoveryInFlight;
    }

    const pass = this.listenForLocalDevices().finally(() => {
      if (this.discoveryInFlight === pass) {
        this.discoveryInFlight = null;
      }
    });
    this.discoveryInFlight = pass;

    return pass;
  }

  async listenForLocalDevices() {
    return new Promise((resolve, reject) => {
      const devices = {};

      // One socket per discovery run, created here rather than at module load.
      //
      // A module-scope socket was wrong three ways. It was opened by the mere
      // act of requiring this file, so a cloud-only install held a bound UDP
      // socket it never used — and it kept the Jest workers alive, which is
      // the "worker process has failed to exit gracefully" warning the suite
      // has printed for months and which would mask a real leak. Worse, the
      // handlers below were attached to that one shared socket on every call,
      // so a second discovery pass double-handled every datagram, and the
      // close() at the end of the first pass left the socket unbindable for
      // the next one.
      const server = dgram.createSocket("udp4");
      let closed = false;
      const closeServer = () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          server.close();
        } catch {
          // Already closed, or never bound. Nothing to release.
        }
      };

      // The discovery socket is bound to 0.0.0.0 and receives whatever any
      // host on the LAN broadcasts to this port — the Roborock phone app doing
      // its own discovery, a port scanner, a malformed retransmit. Neither
      // `localMessageParser.parse` (binary-parser throws RangeError on a short
      // or over-declared buffer) nor `JSON.parse` is total, and a synchronous
      // throw inside a dgram handler is an uncaught exception that takes
      // Homebridge down with it. One stray datagram must never do that, so
      // every unparseable packet is skipped instead.
      server.on("message", (msg) => {
        let parsedDecodedMessage;

        try {
          const parsedMessage = localMessageParser.parse(msg);
          const decodedMessage = this.decryptECB(
            parsedMessage.payload,
            BROADCAST_TOKEN
          ); // this might be decryptCBC for A01. Haven't checked this yet

          if (decodedMessage == null) {
            this.adapter.log.debug(`getLocalDevices: decodedMessage is null`);
            return;
          }

          parsedDecodedMessage = JSON.parse(decodedMessage);
        } catch (error) {
          this.adapter.log.debug(
            `getLocalDevices: ignoring a malformed discovery datagram (${msg?.length ?? 0} bytes): ${error?.message || error}`
          );
          return;
        }

        this.adapter.log.debug(
          `getLocalDevices parsedDecodedMessage: ${JSON.stringify(parsedDecodedMessage)}`
        );

        if (parsedDecodedMessage) {
          const localKey = this.adapter.localKeys.get(
            parsedDecodedMessage.duid
          );
          this.adapter.log.debug(
            `getLocalDevices localKey present: ${Boolean(localKey)}`
          );

          if (localKey) {
            // if there's no localKey, decryption cannot work. For example when the found robot is not associated with a roborock account
            if (!devices[parsedDecodedMessage.duid]) {
              devices[parsedDecodedMessage.duid] = parsedDecodedMessage.ip;
              this.adapter.updateTransportDiagnostics(
                parsedDecodedMessage.duid,
                {
                  localIp: parsedDecodedMessage.ip,
                  localDiscoveryState: "broadcast-detected",
                  lastTransportReason: "udp-broadcast-discovery",
                }
              );
            }
          }
        }
      });

      server.on("error", (error) => {
        this.closeDiscoveryPass = null;
        this.adapter.catchError(`Discover server error: ${error.stack}`);
        closeServer();
        reject(error);
      });

      server.bind(PORT);

      // Shutdown's only hook into this module clears the timer below, which
      // used to be the sole route to `closeServer()` and `resolve()` — so a
      // pass caught in the air leaked a bound UDP socket AND hung every
      // caller awaiting it. Hand shutdown the pass's own teardown instead.
      //
      // It resolves rather than rejects: a rejection reaches `catchError` and
      // would log an error line for an ordinary shutdown. The addresses heard
      // so far are already-measured facts, written to diagnostics as they
      // arrived, so they are handed over rather than discarded.
      this.closeDiscoveryPass = () => {
        this.closeDiscoveryPass = null;
        closeServer();
        resolve(devices);
      };

      this.localDevicesTimeout = this.adapter.setTimeout(() => {
        this.closeDiscoveryPass = null;
        closeServer();

        resolve(devices);
      }, TIMEOUT);
    });
  }

  safeRemovePkcs7(buf) {
    if (!buf || buf.length === 0) return Buffer.alloc(0);
    const pad = buf[buf.length - 1];
    // 僅在 1..16 且最後 pad 個 byte 都等於 pad 時才移除
    if (pad > 0 && pad <= 16) {
      for (let i = 0; i < pad; i++) {
        if (buf[buf.length - 1 - i] !== pad) return buf; // padding 形狀不對，視為無 padding
      }
      return buf.slice(0, buf.length - pad);
    }
    return buf; // 看起來沒有標準 PKCS#7 padding
  }

  decryptECB(encrypted, aesKey) {
    // --- 1) Key/輸入檢查 ---
    const key = Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey);
    if (key.length !== 16) {
      // AES-128 需要 16 bytes 的 key
      return null;
    }

    const input = Buffer.isBuffer(encrypted)
      ? encrypted
      : Buffer.from(encrypted, "latin1"); // "binary" 等同 latin1
    if (input.length === 0 || input.length % 16 !== 0) {
      // 密文長度不是 16 的倍數，多半是封包不完整；丟回 null 讓上層忽略本次
      return null;
    }

    try {
      // --- 2) 固定用 Buffer，關閉自動 padding（你要自己移除） ---
      const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(false);

      const decryptedBuf = Buffer.concat([
        decipher.update(input),
        decipher.final(),
      ]);
      const unpadded = this.safeRemovePkcs7(decryptedBuf);

      // 若原協定內容是 UTF-8，這裡再轉字串；否則直接回傳 Buffer 讓上層處理
      return unpadded.toString("utf8");
    } catch (err) {
      // 例如 wrong final block length、key 不對等情況
      // 這裡不要讓程式炸掉，直接忽略這個封包
      // 你也可以在這裡做一次 debug log
      // console.debug("decryptECB error:", err);
      return null;
    }
  }

  clearLocalDevicedTimeout() {
    if (this.localDevicesTimeout) {
      this.adapter.clearTimeout(this.localDevicesTimeout);
      this.localDevicesTimeout = null;
    }

    // Clearing that timer disarms the pass's own ending, so the pass has to be
    // ended here instead: its socket closed and its promise settled. Dropping
    // the single-flight claim while leaving the socket bound would be worse
    // than the leak — the port is fixed (58866), so the next pass would fail
    // to bind with EADDRINUSE and reject a discovery that had nothing wrong
    // with it. No pass in flight (a cloud-only install never opens one) makes
    // this a no-op by construction.
    this.closeDiscoveryPass?.();

    // This is the only local-transport hook the adapter's
    // clearTimersAndIntervals calls on shutdown. Reconnect timers are armed as
    // far out as LOCAL_RECONNECT_MAX_DELAY_MS, so without this they would
    // outlive stopService and fire createClient into a torn-down adapter.
    for (const duid of [...this.reconnectTimers.keys()]) {
      this.clearReconnectTimer(duid);
    }
    this.reconnectAttempts.clear();
  }

  /**
   * Destroy every local socket on shutdown.
   *
   * `clearLocalDevicedTimeout` above disarms the reconnect timers and its own
   * comment explains why — so nothing fires `createClient` into a torn-down
   * adapter. It left every socket in `localClients` connected, which defeats
   * the point: a socket that closes during shutdown reaches the `close`
   * handler, which schedules a reconnect, which arms a NEW timer and starts
   * writing diagnostics files while the bridge is being dismantled.
   *
   * Sockets are removed from `localClients` before being destroyed, because
   * the `close` handler checks that map to decide whether the socket is still
   * the current one — so removing first makes the handler a no-op by
   * construction rather than by timing.
   */
  destroyAllClients() {
    for (const duid of Object.keys(this.localClients)) {
      const client = this.localClients[duid];
      delete this.localClients[duid];
      const waiter = this.l01HandshakeWaiters.get(duid);
      if (waiter) {
        this.adapter.clearTimeout(waiter.timeout);
        this.l01HandshakeWaiters.delete(duid);
      }
      try {
        client?.removeAllListeners?.();
        client?.destroy?.();
      } catch (error) {
        this.adapter?.log?.debug?.(
          `Destroying the local socket for ${duid} on shutdown failed: ${
            error?.message || error
          }`
        );
      }
    }
    this.l01HandshakeWaiters.clear();
    this.pendingClientConnects.clear();
  }
}

module.exports = {
  localConnector,
};
