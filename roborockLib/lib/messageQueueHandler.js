// @ts-check
"use strict";

const b01Q7Adapter = require("./b01Q7Adapter");

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
 * @typedef {Object} PendingRequest
 * @property {(value: unknown) => void} resolve
 * @property {(reason?: unknown) => void} reject
 * @property {ReturnType<typeof setTimeout>} timeout
 */

/**
 * @typedef {Object} TransportDiagnosticsUpdate
 * @property {"cloud" | "local" | "local-pending"} [lastTransport]
 * @property {string} [lastTransportReason]
 * @property {string} [lastCommandMethod]
 */

/**
 * @typedef {Object} MessageBuilder
 * @property {(duid: string, protocol: number, messageID: number, method: string, params: unknown[], secure: boolean, photo: boolean) => Promise<unknown>} buildPayload
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
 * @property {(message: string, location: string, duid?: string) => void} catchError
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

    // B01 (Q7-series) devices are cloud/MQTT-only and speak a different RPC
    // dialect. Translate the v1-shaped method to the Q7 equivalent here so a
    // single choke point covers every caller (Matter, polling, UI).
    if (b01Q7Adapter.isB01Protocol(version)) {
      const neutral = b01Q7Adapter.neutralResponse(method);
      const translated = b01Q7Adapter.translateOutgoing(method, params);

      if (!translated) {
        if (neutral) {
          this.adapter.log.debug(
            `Method ${method} has no B01/Q7 equivalent for ${duid}; returning a neutral response.`
          );
          return neutral.value;
        }

        const unsupported = /** @type {Error & {code?: string}} */ (
          new Error(
            `Method ${method} is not supported on B01/Q7 devices yet (${duid}).`
          )
        );
        unsupported.code = "B01_METHOD_UNSUPPORTED";
        throw unsupported;
      }

      method = translated.method;
      params = /** @type {any} */ (translated.params);
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
      photo
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
            new Error(
              `Device ${duid} is offline. Not sending method ${method} request.`
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
            new Error(
              `Cloud connection not available. Not sending method ${method} request.`
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
            new Error(
              `Local connection not available for ${duid}. Not sending method ${method} request.`
            )
          );
        } else {
          // setup Timeout
          const requestTimeout = getRequestTimeout(
            method,
            options.requestTimeoutMs
          );
          const timeoutSeconds = Math.round(requestTimeout / 1000);
          const timeout = this.adapter.setTimeout(() => {
            this.adapter.pendingRequests.delete(messageID);
            this.adapter.localConnector.clearChunkBuffer(duid);
            if (useCloudConnection) {
              reject(
                new Error(
                  `Cloud request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds. MQTT connection state: ${mqttConnectionState}`
                )
              );
            } else {
              reject(
                new Error(
                  `Local request with id ${messageID} with method ${method} timed out after ${timeoutSeconds} seconds Local connect state: ${localConnectionState}`
                )
              );
            }
          }, requestTimeout);

          // Store request with resolve and reject functions
          this.adapter.pendingRequests.set(messageID, {
            resolve,
            reject,
            timeout,
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
        `Failed to build Roborock message for method ${method} on ${duid}; the command was not sent.`
      );
    }
  }
}

module.exports = {
  messageQueueHandler,
  getRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT,
};
