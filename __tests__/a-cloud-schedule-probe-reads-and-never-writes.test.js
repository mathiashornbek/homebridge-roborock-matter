"use strict";

/**
 * Issue #22, third act.
 *
 * The reporter's Saros 10R (`roborock.vacuum.a144`) declines the device-side
 * `get_server_timer` with `-10007 "Not FCC robot"`, and the legacy `get_timer`
 * answers `[]`. Both answers are true — that robot holds no DEVICE-side
 * timers — and yet he has three daily schedules, which he showed us living
 * under the robot's own Schedule screen in the app. They are therefore held
 * server-side, on cloud routes the device protocol never touches.
 *
 * Before mapping a payload nobody here has seen, we measure it. These tests
 * pin the constraints that make shipping a measurement to ~3800 installations
 * defensible, because every one of them is a way this could go wrong:
 *
 * - it is silent unless the owner turned debug logging on;
 * - it only ever GETs, so it cannot alter a schedule;
 * - it runs once per robot per session, so no poll cadence can turn it into
 *   traffic;
 * - it cannot throw, because it rides along on a live poll;
 * - and it redacts, because a cloud envelope is not ours to print blindly.
 */

const { Roborock } = require("../roborockLib/roborockAPI");

function makeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(String(m)),
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

/**
 * The probe needs a log, a device describer, the diagnostics writer and an
 * axios-shaped client. Constructing the whole adapter would test the
 * constructor instead of the branch.
 */
function makeAdapter({ debug = true, client = null } = {}) {
  const log = makeLog();
  const api = Object.create(Roborock.prototype);
  api.log = log;
  api.config = { debug };
  api.describeDevice = (duid) =>
    duid === "duid-a144" ? "Rocky" : String(duid);
  api.api = client;

  // Capture diagnostics instead of reaching for adapter state.
  api.states = {};
  api.getRoborockDiagnostics = () => ({});
  api.setStateAsync = async (id, value) => {
    api.states[id] = value;
  };

  return api;
}

/**
 * An axios stand-in that records every call and, crucially, fails loudly if
 * anything other than `get` is used.
 */
function makeClient(responders = {}) {
  const calls = [];
  const forbid = (method) => (path) => {
    calls.push({ method, path });
    throw new Error(`the probe must never ${method.toUpperCase()} (${path})`);
  };

  return {
    calls,
    get: async (path) => {
      calls.push({ method: "get", path });
      const responder = responders[path];
      if (!responder) {
        throw new Error(`unexpected path ${path}`);
      }
      return typeof responder === "function" ? responder() : responder;
    },
    post: forbid("post"),
    put: forbid("put"),
    delete: forbid("delete"),
    patch: forbid("patch"),
  };
}

const SCHEDULES_PATH = "user/devices/duid-a144/jobs";
const SCENES_PATH = "user/scene/device/duid-a144";

/**
 * Shaped after what the reporter showed us: three daily entries at 09:00 whose
 * task is a named program rather than a room list.
 */
const CLOUD_SCHEDULES = [
  { id: 4711, enabled: true, cron: "0 9 * * 3", name: "Saugen+" },
  { id: 4712, enabled: true, cron: "0 9 * * 2,4", name: "Hinten" },
  { id: 4713, enabled: true, cron: "0 9 * * 1,5", name: "Vorne" },
];

const CLOUD_SCENES = [{ id: 991, name: "Saugen+", enabled: true }];

function okBoth() {
  return makeClient({
    [SCHEDULES_PATH]: { data: { result: CLOUD_SCHEDULES, success: true } },
    [SCENES_PATH]: { data: { result: CLOUD_SCENES, success: true } },
  });
}

describe("the cloud schedule probe only runs when it was asked for", () => {
  test("debug logging off means no cloud request at all", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ debug: false, client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result).toBeUndefined();
    expect(client.calls).toHaveLength(0);
    expect(adapter.log.lines.debug).toHaveLength(0);
  });

  test("an uninitialised cloud client is not an error, it is a no-op", async () => {
    const adapter = makeAdapter({ debug: true, client: null });

    await expect(
      adapter.probeCloudScheduleRoutes("duid-a144")
    ).resolves.toBeUndefined();
    expect(adapter.log.lines.error).toHaveLength(0);
  });

  test("a missing duid probes nothing", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    await expect(
      adapter.probeCloudScheduleRoutes(undefined)
    ).resolves.toBeUndefined();
    expect(client.calls).toHaveLength(0);
  });
});

