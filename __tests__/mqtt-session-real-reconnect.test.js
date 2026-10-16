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
  "real mqtt.js automatic reconnect acknowledges generation 2 with one SUBSCRIBE per connection (recovery=%s)",
  async (enableMqttSessionRecovery) => {
    const connections = [];
    const errors = [];
    const callbackGrants = [];
    let realClient;
    let receivedSubacks = 0;
    const originalSubscribe = mqtt.MqttClient.prototype.subscribe;
    const spy = jest
      .spyOn(mqtt.MqttClient.prototype, "subscribe")
      .mockImplementation(function (...args) {
        if (!realClient) {
          realClient = this;
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
          if (connections.length === 1) socket.write(suback);
          else connection.pendingSuback = suback;
        } else if (packet.cmd === "pingreq") {
          socket.write(mqttPacket.generate({ cmd: "pingresp" }));
        } else if (packet.cmd === "disconnect") socket.end();
      });
    });
    let latest;
    const adapter = {
      config: { enableMqttSessionRecovery },
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
      await until(
        () => latest?.generation === 1 && latest.subscriptionAcknowledged
      );
      expect(connections[0].subscriptions).toHaveLength(1);
      connections[0].socket.destroy();
      await until(
        () => latest?.generation === 2 && connections[1]?.pendingSuback
      );
      expect(latest).toMatchObject({
        connected: true,
        subscriptionAcknowledged: false,
      });
      expect(
        callbackGrants.some(
          ({ error, grants }) => !error && grants?.length === 0
        )
      ).toBe(true);
      if (enableMqttSessionRecovery)
        expect(connector.isConnected()).toBe(false);
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
      expect(connector.isConnected()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      connector.disconnect();
      for (const { socket } of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      spy.mockRestore();
    }
  }
);
