"use strict";

// Starting a clean from Apple Home applies the displayed clean mode first
// (3.4.16), and the reported RvcCleanMode is derived from what the robot says
// it is doing during a run so a clean started in the Roborock app shows up
// correctly. Those two features contradicted each other for the first minute
// or two of every Matter-initiated vacuum-only clean.
//
// Measured in #8 (skmzwanke, Saros 10, 12 Aug 2026) — 114 seconds of Apple
// Home showing a mode nobody asked for:
//
//   16:09:20  Applying Vacuum mode to Weebo before starting.
//   16:09:20  ...acknowledged by Roborock in 791 ms via cloud (cloud-only-mode)
//   16:09:22  Matter publish for Weebo: ... runMode=1, cleanMode=0
//   16:09:29  Matter publish for Weebo: ... runMode=1, cleanMode=2   <- wrong
//   16:11:23  Matter publish for Weebo: ... runMode=1, cleanMode=0   <- caught up
//
// The `2` is vacuum+mop, derived from the robot's water-box level, which was
// still reporting the old value seven seconds after the robot had ACKNOWLEDGED
// the command to turn water off. The clean itself was correct throughout; only
// the tile lied.
//
// What makes this a defect rather than a robot quirk: the prep path already
// documents that this exact reading lies in this exact window, and refuses to
// consult it when deciding whether to send —
//
//   "It is deliberately NOT skipped when the robot looks like it already
//    matches: the reading such a check would consult is exactly the one that
//    lies"
//
// — while the reporting path published the same reading as truth. One end of
// the plugin distrusted the value the other end broadcast.
//
// The rule these tests enumerate is therefore about knowledge, not about the
// water box:
//
//   a clean type this plugin sent AND had acknowledged for the run in progress
//   outranks a clean type merely DERIVED from the robot's status, until the
//   robot's own report agrees with it once.
//
// Same shape as 3.4.11: when the plugin does not know, it says nothing new
// rather than something untrue. The pin is released the moment the robot
// agrees, so a genuine mid-run change in the Roborock app is still followed,
// and it does not survive the run it belongs to.

const fs = require("fs");
const path = require("path");

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const SOURCE_PATH = path.join(
  __dirname,
  "..",
  "src",
  "matter_vacuum_accessory.ts"
);

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;
const CLEAN_MODE_VACUUM_TURBO = 5;
const CLEAN_MODE_VACUUM_MAX = 6;

const FAN_POWER_TURBO = 103;
const FAN_POWER_MAX = 104;
const FAN_POWER_OFF = 105;

const WATER_BOX_OFF = 200;
/** Any level other than "off" is what the derivation reads as vacuum+mop. */
const WATER_BOX_ON = 201;

/** Roborock states: 18 is Room Clean (RUNNING), 8 is Charging (docked). */
const ROBOROCK_STATE_ROOM_CLEAN = 18;
const ROBOROCK_STATE_CHARGING = 8;

/** Read the body of a method, brace-matched from its signature. */
function readMethodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) {
    return null;
  }
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBrace, i + 1);
      }
    }
  }
  return null;
}

function createHarness({
  fanPowerCleanModes = false,
  initialStatus = {},
  applyRejectsWith = null,
  applyResolvesWith = undefined,
} = {}) {
  const status = {
    state: ROBOROCK_STATE_CHARGING,
    battery: 100,
    fan_power: FAN_POWER_TURBO,
    water_box_mode: WATER_BOX_ON,
    ...initialStatus,
  };
  const applied = [];
  const started = [];
  const platform = {
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableFanPowerCleanModes: fanPowerCleanModes,
    },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({ updateAccessoryState: jest.fn() }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Weebo" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) => {
        const value = status[property];
        return value === null || value === undefined ? "" : value;
      },
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => null,
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
        canMaxPlusFanPower: false,
        canControlWater: true,
      }),
      getStatus: jest.fn().mockResolvedValue(undefined),
      applyMatterCleanModeSettings: jest.fn(async (duid, settings) => {
        applied.push(settings);
        if (applyRejectsWith) {
          throw applyRejectsWith;
        }
        // The real prep resolves with what the robot confirmed. Undefined is
        // what every other stand-in in this suite returns, and stands for the
        // fully-acknowledged apply this rule was originally written around.
        return applyResolvesWith;
      }),
      app_start: jest.fn(async () => {
        started.push("app_start");
      }),
      app_stop: jest.fn(async () => {}),
      app_pause: jest.fn(async () => {}),
      app_charge: jest.fn(async () => {}),
    },
  };

  const accessory = { UUID: "uuid-applied-type", context: { duid: "duid-1" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-1" },
    true
  );

  return {
    instance,
    platform,
    applied,
    started,
    handlers: accessory.handlers,
    cleanMode: () => instance.getCurrentCleanMode(),
    set: (patch) => Object.assign(status, patch),
    warnings: () => platform.log.warn.mock.calls.map((call) => String(call[0])),
  };
}

