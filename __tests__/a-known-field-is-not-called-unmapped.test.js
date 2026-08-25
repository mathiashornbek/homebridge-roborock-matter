"use strict";

// jcoz00's Qrevo CurvX (#6) is told, once per robot, that this plugin "has no
// mapping for" eighteen `get_status` fields, and that a model report quoting
// the line is how they get added. Fifteen of the eighteen are already in
// `deviceFeatures.js`. There is nothing for a model report to add, so the
// message spends a user's goodwill on work that cannot happen — and it buries
// the three fields that genuinely are news.
//
// The distinction the message misses is between two different things:
//
//   - a field no part of this plugin has ever heard of. `dtof_status`,
//     `pet_reminding` and `sub_error_code` appear nowhere in the source. Those
//     are worth a warning and worth a model report.
//   - a field this plugin knows perfectly well, which is absent from *this
//     robot's* table because the capability gate that installs it did not fire.
//     A per-model table starts as a copy of the pristine `deviceStates` and
//     capability detection adds to it, so "not in this robot's table" and "not
//     known to this plugin" are not the same question. `hasDeviceStatusAttribute`
//     only ever answered the first one.
//
// The rule pinned here is the class, not the eighteen fields I happened to
// look at: every field any capability path can install must be recognised as
// known. The last test in this file derives that set from the source itself, so
// a new `deviceStates.<field> =` writer cannot be added without being declared
// — the hand-written-list-in-two-places defect the note at
// matter_vacuum_accessory.ts:185 warns about.

const fs = require("fs");
const path = require("path");

const { vacuum } = require("../roborockLib/lib/vacuum");
const { isKnownStatusAttribute } = require("../roborockLib/lib/deviceFeatures");

// The exact payload from jcoz00's second diagnostics export in #6, minus the
// fields his robot's own table does name. Values are his.
const KNOWN_BUT_NOT_ENABLED = {
  water_box_status: 1,
  water_box_mode: 201,
  water_box_carriage_status: 1,
  mop_forbidden_enable: 1,
  monitor_status: 0,
  water_shortage_status: 0,
  in_warmup: 0,
  charge_status: 1,
  clean_percent: 0,
  rss: 2,
  dss: 168,
  common_status: 2,
  kct: 0,
  switch_status: 25,
  last_clean_t: 1787504682,
};

// The three that really are unknown to every table and every by-name read.
const GENUINELY_UNKNOWN = {
  dtof_status: 0,
  pet_reminding: 0,
  sub_error_code: 0,
};

const ENABLED_ATTRIBUTES = {
  state: 8,
  battery: 100,
  dock_type: 1,
};

/**
 * An adapter whose robot table names only `ENABLED_ATTRIBUTES` — the condition
 * that sends everything else down the unmapped branch, exactly as it does on
 * jcoz00's a185.
 */
function createAdapter(status, names = {}) {
  const enabled = new Set(Object.keys(ENABLED_ATTRIBUTES));
  const features = {
    hasDeviceStatusAttribute: (attribute) => enabled.has(attribute),
    getStatusDivider: () => null,
    processDockType: jest.fn(),
  };

  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    vacuums: new Proxy({}, { get: () => ({ features }) }),
    messageQueueHandler: {
      sendRequest: jest.fn().mockImplementation(async () => [status()]),
    },
    getObjectAsync: jest.fn(async () => null),
    getStateAsync: jest.fn(async () => null),
    getState: jest.fn(async () => null),
    setStateAsync: jest.fn(),
    setStateChangedAsync: jest.fn(),
    isCleaning: () => false,
    manageDeviceIntervals: jest.fn(),
    deviceNotify: jest.fn(),
    describeDevice: (duid) => names[duid] || String(duid),
    catchError: jest.fn((error) => {
      throw error;
    }),
    socket: null,
  };
}

/** Poll status once, bypassing the per-robot poll throttle. */
async function poll(robot, duid) {
  await robot.getParameter(duid, "get_status", "force");
}

function warnings(adapter) {
  return adapter.log.warn.mock.calls.map((call) => String(call[0]));
}

function debugLines(adapter) {
  return adapter.log.debug.mock.calls.map((call) => String(call[0]));
}

function pollCurvX() {
  const adapter = createAdapter(
    () => ({
      ...ENABLED_ATTRIBUTES,
      ...KNOWN_BUT_NOT_ENABLED,
      ...GENUINELY_UNKNOWN,
    }),
    { "curvx-duid": "Downstairs" }
  );
  const robot = new vacuum(adapter, "roborock.vacuum.a185");

  return { adapter, robot };
}

