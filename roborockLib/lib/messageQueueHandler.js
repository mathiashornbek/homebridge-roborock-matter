// @ts-check
"use strict";

const b01Q7Adapter = require("./b01Q7Adapter");
const b01Q10Adapter = require("./b01Q10Adapter");
const { describeDevice } = require("./describeDevice");

/**
 * A refusal to put a request on the wire, tagged with why.
 *
 * The classifier used to read these back out of the prose — a regex for
 * "Not sending method … request." plus substring tests for "is offline" and
 * "Cloud connection not available". That coupling broke the moment the
 * wording was made readable, and it broke silently in the direction that
 * matters: an unclassified refusal is logged as a plugin error with a stack,
 * once per poll, for as long as the robot is away. The reason now travels as
 * a code and the prose is free to change.
 *
 * `code` defaults to the transport code because most refusals ARE transport
 * conditions — an offline robot, a dead cloud link, a missing local socket —
 * and those must stay visible as warnings. A refusal that reflects what a
 * robot family can never do is a capability fact instead, and passing
 * `B01_METHOD_UNSUPPORTED` puts it on `catchError`'s calm branch by
 * construction rather than leaving each caller to gate itself. Do not widen
 * that to the transport cases: it would tell a user nothing is wrong while
 * their robot is unreachable.
 *
 * @param {string} kind
 * @param {string} message
 * @param {string} [code]
 * @returns {Error & { code: string, transientKind: string }}
 */
function refusal(kind, message, code = "ROBOROCK_TRANSPORT_REFUSED") {
  const error = /** @type {Error & { code: string, transientKind: string }} */ (
    new Error(message)
  );
  error.code = code;
  error.transientKind = kind;
  return error;
}

const DEFAULT_REQUEST_TIMEOUT = 10000; // 10s
// Some commands legitimately take longer to acknowledge. Switching the active
// saved map (load_multi_map) can take well over the default timeout on older
// models such as the S6 Pure, so give it more headroom before timing out.
/** @type {Record<string, number>} */
const METHOD_REQUEST_TIMEOUTS = {
  load_multi_map: 30000, // 30s
};

/**
 * @param {string} method
 * @param {number} [requestTimeoutMs]
 * @returns {number}
 */
function getRequestTimeout(method, requestTimeoutMs) {
  const override = Number(requestTimeoutMs);
  if (Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }

  return METHOD_REQUEST_TIMEOUTS[method] || DEFAULT_REQUEST_TIMEOUT;
}

/**
 * What the MQTT link did while a cloud request was pending, as a sentence to
 * append to the timeout error.
 *
 * A cloud timeout says only that nothing came back, and the two causes behind
 * it need opposite responses: a reply that never arrived is a robot or account
 * that is not answering, while a reply that arrived and was not matched is a
 * correlation bug on this side. The plugin already knows which — the MQTT
 * receiver attributes every decoded message to a device — but the three paths
 * that could say so all log at debug, so the fact never reaches the warn line
 * a user actually reports.
 *
 * Measured in #14 (niclasreich, Q10 S5 `roborock.vacuum.ss07`, 26 Aug 2026):
 * every `prop.get`, `prop.set` and `service.set_room_clean` timed out with the
 * MQTT state reported as `true`, and neither of us could tell silence from an
 * unrecognised answer. It cost two round trips with the reporter.
 *
 * Deliberately cloud-only. A local request dies on its own socket, and MQTT
 * receipts would say nothing about it.
 *
 * @param {MessageQueueAdapter} adapter
 * @param {string} duid
 * @param {number | null} receiptsAtSend Receipts counted as the request went
 *   out, or `null` when this adapter cannot count them.
 * @returns {string} A sentence starting with a space, or `""`.
 */
