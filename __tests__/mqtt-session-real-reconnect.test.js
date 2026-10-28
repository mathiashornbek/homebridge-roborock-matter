"use strict";

// Real connector + real mqtt.js over TCP. Only the remote broker is a fixture;
// it speaks MQTT using the same codec, rather than inventing client callbacks.
const net = require("net");
const path = require("path");
const mqtt = require("mqtt");
const mqttPacket = require(
  require.resolve("mqtt-packet", {
    paths: [path.dirname(require.resolve("mqtt"))],
  })
);
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for MQTT fixture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test.each([false, true])(
  "a real dropped connection is replaced by a new client with a new id, which acknowledges generation 2 with one SUBSCRIBE per connection (recovery=%s)",
  async (enableMqttSessionRecovery) => {
    const connections = [];
    const errors = [];
    const callbackGrants = [];
    const seenClients = new WeakSet();
    const presencePackets = [];
    let receivedSubacks = 0;
    const originalSubscribe = mqtt.MqttClient.prototype.subscribe;
    const spy = jest
      .spyOn(mqtt.MqttClient.prototype, "subscribe")
      .mockImplementation(function (...args) {
        if (!seenClients.has(this)) {
          seenClients.add(this);
          this.on("message", (_topic, _message, packet) =>
            presencePackets.push(packet)
          );
          this.on("packetreceive", (packet) => {
            if (packet.cmd === "suback") receivedSubacks += 1;
          });
        }
        const callbackIndex = args.findIndex(
          (arg) => typeof arg === "function"
        );
        if (callbackIndex !== -1) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (error, grants) => {
            callbackGrants.push({ error, grants });
            callback(error, grants);
          };
        }
        return originalSubscribe.apply(this, args);
      });
    const server = net.createServer((socket) => {
      const connection = { socket, subscriptions: [], pendingSuback: null };
      connections.push(connection);
      const parser = mqttPacket.parser();
      socket.on("error", (error) => errors.push(error));
      parser.on("error", (error) => errors.push(error));
      socket.on("data", (bytes) => parser.parse(bytes));
      parser.on("packet", (packet) => {
        if (packet.cmd === "connect") {
          connection.clientId = packet.clientId;
          connection.username = packet.username;
          socket.write(
            mqttPacket.generate({
              cmd: "connack",
              sessionPresent: false,
              returnCode: 0,
            })
          );
        } else if (packet.cmd === "subscribe") {
          connection.subscriptions.push(packet);
          const suback = mqttPacket.generate({
            cmd: "suback",
            messageId: packet.messageId,
            granted: packet.subscriptions.map(
              (subscription) => subscription.qos
            ),
          });
          if (connections.length === 1) {
            socket.write(suback);
            socket.write(
              mqttPacket.generate({
                cmd: "publish",
                qos: 0,
                retain: true,
                topic: packet.subscriptions[0].topic.replace(/#$/, "robot-a"),
                payload: Buffer.from(JSON.stringify({ online: true })),
              })
            );
          } else connection.pendingSuback = suback;
        } else if (packet.cmd === "pingreq") {
          socket.write(mqttPacket.generate({ cmd: "pingresp" }));
        } else if (packet.cmd === "disconnect") socket.end();
      });
    });
    let latest;
    const adapter = {
      config: { enableMqttSessionRecovery },
      localKeys: new Map([["robot-a", "fixture-key"]]),
      describeDevice: () => "Fixture robot",
      message: { _decodeMsg: (payload) => ({ protocol: 500, payload }) },
      log: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      setStateAsync: async (key, state) => {
        if (key === "MqttSessionDiagnostics") latest = JSON.parse(state.val);
      },
    };
    const connector = new roborock_mqtt_connector(adapter);
    // The back-off is 10 s in production; this fixture is real TCP and real
    // time, so it waits 20 ms.
    connector.reconnectDelays = { initialMs: 20, multiplier: 1.5, maxMs: 1000 };
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      await connector.initUser({
        rriot: {
          u: "fixture-user",
          k: "fixture-key",
          s: "fixture-secret",
          r: { m: `mqtt://127.0.0.1:${server.address().port}` },
        },
      });
      await connector.initMQTT_Subscribe();
      await connector.initMQTT_Message();
      await until(
        () => latest?.generation === 1 && latest.subscriptionAcknowledged
      );
      expect(connections[0].subscriptions).toHaveLength(1);
      await until(() => presencePackets.length === 1);
      expect(presencePackets[0].retain).toBe(true);
      expect(adapter.log.info).not.toHaveBeenCalled();
      expect(connector.robotPresenceByDuid.has("robot-a")).toBe(false);
      const presenceTopic =
        connections[0].subscriptions[0].subscriptions[0].topic.replace(
          /#$/,
          "robot-a"
        );
      connections[0].socket.write(
        mqttPacket.generate({
          cmd: "publish",
          qos: 0,
          retain: false,
          topic: presenceTopic,
          payload: Buffer.from(JSON.stringify({ online: true })),
        })
      );
      await until(() => presencePackets.length === 2);
      expect(presencePackets[1].retain).toBe(false);
      expect(adapter.log.info).toHaveBeenCalledWith(
        "Fixture robot: first live MQTT presence report is online."
      );
      connections[0].socket.destroy();
      await until(
        () => latest?.generation === 2 && connections[1]?.pendingSuback
      );
      expect(latest).toMatchObject({
        connected: true,
        subscriptionAcknowledged: false,
      });
      // A new client subscribes afresh: no callback has fired for it yet.
      expect(callbackGrants).toHaveLength(1);
      connections[1].socket.write(connections[1].pendingSuback);
      await until(() => receivedSubacks === 2);
      // This assertion fails on the old connector even though both SUBACKs arrived.
      expect(latest).toMatchObject({
        generation: 2,
        subscriptionAcknowledged: true,
      });
      expect(
        connections.map((connection) => connection.subscriptions.length)
      ).toEqual([1, 1]);
      expect(connections[1].subscriptions[0].subscriptions).toEqual(
        connections[0].subscriptions[0].subscriptions
      );
      // python-roborock never reuses an id; the account-wide username let any
      // second client of the account take this session over.
      expect(connections[0].clientId).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(connections[1].clientId).toMatch(/^[0-9A-Za-z]{22}$/);
      expect(connections[1].clientId).not.toBe(connections[0].clientId);
      expect(connections[1].username).toBe(connections[0].username);
      expect(errors).toEqual([]);
    } finally {
      connector.disconnect();
      for (const { socket } of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      spy.mockRestore();
    }
  }
);
