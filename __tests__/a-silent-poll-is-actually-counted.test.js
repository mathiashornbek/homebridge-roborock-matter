"use strict";

/**
 * THE GIVE-UP REGISTER HAD NEVER COUNTED A SINGLE POLL FAILURE.
 *
 * 3.30.0 built it. 3.31.0 routed three more polls into it. Both releases
 * described it, in the changelog and in the log line users read, as the thing
 * that stops a robot being asked a question it never answers — naming the
 * seven methods from #22/#24 that motivated it.
 *
 * It could not have counted any of them. `pollParameter` reported the outcome
 * from its own try/catch:
 *
 *     try {
 *       const answer = await vacuum.getParameter(duid, method);
 *       this.noteMethodAnswered(duid, method);   // ran on EVERY poll
 *       return answer;
 *     } catch (error) {
 *       this.noteMethodUnanswered(duid, method, error);   // unreachable
 *       throw error;
 *     }
 *
 * `vacuum.getParameter` swallows its own errors — its catch calls
 * `catchError`, which only logs — and resolves `undefined`. So the catch never
 * ran, and `noteMethodAnswered` actively RESET the counter on every failed
 * poll. Measured before the fix: 20 consecutive timeouts produced 0 entries.
 * Worse, a robot that had finally been left alone was told "answers
 * get_room_mapping again" on the retry that timed out.
 *
 * The register is now fed by the message layer, which is the only place that
 * knows whether a reply arrived. `pollParameter` just says which requests it
 * is entitled to skip.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createApi() {
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "wire-")),
  });
  api.describeDevice = (duid) => `Robot ${duid}`;
  return { api, log };
}

/** Exactly what messageQueueHandler now builds. */
const timeout = (method, transportWasUp = true) =>
  Object.assign(
    new Error(
      `Cloud request with id 7 with method ${method} timed out after 10 seconds. MQTT connection state: ${transportWasUp}`
    ),
    { unansweredRequest: true, transportWasUp }
  );

/**
 * A robot whose polls never come back, modelled the way the real stack
 * behaves: the message layer reports the timeout, and getParameter RESOLVES
 * UNDEFINED rather than throwing.
 */
function silent(api, { transportWasUp = true } = {}) {
  return {
    getParameter: jest.fn(async (duid, method) => {
      api.noteRequestUnanswered(duid, method, timeout(method, transportWasUp));
      return undefined;
    }),
  };
}

describe("a poll that never comes back is actually counted", () => {
  test("six silent polls close the method — this is what never worked", async () => {
    const { api } = createApi();
    const vacuum = silent(api);

    for (let i = 0; i < 6; i += 1) {
      await api.pollParameter("duid-a144", vacuum, "get_room_mapping", false);
    }

    expect(
      api.unansweredMethods.shouldSkip("duid-a144", "get_room_mapping")
    ).toBe(true);
  });

  test("and the request actually stops going out", async () => {
    const { api } = createApi();
    const vacuum = silent(api);

    for (let i = 0; i < 200; i += 1) {
      await api.pollParameter("duid-a144", vacuum, "get_room_mapping", false);
    }

    // 200 attempts, 6 requests. Before this release: 200.
    expect(vacuum.getParameter).toHaveBeenCalledTimes(6);
  });

  test("all seven methods from #22/#24 are covered, not just the map ones", async () => {
    const { api } = createApi();
    const vacuum = silent(api);
    const methods = [
      "get_room_mapping",
      "get_multi_maps_list",
      "get_consumable",
      "get_carpet_mode",
      "get_carpet_clean_mode",
      "get_water_box_custom_mode",
      "get_timer",
    ];

    for (const method of methods) {
      for (let i = 0; i < 6; i += 1) {
        await api.pollParameter("duid-a144", vacuum, method, false);
      }
      expect(api.unansweredMethods.shouldSkip("duid-a144", method)).toBe(true);
    }
  });

  test("a failed poll is never reported as an answer", async () => {
    const { api, log } = createApi();
    const vacuum = silent(api);

    for (let i = 0; i < 6; i += 1) {
      await api.pollParameter("duid-a144", vacuum, "get_consumable", false);
    }
    // The cooldown expires and the one probe times out again. The old code
    // said "answers get_consumable again" here, and reset the counter.
    api.unansweredMethods.entries.get("duid-a144:get_consumable").retryAt = 1;
    await api.pollParameter("duid-a144", vacuum, "get_consumable", false);

    const claimed = log.info.mock.calls.filter(([line]) =>
      /answers get_consumable again/.test(String(line))
    );
    expect(claimed).toHaveLength(0);
    expect(
      api.unansweredMethods.shouldSkip("duid-a144", "get_consumable")
    ).toBe(true);
  });

  test("a real answer still resets it, reported from the message layer", async () => {
    const { api } = createApi();
    let answering = false;
    const vacuum = {
      getParameter: jest.fn(async (duid, method) => {
        if (answering) {
          api.noteRequestAnswered(duid, method);
          return { rooms: [] };
        }
        api.noteRequestUnanswered(duid, method, timeout(method));
        return undefined;
      }),
    };

    for (let i = 0; i < 5; i += 1) {
      await api.pollParameter("duid-a144", vacuum, "get_room_mapping", false);
    }
    answering = true;
    await api.pollParameter("duid-a144", vacuum, "get_room_mapping", false);

    expect(
      api.unansweredMethods.shouldSkip("duid-a144", "get_room_mapping")
    ).toBe(false);
  });
});

