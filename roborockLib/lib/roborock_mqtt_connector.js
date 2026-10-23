"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const zlib = require("zlib");
const roborockCrypto = require("./roborockCrypto");
const { describeDevice } = require("./describeDevice");
const { noteLateReply } = require("./lateReplies");
const {
  describeReplyRefusal,
  createRefusalError,
} = require("./describeReplyRefusal");

const { MqttSessionDiagnostics } = require("./mqttSessionDiagnostics");

// python-roborock's MQTT reconnect policy (mqtt/roborock_session.py):
// MIN_BACKOFF_INTERVAL 10 s, BACKOFF_MULTIPLIER 1.5, back to 10 s after every
// successful connect. Its 6-hour ceiling exists for rate-limited or
// unauthorised accounts, which python-roborock hands to a re-authentication
// hook this plugin does not have; here a dead network is retried at most every
// 10 minutes, so the cloud is back within 10 minutes of the network, and an
// outage costs 6 attempts an hour instead of mqtt.js's one a second.
const MQTT_RECONNECT_DELAYS = Object.freeze({
  initialMs: 10_000,
  multiplier: 1.5,
  maxMs: 10 * 60_000,
});
const CLIENT_ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * A client id of its own for every connection: 22 random base-62 characters,
 * as python-roborock generated them before it moved to broker-assigned ids
 * (`mqtt.base62(uuid4().int, padding=22)`). Within MQTT 3.1.1's guaranteed
 * 1–23 characters of [0-9a-zA-Z]. The account-wide username used to double
 * as the id, so any second client of the account — another Homebridge, the
 * ioBroker adapter, an overlapping restart — took the session over.
 *
 * @returns {string}
 */
function randomClientId() {
  let id = "";
  for (let i = 0; i < 22; i += 1) {
    id += CLIENT_ID_ALPHABET[crypto.randomInt(CLIENT_ID_ALPHABET.length)];
  }
  return id;
}

const PROTOCOL_301_HEADER_LENGTH = 24;

const protocol301Parser = new Parser()
  .endianess("little")
  .string("endpoint", {
    length: 15,
    stripNull: true,
  })
  .uint8("unknown1")
  .uint16("id")
  .buffer("unknown2", {
    length: 6,
  });

let mqttUser;
let mqttPassword;
let client;
let endpoint;
let rriot;

// How many protocol-301 frames have been discarded per robot, and why.
//
// 3.31.0 added a log line for each drop — at DEBUG level, which is off by
// default. So the measurement that was meant to answer this project's oldest
// question (why `get_map_v1` times out forever on a robot that answers
// everything else) could never appear in a log anyone would send. That is the
// same mistake as the silent `return` it replaced: the information existed
// and nobody could reach it.
//
// Counting it instead means the number rides along in the give-up message and
// the diagnostic report, both of which are INFO level and both of which users
// already paste.
const droppedFrames = new Map();

/**
 * Whether a decoded cloud frame is an RPC reply. Protocol 102 always was;
 * python-roborock also takes a frame on 4 or 5 whose payload carries the
 * `102` datapoint, and until 3.36.0 such a reply was dropped here unread.
 *
 * @param {{protocol?: unknown, payload?: unknown}} data
 * @returns {boolean}
 */
function isRpcReplyFrame(data) {
  const protocol = Number(data?.protocol);
  if (protocol === 102) {
    return true;
  }
  if (protocol !== 4 && protocol !== 5) {
    return false;
  }
  try {
    const parsed = JSON.parse(String(data.payload));
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.dps !== null &&
      typeof parsed.dps === "object" &&
      Object.prototype.hasOwnProperty.call(parsed.dps, "102")
    );
  } catch {
    return false;
  }
}

function frameCountersFor(duid) {
  let entry = droppedFrames.get(duid);
  if (!entry) {
    entry = { total: 0, accepted: 0, byReason: {} };
    droppedFrames.set(duid, entry);
  }
  return entry;
}

function noteDroppedFrame(duid, reason) {
  const entry = frameCountersFor(duid);
  entry.total += 1;
  entry.byReason[reason] = (entry.byReason[reason] || 0) + 1;
  return entry;
}

/**
 * The other half of the measurement: a protocol-301 frame that WAS addressed
 * to this plugin.
 *
 * Without it, `addressed-elsewhere` cannot be read. The endpoint on the wire
 * names a controller, and the endpoint is account-wide — the Roborock app, a
 * second Homebridge, a voice skill all share the robot's MQTT topic and each
 * carries its own. Their frames reach this handler and are dropped, correctly.
 * Counting only the drops made that indistinguishable from the one case that
 * IS our fault, a wrong endpoint of our own, and the give-up line duly told
 * #28 to report a bug against correct behaviour. One accepted frame proves our
 * key is right; zero accepted alongside drops is the real bug's shape.
 *
 * @param {string} duid
 * @returns {{total: number, accepted: number, byReason: Record<string, number>}}
 */