describe("the probe reads both candidate routes and never writes", () => {
  test("it GETs the schedules route and the scenes route, and nothing else", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(client.calls).toEqual([
      { method: "get", path: SCHEDULES_PATH },
      { method: "get", path: SCENES_PATH },
    ]);
    expect(client.calls.every((call) => call.method === "get")).toBe(true);
  });

  test("the payload is unwrapped from the Roborock envelope and reported", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.schedules).toMatchObject({
      path: SCHEDULES_PATH,
      ok: true,
      response: CLOUD_SCHEDULES,
    });
    expect(result.scenes).toMatchObject({
      path: SCENES_PATH,
      ok: true,
      response: CLOUD_SCENES,
    });
  });

  test("an envelope without `result` is reported as it arrived", async () => {
    const client = makeClient({
      [SCHEDULES_PATH]: { data: { code: 200, msg: "ok" } },
      [SCENES_PATH]: { data: { result: [], success: true } },
    });
    const adapter = makeAdapter({ client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.schedules.response).toEqual({ code: 200, msg: "ok" });
    // An empty `result` is a real answer and must not be mistaken for absence.
    expect(result.scenes.response).toEqual([]);
    expect(result.scenes.ok).toBe(true);
  });

  test("the raw answer reaches the log, naming the robot and the route", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const probeLines = adapter.log.lines.debug.filter((line) =>
      line.includes("cloud schedule probe")
    );
    expect(probeLines).toHaveLength(2);
    expect(probeLines[0]).toContain("Rocky");
    expect(probeLines[0]).toContain(SCHEDULES_PATH);
    expect(probeLines[0]).toContain("Saugen+");
    expect(probeLines[1]).toContain(SCENES_PATH);
  });

  test("the measurement is filed in diagnostics for later comparison", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const stored = JSON.parse(adapter.states.RoborockDiagnostics.val);
    expect(stored["duid-a144"].lastCloudScheduleProbe.schedules.ok).toBe(true);
  });
});

describe("the probe measures once per robot per session", () => {
  test("a second call for the same robot issues no further requests", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");
    const second = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(second).toBeUndefined();
    expect(client.calls).toHaveLength(2);
  });

  test("a poll cadence cannot turn the probe into traffic", async () => {
    const client = okBoth();
    const adapter = makeAdapter({ client });

    for (let poll = 0; poll < 20; poll += 1) {
      await adapter.probeCloudScheduleRoutes("duid-a144");
    }

    expect(client.calls).toHaveLength(2);
  });

  test("every robot on the account is still measured once", async () => {
    const client = makeClient({
      [SCHEDULES_PATH]: { data: { result: CLOUD_SCHEDULES } },
      [SCENES_PATH]: { data: { result: CLOUD_SCENES } },
      "user/devices/duid-two/jobs": { data: { result: [] } },
      "user/scene/device/duid-two": { data: { result: [] } },
    });
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");
    await adapter.probeCloudScheduleRoutes("duid-two");

    expect(client.calls.map((call) => call.path)).toEqual([
      SCHEDULES_PATH,
      SCENES_PATH,
      "user/devices/duid-two/jobs",
      "user/scene/device/duid-two",
    ]);
  });
});

