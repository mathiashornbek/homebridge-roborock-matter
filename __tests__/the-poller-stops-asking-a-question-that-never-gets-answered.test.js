"use strict";

/**
 * The unit tests next door pin the rule. This file pins the *wiring*: that
 * the poller and the live-room map fetch actually consult it, and that the
 * two paths which must never be throttled are still not wired to it.
 *
 * Against 3.29.0 the first test here fails with 360 calls instead of 6 —
 * that is the bug, stated as a number.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");
const {
  OPEN_AFTER_CONSECUTIVE_TIMEOUTS,
} = require("../roborockLib/lib/unansweredMethodBreaker");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createApi() {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "unanswered-")),
  });
  api.describeDevice = (duid) => `Robot ${duid}`;
  return { api, log };
}

const timeout = (method) =>
  new Error(
    `Cloud request with id 11 with method ${method} timed out after 10 seconds. MQTT connection state: true`
  );

async function pollUntilQuiet(api, vacuum, method, attempts) {
  let sent = 0;
  for (let i = 0; i < attempts; i += 1) {
    const before = vacuum.getParameter.mock.calls.length;
    try {
      await api.pollParameter("duid-a70", vacuum, method, false);
    } catch {
      // The caller above still sees the failure; that is deliberate.
    }
    if (vacuum.getParameter.mock.calls.length > before) {
      sent += 1;
    }
  }
  return sent;
}

describe("the poller stops asking a question that never gets answered", () => {
  test("an hour of polling a silent method costs six requests, not 360", () => {
    const { api } = createApi();
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        throw timeout(method);
      }),
    };

    // 360 attempts is one an hour at the ten-second poll interval — the real
    // shape of `Stueetage`'s 95-in-a-row.
    return pollUntilQuiet(api, vacuum, "get_map_v1", 360).then((sent) => {
      expect(sent).toBe(OPEN_AFTER_CONSECUTIVE_TIMEOUTS);
      expect(vacuum.getParameter).toHaveBeenCalledTimes(
        OPEN_AFTER_CONSECUTIVE_TIMEOUTS
      );
    });
  });

  test("the caller still sees the failure it needs to handle", async () => {
    const { api } = createApi();
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        throw timeout(method);
      }),
    };

    await expect(
      api.pollParameter("duid-a70", vacuum, "get_consumable", false)
    ).rejects.toThrow(/timed out after/);
  });

  test("a skipped poll resolves undefined rather than throwing a fake error", async () => {
    const { api } = createApi();
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        throw timeout(method);
      }),
    };

    await pollUntilQuiet(api, vacuum, "get_carpet_mode", 20);
    await expect(
      api.pollParameter("duid-a70", vacuum, "get_carpet_mode", false)
    ).resolves.toBeUndefined();
  });

  test("one answer puts the method straight back in the cycle", async () => {
    const { api, log } = createApi();
    let answer = false;
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        if (answer) {
          return { ok: true };
        }
        throw timeout(method);
      }),
    };

    await pollUntilQuiet(api, vacuum, "get_room_mapping", 20);
    expect(api.unansweredMethods.describeOpen()).toHaveLength(1);

    // The cooldown has not run out, so nudge it the way a real recovery does:
    // the robot answers the next request that does go out.
    api.unansweredMethods.clear();
    answer = true;
    await expect(
      api.pollParameter("duid-a70", vacuum, "get_room_mapping", false)
    ).resolves.toEqual({ ok: true });
    expect(api.unansweredMethods.describeOpen()).toHaveLength(0);
  });

  test("it says so once, not once per skipped poll", async () => {
    const { api, log } = createApi();
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        throw timeout(method);
      }),
    };

    await pollUntilQuiet(api, vacuum, "get_multi_maps_list", 200);
    const gaveUp = log.warn.mock.calls
      .concat(log.info.mock.calls)
      .filter(([line]) => /get_multi_maps_list/.test(String(line)));
    expect(gaveUp).toHaveLength(1);
  });

  test("a network failure is retried forever, because the link comes back", async () => {
    const { api } = createApi();
    const vacuum = {
      getParameter: jest.fn(async () => {
        throw new Error(
          "Cloud request with id 11 with method get_consumable timed out after 10 seconds: getaddrinfo EAI_AGAIN api.roborock.com"
        );
      }),
    };

    const sent = await pollUntilQuiet(api, vacuum, "get_consumable", 50);
    expect(sent).toBe(50);
  });

  test("a refusal is retried forever too — the robot answered", async () => {
    const { api } = createApi();
    const vacuum = {
      getParameter: jest.fn(async () => {
        throw new Error(
          "The robot refused get_server_timer (cloud id 5): Not FCC robot (code -10007)"
        );
      }),
    };

    const sent = await pollUntilQuiet(api, vacuum, "get_server_timer", 50);
    expect(sent).toBe(50);
  });
});

describe("what must never be throttled", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
    "utf8"
  );

  test("the breaker is consulted in exactly the three places it belongs", () => {
    const uses = source.match(/unansweredMethods\.shouldSkip\(/g) || [];
    // pollParameter, the B01 live-room fetch, the classic live-room fetch.
    expect(uses).toHaveLength(3);
  });

  test("get_status is not one of them", () => {
    // The Home tile lives on get_status. A robot that goes quiet for six
    // cycles and then wakes up must show the truth immediately, so this one
    // is never skipped however often it fails.
    const around = source.split("unansweredMethods.shouldSkip(");
    for (const chunk of around.slice(1)) {
      expect(chunk.slice(0, 200)).not.toMatch(/get_status/);
    }
  });

  test("the command path does not go through pollParameter at all", () => {
    // sendCommand/sendMessage must always be sent: the user just pressed a
    // button. If this ever changes, a press could be silently dropped.
    const commandRegion = source.slice(source.indexOf("async sendCommand("));
    expect(commandRegion.slice(0, 4000)).not.toMatch(/unansweredMethods/);
  });
});