/** `dispatchRoborockMatterCommand` is fire-and-forget; let its chain settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

/** Start a clean from Apple Home and let the prep + start finish. */
async function startFromHome(harness) {
  await harness.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  await settle();
}

describe("the rule is stated once and over the source, not per case", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("the methods this rule reads are all still present", () => {
    // Guard against the rule passing vacuously if something is renamed.
    for (const signature of [
      "private getBaseCleanType(",
      "private acceptLiveCleanType(",
      "private trackAppliedCleanTypeRun(",
      "private getRoborockCleanModeSettings(",
      "private getCurrentCleanMode(",
      "private async applyCleanModeBeforeStarting(",
      "private async changeCleanMode(",
    ]) {
      expect(readMethodBody(source, signature)).not.toBeNull();
    }
  });

  test("the clean-type family reduction exists in exactly one place", () => {
    // A fan-power variant reducing to plain Vacuum is written in ONE helper.
    // Two hand-written copies drifting apart is the most repeated defect in
    // this codebase (3.4.3, 3.4.5, 3.4.11, 3.4.12), so this counts them.
    const reductions = source.match(
      /getFanPowerCleanMode\([^)]*\)\s*\?\s*CLEAN_MODE_VACUUM\s*:/g
    );
    expect(reductions).toHaveLength(1);
    expect(readMethodBody(source, "private getBaseCleanType(")).toContain(
      "getFanPowerCleanMode(cleanMode) ? CLEAN_MODE_VACUUM : cleanMode"
    );
  });

  test("the settings builder uses the shared reduction", () => {
    const body = readMethodBody(
      source,
      "private getRoborockCleanModeSettings("
    );
    expect(body).toContain("this.getBaseCleanType(cleanMode)");
  });

  test("every consumer of the derived clean type goes through the gate", () => {
    // The rule, not the one call site: a second consumer added tomorrow fails
    // this until it is gated too.
    const definition = "private getLiveCleanType()";
    const callSites = [];
    const pattern = /this\.getLiveCleanType\(\)/g;
    for (const match of source.matchAll(pattern)) {
      if (source.lastIndexOf(definition, match.index) === -1) {
        callSites.push(match.index);
        continue;
      }
      callSites.push(match.index);
    }
    expect(callSites.length).toBeGreaterThan(0);

    for (const index of callSites) {
      // The 400 characters after the read must contain the acceptance check;
      // the value must not be consumed unguarded.
      const window = source.slice(index, index + 400);
      expect(window).toContain("acceptLiveCleanType(");
    }
  });

  test("the pin is only taken when the apply actually succeeded", () => {
    const body = readMethodBody(
      source,
      "private async applyCleanModeBeforeStarting("
    );
    const catchIndex = body.indexOf("} catch (error) {");
    expect(catchIndex).toBeGreaterThan(-1);

    const trySection = body.slice(0, catchIndex);
    const catchSection = body.slice(catchIndex);

    // Set after the awaited apply, cleared when it threw.
    expect(trySection).toContain("this.appliedCleanTypePin = {");
    expect(catchSection).toContain("this.appliedCleanTypePin = null");
  });

  test("an explicit Apple Home selection drops the pin", () => {
    const body = readMethodBody(source, "private async changeCleanMode(");
    expect(body).toContain("this.appliedCleanTypePin = null");
  });

  test("the displayed mode is read once in the prep, not three times", () => {
    // The value recorded must be the value that was sent. Re-reading a getter
    // that mutates bookkeeping between the send and the record is how
    // the two drift apart.
    const body = readMethodBody(
      source,
      "private async applyCleanModeBeforeStarting("
    );
    expect(body.match(/this\.getCurrentCleanMode\(\)/g)).toHaveLength(1);
  });
});