function noteAcceptedFrame(duid) {
  const entry = frameCountersFor(duid);
  entry.accepted += 1;
  return entry;
}

/**
 * Protocol-301 frames discarded for one robot, and how many were ours, for the
 * give-up message and the diagnostic report.
 *
 * @param {string} duid
 * @returns {{total: number, accepted: number, byReason: Record<string, number>}}
 */
function describeDroppedFrames(duid) {
  return droppedFrames.get(duid) || { total: 0, accepted: 0, byReason: {} };
}

/** Test seam: the counters are process-lifetime and module-level by design. */
function resetFrameCounters() {
  droppedFrames.clear();
}

/**
 * True when a protocol-102 result is a bare "command accepted" acknowledgement
 * rather than real data. Roborock sends this as the single-element array
 * ["ok"]; some firmware answers with the bare string.
 * @param {unknown} result
 * @returns {boolean}
 */
function isOkAcknowledgement(result) {
  if (result === "ok") {
    return true;
  }
  return Array.isArray(result) && result.length === 1 && result[0] === "ok";
}

/**
 * Decide whether a protocol-102 reply completes a pending request.
 *
 * Only a secure request answered with a bare acknowledgement keeps waiting —
 * its real payload arrives on protocol 301. Everything else resolves here,
 * including a secure request that came back with an error, which would
 * otherwise hang until the request timeout.
 *
 * @param {{secure?: boolean}|undefined} pending
 * @param {unknown} result
 * @returns {boolean}
 */
function shouldResolveOn102(pending, result) {
  if (!pending) {
    return false;
  }
  return !(pending.secure === true && isOkAcknowledgement(result));
}

function parseProtocol301Header(payload) {
  if (
    !Buffer.isBuffer(payload) ||
    payload.length < PROTOCOL_301_HEADER_LENGTH
  ) {
    return null;
  }

  return protocol301Parser.parse(
    payload.subarray(0, PROTOCOL_301_HEADER_LENGTH)
  );
}

class roborock_mqtt_connector {
  constructor(adapter) {
    this.adapter = adapter;

    this.sessionDiagnostics = new MqttSessionDiagnostics((snapshot) => {
      Promise.resolve(
        this.adapter.setStateAsync?.("MqttSessionDiagnostics", {
          val: JSON.stringify(snapshot),
          ack: true,
        })
      ).catch(() => {});
    });
    this.connected = false;
    // Which MQTT connection is current: a new number on every connect, so a
    // request can tell "the link I went out on is still up" from "a link is
    // up" across a session restart.
    this.linkId = 0;
    this.initialConnectTimeout = null;
    // Reconnects are the connector's, not mqtt.js's: every connection is a
    // new client with a new id, after python-roborock's back-off.
    this.reconnectDelays = { ...MQTT_RECONNECT_DELAYS };
    this.reconnectDelayMs = this.reconnectDelays.initialMs;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    this.sessionWanted = false;
    this.connectionEventsWanted = false;
    /** @type {((topic: string, message: Buffer) => void) | null} */
    this.messageHandler = null;
    /** @type {Set<(connected: boolean) => void>} see waitUntilConnected */
    this.connectWaiters = new Set();

    // NOTE: this class previously generated its own RSA-2048 keypair here,
    // but nothing ever read it. Removed: one full RSA keygen less at every
    // startup.
  }

  async initUser(userdata) {
    // A startService retry runs this again. Without ending the client the
    // failed attempt left behind, two clients shared one clientId: the broker
    // kept disconnecting one for the other, both kept reconnecting, and the
    // old one still delivered every frame and was never ended at shutdown.
    this.disconnect();
    rriot = userdata.rriot;

    endpoint = roborockCrypto
      .md5bin(rriot.k)
      .subarray(8, 14)
      .toString("base64"); // Could be a random but rather static string. The app generates it on first run.
    mqttUser = roborockCrypto.md5hex(rriot.u + ":" + rriot.k).substring(2, 10);
    mqttPassword = roborockCrypto.md5hex(rriot.s + ":" + rriot.k).substring(16);
    // A new session from scratch: initMQTT_Subscribe and initMQTT_Message say
    // again which listeners it wants.
    this.connectionEventsWanted = false;
    this.messageHandler = null;
    this.sessionWanted = true;
    this.reconnectDelayMs = this.reconnectDelays.initialMs;
    this.openClient();
  }

