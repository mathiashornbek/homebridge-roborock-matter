"use strict";

// A REAL `Roborock` instance with its REAL messageQueueHandler, give-up
// register and connectors. Only the edges that would touch a network or a
// cipher are replaced: the robot version / online / remote lookups, the
// payload builders, and the two transports' `isConnected`/`sendMessage`.
// Every pending-request entry, timeout and register call is the production
// code path.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

/**
 * @param {{transport?: "cloud" | "local"}} [options]
 */
function createRealRoborockOnFakeWire({
  transport: initialTransport = "cloud",
} = {}) {
  let transport = initialTransport;
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "audit-wire-")),
  });
  api.describeDevice = (duid) => `Robot ${duid}`;

  /** @type {Array<{duid: string, method: string, id: number}>} */
  const sent = [];
  let lastMethod = "";

  api.isRemoteDevice = jest.fn(async () => transport === "cloud");
  api.getRobotVersion = jest.fn(async () => "1.0");
  api.onlineChecker = jest.fn(async () => true);
  api.updateTransportDiagnostics = jest.fn(async () => undefined);
  api.message.buildPayload = jest.fn(
    async (duid, protocol, messageID, method) => {
      lastMethod = method;
      sent.push({ duid, method, id: messageID });
      return JSON.stringify({ id: messageID, method });
    }
  );
  api.message.buildRoborockMessage = jest.fn(async () => Buffer.from("frame"));

  api.rr_mqtt_connector.isConnected = jest.fn(() => true);
  // This wire fixture models an already subscribed transport, not a handshake.
  api.rr_mqtt_connector.waitUntilReady = jest.fn(async () => 0);
  api.rr_mqtt_connector.sendMessage = jest.fn();
  api.localConnector.isConnected = jest.fn(() => transport === "local");
  api.localConnector.sendMessage = jest.fn();

  return {
    api,
    log,
    sent,
    lastMethod: () => lastMethod,
    /** @param {"cloud" | "local"} next */
    setTransport: (next) => {
      transport = next;
    },
  };
}

module.exports = { createRealRoborockOnFakeWire };
