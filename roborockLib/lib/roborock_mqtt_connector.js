"use strict";

const mqtt = require("mqtt");
const crypto = require("crypto");
const Parser = require("binary-parser").Parser;
const zlib = require("zlib");
const roborockCrypto = require("./roborockCrypto");

const PHOTO_MAGIC = "ROBOROCK";
const PHOTO_HEADER_MIN_LENGTH = 9;
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

const photoParser = new Parser()
  .endianess("little")
  .string("roborock", {
    length: 8,
    stripNull: true,
  })
  .uint8("id");

let mqttUser;
let mqttPassword;
let client;
let endpoint;
let rriot;

let photoGzipChunks = [];
let photoChunkID = 0;

function payloadStartsWith(payload, value) {
  return (
    Buffer.isBuffer(payload) &&
    payload.length >= value.length &&
    payload.subarray(0, value.length).toString("utf8") === value
  );
}

function parsePhotoPayload(payload) {
  if (
    !payloadStartsWith(payload, PHOTO_MAGIC) ||
    payload.length < PHOTO_HEADER_MIN_LENGTH
  ) {
    return null;
  }

  return photoParser.parse(payload);
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

    this.connected = false;

    this.keys = roborockCrypto.generateRsaKeyPair();
  }

  async initUser(userdata) {
    rriot = userdata.rriot;

    endpoint = roborockCrypto
      .md5bin(rriot.k)
      .subarray(8, 14)
      .toString("base64"); // Could be a random but rather static string. The app generates it on first run.
    mqttUser = roborockCrypto.md5hex(rriot.u + ":" + rriot.k).substring(2, 10);
    mqttPassword = roborockCrypto.md5hex(rriot.s + ":" + rriot.k).substring(16);
    client = mqtt.connect(rriot.r.m, {
      clientId: mqttUser,
      username: mqttUser,
      password: mqttPassword,
      keepalive: 30,
    });
  }

  async initMQTT_Subscribe() {
    const timeout = setTimeout(async () => {
      this.adapter.restart();
    }, 30000);

    await client.on("connect", (result) => {
      if (typeof result != "undefined") {
        client.subscribe(`rr/m/o/${rriot.u}/${mqttUser}/#`, (err, granted) => {
          if (err) {
            this.adapter.catchError(
              `Failed to subscribe to Roborock MQTT Server! Error: ${err}, granted: ${JSON.stringify(granted)}`,
              `client.on("connect")`
            );
          }
        });
        clearTimeout(timeout);

        this.connected = true;
      }
      this.adapter.log.debug(
        `MQTT connection connected ${JSON.stringify(result)}.`
      );
    });

    await client.on("error", (result) => {
      this.adapter.catchError(
        `MQTT connection error: ${result}`,
        `client.on("error")`
      );

      this.connected = false;
    });

    await client.on("close", () => {
      this.adapter.log.info(`MQTT connection close.`);

      this.connected = false;
    });

    await client.on("reconnect", (error) => {
      if (error) {
        this.adapter.catchError(
          `Failed to reconnect to MQTT server.`,
          `mqtt client reconnect`
        );
      } else {
        client.subscribe(`rr/m/o/${rriot.u}/${mqttUser}/#`, (err, granted) => {
          if (err) {
            this.adapter.catchError(
              `Failed to subscribe to Roborock MQTT Server! Error: ${err}, granted: ${JSON.stringify(granted)}`,
              `client.on("reconnect")`
            );
          }
        });
        clearTimeout(timeout);
      }
      this.adapter.log.info(`MQTT connection reconnect.`);
    });

    await client.on("offline", (result) => {
      this.adapter.catchError(
        `MQTT connection offline: ${result}`,
        `client.on("offline")`
      );

      this.connected = false;
    });
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
    this.adapter.log.info(`MQTT initialized`);

    client.on("message", (topic, message) => {
      try {
        const duid = this.resolveDuidFromTopic(topic);
        if (!duid) {
          this.adapter.log.debug(
            `Skipping MQTT message with unmatched topic '${topic}'.`
          );
          return;
        }

        const data = this.adapter.message._decodeMsg(message, duid);
        if (!data) {
          return;
        }
        // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data)} raw: ${JSON.stringify(mqttMessageParser.parse(message))} message: ${message}`);
        // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data.toString("hex"))} message: ${message}`);
        // this.adapter.log.debug(`MESSAGE RECEIVED for duid ${duid} with key: ${this.adapter.localKeys.get(duid)} data: ${JSON.stringify(data)}`);

        // this.adapter.log.debug("Protocol: " + data.protocol);
        if (data.protocol == 102) {
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

          if (resolveB01PendingResponse(this.adapter, duid, dps)) {
            return;
          }

          if (dps.id !== undefined) {
            this.adapter.log.debug(
              `Cloud message with protocol 102 and id ${dps.id} received. Result: ${JSON.stringify(dps.result)}`
            );
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

            if (this.adapter.deviceNotify !== undefined) {
              this.adapter.deviceNotify("CloudMessage", {
                duid,
                payload: JSON.parse(data.payload),
              });
            }
          }

          // special check for secure request like get_map_v1 etc. Don't process if result is OK. Instead wait for the actual response for protocol 301
          if (dps.result != "ok") {
            if (this.adapter.pendingRequests.has(dps.id)) {
              const { resolve, timeout } = this.adapter.pendingRequests.get(
                dps.id
              );
              this.adapter.clearTimeout(timeout);
              this.adapter.pendingRequests.delete(dps.id);
              resolve(dps.result);
            }
          }
          // protocol 300 seems to be for get_photo 0 only. get_photo 0 is for large images. 1 is for small images.
        } else if (data.protocol == 300) {
          const photoData = parsePhotoPayload(data.payload);
          if (photoData) {
            if (this.adapter.pendingRequests.has(photoData.id)) {
              this.adapter.log.debug(`First photo gzip chunk detected!`);

              photoGzipChunks.push(data.payload.slice(56));
              photoChunkID = photoData.id;
            }
          } else {
            this.adapter.log.debug(
              `Skipping protocol 300 MQTT message for ${duid} because the payload is not a complete Roborock photo header.`
            );
          }
        } else if (data.protocol == 301) {
          // B01/Q7 map upload responses arrive on protocol 301 as an opaque
          // base64 blob. Resolve the per-device pending map request first;
          // classic v1 photo/map chunk handling continues below otherwise.
          const pendingMap = this.adapter.pendingB01MapRequests?.get(duid);
          if (pendingMap) {
            this.adapter.clearTimeout(pendingMap.timeout);
            this.adapter.pendingB01MapRequests.delete(duid);
            pendingMap.resolve(data.payload);
            return;
          }

          if (data.seq == 2 && photoGzipChunks != [] && photoChunkID != 0) {
            this.adapter.log.debug(`Second photo gzip chunk detected!`);
            photoGzipChunks.push(data.payload);

            if (this.adapter.pendingRequests.has(photoChunkID)) {
              const { resolve, timeout } =
                this.adapter.pendingRequests.get(photoChunkID);
              this.adapter.clearTimeout(timeout);
              this.adapter.pendingRequests.delete(photoChunkID);

              const finalPhotoGzip = Buffer.concat(photoGzipChunks);

              photoGzipChunks = [];
              photoChunkID = 0;

              resolve(finalPhotoGzip);
            }
          } else {
            const photoData = parsePhotoPayload(data.payload);
            if (photoData) {
              this.adapter.log.debug(
                `Cloud message with protocol 301 and photo id ${photoData.id} received.`
              );

              if (this.adapter.pendingRequests.has(photoData.id)) {
                const { resolve, timeout } = this.adapter.pendingRequests.get(
                  photoData.id
                );
                this.adapter.clearTimeout(timeout);
                this.adapter.pendingRequests.delete(photoData.id);
                this.adapter.log.debug(
                  `Cloud message with protocol 301 and photo id ${photoData.id} received.`
                );
                resolve(data.payload.slice(56));
              }
            } else {
              const data2 = parseProtocol301Header(data.payload);
              if (!data2) {
                this.adapter.log.debug(
                  `Skipping protocol 301 MQTT message for ${duid} because the payload is shorter than ${PROTOCOL_301_HEADER_LENGTH} bytes.`
                );
                return;
              }

              if (!endpoint.startsWith(data2.endpoint)) {
                return;
              }

              const iv = Buffer.alloc(16, 0);
              const decipher = crypto.createDecipheriv(
                "aes-128-cbc",
                this.adapter.nonce,
                iv
              );
              let decrypted = Buffer.concat([
                decipher.update(data.payload.subarray(24)),
                decipher.final(),
              ]);
              decrypted = zlib.gunzipSync(decrypted);
              // this.adapter.log.debug("raw 301: " + decrypted);

              if (this.adapter.pendingRequests.has(data2.id)) {
                const { resolve, timeout } = this.adapter.pendingRequests.get(
                  data2.id
                );
                this.adapter.clearTimeout(timeout);
                this.adapter.pendingRequests.delete(data2.id);
                // this.adapter.log.debug("protocol 301 OK check: " + JSON.stringify(decrypted));
                this.adapter.log.debug(
                  `Cloud message with protocol 301 and id ${data2.id} received.`
                );
                resolve(decrypted);
              }
            }
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
              `Unable to parse message for ${duid}. Error: ${error.message}. Data: ${dataString}`
            );
            return;
          }

          // Check if the device is online
          if (parsedData.online == false) {
            this.adapter.log.info(
              `Couldn't process message. The device ${duid} is offline.`
            );
          } else if (parsedData.online == true) {
            // this.adapter.log.info(`Device ${duid} is online.`);
          } else if (
            // Check for firmware update information
            parsedData.mqttOtaData
          ) {
            const otaStatus = parsedData.mqttOtaData.mqttOtaStatus?.status;
            const otaProgress =
              parsedData.mqttOtaData.mqttOtaProgress?.progress;

            if (otaStatus) {
              this.adapter.log.info(
                `Device ${duid} firmware update status: ${otaStatus}`
              );
            }

            if (otaProgress !== undefined) {
              this.adapter.log.info(
                `Device ${duid} firmware update progress: ${otaProgress}%`
              );
            }
          } else {
            // Received an unrecognized message
            this.adapter.log.warn(
              `Received an unrecognized message for ${duid}. Data: ${dataString}`
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
      }
    });
  }

  getEndpoint() {
    return endpoint;
  }

  sendMessage(duid, roborockMessage) {
    client.publish(`rr/m/i/${rriot.u}/${mqttUser}/${duid}`, roborockMessage, {
      qos: 1,
    });
  }

  isConnected() {
    return this.connected;
  }

  async ensureConnected() {
    if (client && this.connected) {
      this.adapter.log.debug("MQTT health check passed. Reconnect skipped.");
      return false;
    }

    await this.reconnectClient(true);
    return true;
  }

  async reconnectClient(force = false) {
    if (client) {
      try {
        if (!force && this.connected) {
          this.adapter.log.debug(
            "MQTT reconnect skipped because client is already connected."
          );
          return false;
        }

        this.adapter.log.info("Reconnecting mqtt client!");
        await client.end();
        client.reconnect();
        return true;
      } catch (error) {
        this.adapter.catchError(
          `Failed to reconnect with error: ${error}`,
          `reconnectClient`
        );
      }
    }

    return false;
  }

  decryptWithPrivateKey(privateKeyPem, encryptedData) {
    const privateKey = crypto.createPrivateKey({
      key: privateKeyPem,
      format: "pem",
      type: "pkcs8",
    });

    const decryptedData = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      encryptedData
    );

    return decryptedData;
  }
}