  /**
   * A new mqtt.js client for one connection, with whatever listeners the
   * connector has been asked for. python-roborock builds a new client for
   * every connection as well (`_run_reconnect_loop`), so nothing of a session
   * that went bad — its id, its stores, its timers — reaches the next one.
   */
  openClient() {
    client = mqtt.connect(rriot.r.m, {
      clientId: randomClientId(),
      username: mqttUser,
      password: mqttPassword,
      keepalive: 30,
      // mqtt.js queues a QoS 0 publish made while it is disconnected and
      // sends the whole queue on the next connect — and that queue survives
      // the plugin's own session restart. A Start or a Dock the plugin had
      // already reported as failed would reach the robot minutes later.
      // python-roborock refuses to publish while disconnected; so does this.
      queueQoSZero: false,
      // mqtt.js would reconnect this same client every second, with the same
      // id; scheduleReconnect builds a new one after python-roborock's
      // back-off instead.
      reconnectPeriod: 0,
    });
    if (this.connectionEventsWanted) {
      this.installConnectionEvents();
    }
    if (this.messageHandler) {
      this.listen("message", this.messageHandler);
    }
  }

  /**
   * Open a new client after the back-off: 10 s after a connection that had
   * been up, growing by 1.5 for every attempt that fails, up to 10 minutes.
   *
   * @returns {number | null} the delay, or null when one is already armed or
   *   the session is shut down
   */
  scheduleReconnect() {
    if (!this.sessionWanted || this.reconnectTimer) {
      return null;
    }
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      delayMs * this.reconnectDelays.multiplier,
      this.reconnectDelays.maxMs
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.sessionWanted || this.connected) {
        return;
      }
      const previous = client;
      this.openClient();
      // Let go of the closed one. Its listeners stay and ignore it (see
      // listen); end() only makes sure nothing of it is left running.
      if (previous && previous !== client) {
        try {
          previous.end(true);
        } catch (error) {
          this.adapter.log.debug(
            `Ending the previous MQTT client failed: ${error?.message || error}`
          );
        }
      }
    }, delayMs);
    if (typeof this.reconnectTimer?.unref === "function") {
      this.reconnectTimer.unref();
    }
    return delayMs;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async initMQTT_Subscribe() {
    // This used to invoke a `restart` method on the adapter, which the
    // Roborock class has never had — so on the one path it was written for
    // (the broker
    // neither connecting nor emitting `reconnect` within 30 s, e.g. a Pi that
    // boots before the network is up, or a SYN black-holed by a firewall) it
    // threw a TypeError inside an async timer. That is an unhandled rejection,
    // which terminates the Homebridge process under Node's default policy —
    // the exact opposite of the intended recovery. The connector already
    // retries on its own back-off (scheduleReconnect), so the correct
    // behaviour here is to say so clearly and let it keep trying. The handle is stored and unref'd so
    // shutdown can cancel it instead of firing into a torn-down adapter.
    this.clearInitialConnectTimeout();
    this.initialConnectTimeout = setTimeout(() => {
      this.initialConnectTimeout = null;
      this.logConnectionIssue(
        `The Roborock MQTT broker has not answered within 30 seconds of startup. The client keeps reconnecting in the background; robots stay on cloud fallback until the session is up.`
      );
    }, 30000);
    if (typeof this.initialConnectTimeout?.unref === "function") {
      this.initialConnectTimeout.unref();
    }

    this.connectionEventsWanted = true;
    this.installConnectionEvents();
  }

  /**
   * The connection-state listeners, on the current client. Installed again on
   * every client openClient builds.
   */
  installConnectionEvents() {
    // Observe every SUBACK packet without changing mqtt.js subscription
    // behaviour; its callback is not the only evidence of one.
    this.listen("packetreceive", (packet) => {
      if (packet.cmd !== "suback") return;
      this.sessionDiagnostics.onSubscribe(
        this.sessionDiagnostics.generation,
        null,
        (packet.granted || []).map((qos) => ({ qos }))
      );
    });

    this.listen("connect", (result) => {
      if (typeof result != "undefined") {
        this.linkId += 1;
        // python-roborock: the back-off starts over after every connect.
        this.reconnectDelayMs = this.reconnectDelays.initialMs;
        const generation = this.sessionDiagnostics.onConnect();
        client.subscribe(
          `rr/m/o/${rriot.u}/${mqttUser}/#`,
          this.whileCurrent((err, granted) => {
            this.sessionDiagnostics.onSubscribe(generation, err, granted);
            if (err) {
              this.logConnectionIssue(
                `Failed to subscribe to the Roborock MQTT server: ${err} (granted: ${JSON.stringify(granted)}).`
              );
            }
          })
        );
        this.clearInitialConnectTimeout();

        this.connected = true;
        for (const waiter of [...this.connectWaiters]) {
          waiter(true);
        }
        if (this._connectionIssueActive) {
          this._connectionIssueActive = false;
          this._connectionIssueLog?.clear();
          this.adapter.log.info(
            `Roborock MQTT connection recovered after the reported outage.`
          );
        }
      }
      this.adapter.log.debug(
        `MQTT connection connected ${JSON.stringify(result)}.`
      );
    });

    // Connection-state events are account-level transport telemetry, not
    // per-robot command failures: log them as clear, throttled warnings
    // instead of routing them through catchError (which used to produce the
    // misleading `Failed to execute client.on("error") on robot undefined`
    // spam twice per reconnect attempt during network outages).
    this.listen("error", (error) => {
      this.connected = false;
      this.sessionDiagnostics.onDisconnect();
      this.logConnectionIssue(
        `Roborock MQTT connection error: ${error?.message || error}. The client keeps reconnecting automatically.`
      );
    });

    // Every way a connection ends — a failed connect, a dropped link, a
    // keepalive timeout, the broker closing it — comes through here, and is
    // followed by a new client after the back-off.
    this.listen("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.sessionDiagnostics.onDisconnect();
      const delayMs = this.scheduleReconnect();
      if (wasConnected) {
        // So the next connect says the outage is over.
        this._connectionIssueActive = true;
        this.adapter.log.info(
          delayMs === null
            ? `MQTT connection closed.`
            : `MQTT connection closed; reconnecting in ${Math.round(delayMs / 1000)} seconds.`
        );
      } else if (delayMs !== null) {
        this.adapter.log.debug(
          `MQTT connect attempt did not succeed; next attempt in ${Math.round(delayMs / 1000)} seconds.`
        );
      }
    });
  }

  /**
   * Cancel the startup watchdog. Safe to call when it is not armed, and
   * called from shutdown so the timer cannot outlive the adapter.
   */
  clearInitialConnectTimeout() {
    if (this.initialConnectTimeout) {
      clearTimeout(this.initialConnectTimeout);
      this.initialConnectTimeout = null;
    }
  }

  /**
   * Warn about a connection problem at most once per 5 minutes per message,
   * and remember that an outage is in progress so the next successful
   * connect logs a single recovery line instead of silence.
   * @param {string} message
   */
  logConnectionIssue(message) {
    if (!this._connectionIssueLog) {
      this._connectionIssueLog = new Map();
    }
    this._connectionIssueActive = true;
    const now = Date.now();
    const lastAt = this._connectionIssueLog.get(message) || 0;
    if (now - lastAt >= 5 * 60 * 1000) {
      this._connectionIssueLog.set(message, now);
      this.adapter.log.warn(message);
    } else {
      this.adapter.log.debug(message);
    }
  }

  getKnownDeviceDuids() {
    const knownDuids = new Set();

    if (this.adapter.localKeys instanceof Map) {
      for (const duid of this.adapter.localKeys.keys()) {
        knownDuids.add(duid);
      }
    }

    if (this.adapter.devices && Array.isArray(this.adapter.devices)) {
      for (const device of this.adapter.devices) {
        if (device && device.duid) {
          knownDuids.add(device.duid);
        }
      }
    }

    return knownDuids;
  }

  resolveDuidFromTopic(topic) {
    const topicSegments = topic
      .split("/")
      .filter((segment) => segment && segment.length > 0);
    if (topicSegments.length === 0) {
      return null;
    }

    const knownDuids = this.getKnownDeviceDuids();
    const topicTail = topicSegments[topicSegments.length - 1];

    if (knownDuids.has(topicTail)) {
      return topicTail;
    }

    for (let index = topicSegments.length - 2; index >= 0; index--) {
      if (knownDuids.has(topicSegments[index])) {
        return topicSegments[index];
      }
    }

    if (knownDuids.size === 0) {
      return topicTail;
    }

    return null;
  }

  async initMQTT_Message() {
    this.adapter.log.debug(`MQTT initialized.`);

    // Kept, so every client openClient builds gets it too.
    this.messageHandler = (topic, message) => {
      try {
        this.sessionDiagnostics.noteActivity("raw");
        const duid = this.resolveDuidFromTopic(topic);
        if (!duid) {
          // Counted, not just logged: this is the one inbound path that drops
          // a frame silently as far as a user is concerned (decode failures
          // log at error, a missing localKey warns once). Without a count, a
          // cloud timeout cannot tell a robot that never answers from one
          // whose answers we fail to attribute — see #14.
          if (typeof this.adapter.noteUnattributedCloudMessage === "function") {
            this.adapter.noteUnattributedCloudMessage(topic);
          }
          this.adapter.log.debug(
            `Skipping MQTT message with unmatched topic '${topic}'.`
          );
          return;
        }

        this.sessionDiagnostics.noteActivity("attributed");
        const data = this.adapter.message._decodeMsg(message, duid);
        if (!data) {
          return;
        }

        this.sessionDiagnostics.noteActivity("decoded");

        // Counted here and nowhere else: past the topic match AND past
        // decryption, so the count means the link delivered something real
        // from this robot. A cloud timeout reads it to tell "nothing came
        // back" from "something came back that we could not match" — two
        // causes that a bare timeout leaves indistinguishable (#14).
        if (typeof this.adapter.noteCloudMessageReceived === "function") {
          this.adapter.noteCloudMessageReceived(duid);
        }

        if (isRpcReplyFrame(data)) {
          const parsedPayload = JSON.parse(data.payload);
          let dps;
          if (typeof parsedPayload.dps["102"] != "undefined") {
            dps = JSON.parse(parsedPayload.dps["102"]);
          } else if (typeof parsedPayload.dps["10001"] != "undefined") {
            if (typeof parsedPayload.dps["10001"] == "string") {
              dps = JSON.parse(parsedPayload.dps["10001"]);
            } else {
              dps = parsedPayload.dps["10001"];
            }
          } else {
            dps = parsedPayload.dps;
          }

          if (
            resolveB01PendingResponse(this.adapter, duid, dps, () =>
              this.sessionDiagnostics.noteActivity("correlated")
            )
          ) {
            return;
          }

          if (dps.id !== undefined) {
            // Runs for every cloud message; only pay the stringify cost
            // when debug logging is actually enabled.
            if (this.adapter.config.debug) {
              // A reply with no `result` used to print "Result: undefined",
              // which reads like a robot that said nothing. It said something;
              // it just did not say it in `result`. Print the reply itself so
              // the refusal is on the record even when nobody is waiting for
              // this id any more.
              this.adapter.log.debug(
                typeof dps.result === "undefined"
                  ? `Cloud message with protocol 102 and id ${dps.id} received. No result; reply was ${JSON.stringify(dps)}`
                  : `Cloud message with protocol 102 and id ${dps.id} received. Result: ${JSON.stringify(dps.result)}`
              );
            }
            if (typeof dps.result !== "undefined") {
              this.adapter.setStateAsync("CloudMessage", {
                duid,
                payload: dps.result,
              });
            }
          } else {
            this.adapter.log.debug(
              `Cloud message with protocol 102 received. Result: ${data.payload}`
            );

            if (this.adapter.deviceNotify) {
              this.adapter.deviceNotify("CloudMessage", {
                duid,
                payload: JSON.parse(data.payload),
              });
            }
          }

          // Secure requests (get_map_v1 and friends) answer protocol 102 with
          // a bare acknowledgement and deliver the real payload on protocol
          // 301, so those must stay pending. Everything else is resolved here.
          //
          // This used to be `if (dps.result != "ok")`, which is always true:
          // the wire format is the ARRAY ["ok"], and `["ok"] != "ok"` is false
          // only after ToPrimitive — so the guard never fired for the case it
          // was written for, and instead swallowed the completion of every
          // ordinary cloud command that answers ["ok"] (app_start, app_stop,
          // app_pause, app_charge, set_custom_mode, app_segment_clean, ...).
          // Those requests then sat until the 10 s timeout and failed in Apple
          // Home even though the robot had already carried them out.
          const pending = this.adapter.pendingRequests.get(dps.id);
          if (pending) this.sessionDiagnostics.noteActivity("correlated");
          if (shouldResolveOn102(pending, dps.result)) {
            this.adapter.clearTimeout(pending.timeout);
            this.adapter.pendingRequests.delete(dps.id);
            // A refusal is a failed request, not an empty one. Resolving it
            // with `undefined` is indistinguishable from a real empty answer
            // to every caller upstream — see describeReplyRefusal.
            const refusal = describeReplyRefusal(dps);
            if (refusal) {
              pending.reject(
                createRefusalError(
                  `The robot refused ${pending.method || "the request"} (cloud id ${dps.id}): ${refusal}`,
                  dps
                )
              );
            } else {
              pending.resolve(dps.result);
            }
          } else if (!pending) {
            noteLateReply(this.adapter, duid, dps.id, "cloud");
          }
        } else if (data.protocol == 301) {
          // A B01 robot's map frames are its own format, pushed unasked as
          // well as sent on request. Every one goes to the B01 map handler,
          // which decodes it once and routes it by map type; none reaches
          // the classic photo/map parser below, which counted each push as a
          // frame for another controller.
          if (
            typeof this.adapter.onB01MapFrame === "function" &&
            this.adapter.isB01Device?.(duid)
          ) {
            if (this.adapter.onB01MapFrame(duid, data.payload)) {
              this.sessionDiagnostics.noteActivity("correlated");
            }
            return;
          }

          const data2 = parseProtocol301Header(data.payload);
          if (!data2) {
            this.adapter.log.debug(
              `Skipping protocol 301 MQTT message for ${duid} because the payload is shorter than ${PROTOCOL_301_HEADER_LENGTH} bytes.`
            );
            return;
          }

          // THE COMPARISON IS THE OTHER WAY ROUND, and until 3.31.0 it
          // was inverted AND silent — the worst possible pair.
          //
          // `endpoint` is our own 8-character key (md5bin(rriot.k)
          // bytes 8..14, base64). The wire field is 15 bytes, so a robot
          // that echoes our 8 characters followed by anything that is not
          // a trailing NUL leaves `data2.endpoint` LONGER than 8 —
          // and an 8-character string can never `startsWith` a longer
          // one. python-roborock, the reference implementation, compares
          // it the other way: received.startswith(ours).
          //
          // So this failed closed on a reply that was addressed to us,
          // and it did it with `return` — no log, no counter, nothing.
          // A dropped 301 leaves the pending request to die on its 10 s
          // timer, which is indistinguishable from a robot that never
          // answered. That is exactly the shape of the oldest open bug in
          // this project: `get_map_v1` on a classic robot timing out 95
          // and 225 times in a row while the same robot answers
          // everything else (my own a70; #9's a75).
          //
          // Whether that IS the cause is not settled here — it is
          // measured, because from 3.31.0 the drop says so.
          if (!String(data2.endpoint || "").startsWith(endpoint)) {
            noteDroppedFrame(duid, "addressed-elsewhere");
            this.adapter.log.debug(
              `Ignored a protocol 301 message for ${duid}: it is addressed to endpoint '${data2.endpoint}', and this plugin's endpoint is '${endpoint}'. It belongs to another controller on the same Roborock account (the Roborock app, for one), so ignoring it is expected.`
            );
            return;
          }

          // Past the guard: this frame names US. Counted before the
          // decipher, because the question it answers is only about the
          // endpoint — a frame addressed to us that then fails to decode
          // is still proof that our account key is the right one.
          noteAcceptedFrame(duid);

          let decrypted;
          try {
            const decipher = crypto.createDecipheriv(
              "aes-128-cbc",
              this.adapter.nonce,
              Buffer.alloc(16, 0)
            );
            decrypted = zlib.gunzipSync(
              Buffer.concat([
                decipher.update(data.payload.subarray(24)),
                decipher.final(),
              ])
            );
          } catch (error) {
            // The robot answered; what arrived could not be read. Said
            // as such and settled now, never left to time out as a robot
            // that did not answer.
            const pending = this.adapter.pendingRequests.get(data2.id);
            if (!pending) {
              noteDroppedFrame(duid, "undecodable");
              this.adapter.log.debug(
                `A protocol 301 frame for ${duid} with id ${data2.id} could not be decoded and no request is waiting for it: ${error?.message || error}`
              );
              return;
            }
            this.adapter.clearTimeout(pending.timeout);
            this.adapter.pendingRequests.delete(data2.id);
            this.sessionDiagnostics.noteActivity("correlated");
            pending.reject(
              Object.assign(
                new Error(
                  `The reply to ${pending.method || "the map request"} (cloud id ${data2.id}) from ${describeDevice(this.adapter, duid)} arrived but could not be decoded: ${error?.message || error}`
                ),
                { unansweredRequest: false }
              )
            );
            return;
          }

          if (!this.adapter.pendingRequests.has(data2.id)) {
            // The other silent drop on this path. An unsolicited map push
            // lands here legitimately, but so does a reply whose id we
            // failed to match — and the waiting request then times out
            // with nothing in the log to say a reply had arrived. Since
            // 3.35.0 a reply to a request that had ALREADY timed out is
            // told apart and counted as late, not as discarded: it is the
            // robot being slow, not this side throwing an answer away.
            const late = noteLateReply(this.adapter, duid, data2.id, "cloud");
            noteDroppedFrame(
              duid,
              late ? "arrived-after-timeout" : "no-request-waiting"
            );
            if (!late) {
              this.adapter.log.debug(
                `Received a protocol 301 message for ${duid} with id ${data2.id}, but no request is waiting for that id. It was decrypted successfully, so the robot did answer something; either this is an unsolicited map push, or a reply to a request this plugin did not send.`
              );
            }
          }

          if (this.adapter.pendingRequests.has(data2.id)) {
            const { resolve, timeout } = this.adapter.pendingRequests.get(
              data2.id
            );
            this.adapter.clearTimeout(timeout);
            this.adapter.pendingRequests.delete(data2.id);
            this.adapter.log.debug(
              `Cloud message with protocol 301 and id ${data2.id} received.`
            );
            this.sessionDiagnostics.noteActivity("correlated");
            resolve(decrypted);
          }
        } else if (data.protocol == 500) {
          // 500 is for general information
          const dataString = data.payload.toString("utf8");
          let parsedData;

          try {
            parsedData = JSON.parse(dataString);
          } catch (error) {
            // If parsing fails, the data might be corrupted or in an unexpected format
            this.adapter.log.warn(
              `Unable to parse message for ${describeDevice(this.adapter, duid)}. Error: ${error.message}. Data: ${dataString}`
            );
            return;
          }

          // Check if the device is online
          if (parsedData.online == false) {
            // A robot dropping off is the single most common thing users open
            // issues about, and the old wording ("Couldn't process message")
            // described a failure that did not happen — the message parsed
            // fine, and what it said was "offline".
            this.adapter.log.warn(
              `${describeDevice(this.adapter, duid)} reports itself offline; commands will fail until it reconnects. Check that the robot is powered on and on Wi-Fi.`
            );
          } else if (parsedData.online == true) {
            // The counterpart was commented out, so a robot that dropped and
            // came back left the log asserting it was offline forever.
            this.adapter.log.info(
              `${describeDevice(this.adapter, duid)} is back online.`
            );
          } else if (
            // Check for firmware update information
            parsedData.mqttOtaData
          ) {
            const otaStatus = parsedData.mqttOtaData.mqttOtaStatus?.status;
            const otaProgress =
              parsedData.mqttOtaData.mqttOtaProgress?.progress;

            if (otaStatus) {
              this.adapter.log.info(
                `${describeDevice(this.adapter, duid)} firmware update status: ${otaStatus}`
              );
            }

            if (otaProgress !== undefined) {
              this.adapter.log.info(
                `${describeDevice(this.adapter, duid)} firmware update progress: ${otaProgress}%`
              );
            }
          } else {
            // Received an unrecognized message
            this.adapter.log.warn(
              `Received an unrecognized message for ${describeDevice(this.adapter, duid)}. Data: ${dataString}`
            );
          }
        } else {
          this.adapter.log.debug(
            `Received message with unknown protocol ${data.protocol} data: ${JSON.stringify(data)}.`
          );
        }
      } catch (error) {
        this.adapter.log.error(
          `client.on message failed for topic '${topic}': ${error.stack || error}`
        );
      } finally {
        this.sessionDiagnostics.emit();
      }
    };
    this.listen("message", this.messageHandler);
  }

  getEndpoint() {
    return endpoint;
  }

  /**
   * QoS 0, as python-roborock publishes every V1 and B01 request
   * (`MqttQos.AT_MOST_ONCE`; only A01 appliances need QoS 1, and this plugin
   * drives no A01 device). QoS 1 was inherited from the ioBroker adapter and
   * had a cost on a flaky link: mqtt.js keeps every un-acknowledged QoS 1
   * publish and sends it AGAIN after a reconnect. With QoS 0 and
   * `queueQoSZero: false` (see initUser) a publish made while the link is
   * down is dropped, and the request it belongs to times out like any other
   * unanswered request instead of being replayed later.
   */
  /**
   * @param {string} duid
   * @param {Buffer} roborockMessage
   * @param {(error: Error) => void} [onNotSent] Called when mqtt.js refuses
   *   the publish (no connection to the broker, or the client is closing),
   *   so the caller can fail the request at once instead of waiting out its
   *   timeout and reading a dead link as a silent robot.
   */
  sendMessage(duid, roborockMessage, onNotSent) {
    if (!client) {
      // Shut down between the caller's connection check and this publish.
      onNotSent?.(new Error("The MQTT client is closed"));
      return;
    }
    client.publish(
      `rr/m/i/${rriot.u}/${mqttUser}/${duid}`,
      roborockMessage,
      { qos: 0 },
      (error) => {
        if (error) {
          onNotSent?.(error);
        }
      }
    );
  }

  isConnected() {
    return this.connected;
  }

  /**
   * Listen to the current client for as long as it is the current one.
   *
   * A client `disconnect` has let go of keeps its listeners, and they ignore
   * it. Removing them instead (removeAllListeners) also removed mqtt.js's
   * own, among them the 'close' handler that cancels the CONNACK timer. A
   * client closed mid-handshake — a startService retry during a network
   * outage — then emitted "connack timeout" 30 s later with no 'error'
   * listener left, and an unhandled 'error' event ends the process.
   */
  listen(event, handler) {
    client.on(event, this.whileCurrent(handler));
  }

  /** `fn`, run only while the client current now is still the current one. */
  whileCurrent(fn) {
    const owner = client;
    return (...args) => {
      if (client === owner) fn(...args);
    };
  }

  /**
   * Close the MQTT session on shutdown.
   *
   * `client.end()` existed in exactly 1 place in this codebase — inside
   * `reconnectClient` — and never on the shutdown path. So during the seconds
   * between Homebridge's SIGTERM and its forced exit, robot frames kept
   * arriving and being dispatched into disposed accessories, and the socket
   * kept the event loop alive so the process only ever died by being killed.
   *
   * `end(true)` rather than a graceful close: there is nothing left worth
   * flushing to a broker at this point, and a graceful close can wait on an
   * ack that will not come if the network is what is broken.
   *
   * The client is let go of, not stripped of its listeners (see `listen`).
   */
  disconnect() {
    this.sessionWanted = false;
    this.clearReconnectTimer();
    this.clearInitialConnectTimeout();
    const closing = client;
    client = undefined;
    if (!closing) {
      return;
    }
    try {
      closing.end(true);
    } catch (error) {
      this.adapter?.log?.debug?.(
        `Closing the MQTT client on shutdown failed: ${error?.message || error}`
      );
    }
    this.connected = false;
    this.sessionDiagnostics.onDisconnect();
  }

  /**
   * Resolve once the MQTT session is usable, or after `timeoutMs` regardless.
   *
   * The broker handshake takes a few seconds, and cloud requests issued
   * before it completes fail outright with "Cloud connection not available".
   * Startup used to get away with this because an unrelated fixed delay
   * happened to sit in front of the first requests; waiting on the real
   * signal makes that timing explicit rather than accidental. Resolving on
   * timeout (instead of rejecting) keeps a slow or offline broker from
   * blocking startup — callers fall back to their own error handling.
   *
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<boolean>} whether the connection came up in time
   */
  async waitUntilConnected(timeoutMs = 10000) {
    if (this.connected) {
      return true;
    }

    return new Promise((resolve) => {
      /** @param {boolean} connected */
      const settle = (connected) => {
        clearTimeout(timer);
        this.connectWaiters.delete(settle);
        resolve(connected);
      };
      const timer = setTimeout(() => settle(this.connected), timeoutMs);
      if (typeof timer?.unref === "function") {
        timer.unref();
      }
      this.connectWaiters.add(settle);
    });
  }

  async ensureConnected() {
    if (client && this.connected) {
      this.adapter.log.debug("MQTT health check passed. Reconnect skipped.");
      return false;
    }
    if (this.reconnectTimer) {
      this.adapter.log.debug(
        "MQTT health check: a reconnect is already scheduled."
      );
      return false;
    }

    return this.reconnectClient(true);
  }

  /**
   * Start a fresh MQTT session: end this client now and build a new one after
   * the back-off, as python-roborock's `restart()` cancels its connection and
   * lets the reconnect loop build the next client.
   *
   * This used to end the client and call `reconnect()` on the SAME object,
   * with the same id, one second later. The teardown is still forced:
   * an unforced `end()` waits for an `outgoingEmpty` that a dead link never
   * emits (25 Aug 2026: 1 h 44 min of failures after the network was back).
   *
   * @param {boolean} [force]
   * @returns {Promise<boolean>} whether a new session was started
   */
  async reconnectClient(force = false) {
    if (!client || !this.sessionWanted) {
      return false;
    }
    if (!force && this.connected) {
      this.adapter.log.debug(
        "MQTT reconnect skipped because client is already connected."
      );
      return false;
    }

    this.adapter.log.info("Reconnecting mqtt client!");
    const current = client;
    this.connected = false;
    this.sessionDiagnostics.onDisconnect();
    try {
      current.end(true);
    } catch (error) {
      this.adapter.log.debug(
        `Ending the MQTT client failed: ${error?.message || error}`
      );
    }
    // Shut down, or replaced by a retried start, while the link closed.
    if (!this.sessionWanted || client !== current) {
      return false;
    }
    this.scheduleReconnect();
    return true;
  }
}

