"use strict";

// The Q7 tile in Apple Home was wrong for 28 seconds after every restart, and
// the reason turned out NOT to be the one the notes had assumed for fourteen
// observations. 3.9.1 fixed the refused first B01 poll, and the field
// verification proved it: both Q7s reported `B01 status online … state=8` one
// second after the loop started, with zero recoveries logged. And the tile was
// STILL wrong for 28 seconds:
//
//   06:22:08  B01 status online for 1. Sal: state=8, battery=100%, charging=yes
//   06:22:09  Matter publish for 1. Sal: operationalState=0, runMode=0, cleanMode=0
//   06:22:38  Matter publish for 1. Sal: operationalState=65, runMode=0, cleanMode=6
//
// The status was online BEFORE the accessory was even added, so the window is
// not "between the failed first request and the successful second" as the
// earlier model had it. The real cause is that the status had nowhere to go:
//
//   * `dispatchDeviceUpdate` routes a scoped live frame through
//     `notifyVacuumByDuid`, which looks the duid up in `matterVacuums` and
//     returns in silence when there is no entry yet.
//   * `updateMatterStateFromMessage` opens with `if (!this.registered) return;`,
//     so an accessory that exists but has not been registered drops it too.
//   * Nothing redelivers a frame that hit either gate.
//
// `discoverDevices()` runs in the startService callback, i.e. after the poll
// loop is already answering, so the robot's real status is routinely known
// before there is anything able to show it. The tile therefore fell back on
// `getVacuumDeviceStatus`, which reads the HomeData snapshot — pairing-day
// values — and only corrected itself on the next poll tick.
//
// The fix is to replay the status the API already kept, on the same live-message
// channel every other frame uses, at the moment the accessory becomes usable.
//
// These tests pin the rule and not the incident: an accessory that becomes
// usable while a fresher status is already known must be given it, on BOTH
// discovery paths, and must never be given a status that was not reported.
//
// The trap here is worth stating because the first draft fell into it: seeding
// from `createOrUpdateMatterVacuum` — the one place a vacuum is constructed, and
// where 3.9.0 rightly hung `setStateListener` — is silently dropped by the
// `registered` guard, and the test looks green because nothing happens at all.
// Hence the ordering assertion below, and hence the symptom test asserting a
// published value rather than a call count.

const RoborockPlatform = require("../src/platform").default;
const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const DUID = "duid-1sal";

/** The robot charging in its dock, as the B01 poll loop stored it. */
const REPORTED_STATUS = {
  state: 8,
  charge_status: 1,
  battery: 100,
  fan_power: 103,
};

/**
 * The pairing-day HomeData snapshot: idle, plain Vacuum. This is what the tile
 * published for 28 seconds, and it must lose to anything the robot has actually
 * said.
 */
const STALE_SNAPSHOT = { state: 0, charge_status: 0, battery: 100 };

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * A platform with one Matter vacuum, wired to a real accessory and a capturing
 * Matter API.
 *
 * @param {{knownStatus?: object|null, cached?: boolean, hasGetter?: boolean}} options
 */