function describeCloudSilence(adapter, duid, receiptsAtSend) {
  if (
    receiptsAtSend === null ||
    typeof adapter.getCloudMessageReceiptCount !== "function"
  ) {
    return "";
  }

  const total = adapter.getCloudMessageReceiptCount(duid);

  if (total === 0) {
    // 3.17.7 concluded "the reply never arrived rather than arriving
    // unrecognised" here, and that does not follow. The receiver drops a frame
    // before the counter whenever its topic matches no known robot, and that
    // path logs at debug — so an unattributed reply is invisible to both the
    // counter and the user. Unattributed traffic is the difference between a
    // robot that is silent (Roborock-side) and one whose answers we are
    // throwing away (ours), so say which was observed and claim nothing more.
    const unattributed =
      typeof adapter.getUnattributedCloudMessageCount === "function"
        ? adapter.getUnattributedCloudMessageCount()
        : null;

    if (unattributed === null) {
      return " No Roborock message has reached the plugin from this robot since startup.";
    }

    if (unattributed > 0) {
      return ` No Roborock message has reached the plugin from this robot since startup, but ${unattributed} message(s) arrived on a topic matching no known robot — the link is delivering and the plugin is failing to attribute it, which is a fault on this side.`;
    }

    return " No Roborock message has reached the plugin from this robot since startup, and none arrived on an unrecognised topic either, so nothing is coming back over MQTT at all.";
  }

  const duringRequest = total - receiptsAtSend;
  if (duringRequest > 0) {
    // Arrived-but-unmatched is not proof the reply was sent: an unsolicited
    // robot push counts here too. It does prove the link delivers, which is
    // the half that a bare timeout leaves open.
    return ` ${duringRequest} Roborock message(s) reached the plugin from this robot while the request was pending, so the link is delivering; the reply was either never sent or not recognised.`;
  }

  // The bare total was uninterpretable, and it misleads in the one direction
  // that matters. This counter is incremented in the MQTT receiver only, so a
  // robot that answers on the local socket never touches it — yet the poll
  // chain a reader would compare it against runs over whichever transport is
  // up. Measured on Mathias' own S8 Pro Ultra (a70, 27 Aug 2026): one cloud
  // timeout reported "(8 since startup)" after 8.5 hours in which the 180 s
  // poll had issued hundreds of requests, all answered locally. Read as a
  // like-for-like ratio that says a 95 % dead link; read correctly it says
  // nothing is wrong. Say what the number counts so the comparison is not
  // available to make.
  return ` No Roborock message reached the plugin from this robot while the request was pending (${total} cloud message(s) since startup). That total counts cloud traffic only — replies over the local socket are never counted here — so a low number on a robot that usually answers locally is normal and is not evidence the link is failing.`;
}

/**
 * @typedef {Object} PendingRequest
 * @property {(value: unknown) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {ReturnType<typeof setTimeout>} timeout
 * @property {boolean} [secure] True for requests whose protocol-102 reply is
 *   only an acknowledgement, with the real payload arriving on protocol 301.
 * @property {string} [method] The Roborock method, kept for diagnostics.
 */

/**
 * @typedef {Object} TransportDiagnosticsUpdate
 * @property {"cloud" | "local" | "local-pending"} [lastTransport]
 * @property {string} [lastTransportReason]
 * @property {string} [lastCommandMethod]
 */

/**
 * @typedef {Object} MessageBuilder
 * @property {(duid: string, protocol: number, messageID: number, method: string, params: unknown[], secure: boolean, photo: boolean, options?: {b01Q10Dps?: Record<string, unknown>}) => Promise<unknown>} buildPayload
 * @property {(duid: string, protocol: number, timestamp: number, payload: unknown) => Promise<Buffer | null | undefined>} buildRoborockMessage
 */

/**
 * @typedef {Object} LocalConnector
 * @property {(duid: string) => boolean} isConnected
 * @property {(duid: string, message: Buffer) => void} sendMessage
 * @property {(duid: string) => void} clearChunkBuffer
 * @property {(duid: string) => Promise<void>} [ensureL01Handshake]
 */

/**
 * @typedef {Object} MqttConnector
 * @property {() => boolean} isConnected
 * @property {(duid: string, message: Buffer) => void} sendMessage
 */

/**
 * @typedef {Object} LoggerLike
 * @property {(message: string) => void} debug
 * @property {(message: string) => void} info
 */

/**
 * @typedef {Object} RoborockConfig
 * @property {boolean} [cloudOnlyMode]
 */