describe("a field this plugin knows is not reported as unmapped (#6)", () => {
  test("the warning names only the three genuinely unknown fields", async () => {
    const { adapter, robot } = pollCurvX();

    await poll(robot, "curvx-duid");

    const reported = warnings(adapter);
    expect(reported).toHaveLength(1);

    for (const attribute of Object.keys(GENUINELY_UNKNOWN)) {
      expect(reported[0]).toContain(attribute);
    }
  });

  test("the fifteen known fields are absent from the warning", async () => {
    const { adapter, robot } = pollCurvX();

    await poll(robot, "curvx-duid");

    // The whole defect: these are in `deviceFeatures.js` already, so asking
    // for a model report about them asks for something that cannot be done.
    for (const attribute of Object.keys(KNOWN_BUT_NOT_ENABLED)) {
      expect(warnings(adapter)[0]).not.toContain(attribute);
    }
  });

  test("the count in the message is three, not eighteen", async () => {
    const { adapter, robot } = pollCurvX();

    await poll(robot, "curvx-duid");

    // The number is what a reader believes, so it is worth its own assertion.
    expect(warnings(adapter)[0]).toContain("3 get_status field(s)");
    expect(warnings(adapter)[0]).not.toContain("18 get_status field(s)");
  });

  test("a known-but-not-enabled field is still visible at debug level", async () => {
    const { adapter, robot } = pollCurvX();

    await poll(robot, "curvx-duid");

    // Quietening a wrong warning must not throw the diagnostic away: a robot
    // sending a field whose gate did not fire is worth seeing when we go
    // looking, just not worth waking a user for.
    const lines = debugLines(adapter).join("\n");
    for (const attribute of Object.keys(KNOWN_BUT_NOT_ENABLED)) {
      expect(lines).toContain(attribute);
    }
  });

  test("the debug line does not ask the user for a model report", async () => {
    const { adapter, robot } = pollCurvX();

    await poll(robot, "curvx-duid");

    const lines = debugLines(adapter).join("\n");
    expect(lines).not.toContain("GitHub");
  });

  test("the known fields are reported once per robot, not once per poll", async () => {
    const { adapter, robot } = pollCurvX();

    for (let i = 0; i < 20; i++) {
      await poll(robot, "curvx-duid");
    }

    // The rule from #8 still holds for the class that moved to debug.
    expect(warnings(adapter)).toHaveLength(1);
    expect(
      debugLines(adapter).filter((line) => line.includes("water_box_status"))
    ).toHaveLength(1);
  });

  test("a robot sending only known-but-not-enabled fields is never warned", async () => {
    const adapter = createAdapter(() => ({
      ...ENABLED_ATTRIBUTES,
      ...KNOWN_BUT_NOT_ENABLED,
    }));
    const robot = new vacuum(adapter, "roborock.vacuum.a185");

    await poll(robot, "curvx-duid");
    await poll(robot, "curvx-duid");

    expect(warnings(adapter)).toEqual([]);
  });

  test("a genuinely new field still gets through", async () => {
    let extra = {};
    const adapter = createAdapter(() => ({
      ...ENABLED_ATTRIBUTES,
      ...KNOWN_BUT_NOT_ENABLED,
      ...extra,
    }));
    const robot = new vacuum(adapter, "roborock.vacuum.a185");

    await poll(robot, "curvx-duid");
    expect(warnings(adapter)).toEqual([]);

    // Narrowing what counts as unmapped must not cost the signal the message
    // exists for.
    extra = { brand_new_field: 42 };
    await poll(robot, "curvx-duid");

    const reported = warnings(adapter);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("brand_new_field");
    expect(reported[0]).toContain("42");
  });
});

describe("every field a capability path can install counts as known", () => {
  // Test the class, not the eighteen fields in #6. `isKnownStatusAttribute`
  // carries a hand-written set, and a hand-written list in two places is the
  // defect this project keeps re-finding. Derive the truth from the source and
  // let the mismatch fail here rather than in a user's log.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "roborockLib", "lib", "deviceFeatures.js"),
    "utf8"
  );

  const written = [
    ...source.matchAll(/deviceStates\.([A-Za-z0-9_]+)\s*=/g),
  ].map((match) => match[1]);

  const installable = [...new Set(written)].sort();

  test("the source really does install fields this way", () => {
    // Guard the regex itself: if a refactor changes how these are written,
    // this suite must fail loudly rather than pass on an empty set.
    expect(installable.length).toBeGreaterThan(30);
  });

  test.each(installable)("%s is recognised as known", (attribute) => {
    expect(isKnownStatusAttribute(attribute)).toBe(true);
  });

  // The second user-visible consequence of the fix, and it belongs to a
  // different reporter. skmzwanke's Saros 10 (#8) was warned about nine fields;
  // every one of them has since been added to `deviceStates`, so his warning
  // was still asking for a model report for work that was already done. It goes
  // quiet on its own, which is worth pinning so a future edit cannot bring it
  // back without saying so.
  test.each([
    "home_sec_status",
    "voice_chat_status",
    "home_sec_enable_password",
    "extra_time",
    "sterilize_status",
    "rst",
    "cleaning_info",
    "exit_dock",
    "seq_type",
  ])("#8's %s is mapped and no longer worth a warning", (attribute) => {
    expect(isKnownStatusAttribute(attribute)).toBe(true);
  });

  test("a field no writer installs is not claimed as known", () => {
    for (const attribute of Object.keys(GENUINELY_UNKNOWN)) {
      expect(isKnownStatusAttribute(attribute)).toBe(false);
    }

    expect(isKnownStatusAttribute("brand_new_field")).toBe(false);
  });
});