function createPlatform({
  knownStatus = REPORTED_STATUS,
  cached = false,
  hasGetter = true,
} = {}) {
  const platform = Object.create(RoborockPlatform.prototype);

  const published = {
    rvcRunMode: {},
    rvcOperationalState: {},
    rvcCleanMode: {},
    powerSource: {},
  };
  const events = [];

  platform.log = createLog();
  platform.platformConfig = {
    enableMatter: true,
    enableMatterCleanMode: true,
    enableMatterChargingDockedStates: true,
    enableMatterExtendedOperationalStates: true,
  };
  platform.accessories = [];
  platform.api = {
    hap: { uuid: { generate: (seed) => `uuid-${seed}` } },
    unregisterPlatformAccessories: jest.fn(),
  };
  platform.matterAccessories = [];
  platform.matterVacuums = new Map();
  platform.stateSensors = new Map();
  platform.shouldAcceptUnscopedLiveMessage = () => true;
  platform.refreshStateSensorsForRobot = () => {};

  const matterApi = {
    deviceTypes: { RoboticVacuumCleaner: "rvc" },
    updateAccessoryState: jest.fn(async (_uuid, cluster, attributes) => {
      events.push({ kind: "publish", cluster, attributes });
      if (cluster in published) {
        Object.assign(published[cluster], attributes);
      }
    }),
    registerPlatformAccessories: jest.fn(async () => {
      events.push({ kind: "register" });
    }),
    updatePlatformAccessories: jest.fn(async () => {
      events.push({ kind: "update" });
    }),
  };
  platform.getMatterApi = () => matterApi;

  platform.roborockAPI = {
    getVacuumDeviceInfo: (_duid, property) =>
      property === "name" ? "1. Sal" : "sn-1",
    getProductAttribute: () => "roborock.vacuum.sc05",
    // The stale channel: what the tile fell back on.
    getVacuumDeviceStatus: (_duid, property) => STALE_SNAPSHOT[property] ?? "",
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
    describeDevice: (duid) => `1. Sal (${duid})`,
    getStatus: jest.fn().mockResolvedValue(undefined),
  };
  if (hasGetter) {
    platform.roborockAPI.getLastKnownLiveStatus = jest.fn(() => knownStatus);
  }

  // The cached path finds an accessory already in matterAccessories; the fresh
  // path does not. generateMatterUuid is the real one, so the lookup matches
  // the way it does in production.
  const uuid = platform.generateMatterUuid(DUID);
  if (cached) {
    platform.matterAccessories.push({
      UUID: uuid,
      context: { duid: DUID },
      displayName: "1. Sal",
    });
  }

  return { platform, published, events, matterApi, uuid };
}

/** Run the real discovery for one B01 robot. */
async function discover(platform) {
  await platform.discoverMatterVacuum({
    duid: DUID,
    name: "1. Sal",
    pv: "B01",
    online: true,
  });
}

/** Every live-message frame the accessory was handed, in order. */
function seededFrames(platform) {
  const vacuum = platform.matterVacuums.get(DUID);
  return vacuum ? vacuum.__seededFrames || [] : [];
}

/**
 * Record what reaches notifyDeviceUpdater and whether the accessory was
 * registered at that moment. The ordering is the whole fix, so it is observed
 * rather than assumed.
 */
