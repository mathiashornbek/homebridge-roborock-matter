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
 * Requests python-roborock 7.13.0 sends over MQTT only, even to a robot whose
 * LAN socket is up: the `MapsTrait` read and map switch (`@mqtt_rpc_channel`),
 * the map content (`map_rpc_channel`), obstacle photos (`blob_rpc_channel`)
 * and the network info `V1Channel` fetches through `mqtt_rpc_channel`.
 */
const CLOUD_ONLY_METHODS = new Set([
  "get_map_v1",
  "get_multi_maps_list",
  "load_multi_map",
  "get_network_info",
  "get_photo",
]);

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
 * @property {(value: unknown, via?: "local" | "cloud") => void} resolve `via`
 *   is the transport the reply came over, when a handler says.
 * @property {(reason?: unknown, via?: "local" | "cloud") => void} reject
 *   Called by the reply handlers with the robot's own refusal, so it also
 *   tells the give-up register the robot answered.
 * @property {(reason?: unknown) => void} [abandon] Rejects WITHOUT telling the
 *   register anything — for shutdown, where nothing was answered.
 * @property {ReturnType<typeof setTimeout> | undefined} timeout
 * @property {boolean} [secure] True for requests whose protocol-102 reply is
 *   only an acknowledgement, with the real payload arriving on protocol 301.
 * @property {string} [method] The Roborock method, kept for diagnostics.
 * @property {"local" | "cloud"} [transport] The transport it was sent over.
 */

/**
 * @typedef {Object} TransportDiagnosticsUpdate
 * @property {"cloud" | "local" | "local-pending"} [lastTransport]
 * @property {string} [lastTransportReason]
 * @property {string} [lastCommandMethod]
 */

/**
 * @typedef {Object} MessageBuilder
 * @property {(duid: string, protocol: number, messageID: number, method: string, params: unknown[], secure: boolean, unused: boolean, options?: {b01Q10Dps?: Record<string, unknown>}) => Promise<unknown>} buildPayload
 * @property {(duid: string, protocol: number, timestamp: number, payload: unknown) => Promise<Buffer | null | undefined>} buildRoborockMessage
 */

/**
 * @typedef {Object} LocalConnector
 * @property {(duid: string) => boolean} isConnected
 * @property {(duid: string, message: Buffer) => void} sendMessage
 * @property {(duid: string, frame: Buffer, onLost: (cause: string) => void) => LocalRequestHandle | null} [writeRequest]
 * @property {(duid: string) => Promise<void>} [awaitLocalNegotiation]
 * @property {(duid: string) => string | undefined} [getNegotiatedVersion]
 */

/**
 * @typedef {Object} MqttConnector
 * @property {import("./mqttSessionDiagnostics").MqttSessionDiagnostics} [sessionDiagnostics]
 * @property {number} [linkId] which connection is current
 * @property {(options?: {timeoutMs?: number}) => Promise<number>} [waitUntilReady]
 * @property {() => boolean} [isReady]
 * @property {() => boolean} isConnected
 * @property {(duid: string, message: Buffer, onNotSent?: (error: Error) => void) => void} sendMessage
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
 * A request that was sent and drew no reply, carrying what the transport knew
 * at the moment it gave up. The give-up register reads these fields instead of
 * parsing the message text — twice now a prose-matching rule has turned out to
 * be dead code against a string the plugin cannot produce.
 *
 * @param {string} message
 * @param {boolean} transportWasUp whether every link the request went out on
 *   was still up AT REJECTION TIME
 * @param {boolean} [accountSessionWasSilent=false] correlated silence on this cloud read
 * @param {string} [transientKind] how catchError files it
 * @returns {Error & {unansweredRequest: boolean, transportWasUp: boolean, accountSessionWasSilent: boolean, transientKind?: string}}
 */
function unansweredRequestError(
  message,
  transportWasUp,
  accountSessionWasSilent = false,
  transientKind = undefined
) {
  return Object.assign(new Error(message), {
    unansweredRequest: true,
    transportWasUp,
    accountSessionWasSilent,
    ...(transientKind ? { transientKind } : {}),
  });
}

/**
 * The least a cloud retry may be given out of a caller's explicit budget; a
 * cloud round trip rarely takes more than a few hundred milliseconds.
 */
