"use strict";

// When suction-level clean modes are announced (enableFanPowerCleanModes),
// the reported RvcCleanMode is derived from the robot's live fan power so a
// suction level chosen in the Roborock app shows up in Apple Home. That
// derivation had no answer for "the fan power cannot be read right now": it
// fell through to the last Matter selection, which defaults to plain Vacuum.
//
// Measured on Mathias' own two Q7 robots, 11 Aug 2026, plugin 3.4.10, both
// docked and charging. Every battery tick produced a PAIR of publishes one
// second apart:
//
//   9:48:15  Matter publish for Garage: battery=93%, ..., cleanMode=0.
//   9:48:16  Matter publish for Garage: battery=93%, ..., cleanMode=6.
//   9:49:20  Matter publish for 1. Sal: battery=97%, ..., cleanMode=0.
//   9:49:21  Matter publish for 1. Sal: battery=97%, ..., cleanMode=5.
//
// Ten consecutive pairs in fourteen minutes. cleanMode 6 is "Max Vacuum" and
// 5 is "Turbo Vacuum" — the levels those robots are actually set to — while 0
// is plain "Vacuum", a level nobody selected. The Apple Home mode picker
// flipped to Vacuum and back roughly every ninety seconds.
//
// The defect is not which read fails, it is what the plugin says when a read
// fails: it published a specific mode it had not measured. That is the same
// class of defect as 3.4.6 (a stale marker reported a transport state the
// plugin was not in) and 3.4.7 (a marker invented a reason for going remote).
// The rule these tests enumerate is therefore about missing data, not about
// any one source of it:
//
//   while suction-level modes are announced, a fan power that cannot be read
//   leaves the reported level unchanged — it never collapses to plain Vacuum.
//
// An explicit Matter selection still wins immediately: choosing a mode in
// Apple Home clears the remembered level, so the user's choice is never
// shadowed by what the robot said before they made it.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_VACUUM_BALANCED = 4;
const CLEAN_MODE_VACUUM_TURBO = 5;
const CLEAN_MODE_VACUUM_MAX = 6;

const FAN_POWER_TURBO = 103;
const FAN_POWER_MAX = 104;
// 105 is Roborock's "fan off" (mop-only) level. It is a real value the robot
// reports and it is deliberately NOT one of the announced suction modes, so
// it exercises "read fine, but not a level we announce" rather than "no read".
const FAN_POWER_OFF = 105;

function createHarness({
  fanPowerCleanModes = true,
  initialFanPower = FAN_POWER_MAX,
} = {}) {
  // The value the robot's fan power currently reads as. `null` means the
  // plugin cannot read it at all, which is the case the pairs above exposed.
  const status = { fan_power: initialFanPower };
  const platform = {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    platformConfig: {
      enableMatter: true,
      enableMatterCleanMode: true,
      enableFanPowerCleanModes: fanPowerCleanModes,
    },
    getMatterApi: () => ({ updateAccessoryState: jest.fn() }),
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Garage" : "",
      getProductAttribute: () => "roborock.vacuum.sc05",
      getVacuumDeviceStatus: (duid, property) => {
        const value = status[property];
        return value === null || value === undefined ? "" : value;
      },
      getMatterCleanModeCapabilities: () => ({
        canVacuum: true,
        canMop: true,
        canControlFanPower: true,
      }),
      getRoomMappingsForDevice: () => [],
      getMapListForDevice: () => [],
      getCurrentMapIdForDevice: () => 0,
    },
  };
  const accessory = { UUID: "uuid-clean-mode", context: { duid: "duid-q7" } };
  const instance = new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "duid-q7" },
    false
  );
  instance.markRegistered();

  return {
    instance,
    platform,
    setFanPower: (value) => {
      status.fan_power = value;
    },
    cleanMode: () => instance.getCurrentCleanMode(),
  };
}

describe("a fan power the plugin cannot read never becomes plain Vacuum", () => {
  test("a readable fan power is reported as its suction mode", () => {
    const { cleanMode } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);
  });

  test("a live change between suction levels is followed", () => {
    const { cleanMode, setFanPower } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);
    setFanPower(FAN_POWER_TURBO);
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_TURBO);
  });

  // The regression the Q7 pairs showed, stated directly.
  test("an unreadable fan power keeps the level last read", () => {
    const { cleanMode, setFanPower } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);

    setFanPower(null);
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);
  });

  test("the level survives repeated unreadable polls rather than flapping", () => {
    const { cleanMode, setFanPower } = createHarness();
    setFanPower(FAN_POWER_TURBO);
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_TURBO);

    const reported = [];
    for (let poll = 0; poll < 6; poll += 1) {
      setFanPower(poll % 2 === 0 ? null : FAN_POWER_TURBO);
      reported.push(cleanMode());
    }

    expect(reported).toEqual([
      CLEAN_MODE_VACUUM_TURBO,
      CLEAN_MODE_VACUUM_TURBO,
      CLEAN_MODE_VACUUM_TURBO,
      CLEAN_MODE_VACUUM_TURBO,
      CLEAN_MODE_VACUUM_TURBO,
      CLEAN_MODE_VACUUM_TURBO,
    ]);
  });

  // A value that reads fine but is not one of the announced modes is the same
  // situation as no value at all: the plugin still does not know which of the
  // announced levels to report, so it must not invent one.
  test("a fan power outside the announced levels keeps the level last read", () => {
    const { cleanMode, setFanPower } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);

    setFanPower(FAN_POWER_OFF);
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);
  });

  // Nothing to keep means nothing is kept: a robot whose fan power has never
  // been readable still reports the Matter selection, so the fallback cannot
  // invent a level of its own on a robot it has learnt nothing about.
  test("with no level ever read, the Matter selection is still what is reported", () => {
    const { cleanMode } = createHarness({ initialFanPower: null });
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });
});

describe("an explicit Apple Home selection is never shadowed", () => {
  test("choosing a mode wins over the remembered live level", async () => {
    const { instance, cleanMode, setFanPower } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);

    setFanPower(null);
    await instance.changeCleanMode(CLEAN_MODE_VACUUM_BALANCED);

    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_BALANCED);
  });

  // The remembered level must be discarded by the selection, not merely
  // outranked while the selection is pending — otherwise it would resurface
  // the moment the selection has been applied to the robot.
  test("choosing plain Vacuum reports plain Vacuum, not the old level", async () => {
    const { instance, cleanMode, setFanPower } = createHarness();
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM_MAX);

    await instance.changeCleanMode(CLEAN_MODE_VACUUM);
    instance.selectedCleanModeNeedsApply = false;
    setFanPower(null);

    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });
});

describe("robots without announced suction levels are unaffected", () => {
  test("the fan power is not consulted at all", () => {
    const { cleanMode, setFanPower } = createHarness({
      fanPowerCleanModes: false,
    });
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM);

    setFanPower(null);
    expect(cleanMode()).toBe(CLEAN_MODE_VACUUM);
  });
});
