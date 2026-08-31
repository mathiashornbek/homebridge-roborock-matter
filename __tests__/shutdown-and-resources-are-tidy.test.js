const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const { localConnector } = require("../roborockLib/lib/localConnector");
const deviceFeatures = require("../roborockLib/lib/deviceFeatures");

// The resource-discipline half of the 31 August robustness review. Each block
// names the finding it closes; each one failed before 3.20.1.

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  return new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "tidy-")),
  });
}

describe("timers created by roborockLib obey the project's own policy", () => {
  // src/timers.ts: "A pending timer must never be why Homebridge cannot shut
  // down." src/ honoured it at every call site; this library never imported
  // the module and so every timer it made was ref'd, including each in-flight
  // request timeout of up to 30 seconds.
  test("setTimeout and setInterval both return an unref'd handle", () => {
    const api = createApi();

    const timeout = api.setTimeout(() => {}, 60000);
    const interval = api.setInterval(() => {}, 60000);

    expect(timeout.hasRef()).toBe(false);
    expect(interval.hasRef()).toBe(false);

    api.clearTimeout(timeout);
    api.clearInterval(interval);
  });

  // Homebridge's uncaughtException handler is process.kill(SIGTERM), and node
  // routes unhandled rejections through it. A rejecting async callback on a
  // poll loop would take the bridge down.
  test("a rejecting async callback cannot become an unhandled rejection", async () => {
    const api = createApi();
    const seen = [];
    process.on("unhandledRejection", (reason) => seen.push(reason));

    api.setTimeout(async () => {
      throw new Error("poll blew up");
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(seen).toEqual([]);
    expect(
      api.log.debug.mock.calls.some(([line]) =>
        String(line).includes("poll blew up")
      )
    ).toBe(true);
    process.removeAllListeners("unhandledRejection");
  });

  test("a synchronously throwing callback is contained too", () => {
    const api = createApi();

    expect(() => {
      api.setTimeout(() => {
        throw new Error("sync boom");
      }, 1);
    }).not.toThrow();
  });
});

describe("shutdown actually stops things", () => {
  test("stopService closes MQTT, destroys local sockets and drains pending requests", async () => {
    const api = createApi();
    const disconnect = jest.fn();
    const destroyAllClients = jest.fn();
    api.rr_mqtt_connector = { disconnect, isConnected: () => false };
    api.localConnector = {
      destroyAllClients,
      clearLocalDevicedTimeout: jest.fn(),
    };

    const rejected = [];
    api.pendingRequests.set(7, {
      timeout: api.setTimeout(() => {}, 60000),
      reject: (error) => rejected.push(error.message),
    });

    await api.stopService();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(destroyAllClients).toHaveBeenCalledTimes(1);
    expect(rejected).toEqual(["Homebridge is shutting down."]);
    expect(api.pendingRequests.size).toBe(0);
    expect(api.bInited).toBe(false);
  });

  test("destroyAllClients unhooks each socket before destroying it", () => {
    const adapter = { log: createLog(), clearTimeout: jest.fn() };
    const connector = new localConnector(adapter);
    const socket = {
      removeAllListeners: jest.fn(),
      destroy: jest.fn(),
    };
    connector.localClients["duid-1"] = socket;

    connector.destroyAllClients();

    // Removed from the map FIRST: the close handler decides whether to
    // reconnect by looking itself up there, so this makes it a no-op by
    // construction rather than by timing.
    expect(connector.localClients["duid-1"]).toBeUndefined();
    expect(socket.removeAllListeners).toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();
  });

  test("one socket that throws on destroy does not strand the others", () => {
    const adapter = { log: createLog(), clearTimeout: jest.fn() };
    const connector = new localConnector(adapter);
    const good = { removeAllListeners: jest.fn(), destroy: jest.fn() };
    connector.localClients["bad"] = {
      removeAllListeners: jest.fn(),
      destroy: () => {
        throw new Error("already gone");
      },
    };
    connector.localClients["good"] = good;

    connector.destroyAllClients();

    expect(good.destroy).toHaveBeenCalled();
    expect(Object.keys(connector.localClients)).toEqual([]);
  });
});

describe("a list that used to grow forever", () => {
  // processDockType runs on every status poll carrying dock_type - about once
  // a minute - and the poll site's comment says that is safe because the
  // function is idempotent. It was, for every member except this one, which
  // used .push: 6 entries became 2016 after 1005 polls.
  test("resetConsumables does not grow when the dock type is re-processed", () => {
    const features = new deviceFeatures.deviceFeatures(
      { log: createLog() },
      0,
      0,
      "duid-1"
    );
    features.isWashThenChargeCmdSupported();
    const afterFirst = [...features.resetConsumables];

    for (let i = 0; i < 50; i += 1) {
      features.isWashThenChargeCmdSupported();
    }

    expect(features.resetConsumables).toEqual(afterFirst);
    expect(
      features.resetConsumables.filter((c) => c === "strainer_work_times")
    ).toHaveLength(1);
  });
});

describe("a transient network failure does not destroy the saved session", () => {
  test.each([
    ["getaddrinfo EAI_AGAIN api.roborock.com", false],
    ["connect ECONNREFUSED 1.2.3.4:443", false],
    ["socket hang up", false],
    ["request timeout", false],
    ["Login failed: invalid password", true],
    ["unauthorized", true],
  ])("%s -> credential rejection: %s", (message, expected) => {
    const api = createApi();
    expect(api.isCredentialRejection(new Error(message))).toBe(expected);
  });

  test("an unrecognised failure keeps the session, because deleting a good one costs more", () => {
    const api = createApi();
    expect(api.isCredentialRejection(new Error("something odd"))).toBe(false);
  });

  test("Roborock's own refusal codes still clear it", () => {
    const api = createApi();
    for (const code of [2012, 2008, 2018, 2010]) {
      expect(api.isCredentialRejection({ code, message: "nope" })).toBe(true);
    }
  });
});

describe("only one local connect per robot at a time", () => {
  test("a second createClient while one is in flight is refused, and the claim is always released", async () => {
    const adapter = { log: createLog(), clearTimeout: jest.fn() };
    const connector = new localConnector(adapter);
    let release;
    connector.createClientUnguarded = jest.fn(
      () => new Promise((resolve) => (release = resolve))
    );

    const first = connector.createClient("duid-1", "10.0.0.5");
    await connector.createClient("duid-1", "10.0.0.5");
    expect(connector.createClientUnguarded).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(connector.pendingClientConnects.has("duid-1")).toBe(false);
  });

  test("a claim is released even when the connect throws", async () => {
    const adapter = { log: createLog(), clearTimeout: jest.fn() };
    const connector = new localConnector(adapter);
    connector.createClientUnguarded = jest
      .fn()
      .mockRejectedValue(new Error("no route to host"));

    await expect(connector.createClient("duid-1", "10.0.0.5")).rejects.toThrow(
      "no route to host"
    );

    // A leaked claim would be worse than the leak it prevents: that robot
    // could never reconnect again.
    expect(connector.pendingClientConnects.has("duid-1")).toBe(false);
  });
});