function instrument(platform) {
  const original = RoborockMatterVacuumAccessory.prototype.notifyDeviceUpdater;
  jest
    .spyOn(RoborockMatterVacuumAccessory.prototype, "notifyDeviceUpdater")
    .mockImplementation(async function (id, data) {
      if (!this.__seededFrames) {
        this.__seededFrames = [];
      }
      this.__seededFrames.push({
        id,
        data,
        // Read through the public behaviour rather than the private field: an
        // unregistered accessory publishes nothing at all.
        registeredAtDelivery: this.registered === true,
      });
      return original.call(this, id, data);
    });
  return platform;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("a newly usable accessory is given the status the robot already reported", () => {
  test("a freshly registered accessory is seeded from the last known status", async () => {
    const { platform } = createPlatform();
    instrument(platform);

    await discover(platform);

    const frames = seededFrames(platform);
    expect(frames).toHaveLength(1);
    expect(frames[0].id).toBe("CloudMessage");
    expect(frames[0].data).toEqual({ duid: DUID, payload: [REPORTED_STATUS] });
  });

  test("a cached accessory is seeded too, not just a freshly registered one", async () => {
    // The measured incident was a fresh registration, but a cached accessory is
    // re-attached in the same callback and has the same hole. Fixing only the
    // path that was measured is the mistake two releases in a row made.
    const { platform, matterApi } = createPlatform({ cached: true });
    instrument(platform);

    await discover(platform);

    expect(matterApi.updatePlatformAccessories).toHaveBeenCalled();
    expect(matterApi.registerPlatformAccessories).not.toHaveBeenCalled();
    const frames = seededFrames(platform);
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toEqual({ duid: DUID, payload: [REPORTED_STATUS] });
  });

  test("the seed arrives after the accessory is registered, never before", async () => {
    // THE trap. updateMatterStateFromMessage opens with
    // `if (!this.registered) return;`, so a seed delivered one line earlier is
    // dropped in silence and this whole suite would pass while the tile stayed
    // wrong.
    const { platform } = createPlatform();
    instrument(platform);

    await discover(platform);

    const frames = seededFrames(platform);
    expect(frames).toHaveLength(1);
    expect(frames[0].registeredAtDelivery).toBe(true);
  });

  test("the seed carries the stored status unchanged", async () => {
    // Replayed on the live-message channel so one piece of code interprets
    // these bytes. A second reading of the same status, written here, is the
    // thing that drifts.
    const { platform } = createPlatform();
    instrument(platform);

    await discover(platform);

    expect(seededFrames(platform)[0].data.payload[0]).toBe(REPORTED_STATUS);
  });
});

describe("nothing is invented when nothing has been reported", () => {
  test("no known status means no seed at all", async () => {
    // The startup guard that matters: a status the robot never sent must not be
    // conjured from the snapshot. That would put a wrong value on the tile with
    // confidence instead of leaving it to the next tick.
    const { platform } = createPlatform({ knownStatus: null });
    instrument(platform);

    await discover(platform);

    expect(seededFrames(platform)).toHaveLength(0);
  });

  test("a classic robot with no such store is discovered normally", async () => {
    // Only the cloud-only B01 dialect keeps a last-known status; a70 streams
    // over MQTT and has no gap. An absent value must read as "nothing known",
    // not crash discovery. Note `undefined` and not `null`: the getter answers
    // whatever the store holds, and both spellings of absence must be safe.
    const { platform, matterApi } = createPlatform({ knownStatus: null });
    platform.roborockAPI.getLastKnownLiveStatus = jest.fn(() => undefined);
    instrument(platform);

    await discover(platform);

    expect(matterApi.registerPlatformAccessories).toHaveBeenCalled();
    expect(seededFrames(platform)).toHaveLength(0);
    expect(platform.log.error).not.toHaveBeenCalled();
  });

  test("an API without the getter still discovers the robot", async () => {
    // The accessory and the library are versioned together in the package, but
    // discovery must not depend on a method existing to complete at all.
    const { platform, matterApi } = createPlatform({ hasGetter: false });
    instrument(platform);

    await discover(platform);

    expect(matterApi.registerPlatformAccessories).toHaveBeenCalled();
    expect(platform.log.error).not.toHaveBeenCalled();
  });

  test("a seed that throws does not abort discovery", async () => {
    const { platform, matterApi } = createPlatform();
    jest
      .spyOn(RoborockMatterVacuumAccessory.prototype, "notifyDeviceUpdater")
      .mockRejectedValue(new Error("matter endpoint still initializing"));

    await discover(platform);

    expect(matterApi.registerPlatformAccessories).toHaveBeenCalled();
    expect(platform.matterAccessories).toHaveLength(1);
    expect(platform.log.error).not.toHaveBeenCalled();
  });
});

describe("the field symptom", () => {
  // The sequence in the log is registration, then the scheduled snapshot
  // refresh one second later. Both halves have to run: the seed must land, and
  // the refresh that follows must not undo it. Discovery publishes nothing by
  // itself, so a test that stopped at `await discover()` would be measuring the
  // wrong moment entirely.
  //
  // The refresh is invoked directly rather than advanced to under fake timers.
  // What is being asserted is the ORDER of two publishes, not that a delay is
  // 1000ms, and two startup tests in this repo were already rewritten from
  // clock assertions to structural ones for exactly that reason. The delay
  // itself is pinned separately, by the no-regression tests further down.
  async function discoverThenRunScheduledRefresh(platform) {
    await discover(platform);
    await platform.matterVacuums.get(DUID).updateMatterStateFromRoborock();
  }

  test("the tile does not publish the pairing-day snapshot for a docked robot", async () => {
    // The measurement, reproduced: the robot reported state=8 charge_status=1
    // before the accessory existed, while the HomeData snapshot still said
    // state=0. operationalState=0 runMode=0 cleanMode=0 is the exact line the
    // log carried at 06:22:09 for both Q7s.
    const { platform, published } = createPlatform();

    await discoverThenRunScheduledRefresh(platform);

    expect(published.rvcOperationalState.operationalState).not.toBe(0);
    // 66 = DOCKED, which is where a robot reporting charge_status=1 is.
    expect(published.rvcOperationalState.operationalState).toBe(66);
  });

  test("the snapshot refresh a second later does not undo the seed", async () => {
    // This is why the fix can be a seed at all: rememberLiveStatus makes the
    // full cluster rebuild prefer the live values over the HomeData snapshot,
    // so the scheduled refresh republishes the correct value instead of
    // reinstating the stale one. If it clobbered the seed, the tile would be
    // wrong again one second in and the fix would buy nothing.
    const { platform, published, matterApi } = createPlatform();

    await discoverThenRunScheduledRefresh(platform);

    // Asserted over every write in the whole sequence rather than over a write
    // count. publishRoborockSnapshot skips clusters whose payload is
    // byte-identical to the last confirmed publish, so the refresh legitimately
    // writes nothing here — it agrees with the seed. Counting writes measured
    // that dedup instead of the property, and failed for a reason that had
    // nothing to do with the bug.
    const opStateWrites = matterApi.updateAccessoryState.mock.calls.filter(
      ([, cluster]) => cluster === "rvcOperationalState"
    );
    expect(opStateWrites.length).toBeGreaterThan(0);
    for (const [, , attributes] of opStateWrites) {
      expect(attributes.operationalState).not.toBe(0);
    }
    expect(published.rvcOperationalState.operationalState).toBe(66);
  });

  test("the stale snapshot genuinely disagrees, so this is not a free pass", async () => {
    // Without this, the symptom tests above could be satisfied by a snapshot
    // that happened to be right, and the suite would be green against the
    // unfixed code. With no known status the accessory has only the snapshot to
    // go on, and it publishes exactly the wrong values from the log.
    const { platform, published } = createPlatform({ knownStatus: null });

    await discoverThenRunScheduledRefresh(platform);

    expect(published.rvcOperationalState.operationalState).toBe(0);
    expect(published.rvcRunMode.currentMode).toBe(0);
    expect(published.rvcCleanMode.currentMode).toBe(0);
  });
});

describe("what the seed must not disturb", () => {
  test("the registration-time snapshot refresh still happens", async () => {
    // The seed is an addition, not a replacement. The scheduled refresh is what
    // covers everything the live frame does not carry, and removing it would
    // trade one gap for another.
    const { platform } = createPlatform();
    const refresh = jest.spyOn(
      RoborockMatterVacuumAccessory.prototype,
      "scheduleMatterStateRefresh"
    );

    await discover(platform);

    expect(refresh).toHaveBeenCalledWith("accessory registration", 1000);
  });

  test("the cached path keeps its own refresh reason", async () => {
    const { platform } = createPlatform({ cached: true });
    const refresh = jest.spyOn(
      RoborockMatterVacuumAccessory.prototype,
      "scheduleMatterStateRefresh"
    );

    await discover(platform);

    expect(refresh).toHaveBeenCalledWith("cached accessory update", 1000);
  });

  test("the accessory is registered with the unchanged plugin name", async () => {
    // PLUGIN_NAME is deliberately the pre-Matter identifier: changing it would
    // miss the Matter cache and force every user to re-pair every robot. A
    // change in this method is exactly where that could slip in.
    const { platform, matterApi } = createPlatform();

    await discover(platform);

    expect(matterApi.registerPlatformAccessories).toHaveBeenCalledWith(
      "homebridge-roborock-vacuum",
      expect.any(String),
      expect.any(Array)
    );
  });
});
