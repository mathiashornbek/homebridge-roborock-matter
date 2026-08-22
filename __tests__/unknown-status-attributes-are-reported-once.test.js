"use strict";

// A robot with no per-model profile in `deviceFeatures.js` runs on the
// capability-derived path, which works — but every `get_status` attribute the
// profile does not name was warned about on *every* poll, one `log.warn` per
// attribute. skmzwanke's Saros 10 (#8) produces eight of them, so at one poll
// a minute that is ~11,500 warnings a day telling him to contact the dev about
// the same eight fields. Both #6 and #8 were promised this would be quietened.
//
// The rule pinned here is per (robot, attribute), not per line I happened to
// look at: an unmapped attribute is reported once, and the same attribute is
// never reported twice for the same robot no matter how many polls run. It has
// to stay a warning the first time — an unmapped attribute really is something
// worth a model report — and a genuinely new attribute appearing later must
// still get through, otherwise quietening the noise would also hide the signal.

const { vacuum } = require("../roborockLib/lib/vacuum");

// The fields the Saros 10 in #8 reports that no profile names, with the values
// from the log in that issue.
const UNMAPPED_SAROS_ATTRIBUTES = {
  home_sec_status: 0,
  home_sec_enable_password: 1,
  extra_time: 286,
  sterilize_status: 0,
  rst: 0,
  cleaning_info: { total: 1 },
  exit_dock: 0,
  seq_type: 0,
};

const MAPPED_ATTRIBUTES = {
  state: 8,
  battery: 100,
  charge_status: 1,
  dock_type: 1,
};

/**
 * An adapter whose profile knows only `MAPPED_ATTRIBUTES`, and which has a
 * Homebridge state object only for those — the condition that sends the real
 * code down the unmapped-attribute branch.
 */
function createAdapter(status, names = {}) {
  const known = new Set(Object.keys(MAPPED_ATTRIBUTES));
  const features = {
    hasDeviceStatusAttribute: (attribute) => known.has(attribute),
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
    vacuums: new Proxy(
      {},
      {
        get: () => ({ features }),
      }
    ),
    messageQueueHandler: {
      sendRequest: jest.fn().mockImplementation(async () => [status()]),
    },
    getObjectAsync: jest.fn(async (id) =>
      known.has(String(id).split(".").pop()) ? { _id: id } : null
    ),
    getStateAsync: jest.fn(async () => null),
    getState: jest.fn(async () => null),
    setStateAsync: jest.fn(),
    setStateChangedAsync: jest.fn(),
    isCleaning: () => false,
    manageDeviceIntervals: jest.fn(),
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

// Every warning the poll produced. Deliberately unfiltered: matching on the
// message wording would let a reworded warning slip past the count assertions,
// which is the one thing these tests exist to hold down. This harness feeds a
// clean status payload, so any warning at all is one of ours.
function unmappedWarnings(adapter) {
  return adapter.log.warn.mock.calls.map((call) => String(call[0]));
}

describe("unmapped get_status attributes are reported once per robot", () => {
  test("dock capability detection receives the dock type value", async () => {
    const adapter = createAdapter(() => ({ ...MAPPED_ATTRIBUTES }));
    const robot = new vacuum(adapter, "roborock.vacuum.a08");

    await poll(robot, "s7-duid");

    expect(
      adapter.vacuums["s7-duid"].features.processDockType
    ).toHaveBeenCalledWith(1);
  });

  test("the first poll reports the unmapped attributes, naming the robot", async () => {
    const adapter = createAdapter(() => ({
      ...MAPPED_ATTRIBUTES,
      ...UNMAPPED_SAROS_ATTRIBUTES,
    }));
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    await poll(robot, "saros-duid");

    const reported = unmappedWarnings(adapter);
    expect(reported).toHaveLength(1);

    // Names the robot and the model, and still lists every attribute and value
    // so a model report carries the same information it did before.
    expect(reported[0]).toContain("roborock.vacuum.a144");
    for (const [attribute, value] of Object.entries(
      UNMAPPED_SAROS_ATTRIBUTES
    )) {
      expect(reported[0]).toContain(attribute);

      if (typeof value !== "object") {
        expect(reported[0]).toContain(String(value));
      }
    }
  });

  test("uses the robot's friendly name, not its duid", async () => {
    const adapter = createAdapter(
      () => ({ ...MAPPED_ATTRIBUTES, ...UNMAPPED_SAROS_ATTRIBUTES }),
      { "saros-duid": "Weebo" }
    );
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    await poll(robot, "saros-duid");

    expect(unmappedWarnings(adapter)[0]).toContain("Weebo");
    expect(unmappedWarnings(adapter)[0]).not.toContain("saros-duid");
  });

  test("further polls of the same robot warn no further", async () => {
    const adapter = createAdapter(() => ({
      ...MAPPED_ATTRIBUTES,
      ...UNMAPPED_SAROS_ATTRIBUTES,
    }));
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    for (let i = 0; i < 20; i++) {
      await poll(robot, "saros-duid");
    }

    // This is the whole complaint in #8: the count must not grow with uptime.
    expect(unmappedWarnings(adapter)).toHaveLength(1);
  });

  test("an attribute that appears for the first time later is still reported", async () => {
    let extra = {};
    const adapter = createAdapter(() => ({
      ...MAPPED_ATTRIBUTES,
      ...UNMAPPED_SAROS_ATTRIBUTES,
      ...extra,
    }));
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    await poll(robot, "saros-duid");
    await poll(robot, "saros-duid");
    expect(unmappedWarnings(adapter)).toHaveLength(1);

    // Quietening the repeats must not cost us the one thing the message is
    // for: a field nobody has seen before.
    extra = { brand_new_field: 42 };
    await poll(robot, "saros-duid");

    const reported = unmappedWarnings(adapter);
    expect(reported).toHaveLength(2);
    expect(reported[1]).toContain("brand_new_field");
    expect(reported[1]).toContain("42");

    // ...and only the new one, not the eight already reported.
    for (const attribute of Object.keys(UNMAPPED_SAROS_ATTRIBUTES)) {
      expect(reported[1]).not.toContain(attribute);
    }
  });

  test("each robot is reported separately, so a second robot is not silenced by the first", async () => {
    const adapter = createAdapter(
      () => ({ ...MAPPED_ATTRIBUTES, ...UNMAPPED_SAROS_ATTRIBUTES }),
      { "robot-a": "Upstairs", "robot-b": "Garage" }
    );
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    await poll(robot, "robot-a");
    await poll(robot, "robot-b");
    await poll(robot, "robot-a");
    await poll(robot, "robot-b");

    const reported = unmappedWarnings(adapter);
    expect(reported).toHaveLength(2);
    expect(reported[0]).toContain("Upstairs");
    expect(reported[1]).toContain("Garage");
  });

  test("a robot whose attributes are all mapped is never warned about", async () => {
    const adapter = createAdapter(() => ({ ...MAPPED_ATTRIBUTES }));
    const robot = new vacuum(adapter, "roborock.vacuum.a70");

    await poll(robot, "vicky-duid");
    await poll(robot, "vicky-duid");

    expect(unmappedWarnings(adapter)).toEqual([]);
  });
});
