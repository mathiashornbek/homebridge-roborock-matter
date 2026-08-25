/**
 * A reconnect must never wait for the outgoing queue to drain.
 *
 * WHY THIS SUITE EXISTS. On 25 August 2026 the maintainer's own server lost
 * DNS for roughly 75 minutes. Every other plugin on the bridge recovered by
 * itself — the Tado platform was making successful API calls again 35 minutes
 * after its last name-resolution error. The Roborock platform did not. It
 * logged "B01 status has failed 1070 times in a row … the Roborock cloud
 * connection is not available" continuously for 1 hour and 44 minutes AFTER
 * the network was healthy again, across three scheduled hourly reconnect
 * attempts, and only came back when a plugin update restarted the child
 * bridge. It then connected instantly on the very same session from config,
 * which is what rules out the credentials and points at the reconnect itself.
 *
 * THE MECHANISM, MEASURED AGAINST mqtt.js 5.15 RATHER THAN REASONED ABOUT.
 * `reconnectClient` called `client.end()` with no arguments, so `force` was
 * false. mqtt.js's `end(force)` only tears down immediately when `force` is
 * set; otherwise it waits for an `outgoingEmpty` event before it will finish.
 * A link that has just died still holds unacknowledged outgoing messages, and
 * that event never comes — so `end()` never completes, `disconnected` is never
 * set, and `disconnecting` stays true forever. `reconnect()` refuses to act in
 * exactly that state (it stores a deferred callback that only `end()`'s own
 * completion path would ever invoke), so nothing reconnects. Worse, the latch
 * is self-sustaining: every later `end()` short-circuits on the still-true
 * `disconnecting` flag, so each hourly retry is a silent no-op. No error
 * event, no close event, no connect event — which is why the three hours of
 * log carried zero MQTT diagnostics while the robots sat unreachable.
 *
 * Passing `force` is the whole fix. There is never a reason to wait for a
 * queue to drain over a connection we have already concluded is dead — that
 * is the only situation in which this function is called.
 */

"use strict";

jest.mock("mqtt");

const mqtt = require("mqtt");
const realMqtt = jest.requireActual("mqtt");
const {
  roborock_mqtt_connector,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const USERDATA = {
  rriot: {
    k: "test-key",
    u: "test-user",
    s: "test-secret",
    r: { m: "mqtt://broker.invalid:1883" },
  },
};

function makeAdapter() {
  return {
    log: {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    catchError: jest.fn(),
  };
}

/**
 * A stand-in that reproduces the one part of mqtt.js's contract this bug
 * turns on: `end()` only completes when it is forced, or when there is
 * nothing left in the outgoing queue.
 */
function makeClient({ outgoingMessages = 1 } = {}) {
  const client = {
    outgoing: {},
    tornDown: false,
    stillWaitingToDrain: false,
    reconnectCalls: 0,
    disconnecting: false,

    end(force) {
      if (this.disconnecting) {
        // mqtt.js short-circuits here and never reaches its teardown path.
        return this;
      }
      this.disconnecting = true;
      if (!force && Object.keys(this.outgoing).length > 0) {
        this.stillWaitingToDrain = true;
        return this;
      }
      this.tornDown = true;
      this.disconnecting = false;
      return this;
    },

    // mqtt.js offers both shapes; the promise-returning one is the only way
    // to await the teardown rather than a tick of luck.
    async endAsync(force) {
      this.end(force);
      return undefined;
    },

    reconnect() {
      this.reconnectCalls += 1;
      return this;
    },

    on() {
      return this;
    },
    subscribe() {
      return this;
    },
  };

  for (let i = 0; i < outgoingMessages; i += 1) {
    client.outgoing[i] = { volatile: false, cb: () => {} };
  }

  return client;
}

describe("a reconnect does not wait for a dead link", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("tears the client down even when the outgoing queue can never drain", async () => {
    const client = makeClient({ outgoingMessages: 3 });
    mqtt.connect.mockReturnValue(client);

    const connector = new roborock_mqtt_connector(makeAdapter());
    await connector.initUser(USERDATA);

    await connector.reconnectClient(true);

    expect(client.stillWaitingToDrain).toBe(false);
    expect(client.tornDown).toBe(true);
    expect(client.reconnectCalls).toBe(1);
  });

  test("a second attempt still does real work instead of silently doing nothing", async () => {
    const client = makeClient({ outgoingMessages: 2 });
    mqtt.connect.mockReturnValue(client);

    const connector = new roborock_mqtt_connector(makeAdapter());
    await connector.initUser(USERDATA);

    await connector.reconnectClient(true);
    client.tornDown = false;
    await connector.reconnectClient(true);

    // The field symptom was an hourly retry that had become a no-op: the
    // connection stayed down for as long as the process lived.
    expect(client.tornDown).toBe(true);
    expect(client.reconnectCalls).toBe(2);
  });

  test("mqtt.js still refuses to finish an unforced end while messages are queued", () => {
    // The fix rests on an upstream detail, so it is pinned here rather than
    // trusted: if mqtt.js ever drains without being forced, this suite should
    // be the thing that says so.
    const client = realMqtt.connect("mqtt://broker.invalid:1883", {
      manualConnect: true,
    });

    try {
      client.outgoing[1] = { volatile: false, cb: () => {} };

      client.end();

      expect(client.disconnecting).toBe(true);
      expect(client.disconnected).not.toBe(true);
    } finally {
      client.outgoing = {};
      client.removeAllListeners();
    }
  });
});