/**
 * @typedef {Object} MessageQueueAdapter
 * @property {RoborockConfig} [config]
 * @property {(duid: string) => Promise<boolean>} isRemoteDevice
 * @property {(duid: string) => Promise<string>} getRobotVersion
 * @property {(duid: string) => Promise<boolean>} onlineChecker
 * @property {MqttConnector} rr_mqtt_connector
 * @property {LocalConnector} localConnector
 * @property {MessageBuilder} message
 * @property {() => number} getRequestId
 * @property {Map<number, PendingRequest>} pendingRequests
 * @property {(callback: () => void, timeout: number) => ReturnType<typeof setTimeout>} setTimeout
 * @property {(timeout: ReturnType<typeof setTimeout>) => void} clearTimeout
 * @property {LoggerLike} log
 * @property {(duid: string, update: TransportDiagnosticsUpdate) => Promise<void>} updateTransportDiagnostics
 * @property {(duid: string) => Promise<boolean>} [ensureLocalConnection]
 * @property {(duid: string, method?: string) => Promise<void>} [noteLocalRequestTimedOut]
 * @property {(duid: string) => number} [getCloudMessageReceiptCount] How many
 *   decoded MQTT messages have been attributed to this robot since startup.
 *   Optional so an adapter that cannot count them keeps the old timeout text.
 * @property {() => number} [getUnattributedCloudMessageCount] How many inbound
 *   MQTT frames matched no known robot since startup. Account-wide, since
 *   attribution is what failed. Optional: without it the timeout reports the
 *   observation and draws no conclusion about why the robot is silent.
 * @property {(message: string, location: string, duid?: string) => void} catchError
 * @property {(duid: string) => string} [describeDevice]
 * @property {(duid: string, attribute: string) => string} [getProductAttribute]
 */

/**
 * @typedef {Object} RequestOptions
 * @property {boolean} [preferCloud]
 * @property {boolean} [preferLocal]
 * @property {boolean} [allowOfflineCloudSend]
 * @property {number} [requestTimeoutMs]
 */