/**
 * Correlate a Q7/B01 RPC response (dps 10001 payload) to its pending request
 * by msgId. Returns true when the dps object was a B01 message and has been
 * fully handled; false when the caller should continue v1 processing.
 * Robot-initiated B01 pushes (no matching request) trigger a status refresh
 * instead of guessing at undocumented event payload formats.
 */
function resolveB01PendingResponse(
  adapter,
  duid,
  dps,
  onCorrelatedReply = () => {}
) {
  if (
    dps &&
    dps.msgId === undefined &&
    dps.id === undefined &&
    typeof adapter.onB01DatapointPush === "function" &&
    adapter.isB01Device?.(duid)
  ) {
    // A datapoint push from a B01 robot. It is read in the robot's own
    // dialect there; handed on raw it was read as classic datapoints.
    adapter.onB01DatapointPush(duid, dps);
    return true;
  }
  if (!dps || dps.msgId === undefined || dps.id !== undefined) {
    return false;
  }

  const b01Key = String(dps.msgId);
  const pendingB01 = adapter.pendingRequests.get(b01Key);

  if (pendingB01) {
    onCorrelatedReply();
    adapter.clearTimeout(pendingB01.timeout);
    adapter.pendingRequests.delete(b01Key);
    if (dps.code !== undefined && dps.code !== 0) {
      pendingB01.reject(
        new Error(
          `B01 command ${dps.method || "(unknown method)"} failed with code ${dps.code} for ${describeDevice(adapter, duid)}.`
        )
      );
    } else {
      pendingB01.resolve(dps.data !== undefined ? dps.data : null);
    }
  } else {
    adapter.log.debug(
      `Unsolicited B01 message for ${describeDevice(adapter, duid)} (${dps.method || "no method"}); scheduling a status refresh.`
    );
    if (typeof adapter.getStatus === "function") {
      void adapter.getStatus(duid, { force: true }).catch(() => undefined);
    }
  }

  return true;
}

module.exports = {
  describeDroppedFrames,
  noteAcceptedFrame,
  noteDroppedFrame,
  resetFrameCounters,
  isRpcReplyFrame,
  resolveB01PendingResponse,
  roborock_mqtt_connector,
  parseProtocol301Header,
  isOkAcknowledgement,
  shouldResolveOn102,
};