/**
 * Correlate a Q7/B01 RPC response (dps 10001 payload) to its pending request
 * by msgId. Returns true when the dps object was a B01 message and has been
 * fully handled; false when the caller should continue v1 processing.
 * Robot-initiated B01 pushes (no matching request) trigger a status refresh
 * instead of guessing at undocumented event payload formats.
 */
function resolveB01PendingResponse(adapter, duid, dps) {
  if (!dps || dps.msgId === undefined || dps.id !== undefined) {
    return false;
  }

  const b01Key = String(dps.msgId);
  const pendingB01 = adapter.pendingRequests.get(b01Key);

  if (pendingB01) {
    adapter.clearTimeout(pendingB01.timeout);
    adapter.pendingRequests.delete(b01Key);
    if (dps.code !== undefined && dps.code !== 0) {
      pendingB01.reject(
        new Error(
          `B01 command ${dps.method || "(unknown method)"} failed with code ${dps.code} for ${duid}.`
        )
      );
    } else {
      pendingB01.resolve(dps.data !== undefined ? dps.data : null);
    }
  } else {
    adapter.log.debug(
      `Unsolicited B01 message for ${duid} (${dps.method || "no method"}); scheduling a status refresh.`
    );
    if (typeof adapter.getStatus === "function") {
      void adapter.getStatus(duid, { force: true }).catch(() => undefined);
    }
  }

  return true;
}

module.exports = {
  resolveB01PendingResponse,
  roborock_mqtt_connector,
  parseProtocol301Header,
  parsePhotoPayload,
  payloadStartsWith,
};