class messageQueueHandler {
  /**
   * @param {MessageQueueAdapter} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @param {unknown[]} params
   * @param {boolean} [secure=false]
   * @param {boolean} [photo=false]
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown | undefined>}
   */
  async sendRequest(
    duid,
    method,
    params,
    secure = false,
    photo = false,
    options = {}
  ) {
    const remoteConnection = await this.adapter.isRemoteDevice(duid);
    const version = await this.adapter.getRobotVersion(duid);

    const deviceOnline = await this.adapter.onlineChecker(duid);
    const mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    let localConnectionState = this.adapter.localConnector.isConnected(duid);
    const cloudOnlyConnection = Boolean(this.adapter.config?.cloudOnlyMode);
    const preferCloudConnection =
      Boolean(options.preferCloud) && mqttConnectionState;
    const preferLocalConnection =
      Boolean(options.preferLocal) &&
      !cloudOnlyConnection &&
      !preferCloudConnection &&
      !remoteConnection &&
      !secure &&
      !photo &&
      method != "get_network_info";

    if (
      preferLocalConnection &&
      !localConnectionState &&
      typeof this.adapter.ensureLocalConnection == "function"
    ) {
      await this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "local-pending",
        lastTransportReason: "preferred-local-reconnect",
        lastCommandMethod: method,
      });
      await this.adapter.ensureLocalConnection(duid);
      localConnectionState = this.adapter.localConnector.isConnected(duid);
    }

    // The Q10 datapoint write, when this request is bound for a Q10. Non-null
    // is what makes the send below fire-and-forget, because that is the only
    // family whose dialect never replies.
    /** @type {Record<string, any> | null} */
    let b01Q10Dps = null;

    // B01 devices are cloud/MQTT-only and speak a different RPC dialect.
    // Translate the v1-shaped method to the family's equivalent here so a
    // single choke point covers every caller (Matter, polling, UI).
    if (b01Q7Adapter.isB01Protocol(version)) {
      const model = this.adapter?.getProductAttribute?.(duid, "model");
      const family = b01Q7Adapter.b01FamilyForModel(model);
      const neutral = b01Q7Adapter.neutralResponse(method);

      // `pv === "B01"` IS TWO WIRE PROTOCOLS AND ONLY Q7 IS IMPLEMENTED.
      //
      // Q7 (`sc*`) carries a request as an RPC envelope on datapoint 10000:
      //   {"dps":{"10000":{"method":"prop.set","msgId":"…","params":…}}}
      // Q10 (`ss*`) writes the datapoint directly, with no method and no
      // msgId at all:
      //   {"dps":{"201":1}}
      //
      // Datapoint 10000 is not in the Q10 datapoint set, so publishing the Q7
      // envelope to a Q10 sends it a correctly framed, correctly encrypted
      // frame addressed to a datapoint it does not have, which it discards.
      // Q10 commands are also fire-and-forget — the dialect sends no RPC
      // reply — so the request then waits out its full timeout for an answer
      // that could not arrive even on a healthy link.
      //
      // That is what #14 spent three rounds on: the timeout diagnostics
      // correctly reported total MQTT silence and thereby sent the reporter
      // after a Roborock-side fault, when the cause was this plugin speaking
      // the wrong language into a working link.
      //
      // Since 3.19.0 the Q10 dialect is spoken for COMMANDS: the datapoint
      // write is built here and travels to the encoder in the options bag.
      // READS stay refused, and that is a property of the dialect rather than
      // unfinished work — a Q10 sends no RPC reply at all, so a read has
      // nothing to resolve with. Serving one would hand the caller a value the
      // robot never sent, and `mapStatusToV1` would publish that non-answer to
      // Apple Home as the robot's state. A Q10's status comes from home data
      // over HTTPS instead, a separate transport measured working in #14;
      // reading it off pushed datapoint updates is the remaining half of #19.
      //
      // Methods answered from NEUTRAL_RESPONSES never touch the wire, so they
      // are left alone either way — refusing those would regress the
      // room-mapping fix from 3.17.3, opened by this same reporter.
      if (family === b01Q7Adapter.B01_FAMILY.Q10 && !neutral) {
        const q10 = b01Q10Adapter.translateOutgoing(method, params);

        if (!q10) {
          // A capability fact, not a transport fault: this dialect has no
          // equivalent for the method and never will. Carrying the unsupported
          // code keeps `catchError` calm BY CONSTRUCTION, so a caller that
          // reaches here logs debug instead of "Failed to execute …" on warn.
          // 3.19.0 and 3.19.1 were each one gate for one loop of exactly this
          // class; the shape of the error is what kept producing them.
          throw refusal(
            "b01 q10 method unsupported",
            `${describeDevice(this.adapter, duid)} speaks the B01 Q10 dialect, which has no equivalent for ${method}, so it was not sent. The Q10 dialect (${model || "ss*"}) writes numbered datapoints and sends no reply, so a request that exists to read a value cannot be answered over it; see issue #19.`,
            "B01_METHOD_UNSUPPORTED"
          );
        }

        b01Q10Dps = b01Q10Adapter.buildDps(q10.dp, q10.params);
      }

      // A Q10 request is already fully encoded; running it through the Q7
      // translation as well would overwrite `method` and `params` with the
      // wrong dialect's names, and `set_custom_mode` would then be refused
      // outright because the Q10 wind codes are not in the Q7 table.
      const translated = b01Q10Dps
        ? null
        : b01Q7Adapter.translateOutgoing(method, params, family);

      if (!b01Q10Dps && !translated) {
        if (neutral) {
          this.adapter.log.debug(
            `Method ${method} has no B01/Q7 equivalent for ${duid}; returning a neutral response.`
          );
          return neutral.value;
        }

        const unsupported = /** @type {Error & {code?: string}} */ (
          new Error(
            `Method ${method} is not supported on B01/Q7 robots yet (${describeDevice(this.adapter, duid)}).`
          )
        );
        unsupported.code = "B01_METHOD_UNSUPPORTED";
        throw unsupported;
      }

      if (translated) {
        method = translated.method;
        params = /** @type {any} */ (translated.params);
      }
    }

    let useCloudConnection =
      b01Q7Adapter.isB01Protocol(version) ||
      cloudOnlyConnection ||
      preferCloudConnection ||
      remoteConnection ||
      secure ||
      photo ||
      method == "get_network_info";
    if (!useCloudConnection && !localConnectionState && mqttConnectionState) {
      useCloudConnection = true;
      await this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "cloud",
        lastTransportReason: "local-unavailable-fallback",
        lastCommandMethod: method,
      });
      this.adapter.log.debug(
        `Local connection unavailable for ${duid}. Falling back to cloud connection for method ${method}.`
      );
    }

    if (!useCloudConnection && version == "L01") {
      try {
        if (this.adapter.localConnector.ensureL01Handshake) {
          await this.adapter.localConnector.ensureL01Handshake(duid);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.adapter.log.debug(
          `L01 handshake before request failed for ${duid}: ${errorMessage}`
        );
      }
    }

    let messageID = /** @type {any} */ (
      b01Q7Adapter.isB01Protocol(version)
        ? b01Q7Adapter.createB01MessageId()
        : this.adapter.getRequestId()
    );
    if (photo && typeof messageID === "number") {
      messageID = messageID % 256; // this is a special case. Otherwise photo requests will not have the correct ID in the response.
    }
    const timestamp = Math.floor(Date.now() / 1000);

    const protocol = useCloudConnection ? 101 : 4;
    const allowOfflineCloudSend =
      Boolean(options.allowOfflineCloudSend) && useCloudConnection;
    const payload = await this.adapter.message.buildPayload(
      duid,
      protocol,
      messageID,
      method,
      params,
      secure,
      photo,
      b01Q10Dps ? { b01Q10Dps } : {}
    );
    const roborockMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      protocol,
      timestamp,
      payload
    );

    if (roborockMessage) {
      return new Promise((resolve, reject) => {
        if (
          !deviceOnline &&
          (useCloudConnection || !localConnectionState) &&
          !allowOfflineCloudSend
        ) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "device-offline",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Device ${duid} offline. Not sending for method ${method} request!`
          );
          reject(
            refusal(
              "device offline",
              `${describeDevice(this.adapter, duid)} is offline, so the ${method} request was not sent.`
            )
          );
        } else if (!mqttConnectionState && useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastTransport: "cloud",
            lastCommandMethod: method,
            lastTransportReason: cloudOnlyConnection
              ? "cloud-only-mqtt-unavailable"
              : "mqtt-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Cloud connection not available. Not sending for method ${method} request!`
          );
          reject(
            refusal(
              "cloud unavailable",
              `The Roborock cloud connection is not available, so the ${method} request was not sent.`
            )
          );
        } else if (!localConnectionState && !useCloudConnection) {
          this.adapter.updateTransportDiagnostics(duid, {
            lastCommandMethod: method,
            lastTransportReason: "local-socket-unavailable",
          });
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.log.debug(
            `Adapter not connect locally to robot ${duid}. Not sending for method ${method} request!`
          );
          reject(
            refusal(
              "local connection unavailable",
              `No local connection to ${describeDevice(this.adapter, duid)}, so the ${method} request was not sent.`
            )
          );
        } else if (b01Q10Dps) {
          // THE Q10 DIALECT IS FIRE-AND-FORGET. It defines no RPC reply, so
          // there is no acknowledgement to wait for and nothing to correlate
          // against — upstream's own channel returns None. Registering a
          // pending request here would arm a timeout that is guaranteed to
          // expire on a perfectly healthy link, and reporting that expiry is
          // exactly the false "the cloud has gone silent" diagnosis that cost
          // #14 three rounds.
          //
          // Resolving means "the write left this plugin", not "the robot did
          // it". Nothing downstream may treat it as confirmation: the state
          // the tile shows still comes from the optimistic-state machinery,
          // which self-corrects against what the robot actually reports.
          this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
          this.adapter.updateTransportDiagnostics(duid, {
            lastTransport: "cloud",
            lastTransportReason: "b01-q10-fire-and-forget",
            lastCommandMethod: method,
          });
          this.adapter.log.debug(
            `Published B01 Q10 datapoint write for ${duid} with ${payload}. The Q10 dialect is fire-and-forget, so this is a publish confirmation and not a robot acknowledgement; no reply is expected.`
          );
          resolve(["ok"]);
        } else {
          // setup Timeout
          const requestTimeout = getRequestTimeout(
            method,
            options.requestTimeoutMs
          );
          const timeoutSeconds = Math.round(requestTimeout / 1000);
          // Read BEFORE the send, so the timeout can subtract and report what
          // arrived while this particular request was outstanding.
          const receiptsAtSend =
            typeof this.adapter.getCloudMessageReceiptCount === "function"
              ? this.adapter.getCloudMessageReceiptCount(duid)
              : null;
          const timeout = this.adapter.setTimeout(() => {
            this.adapter.pendingRequests.delete(messageID);
            this.adapter.localConnector.clearChunkBuffer(duid);
            if (useCloudConnection) {
              reject(
                new Error(
                  `Cloud request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds. MQTT connection state: ${mqttConnectionState}${describeCloudSilence(this.adapter, duid, receiptsAtSend)}`
                )
              );
            } else {
              // A socket that keeps reporting itself connected while every
              // request dies of silence is not a transport worth retrying
              // forever. Fire-and-forget: the caller is owed its rejection now,
              // not after the bookkeeping resolves.
              if (this.adapter.noteLocalRequestTimedOut) {
                Promise.resolve(
                  this.adapter.noteLocalRequestTimedOut(duid, method)
                ).catch(() => {});
              }
              reject(
                new Error(
                  `Local request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds Local connect state: ${localConnectionState}`
                )
              );
            }
          }, requestTimeout);

          // Store request with resolve and reject functions.
          // `secure` travels with the entry so the MQTT receiver can tell a
          // secure request (whose protocol-102 reply is only an ack — the real
          // payload arrives on protocol 301) from an ordinary one (whose 102
          // reply IS the result). It used to guess by comparing the result to
          // the string "ok", which silently never matched.
          this.adapter.pendingRequests.set(messageID, {
            resolve,
            reject,
            timeout,
            secure,
            method,
          });

          if (useCloudConnection) {
            if (!deviceOnline && allowOfflineCloudSend) {
              this.adapter.log.debug(
                `Device ${duid} is marked offline, but sending method ${method} via cloud because the command explicitly allows offline cloud delivery.`
              );
            }
            this.adapter.rr_mqtt_connector.sendMessage(duid, roborockMessage);
            const lastTransportReason =
              [
                {
                  condition: !deviceOnline && allowOfflineCloudSend,
                  reason: "offline-cloud-command",
                },
                { condition: secure, reason: "secure-command" },
                { condition: photo, reason: "photo-command" },
                { condition: cloudOnlyConnection, reason: "cloud-only-mode" },
                {
                  condition: preferCloudConnection,
                  reason: "preferred-cloud-command",
                },
                { condition: remoteConnection, reason: "remote-device" },
                {
                  condition: method == "get_network_info",
                  reason: "network-info-cloud-only",
                },
              ].find((entry) => entry.condition)?.reason ?? "cloud-request";
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "cloud",
              lastTransportReason,
              lastCommandMethod: method,
            });
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using cloud connection`
            );
            //client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${duid}`, roborockMessage, { qos: 1 });
            // this.adapter.log.debug(`Promise for messageID ${messageID} created. ${this.adapter.message._decodeMsg(roborockMessage, duid).payload}`);
          } else {
            const lengthBuffer = Buffer.alloc(4);
            lengthBuffer.writeUInt32BE(roborockMessage.length, 0);

            const fullMessage = Buffer.concat([lengthBuffer, roborockMessage]);
            this.adapter.localConnector.sendMessage(duid, fullMessage);
            this.adapter.updateTransportDiagnostics(duid, {
              lastTransport: "local",
              lastTransportReason: "local-request",
              lastCommandMethod: method,
            });
            // this.adapter.log.debug(`sent fullMessage: ${fullMessage.toString("hex")}`);
            this.adapter.log.debug(
              `Sent payload for ${duid} with ${payload} using local connection`
            );
          }
        }
      }).finally(() => {
        this.adapter.log.debug(
          `Size of message queue: ${this.adapter.pendingRequests.size}`
        );
      });
    } else {
      // Never resolve successfully when nothing was sent. Callers that wait
      // for acknowledgement (Matter commands, HomeKit switches) would
      // otherwise log the command as acknowledged even though the robot never
      // received it.
      this.adapter.catchError(
        "Failed to build buildRoborockMessage!",
        "function sendRequest",
        duid
      );
      throw new Error(
        `Failed to build the Roborock message for ${method} on ${describeDevice(this.adapter, duid)}; the command was not sent.`
      );
    }
  }
}

module.exports = {
  messageQueueHandler,
  getRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT,
};
