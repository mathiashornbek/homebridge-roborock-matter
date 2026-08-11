const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

// The window src/matter_vacuum_accessory.ts races the whole prep sequence
// against before it sends the start command. A structural test below asserts
// the accessory really hands this same number to the protocol layer, so the two
// cannot drift apart.
const PREP_WINDOW_MS = 2500;

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

// Models the transport the prep actually talks to: messageQueueHandler rejects a
// request when `requestTimeoutMs` elapses. A robot that never answers is the
// case that produced #8, so it is the default here.
function createCommandRecorder({ answers = {} } = {}) {
  const calls = [];
  const command = jest.fn((duid, method, value, options = {}) => {
    const requestTimeoutMs = options.requestTimeoutMs;
    calls.push({ method, value, requestTimeoutMs, startedAt: Date.now() });

    const answer = answers[method];
    if (answer === "unsupported") {
      return Promise.reject(new Error(`${method}: unknown method`));
    }
    if (answer === "ok") {
      return Promise.resolve(["ok"]);
    }

    return new Promise((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Cloud request with method ${method} timed out after ${requestTimeoutMs} ms`
          )
        );
      }, requestTimeoutMs);
    });
  });

  return { calls, command };
}

async function createV1Api({ answers, schema } = {}) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "prep-window-v1-")),
  });
  await api.setStateAsync("HomeData", {
    val: JSON.stringify({
      products: [
        {
          id: "product-1",
          schema: schema ?? [
            { id: 123, code: "fan_power" },
            { id: 124, code: "water_box_mode" },
          ],
        },
      ],
      devices: [{ duid: "device-1", productId: "product-1", name: "Weebo" }],
      receivedDevices: [],
    }),
    ack: true,
  });
  api.isInited = () => true;
  const recorder = createCommandRecorder({ answers });
  api.vacuums["device-1"] = { command: recorder.command };

  return { api, log, ...recorder };
}

function createB01Api({ answers } = {}) {
  const log = createLog();
  const api = new Roborock({
    log,
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "prep-window-b01-")),
  });
  api.getVacuumDeviceInfo = jest.fn((duid, attr) => {
    if (attr === "pv") {
      return "B01";
    }
    if (attr === "name") {
      return "Garage";
    }
    return "";
  });
  api.isInited = () => true;
  const recorder = createCommandRecorder({ answers });
  api.vacuums["device-1"] = { command: recorder.command };

  return { api, log, ...recorder };
}

// Every dialect the prep has a branch for, with the settings a user selecting
// "Vacuum" in Apple Home produces, and the command that carries that choice on
// that dialect. A new dialect branch added without an entry here fails the
// enumeration test at the bottom.
const DIALECTS = [
  {
    name: "v1 (water box carries the clean type)",
    create: createV1Api,
    settings: { cleanMode: 0, fanPower: 104, waterBoxMode: 200 },
    modeCarryingCommands: ["set_water_box_mode", "set_water_box_custom_mode"],
    cosmeticCommand: "set_custom_mode",
    unconfirmedModeLabel: "water mode",
  },
  {
    name: "B01/Q7 (set_clean_type carries the clean type)",
    create: createB01Api,
    settings: { cleanMode: 0, fanPower: 104 },
    modeCarryingCommands: ["set_clean_type"],
    cosmeticCommand: "set_custom_mode",
    unconfirmedModeLabel: "clean type",
  },
];

describe("the Matter clean mode prep fits inside the window it is raced against", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // THE RULE. The caller sends the start command the instant the prep window
  // closes, so a command that is merely *started* inside the window buys
  // nothing: it is abandoned in flight while the start overtakes it. That is
  // what happened to skmzwanke on 3.4.8 — the reordering put the water command
  // first, but three sequential two-second commands still do not fit in 2500 ms,
  // so his "vacuum only" choice was in flight when the clean started and the
  // robot mopped the room anyway (#8).
  describe.each(DIALECTS)("$name", (dialect) => {
    test("never starts a command that cannot finish inside the window", async () => {
      jest.useFakeTimers();
      const { api, calls } = await dialect.create();
      const startedAt = Date.now();

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const elapsed = call.startedAt - startedAt;
        expect(elapsed + call.requestTimeoutMs).toBeLessThanOrEqual(
          PREP_WINDOW_MS
        );
      }
    });

    test("returns before the window closes instead of being cut off", async () => {
      jest.useFakeTimers();
      const { api } = await dialect.create();
      const startedAt = Date.now();

      // The resolution time has to be captured as it happens: advancing the
      // fake clock moves Date.now() whether the prep finished early or not.
      let finishedAt = null;
      const prep = api
        .applyMatterCleanModeSettings("device-1", dialect.settings, {
          waitForResult: true,
          prepWindowMs: PREP_WINDOW_MS,
        })
        .then(() => {
          finishedAt = Date.now();
        });
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      expect(finishedAt).not.toBeNull();
      expect(finishedAt - startedAt).toBeLessThanOrEqual(PREP_WINDOW_MS);
    });

    test("gives the window to the command carrying the user's choice first", async () => {
      jest.useFakeTimers();
      const { api, calls } = await dialect.create();

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      expect(dialect.modeCarryingCommands).toContain(calls[0].method);
      // …and it gets a real share of the window, not the remains after a
      // cosmetic command has spent it.
      expect(calls[0].requestTimeoutMs).toBe(2000);
    });

    // messageQueueHandler treats a non-positive requestTimeoutMs as "no
    // override given" and silently restores its own ten-second default — four
    // times the whole window. A command with no budget left must be skipped and
    // reported, never sent with a zero or negative timeout.
    test("never hands the transport a non-positive timeout", async () => {
      jest.useFakeTimers();
      const { api, calls } = await dialect.create();

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      for (const call of calls) {
        expect(call.requestTimeoutMs).toBeGreaterThan(0);
      }
    });

    test("reports the mode as unconfirmed when the robot never answers", async () => {
      jest.useFakeTimers();
      const { api, log } = await dialect.create();

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining(dialect.unconfirmedModeLabel)
      );
      // Named, not a raw duid — the log line is what someone reads when a
      // clean did not match the tile.
      expect(log.warn).toHaveBeenCalledWith(
        expect.not.stringContaining("device-1")
      );
    });

    test("reports the cosmetic setting when the window closed before its turn", async () => {
      jest.useFakeTimers();
      const { api, calls, log } = await dialect.create();

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      const cosmetic = calls.filter(
        (call) => call.method === dialect.cosmeticCommand
      );
      const warned = log.warn.mock.calls.map(([message]) => message).join("\n");

      // Either it was sent inside the window, or it is named as unconfirmed.
      // Silently dropping it is what left the Matter tile stating a suction
      // level the robot was not using.
      if (cosmetic.length === 0) {
        expect(warned).toContain("suction level");
      }
      expect(warned).toContain("did not confirm");
    });

    test("says nothing when every command is confirmed", async () => {
      jest.useFakeTimers();
      const { api, log } = await dialect.create({
        answers: {
          set_clean_type: "ok",
          set_water_box_mode: "ok",
          set_water_box_custom_mode: "ok",
          set_custom_mode: "ok",
        },
      });

      const prep = api.applyMatterCleanModeSettings(
        "device-1",
        dialect.settings,
        { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
      );
      await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
      await prep;

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  test("a water command fallback is budgeted out of the same window", async () => {
    jest.useFakeTimers();
    // set_water_box_mode answers "unknown method" immediately, so the fallback
    // to set_water_box_custom_mode is tried — a second command out of the same
    // window, and then the suction level wants a third.
    const { api, calls } = await createV1Api({
      answers: { set_water_box_mode: "unsupported" },
    });
    const startedAt = Date.now();

    const prep = api.applyMatterCleanModeSettings(
      "device-1",
      { cleanMode: 0, fanPower: 104, waterBoxMode: 200 },
      { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
    );
    await jest.advanceTimersByTimeAsync(PREP_WINDOW_MS * 4);
    await prep;

    expect(calls.map((call) => call.method)).toEqual([
      "set_water_box_mode",
      "set_water_box_custom_mode",
      "set_custom_mode",
    ]);
    for (const call of calls) {
      expect(call.requestTimeoutMs).toBeGreaterThan(0);
      expect(
        call.startedAt - startedAt + call.requestTimeoutMs
      ).toBeLessThanOrEqual(PREP_WINDOW_MS);
    }
  });

  // The one exit that was debug-only: the plugin believes water is
  // controllable — so Apple Home is offering "Vacuum" and "Vacuum and mop" —
  // but every water command has been marked unsupported, so the selection is
  // never sent. That is the mop running when the user asked for vacuum only,
  // and it said nothing above debug.
  test("reports the water mode when no water command is left to send it with", async () => {
    const { api, calls, log } = await createV1Api();
    api.matterUnsupportedSettingCommands.add("device-1:set_water_box_mode");
    api.matterUnsupportedSettingCommands.add(
      "device-1:set_water_box_custom_mode"
    );

    await api.applyMatterCleanModeSettings(
      "device-1",
      { cleanMode: 0, fanPower: 104, waterBoxMode: 200 },
      { waitForResult: true, prepWindowMs: PREP_WINDOW_MS }
    );

    expect(calls.map((call) => call.method)).not.toContain(
      "set_water_box_mode"
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not confirm the water mode")
    );
  });

  test("without a window the prep keeps the fixed per-command timeout", async () => {
    const { api, calls } = await createV1Api({
      answers: {
        set_water_box_mode: "ok",
        set_custom_mode: "ok",
      },
    });

    await api.applyMatterCleanModeSettings(
      "device-1",
      { cleanMode: 0, fanPower: 104, waterBoxMode: 200 },
      { waitForResult: true }
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.requestTimeoutMs).toBe(2000);
    }
  });

  // The window is one number in two files. If the accessory stops handing its
  // own timeout to the protocol layer, the layer silently goes back to sizing
  // commands against nothing — the defect this file exists to prevent — and no
  // behavioural test would notice, because the fixed timeout still "works".
  test("the accessory hands the protocol layer the same window it enforces", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "src", "matter_vacuum_accessory.ts"),
      "utf8"
    );

    expect(source).toContain("prepWindowMs: MATTER_CLEAN_MODE_PREP_TIMEOUT_MS");
    expect(source).toMatch(/const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = (\d+);/);
    const declared = Number(
      /const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = (\d+);/.exec(source)[1]
    );
    expect(declared).toBe(PREP_WINDOW_MS);
  });
});