describe("#8 replayed: the robot's water level lags a vacuum-only start", () => {
  test("Apple Home is not told vacuum+mop while the report catches up", async () => {
    const harness = createHarness();

    // Home already displays "Vacuum", so the user does not tap the picker.
    await startFromHome(harness);
    expect(harness.applied).toHaveLength(1);
    expect(harness.applied[0].waterBoxMode).toBe(WATER_BOX_OFF);
    expect(harness.started).toEqual(["app_start"]);

    // The robot is running, and still reporting the water level it had before
    // it acknowledged the command. This is the 16:09:29 publish.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("the robot catching up releases the pin", async () => {
    const harness = createHarness();
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);

    // 16:11:23 — the robot's own report agrees at last.
    harness.set({ water_box_mode: WATER_BOX_OFF });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);

    // From here the derivation is authoritative again: water turned back on
    // in the Roborock app mid-run must show up in Apple Home.
    harness.set({ water_box_mode: WATER_BOX_ON });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("the suction variant is still reported during the pin window", async () => {
    // The pin suppresses the clean TYPE override only. It must not also flatten
    // an announced suction level back to plain Vacuum.
    const harness = createHarness({
      fanPowerCleanModes: true,
      initialStatus: { fan_power: FAN_POWER_MAX },
    });
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);
  });

  test("it works the other way too: a mop start with water still off", async () => {
    const harness = createHarness({
      initialStatus: { water_box_mode: WATER_BOX_OFF },
    });

    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_VACUUM_AND_MOP,
    });
    await settle();
    await startFromHome(harness);

    // Running, and the robot has not yet reported the water it was told to
    // turn on. Reporting plain Vacuum here is the same lie in mirror image.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });
});

describe("the pin says something, once, instead of nothing", () => {
  test("the disagreement is reported on warn", async () => {
    const harness = createHarness();
    await startFromHome(harness);
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });

    harness.cleanMode();

    const reported = harness
      .warnings()
      .filter((line) => /still reports/.test(line));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("Weebo");
  });

  test("and not once per publish for the rest of the run", async () => {
    const harness = createHarness();
    await startFromHome(harness);
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });

    for (let i = 0; i < 5; i += 1) {
      harness.cleanMode();
    }

    expect(
      harness.warnings().filter((line) => /still reports/.test(line))
    ).toHaveLength(1);
  });
});