describe("what the message layer must never be able to close", () => {
  test("get_status survives any number of timeouts", () => {
    const { api } = createApi();
    for (let i = 0; i < 100; i += 1) {
      api.noteRequestUnanswered(
        "duid-a144",
        "get_status",
        timeout("get_status")
      );
    }
    expect(api.unansweredMethods.shouldSkip("duid-a144", "get_status")).toBe(
      false
    );
    expect(api.unansweredMethods.describeOpen()).toHaveLength(0);
  });

  test("a command survives any number of timeouts", () => {
    const { api } = createApi();
    for (const method of [
      "app_start",
      "app_stop",
      "app_charge",
      "app_segment_clean",
    ]) {
      for (let i = 0; i < 50; i += 1) {
        api.noteRequestUnanswered("duid-a144", method, timeout(method));
      }
      expect(api.unansweredMethods.shouldSkip("duid-a144", method)).toBe(false);
    }
  });

  test("only a caller that can skip gets to claim one", () => {
    const { api } = createApi();
    // Never claimed: counting is a no-op however many times it fails.
    for (let i = 0; i < 50; i += 1) {
      api.noteRequestUnanswered("duid-a144", "get_prop", timeout("get_prop"));
    }
    expect(api.unansweredMethods.shouldSkip("duid-a144", "get_prop")).toBe(
      false
    );

    api.unansweredMethods.govern("duid-a144", "get_prop");
    for (let i = 0; i < 6; i += 1) {
      api.noteRequestUnanswered("duid-a144", "get_prop", timeout("get_prop"));
    }
    expect(api.unansweredMethods.shouldSkip("duid-a144", "get_prop")).toBe(
      true
    );
  });
});

describe("the network blip, decided by data rather than prose", () => {
  test("a link that was down at rejection time does not count", async () => {
    const { api } = createApi();
    const vacuum = silent(api, { transportWasUp: false });

    for (let i = 0; i < 40; i += 1) {
      await api.pollParameter("duid-a144", vacuum, "get_room_mapping", false);
    }
    expect(
      api.unansweredMethods.shouldSkip("duid-a144", "get_room_mapping")
    ).toBe(false);
    expect(vacuum.getParameter).toHaveBeenCalledTimes(40);
  });

  test("the structured flag beats the prose, whatever the prose says", () => {
    const {
      isUnansweredRequest,
    } = require("../roborockLib/lib/unansweredMethodBreaker");

    // Prose says the link was up; the data says it was down. Data wins.
    const lying = Object.assign(
      new Error("… timed out after 10 seconds. MQTT connection state: true"),
      { unansweredRequest: true, transportWasUp: false }
    );
    expect(isUnansweredRequest(lying)).toBe(false);

    const honest = Object.assign(
      new Error("… timed out after 10 seconds. MQTT connection state: false"),
      { unansweredRequest: true, transportWasUp: true }
    );
    expect(isUnansweredRequest(honest)).toBe(true);
  });
});

describe("the message layer really does report both outcomes", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "lib", "messageQueueHandler.js"),
    "utf8"
  );

  test("a timeout tells the register", () => {
    const arms = source.match(/noteRequestUnanswered\?\.\(/g) || [];
    expect(arms.length).toBe(2); // cloud and local
  });

  test("a reply tells the register", () => {
    expect(source).toMatch(/noteRequestAnswered\?\.\(duid, method\)/);
  });

  test("the timeout carries the link state read at rejection time", () => {
    // Not the copy captured before the send — that is what made two
    // consecutive transport exclusions dead code.
    expect(source).toMatch(/unansweredRequestError\(/);
    expect(source).toMatch(/isConnected\?\.\(\)/);
    expect(source).toMatch(/isConnected\?\.\(duid\)/);
  });

  test("pollParameter no longer pretends to observe the outcome", () => {
    const api = fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "roborockAPI.js"),
      "utf8"
    );
    const at = api.indexOf("async pollParameter(");
    // Stop at the next method definition, not at the first "\n  }" — the
    // dialect guard inside has one of those.
    const body = api.slice(at, api.indexOf("\n  /**", at));
    expect(body).toMatch(/unansweredMethods\.govern\(duid, method\)/);
    // The CALL, not the word — the comment above it explains the bug by name.
    expect(body).not.toMatch(/this\.noteMethodAnswered\(/);
    expect(body).not.toMatch(/this\.noteMethodUnanswered\(/);
  });
});