describe("the probe cannot break the poll it rides on", () => {
  test("a failing route is recorded, and the other route is still read", async () => {
    const failure = Object.assign(
      new Error("Request failed with status code 404"),
      {
        response: { status: 404 },
      }
    );
    const client = makeClient({
      [SCHEDULES_PATH]: () => {
        throw failure;
      },
      [SCENES_PATH]: { data: { result: CLOUD_SCENES } },
    });
    const adapter = makeAdapter({ client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.schedules).toMatchObject({ ok: false, status: 404 });
    expect(result.scenes.ok).toBe(true);
    expect(
      adapter.log.lines.debug.some((line) => line.includes("HTTP 404"))
    ).toBe(true);
  });

  test("both routes failing still resolves, and never logs an error", async () => {
    const client = makeClient({
      [SCHEDULES_PATH]: () => {
        throw new Error("socket hang up");
      },
      [SCENES_PATH]: () => {
        throw new Error("socket hang up");
      },
    });
    const adapter = makeAdapter({ client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.schedules.ok).toBe(false);
    expect(result.scenes.ok).toBe(false);
    expect(result.schedules.status).toBeNull();
    // A robot that declines a method is not a plugin fault, and neither is a
    // probe that could not reach a route.
    expect(adapter.log.lines.error).toHaveLength(0);
    expect(adapter.log.lines.warn).toHaveLength(0);
  });

  test("a rejection that is not an Error is still described", async () => {
    const client = makeClient({
      [SCHEDULES_PATH]: () => {
        throw "gateway said no";
      },
      [SCENES_PATH]: { data: { result: [] } },
    });
    const adapter = makeAdapter({ client });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.schedules.error).toBe("gateway said no");
  });
});

describe("the probe reports the schedules it found, not just the bytes", () => {
  /**
   * The reporter's real answer, structurally faithful: the cron lives inside
   * a JSON string nested two levels deep, behind a room list long enough to
   * pass the diagnostic's own 500-character string cap.
   */
  const ROOMS = "Schlafzimmer Esszimmer Küche Wohnzimmer Büro Flur ".repeat(20);
  const TIMER_SCENE = {
    id: 14303871,
    name: "Saugen+",
    enabled: true,
    type: "WORKFLOW",
    param: JSON.stringify({
      triggers: [
        {
          id: 6841731,
          name: "TIMER",
          type: "TIMER",
          entityId: "",
          param: JSON.stringify({
            cron: "0 9 * * 3",
            type: "NORMAL",
            enabled: true,
            repeated: true,
            timeZoneId: "Europe/Berlin",
          }),
        },
      ],
      action: {
        type: "S",
        items: [
          {
            id: 1,
            type: "CMD",
            name: ROOMS,
            entityId: "duid-a144",
            param: JSON.stringify({
              id: 1,
              method: "do_scenes_segments",
              params: { data: [{ tid: "1786680804759", segs: [{ sid: 2 }] }] },
            }),
          },
        ],
      },
    }),
  };

  function withTimerScene() {
    return makeClient({
      [SCHEDULES_PATH]: { data: { result: [] } },
      [SCENES_PATH]: { data: { result: [TIMER_SCENE] } },
    });
  }

  test("the decoded schedule reaches the log in plain words", async () => {
    const adapter = makeAdapter({ client: withTimerScene() });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const logged = adapter.log.lines.debug.join("\n");
    expect(logged).toContain("carries 1 timer-driven scene(s)");
    expect(logged).toContain('"Saugen+" (scene 14303871)');
    expect(logged).toContain("09:00 on Wed");
    expect(logged).toContain("Europe/Berlin");
    expect(logged).toContain("do_scenes_segments");
  });

  test("the task the raw line truncated away is still reported", async () => {
    const adapter = makeAdapter({ client: withTimerScene() });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const rawLine = adapter.log.lines.debug.find(
      (line) => line.includes("answered:") && line.includes(SCENES_PATH)
    );
    // The diagnostic still compacts what it prints, and that is right for an
    // envelope nobody has mapped. This is what it cost on the real answer:
    // every scene was cut mid-task, so the log said when each schedule fires
    // and never what it does.
    expect(rawLine).toContain("...");
    expect(rawLine).not.toContain("do_scenes_segments");
    // The decoded reading is taken from the raw answer, so it is intact.
    expect(
      adapter.log.lines.debug.some((line) =>
        line.includes("do_scenes_segments over 1 segment(s)")
      )
    ).toBe(true);
  });

  test("a ninth schedule survives the array cap that drops it from the raw line", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...TIMER_SCENE,
      id: 100 + index,
      name: `Plan ${index}`,
    }));
    const adapter = makeAdapter({
      client: makeClient({
        [SCHEDULES_PATH]: { data: { result: [] } },
        [SCENES_PATH]: { data: { result: many } },
      }),
    });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const rawLine = adapter.log.lines.debug.find(
      (line) => line.includes("answered:") && line.includes(SCENES_PATH)
    );
    expect(rawLine).toContain("[truncated:1]");
    expect(rawLine).not.toContain("Plan 8");

    expect(
      adapter.log.lines.debug.some((line) =>
        line.includes("carries 9 timer-driven scene(s)")
      )
    ).toBe(true);
    expect(
      adapter.log.lines.debug.some((line) => line.includes('"Plan 8"'))
    ).toBe(true);
  });

  test("the decoded reading is filed in diagnostics alongside the answer", async () => {
    const adapter = makeAdapter({ client: withTimerScene() });

    const result = await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(result.scenes.schedules[0]).toBe("1 timer-driven scene(s)");
    expect(result.schedules.schedules).toBeUndefined();
  });

  test("a route with nothing to decode adds no lines at all", async () => {
    const adapter = makeAdapter({ client: okBoth() });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    expect(
      adapter.log.lines.debug.some((line) => line.includes("carries"))
    ).toBe(false);
    expect(adapter.log.lines.error).toHaveLength(0);
  });
});

describe("a cloud envelope is not ours to print blindly", () => {
  test("credential-shaped keys in the answer are redacted in the log", async () => {
    const client = makeClient({
      [SCHEDULES_PATH]: {
        data: {
          result: [
            {
              id: 4711,
              name: "Saugen+",
              localKey: "Ou8zmVYF6jHmkz96",
              token: "should-never-be-printed",
            },
          ],
        },
      },
      [SCENES_PATH]: { data: { result: [] } },
    });
    const adapter = makeAdapter({ client });

    await adapter.probeCloudScheduleRoutes("duid-a144");

    const logged = adapter.log.lines.debug.join("\n");
    expect(logged).toContain("Saugen+");
    expect(logged).not.toContain("Ou8zmVYF6jHmkz96");
    expect(logged).not.toContain("should-never-be-printed");
    expect(logged).toContain("[redacted]");
  });
});