describe("the pin is bounded: it belongs to one run and one command", () => {
  test("it does not survive the run it was applied for", async () => {
    const harness = createHarness();
    await startFromHome(harness);

    // The run happens, then the robot docks.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
    harness.set({ state: ROBOROCK_STATE_CHARGING });
    harness.cleanMode();

    // A mop clean started from the Roborock app must be reported as a mop
    // clean, not through the previous Matter run's intent.
    harness.set({
      state: ROBOROCK_STATE_ROOM_CLEAN,
      water_box_mode: WATER_BOX_ON,
    });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("but a publish before the robot reports it started does not drop it", async () => {
    const harness = createHarness();
    await startFromHome(harness);

    // The gap between the acknowledgement and the robot reporting RUNNING.
    // Releasing the pin here would make the whole thing a no-op in exactly
    // the case it was built for.
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("an apply that failed leaves the robot's report authoritative", async () => {
    const harness = createHarness({
      applyRejectsWith: new Error("timed out"),
    });
    await startFromHome(harness);
    expect(harness.applied).toHaveLength(1);

    // Nothing was confirmed, so nothing is known. The plugin must not pin an
    // intent it has no acknowledgement for — that would hide a real failure.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
    expect(
      harness.warnings().filter((line) => /still reports/.test(line))
    ).toHaveLength(0);
  });

  test("a mid-run mop selection in Apple Home is honoured immediately", async () => {
    const harness = createHarness();
    await startFromHome(harness);
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);

    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_MOP,
    });
    await settle();

    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
  });

  test("a clean started in the Roborock app is unaffected", () => {
    // No Matter start, so no pin: the derivation is the only signal there is
    // and it keeps full authority.
    const harness = createHarness({
      initialStatus: {
        state: ROBOROCK_STATE_ROOM_CLEAN,
        water_box_mode: WATER_BOX_ON,
      },
    });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("an idle robot still reports the user's selection, not the robot's", () => {
    // Outside a run the robot's sticky settings must not shadow the selection.
    const harness = createHarness({
      initialStatus: { water_box_mode: WATER_BOX_ON },
    });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("a suction level changed in the app mid-run is still followed", async () => {
    const harness = createHarness({
      fanPowerCleanModes: true,
      initialStatus: { fan_power: FAN_POWER_MAX },
    });
    await startFromHome(harness);
    harness.set({
      state: ROBOROCK_STATE_ROOM_CLEAN,
      water_box_mode: WATER_BOX_OFF,
    });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);

    harness.set({ fan_power: FAN_POWER_TURBO });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_TURBO);
  });
});

// The clause this rule was missing for three releases: "acknowledged" was read
// off the apply RESOLVING, and the prep resolves on a partial apply too. It
// sends up to three commands, reports at warn what the robot never confirmed,
// and returns normally — because the start command goes out regardless.
//
// So an apply could resolve having lost the one command that carries the user's
// clean TYPE, and the pin treated that as ground truth. Measured in #8
// (skmzwanke, Saros 10, 18 Aug 2026), vacuum-only on two rooms:
//
//   13:50:57  Applying Vacuum mode to Weebo before starting.
//   13:50:59  Roborock did not confirm the water mode and suction level ...
//             the robot may keep its previous settings for this run
//   13:52:22  Roborock still reports Vacuum + Mop ... after Vacuum was applied
//             and acknowledged
//
// The robot really did mop. The plugin had said so itself at 13:50:59, then
// contradicted itself at 13:52:22 and held Apple Home on Vacuum for the run —
// so the only place the failure was visible was the floor.
//
// The rule is the same one the thrown-apply case already obeys, extended to the
// case that resolves: a pin is KNOWN ground truth or it is not taken.
describe("an apply that resolved without confirming the type is not knowledge", () => {
  const UNCONFIRMED_TYPE = {
    unconfirmedSettings: ["water mode", "suction level"],
    cleanTypeConfirmed: false,
  };

  test("#8 replayed: the robot's vacuum+mop report is not overridden", async () => {
    const harness = createHarness({ applyResolvesWith: UNCONFIRMED_TYPE });

    await startFromHome(harness);
    expect(harness.applied).toHaveLength(1);
    expect(harness.started).toEqual(["app_start"]);

    // The robot is out cleaning and reporting water on — which, on his log, was
    // the truth: it kept the settings it already had.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });

  test("and it does not claim an acknowledgement it never had", async () => {
    // The line said "was applied and acknowledged" 83 seconds after the plugin
    // logged that Roborock had confirmed neither setting. With no pin the line
    // cannot be reached, so the claim becomes true by construction.
    const harness = createHarness({ applyResolvesWith: UNCONFIRMED_TYPE });
    await startFromHome(harness);
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    harness.cleanMode();

    expect(
      harness.warnings().filter((line) => /still reports/.test(line))
    ).toHaveLength(0);
  });

  test("an unconfirmed SUCTION LEVEL alone still leaves the pin standing", async () => {
    // A level inside the type says nothing about which type is running, and
    // dropping the pin for it would reintroduce the lagging-report lie for a
    // cosmetic command's sake.
    const harness = createHarness({
      applyResolvesWith: {
        unconfirmedSettings: ["suction level"],
        cleanTypeConfirmed: true,
      },
    });
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("a prep that confirmed everything is unchanged", async () => {
    const harness = createHarness({
      applyResolvesWith: {
        unconfirmedSettings: [],
        cleanTypeConfirmed: true,
      },
    });
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("a prep that says nothing is still trusted", async () => {
    // Seventeen suites stand the API in with a resolve of `undefined`, and the
    // shipped prep before this change said nothing either. Only an explicit
    // `cleanTypeConfirmed: false` withdraws the pin — absence of an answer must
    // not silently change behaviour for every other caller in the codebase.
    const harness = createHarness({ applyResolvesWith: undefined });
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });

  test("the withdrawal is stated in the prep, beside the pin it withdraws", () => {
    // Both halves of the decision must be in the one method, so a future
    // reader cannot find the pin without finding the condition on it.
    const body = readMethodBody(
      fs.readFileSync(SOURCE_PATH, "utf8"),
      "private async applyCleanModeBeforeStarting("
    );
    expect(body).toContain("cleanTypeConfirmed === false");
    const withdrawal = body.indexOf("cleanTypeConfirmed === false");
    const pin = body.indexOf("this.appliedCleanTypePin = {");
    // The check comes BEFORE the pin is taken, not as a later correction.
    expect(withdrawal).toBeLessThan(pin);
  });
});

describe("the drive home is not a mode change", () => {
  // Replayed from Mathias' own log, 20 Aug, Stueetage (a70), asked to mop:
  //
  //   16:55:15  clean mode request 1 (Mop), run mode request 1, Mop applied
  //   16:55:16  publish … cleanMode=1
  //   16:55:31  publish … cleanMode=1, fault=68
  //   16:56:15  sent back to dock
  //   16:56:16  publish … operationalState=64, cleanMode=2   <-- wrong
  //   16:56:54  publish … operationalState=66, cleanMode=1
  //
  // 1, 2, 1 on one run, and he had asked for exactly one thing. The robot was
  // not misbehaving: sending it home resets its fan power while the water box
  // stays configured, and "fan not off plus water on" is the signature
  // getLiveCleanType() reads as vacuum+mop on a classic robot.
  //
  // Roborock state 6 is "returning to dock", which the plugin maps to Matter
  // SEEKING_CHARGER (64). While that is the state, the derivation is frozen.

  const ROBOROCK_STATE_RETURNING = 6;
  const ROBOROCK_STATE_WASHING_MOP = 23;
  const ROBOROCK_STATE_EMPTYING = 22;
  const ROBOROCK_STATE_MAPPING = 29;

  test("a mop run stays Mop while the robot drives home", async () => {
    const harness = createHarness({
      initialStatus: { fan_power: FAN_POWER_OFF, water_box_mode: WATER_BOX_ON },
    });
    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_MOP,
    });
    await settle();
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);

    // Sent home. Fan power is reset by the robot; the water box is untouched.
    harness.set({
      state: ROBOROCK_STATE_RETURNING,
      fan_power: FAN_POWER_MAX,
    });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
  });

  test("and it is still Mop once docked", async () => {
    const harness = createHarness({
      initialStatus: { fan_power: FAN_POWER_OFF, water_box_mode: WATER_BOX_ON },
    });
    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_MOP,
    });
    await settle();
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    harness.set({ state: ROBOROCK_STATE_RETURNING, fan_power: FAN_POWER_MAX });
    harness.set({ state: ROBOROCK_STATE_CHARGING });

    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
  });

  test("and the dock washing the mop afterwards is not one either", async () => {
    // 3.12.3 froze the drive home and was too narrow by exactly one dock.
    // Replayed from the same robot 3 hours later, 20 Aug:
    //
    //   21:04:33  publish … operationalState=1,  cleanMode=1   mopping the hall
    //   21:07:43  publish … operationalState=64, cleanMode=1   driving home
    //   21:09:31  publish … operationalState=68, cleanMode=2   washing the mop
    //
    // Roborock state 23 is "washing the mop", which maps to Matter
    // CLEANING_MOP (68) and still counts as part of the run. A dock washing a
    // mop runs water with the fan off and on again, which is the same
    // signature read the same wrong way.
    const harness = createHarness({
      initialStatus: { fan_power: FAN_POWER_OFF, water_box_mode: WATER_BOX_ON },
    });
    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_MOP,
    });
    await settle();
    await startFromHome(harness);

    // The robot agrees while it works, exactly as it did in the log — which
    // is what releases the applied-type pin. Without this read the pin would
    // still be holding and would mask the defect being tested.
    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);

    harness.set({ state: ROBOROCK_STATE_RETURNING, fan_power: FAN_POWER_MAX });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);

    harness.set({ state: ROBOROCK_STATE_WASHING_MOP });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
  });

  test("nor is the dock emptying the bin, nor updating the map", async () => {
    const harness = createHarness({
      initialStatus: { fan_power: FAN_POWER_OFF, water_box_mode: WATER_BOX_ON },
    });
    await harness.handlers.rvcCleanMode.changeToMode({
      newMode: CLEAN_MODE_MOP,
    });
    await settle();
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
    harness.set({ state: ROBOROCK_STATE_RETURNING, fan_power: FAN_POWER_MAX });

    for (const state of [
      ROBOROCK_STATE_EMPTYING,
      ROBOROCK_STATE_MAPPING,
      ROBOROCK_STATE_WASHING_MOP,
    ]) {
      harness.set({ state });
      expect(harness.cleanMode()).toBe(CLEAN_MODE_MOP);
    }
  });

  test("a mode genuinely changed mid-clean still reaches Apple Home", async () => {
    // The case the freeze must not eat. This is why the fix is scoped to the
    // drive home and not to the whole run: a first attempt held the type for
    // the entire run and broke exactly this.
    const harness = createHarness({
      initialStatus: {
        fan_power: FAN_POWER_MAX,
        water_box_mode: WATER_BOX_OFF,
      },
    });
    await startFromHome(harness);

    harness.set({ state: ROBOROCK_STATE_ROOM_CLEAN });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM);

    // Water turned on in the Roborock app while the robot is still cleaning.
    harness.set({ water_box_mode: WATER_BOX_ON });
    expect(harness.cleanMode()).toBe(CLEAN_MODE_VACUUM_AND_MOP);
  });
});