const MIN_CLOUD_RETRY_MS = 1000;

/** @param {unknown} error @returns {boolean} */
function isUnanswered(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      /** @type {any} */ (error).unansweredRequest === true
  );
}

/** @param {unknown} error @returns {string} */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @typedef {Object} LocalRequestHandle
 * @property {() => void} release stop watching the socket for this request
 * @property {() => boolean} isUp whether the socket it was written on is
 *   still the robot's socket and connected
 * @property {(method: string) => void} [noteUnanswered] the robot left it
 *   unanswered on a live socket
 */

/**
 * @typedef {Object} RequestContext
 * @property {string} duid
 * @property {string} method
 * @property {unknown[]} params
 * @property {boolean} secure
 * @property {any} messageID
 * @property {string} version
 * @property {unknown} payload
 * @property {boolean} deviceOnline
 * @property {boolean} allowOfflineCloudSend
 * @property {RequestOptions} options
 * @property {string} cloudReason
 * @property {"cloud" | "local"} first
 * @property {Buffer} frame
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
 * @property {(duid: string, method: string) => void} [noteRequestAnswered]
 * @property {(duid: string, transport: "local" | "cloud", outcome: import("./transportTally").Outcome) => void} [noteTransportOutcome]
 *   For the hourly per-robot transport summary.
 * @property {() => void} [noteCloudReply] A V1 cloud request was answered
 *   (not refused).
 * @property {() => boolean} [noteCloudSilence] A V1 cloud request timed out
 *   while MQTT reported itself connected.
 * @property {(duid: string, method: string, error: unknown) => void} [noteRequestUnanswered]
 * @property {import("./lateReplies").LateReplyTracker} [lateReplies] Remembers
 *   timed-out request ids so a reply that turns up after its timeout can be
 *   told apart from one that never came.
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
   * @param {boolean} [_unused=false] the photo flag's old slot, kept so
   *   positional callers stay valid; nothing asks for a photo
   * @param {RequestOptions} [options]
   * @returns {Promise<unknown | undefined>}
   */
  async sendRequest(
    duid,
    method,
    params,
    secure = false,
    _unused = false,
    options = {}
  ) {
    // An explicit timeout is the caller's total budget, including readiness.
    const explicitTimeout = Number(options.requestTimeoutMs);
    const deadline =
      Number.isFinite(explicitTimeout) && explicitTimeout > 0
        ? Date.now() + getRequestTimeout(method, explicitTimeout)
        : undefined;
    const budgetExpired = () =>
      Object.assign(
        refusal(
          "cloud unavailable",
          "The command budget expired before publication; this request was not sent."
        ),
        { requestNotSent: true, unansweredRequest: false }
      );
    const remoteConnection = await this.adapter.isRemoteDevice(duid);
    const version = await this.adapter.getRobotVersion(duid);

    let deviceOnline = await this.adapter.onlineChecker(duid);
    let mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
    let localConnectionState = this.adapter.localConnector.isConnected(duid);
    const cloudOnlyConnection = Boolean(this.adapter.config?.cloudOnlyMode);
    const preferCloudConnection =
      Boolean(options.preferCloud) &&
      (this.adapter.rr_mqtt_connector.isReady?.() ?? mqttConnectionState);
    const preferLocalConnection =
      Boolean(options.preferLocal) &&
      !cloudOnlyConnection &&
      !preferCloudConnection &&
      !remoteConnection &&
      !secure &&
      !CLOUD_ONLY_METHODS.has(method);

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
      if (family === null && !neutral) {
        // Neither dialect is known for this model, so neither is spoken: a
        // guessed envelope is discarded by a robot of the other family and
        // the request then waits out its timeout. Refused calmly (the code),
        // and explained once by the status loop.
        throw refusal(
          "b01 family unknown",
          `${describeDevice(this.adapter, duid)} speaks the B01 protocol, but its model (${model || "missing from the home data"}) is neither a Q7 (sc*) nor a Q10 (ss*), so ${method} was not sent.`,
          "B01_METHOD_UNSUPPORTED"
        );
      }

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
      CLOUD_ONLY_METHODS.has(method);
    if (
      !useCloudConnection &&
      !localConnectionState &&
      (mqttConnectionState ||
        typeof this.adapter.rr_mqtt_connector.waitUntilReady === "function")
    ) {
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

    if (!useCloudConnection) {
      // Never put a request on a socket whose hello is still in the air: the
      // answer decides how the frame is encrypted. Bounded by the hello's own
      // timeouts (2 x 5 s), and instant once negotiated.
      try {
        await this.adapter.localConnector.awaitLocalNegotiation?.(duid);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.adapter.log.debug(
          `Local hello before request failed for ${duid}: ${errorMessage}`
        );
      }
      // The socket may have closed during the wait. The state read before it
      // is stale, so read it again — for the cloud fallback here AND for the
      // "no local connection" refusal further down, which reads the same
      // variable (found in final verification).
      localConnectionState = this.adapter.localConnector.isConnected(duid);
      if (
        !localConnectionState &&
        (this.adapter.rr_mqtt_connector.isConnected() ||
          typeof this.adapter.rr_mqtt_connector.waitUntilReady === "function")
      ) {
        useCloudConnection = true;
        this.adapter.log.debug(
          `The local socket for ${duid} closed during its hello. Falling back to cloud connection for method ${method}.`
        );
      }
    }

    const messageID = /** @type {any} */ (
      b01Q7Adapter.isB01Protocol(version)
        ? b01Q7Adapter.createB01MessageId()
        : this.adapter.getRequestId()
    );
    const allowOfflineCloudSend =
      Boolean(options.allowOfflineCloudSend) && useCloudConnection;
    if (useCloudConnection && (deviceOnline || allowOfflineCloudSend)) {
      // No frame or pending RPC exists while the reply subscription is pending.
      try {
        const remaining =
          deadline === undefined ? 10000 : deadline - Date.now();
        if (remaining <= 0) throw budgetExpired();
        await this.adapter.rr_mqtt_connector.waitUntilReady?.({
          timeoutMs: Math.min(10000, remaining),
        });
      } catch (error) {
        this.adapter.noteTransportOutcome?.(duid, "cloud", "notSent");
        throw error;
      }
      mqttConnectionState = this.adapter.rr_mqtt_connector.isConnected();
      deviceOnline = await this.adapter.onlineChecker(duid);
    }
    const timestamp = Math.floor(Date.now() / 1000);

    const protocol = useCloudConnection ? 101 : 4;
    const payload = await this.adapter.message.buildPayload(
      duid,
      protocol,
      messageID,
      method,
      params,
      secure,
      false,
      b01Q10Dps ? { b01Q10Dps } : {}
    );
    const roborockMessage = await this.adapter.message.buildRoborockMessage(
      duid,
      protocol,
      timestamp,
      payload
    );

    if (useCloudConnection && deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.adapter.noteTransportOutcome?.(duid, "cloud", "notSent");
        throw budgetExpired();
      }
      // Frame construction and readiness have already spent this much time.
      options = { ...options, requestTimeoutMs: remaining };
    }

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
          let notSent = null;
          this.adapter.rr_mqtt_connector.sendMessage(
            duid,
            roborockMessage,
            (/** @type {Error} */ error) => {
              notSent = error;
            }
          );
          if (notSent) {
            reject(
              refusal(
                "cloud unavailable",
                `The Roborock cloud connection was lost before the ${method} write could be sent, so it was not sent.`
              )
            );
            return;
          }
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
          this.requestWithCloudRetry({
            duid,
            method,
            params,
            secure,
            messageID,
            version,
            payload,
            deviceOnline,
            allowOfflineCloudSend,
            options,
            cloudReason:
              [
                {
                  condition: !deviceOnline && allowOfflineCloudSend,
                  reason: "offline-cloud-command",
                },
                { condition: secure, reason: "secure-command" },
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
                {
                  condition: CLOUD_ONLY_METHODS.has(method),
                  reason: "cloud-only-method",
                },
              ].find((entry) => entry.condition)?.reason ?? "cloud-request",
            first: useCloudConnection ? "cloud" : "local",
            frame: roborockMessage,
          }).then(resolve, reject);
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

  /**
   * Send a built request and wait for its reply, the way python-roborock's
   * `RpcChannel.send_command` does: over the LAN first when that is the
   * chosen transport, and when the LAN attempt fails — its socket closed, or
   * nothing answered within the timeout — the SAME request (same id) once
   * more over MQTT. A refusal is an answer and is never retried.
   *
   * With an explicit `requestTimeoutMs` the caller owns a budget, so the
   * cloud retry only gets what is left of it.
   *
   * @param {RequestContext} context
   * @returns {Promise<unknown>}
   */
  async requestWithCloudRetry(context) {
    const { duid, method, options } = context;
    const requestTimeout = getRequestTimeout(method, options.requestTimeoutMs);
    const startedAt = Date.now();
    try {
      if (context.first === "cloud") {
        return await this.exchangeOverCloud(
          context,
          context.frame,
          requestTimeout
        );
      }
      try {
        return await this.exchangeOverLocal(
          context,
          context.frame,
          requestTimeout
        );
      } catch (localError) {
        const retryTimeout = this.cloudRetryTimeout(
          context,
          localError,
          requestTimeout - (Date.now() - startedAt)
        );
        if (retryTimeout === null) {
          throw localError;
        }
        this.adapter.log.debug(
          `Retrying ${method} (id ${context.messageID}) for ${duid} over the cloud: ${errorText(localError)}`
        );
        this.adapter.noteTransportOutcome?.(duid, "local", "retried");
        const readinessStartedAt = Date.now();
        const explicitBudget =
          Number.isFinite(Number(options.requestTimeoutMs)) &&
          Number(options.requestTimeoutMs) > 0;
        try {
          await this.adapter.rr_mqtt_connector.waitUntilReady?.({
            timeoutMs: explicitBudget ? Math.min(10000, retryTimeout) : 10000,
          });
        } catch (error) {
          this.adapter.noteTransportOutcome?.(duid, "cloud", "notSent");
          // The original request DID leave over the LAN. Preserve its failure
          // and late-reply/breaker evidence when no cloud retry was published.
          throw localError;
        }
        const payload = await this.adapter.message.buildPayload(
          duid,
          101,
          context.messageID,
          method,
          context.params,
          context.secure,
          false,
          {}
        );
        const frame = await this.adapter.message.buildRoborockMessage(
          duid,
          101,
          Math.floor(Date.now() / 1000),
          payload
        );
        const responseTimeout = explicitBudget
          ? retryTimeout - (Date.now() - readinessStartedAt)
          : retryTimeout;
        if (!frame || responseTimeout <= 0) {
          throw localError;
        }
        return await this.exchangeOverCloud(
          { ...context, payload, cloudReason: "local-failed-cloud-retry" },
          frame,
          responseTimeout,
          localError
        );
      }
    } catch (error) {
      if (isUnanswered(error)) {
        this.adapter.noteRequestUnanswered?.(duid, method, error);
        this.adapter.lateReplies?.noteTimedOut(context.messageID, duid, method);
      }
      throw error;
    }
  }

  /**
   * How long the cloud retry of a failed LAN request may wait, or null when
   * it is not retried: the failure was an answer, the cloud is down, or the
   * robot is offline per home data (the cloud would refuse it anyway).
   *
   * @param {RequestContext} context
   * @param {unknown} localError
   * @param {number} remainingMs what is left of an explicit budget
   * @returns {number | null}
   */
  cloudRetryTimeout(context, localError, remainingMs) {
    const failure = /** @type {any} */ (localError);
    const retryable =
      failure?.localTransportLost === true ||
      (failure?.unansweredRequest === true &&
        failure?.transientKind === "local timeout");
    if (!retryable) {
      return null;
    }
    if (!this.adapter.rr_mqtt_connector.isConnected()) {
      return null;
    }
    if (!context.deviceOnline && !context.options.allowOfflineCloudSend) {
      return null;
    }
    const explicit = Number(context.options.requestTimeoutMs);
    if (Number.isFinite(explicit) && explicit > 0) {
      return remainingMs >= MIN_CLOUD_RETRY_MS ? Math.round(remainingMs) : null;
    }
    return getRequestTimeout(context.method);
  }

  /**
   * One attempt over MQTT.
   *
   * @param {RequestContext} context
   * @param {Buffer} frame
   * @param {number} requestTimeout
   * @param {unknown} [localError] the LAN failure this attempt retries
   * @returns {Promise<unknown>}
   */
  exchangeOverCloud(context, frame, requestTimeout, localError) {
    const { duid, method, messageID, version, secure } = context;
    const timeoutSeconds = Math.round(requestTimeout / 1000);
    return new Promise((resolve, reject) => {
      // Read BEFORE the send, so the timeout can subtract and report what
      // arrived while this particular request was outstanding.
      const receiptsAtSend =
        typeof this.adapter.getCloudMessageReceiptCount === "function"
          ? this.adapter.getCloudMessageReceiptCount(duid)
          : null;
      const sessionDiagnostics =
        this.adapter.rr_mqtt_connector.sessionDiagnostics;
      const sessionRequest = sessionDiagnostics?.captureRequest();
      const linkAtSend = this.adapter.rr_mqtt_connector.linkId;
      // The requests python-roborock's HealthManager hears about: V1 RPCs
      // over MQTT, and nothing from the B01 channels.
      const feedsCloudHealth = !b01Q7Adapter.isB01Protocol(version);
      // A retry after the LAN socket closed under its request is a transport
      // event, not a request the robot left unanswered on a working link.
      const localWasUp =
        localError === undefined ||
        /** @type {any} */ (localError)?.transportWasUp === true;
      const onTimeout = () => {
        this.adapter.pendingRequests.delete(messageID);
        // The link state READ NOW, not the copy taken before the send. A
        // link that died mid-flight is the entire case the give-up
        // register's transport exclusion exists for, and both previous
        // attempts at that exclusion were dead code because they read a
        // value captured before the request even went out. And it must be
        // the SAME link: a request in flight across a session restart went
        // out on a connection that is gone, whatever its successor does.
        const transportWasUp =
          Boolean(this.adapter.rr_mqtt_connector?.isConnected?.()) &&
          this.adapter.rr_mqtt_connector.linkId === linkAtSend;
        const sessionHealth = sessionDiagnostics?.noteTimeout(
          duid,
          method,
          sessionRequest
        );
        const sessionSummary = sessionHealth?.correlatedSilenceObserved
          ? ` MQTT session: correlated silence across ${sessionHealth.silentReadRobotCount} robots (generation ${sessionHealth.generation}).`
          : sessionHealth?.connected && !sessionHealth.subscriptionAcknowledged
            ? ` MQTT session: subscription not acknowledged (generation ${sessionHealth.generation}).`
            : "";
        const retried = localError
          ? ` It was the cloud retry after the local attempt failed: ${errorText(localError)}`
          : "";
        const error = unansweredRequestError(
          `Cloud request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds. MQTT connection state: ${transportWasUp}${describeCloudSilence(this.adapter, duid, receiptsAtSend)}${sessionSummary}${retried}`,
          transportWasUp && localWasUp,
          // A LAN silence the retry follows is the robot's own, whatever the
          // account session was doing.
          Boolean(
            !localError &&
              transportWasUp &&
              sessionHealth?.requestWasSilent &&
              sessionHealth?.correlatedSilenceObserved
          ),
          "cloud timeout"
        );
        // python-roborock's HealthManager counts every V1 MQTT timeout,
        // whatever else the robot's frames did meanwhile (its map decoder
        // ignores the 102 acknowledgement too). B01 never feeds it, in
        // either direction.
        if (transportWasUp && feedsCloudHealth) {
          this.adapter.noteCloudSilence?.();
        }
        this.adapter.noteTransportOutcome?.(duid, "cloud", "timeout");
        reject(error);
      };

      // `secure` travels with the entry so the MQTT receiver can tell a
      // secure request (whose protocol-102 reply is only an ack — the real
      // payload arrives on protocol 301) from an ordinary one (whose 102
      // reply IS the result). It used to guess by comparing the result to
      // the string "ok", which silently never matched.
      /** @type {PendingRequest} */
      const pendingRequest = {
        // Wrapped so the give-up register learns of an answer HERE, in the
        // one place that knows a reply arrived. Until 3.32.0 the register
        // was told by `pollParameter`, whose try/catch never fired:
        // `vacuum.getParameter` swallows its own errors (it calls
        // catchError, which only logs) and resolves `undefined`. So every
        // poll looked like a success, the failure branch was unreachable,
        // and the register never counted a single one — including all
        // seven methods in #22/#24 that it was built for.
        //
        // `via` is the transport the reply came over. The LAN reply to the
        // attempt this one retries can still arrive, under the same id: the
        // robot answered, but MQTT delivered nothing, so it is booked to the
        // LAN and says nothing about the cloud session (python-roborock stops
        // listening on the LAN before its MQTT attempt).
        resolve: (value, via = "cloud") => {
          this.adapter.noteRequestAnswered?.(duid, method);
          if (feedsCloudHealth && via === "cloud") {
            this.adapter.noteCloudReply?.();
          }
          this.adapter.noteTransportOutcome?.(duid, via, "ok");
          resolve(value);
        },
        // A refusal is an answer too. The reply handlers (cloud 102, local
        // protocol 4, B01 code) hand the robot's own error to the STORED
        // reject; timeouts and no-link refusals use the promise's reject
        // directly, and shutdown uses `abandon`. Until 3.35.0 this was the
        // bare reject, so a robot that kept saying "no" neither counted nor
        // reset: five silences, one refusal, one silence, and the method was
        // given up on although the robot had just replied.
        // Not a cloud-health success: python-roborock's `_send_rpc` raises
        // an API error before it reaches `on_success`.
        reject: (error, via = "cloud") => {
          this.adapter.noteRequestAnswered?.(duid, method);
          this.adapter.noteTransportOutcome?.(duid, via, "ok");
          reject(error);
        },
        abandon: reject,
        timeout: undefined,
        secure,
        method,
        transport: "cloud",
      };
      this.adapter.pendingRequests.set(messageID, pendingRequest);

      if (!context.deviceOnline && context.allowOfflineCloudSend) {
        this.adapter.log.debug(
          `Device ${duid} is marked offline, but sending method ${method} via cloud because the command explicitly allows offline cloud delivery.`
        );
      }
      // The link can drop between the connection check and this publish
      // (there are awaits in between). mqtt.js then refuses the publish;
      // fail the request now, as the refusal it is, rather than let its
      // timeout read a dead link as a robot that did not answer.
      let publicationRejected = false;
      try {
        this.adapter.rr_mqtt_connector.sendMessage(duid, frame, () => {
          publicationRejected = true;
          const pending = this.adapter.pendingRequests.get(messageID);
          if (pending !== pendingRequest) {
            return;
          }
          if (pending.timeout) this.adapter.clearTimeout(pending.timeout);
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.noteTransportOutcome?.(duid, "cloud", "notSent");
          reject(
            localError ??
              refusal(
                "cloud unavailable",
                `The Roborock cloud connection was lost before the ${method} request could be sent, so it was not sent.`
              )
          );
        });
      } catch (error) {
        this.adapter.pendingRequests.delete(messageID);
        this.adapter.noteTransportOutcome?.(duid, "cloud", "notSent");
        reject(localError ?? error);
        return;
      }
      if (publicationRejected) return;
      if (this.adapter.pendingRequests.get(messageID) === pendingRequest) {
        pendingRequest.timeout = this.adapter.setTimeout(
          onTimeout,
          requestTimeout
        );
      }
      this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "cloud",
        lastTransportReason: context.cloudReason,
        lastCommandMethod: method,
      });
      this.adapter.log.debug(
        `Sent payload for ${duid} with ${context.payload} using cloud connection`
      );
    });
  }

  /**
   * One attempt over the LAN. Settles the moment the socket it was written on
   * closes: a request must never wait out its timeout on a socket already
   * known to be gone.
   *
   * @param {RequestContext} context
   * @param {Buffer} frame
   * @param {number} requestTimeout
   * @returns {Promise<unknown>}
   */
  exchangeOverLocal(context, frame, requestTimeout) {
    const { duid, method, messageID, secure } = context;
    const timeoutSeconds = Math.round(requestTimeout / 1000);
    const sessionDiagnostics =
      this.adapter.rr_mqtt_connector.sessionDiagnostics;
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {LocalRequestHandle | null} */
      let handle = null;
      /**
       * @param {(value: any) => void} settle
       * @param {unknown} value
       */
      const finish = (settle, value) => {
        if (settled) {
          return;
        }
        settled = true;
        handle?.release();
        settle(value);
      };
      const onTimeout = () => {
        this.adapter.pendingRequests.delete(messageID);
        // Up means the socket this request was written on is still the
        // robot's socket and still connected.
        const transportWasUp = handle ? handle.isUp() : false;
        // Silence on a live socket counts toward closing it (see
        // localConnector.dropUnanswered).
        if (transportWasUp) {
          handle?.noteUnanswered?.(method);
        }
        this.adapter.noteTransportOutcome?.(duid, "local", "timeout");
        finish(
          reject,
          unansweredRequestError(
            `Local request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds Local connect state: ${transportWasUp}`,
            transportWasUp,
            false,
            "local timeout"
          )
        );
      };

      /** @type {PendingRequest} */
      const pendingRequest = {
        resolve: (value) => {
          sessionDiagnostics?.noteActivity("local");
          sessionDiagnostics?.emit();
          this.adapter.noteRequestAnswered?.(duid, method);
          this.adapter.noteTransportOutcome?.(duid, "local", "ok");
          finish(resolve, value);
        },
        reject: (error) => {
          this.adapter.noteRequestAnswered?.(duid, method);
          this.adapter.noteTransportOutcome?.(duid, "local", "ok");
          finish(reject, error);
        },
        abandon: (error) => finish(reject, error),
        timeout: undefined,
        secure,
        method,
        transport: "local",
      };
      this.adapter.pendingRequests.set(messageID, pendingRequest);

      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(frame.length, 0);
      const fullMessage = Buffer.concat([lengthBuffer, frame]);
      try {
        const written = this.writeLocal(duid, fullMessage, (cause) => {
          const pending = this.adapter.pendingRequests.get(messageID);
          if (pending !== pendingRequest) {
            return;
          }
          if (pending.timeout) this.adapter.clearTimeout(pending.timeout);
          this.adapter.pendingRequests.delete(messageID);
          this.adapter.noteTransportOutcome?.(duid, "local", "lost");
          finish(
            reject,
            Object.assign(
              refusal(
                "local connection unavailable",
                `The local connection to ${describeDevice(this.adapter, duid)} closed before ${method} (local id ${messageID}) was answered: ${cause}.`
              ),
              { localTransportLost: true }
            )
          );
        });
        handle = written;
        if (!handle) {
          return;
        }
        if (settled) {
          // Answered while it was being written (a test double): nothing is
          // left to watch for.
          handle.release();
        }
      } catch (error) {
        this.adapter.pendingRequests.delete(messageID);
        finish(reject, error);
        return;
      }
      if (this.adapter.pendingRequests.get(messageID) === pendingRequest) {
        pendingRequest.timeout = this.adapter.setTimeout(
          onTimeout,
          requestTimeout
        );
      }
      this.adapter.updateTransportDiagnostics(duid, {
        lastTransport: "local",
        lastTransportReason: "local-request",
        lastCommandMethod: method,
      });
      this.adapter.log.debug(
        `Sent payload for ${duid} with ${context.payload} using local connection`
      );
    });
  }

  /**
   * Write a frame on the robot's socket and have `onLost` called if that
   * socket goes before the reply. A connector without in-flight tracking
   * (test doubles) gets a handle that only reads the connection state.
   *
   * @param {string} duid
   * @param {Buffer} frame
   * @param {(cause: string) => void} onLost
   * @returns {LocalRequestHandle | null} null when nothing could be written,
   *   after `onLost` has been told
   */
  writeLocal(duid, frame, onLost) {
    const connector = this.adapter.localConnector;
    if (typeof connector.writeRequest === "function") {
      const handle = connector.writeRequest(duid, frame, onLost);
      if (!handle) {
        onLost(
          "the socket was no longer connected when the request was written"
        );
      }
      return handle;
    }
    connector.sendMessage(duid, frame);
    return {
      release() {},
      isUp: () => Boolean(connector.isConnected(duid)),
    };
  }
}

module.exports = {
  CLOUD_ONLY_METHODS,
  messageQueueHandler,
  getRequestTimeout,
  refusal,
  DEFAULT_REQUEST_TIMEOUT,
};
