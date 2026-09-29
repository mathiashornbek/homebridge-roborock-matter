"use strict";

// CooperCGN opened #28 asking how to continue a clean from HomeKit, and the
// answer turned out to be that he could not.
//
// His automation pauses the robot when the house door opens and resumes it
// when the door closes. The reason is not tidiness: he once left that door
// open, the robot drove out of it and fell down a flight of stairs. He had
// been doing this with a Python script against the Roborock library and
// wanted to drop it.
//
// Pause worked. Resume did not — the play button on the tile started a whole
// new cleaning run. Asked which kind of clean had been interrupted, he tested
// both and reported back (23 Sept 2026):
//
//   "you're absolutely right, it happens during a room clean. While a full
//    clean is continued as expected a paused room clean is restarted as a
//    new full clean."
//
// Which is exactly what the code said it would do. Matter's Resume has always
// dispatched `app_start` (`resumeCleaning`), and `app_start` on a paused full
// clean continues it — but on a paused ROOM clean it is a fresh whole-home
// start. Roborock's own verb for the second case, `resume_segment_clean`, has
// sat in `deviceFeatures.js` since the library was imported and has never
// been sent from anywhere in this plugin.
//
// WHY THIS IS GATED RATHER THAN SWITCHED. A resume verb sent to a robot that
// is NOT in a room clean is how the play button breaks for everyone, and that
// cannot be verified without a robot paused mid-room-clean. So the gate is
// the robot's own answer: `in_cleaning` is 0 for a whole-home run and
// non-zero when the robot was sent at selected areas, and unlike `state` it
// survives the pause (a paused robot reports state 10 and nothing else).
// Absent or unreadable reads as a full clean, which is what every release
// before this one assumed for every robot.
//
// These tests pin both directions. The one that must never regress is the
// second describe: the ordinary play button still sends `app_start`.

const RoborockMatterVacuumAccessory =
  require("../src/matter_vacuum_accessory").default;

const PAUSED = 10;

function createPlatform({ status = {}, sent = [], api = {} } = {}) {
  return {
    platformConfig: { enableMatter: true, enableMatterCleanMode: true },
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    getMatterApi: () => ({
      updateAccessoryState: jest.fn().mockResolvedValue(undefined),
    }),
    shouldAcceptUnscopedLiveMessage: () => true,
    roborockAPI: {
      getVacuumDeviceInfo: (duid, property) =>
        property === "name" ? "Rocky" : "",
      getProductAttribute: () => "roborock.vacuum.a144",
      getVacuumDeviceStatus: (duid, property) => status[property] ?? "",
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
      applyMatterCleanModeSettings: jest.fn().mockResolvedValue(undefined),
      app_start: jest.fn(async () => {
        sent.push("app_start");
      }),
      app_stop: jest.fn(async () => {
        sent.push("app_stop");
      }),
      app_pause: jest.fn(async () => {
        sent.push("app_pause");
      }),
      app_charge: jest.fn(async () => {
        sent.push("app_charge");
      }),
      resume_segment_clean: jest.fn(async () => {
        sent.push("resume_segment_clean");
      }),
      supportsSegmentResume: () => true,
      ...api,
    },
  };
}

function createAccessory(platform) {
  const accessory = { UUID: "uuid-resume", context: { duid: "device-1" } };
  new RoborockMatterVacuumAccessory(
    platform,
    accessory,
    { duid: "device-1" },
    true
  );
  return accessory.handlers;
}

/** `dispatchRoborockMatterCommand` is fire-and-forget; let its chain settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

async function pressPlay(options) {
  const sent = [];
  const platform = createPlatform({ ...options, sent });
  const handlers = createAccessory(platform);

  await handlers.rvcOperationalState.resume();
  await settle();

  return { sent, platform };
}

describe("#28: resuming a paused room clean continues it", () => {
  test("a robot paused mid-room-clean is told to continue, not to start", async () => {
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 2 },
    });

    expect(sent).toEqual(["resume_segment_clean"]);
    expect(sent).not.toContain("app_start");
  });

  test("any non-zero in_cleaning counts, because the exact codes are not ours", async () => {
    // Roborock uses more than one non-zero value here across firmwares (a
    // segment clean has been seen reported as 3), and this plugin has no
    // measurement that pins which value means which kind of targeted clean.
    // What it does know is the part that matters: zero means whole-home.
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 3 },
    });

    expect(sent).toEqual(["resume_segment_clean"]);
  });

  test("a failed continue is not quietly turned into a whole-home run", async () => {
    // The failure mode worth spelling out. Falling back to `app_start` here
    // would produce precisely the outcome #28 is about — a full clean nobody
    // asked for — at the moment the robot is least likely to be somewhere
    // safe. A paused robot stays paused and the user presses play again.
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 2 },
      api: {
        resume_segment_clean: jest.fn(async () => {
          throw new Error(
            "Cloud request with id 12 with method resume_segment_clean timed out after 10 seconds"
          );
        }),
      },
    });

    expect(sent).not.toContain("app_start");
  });
});

describe("the ordinary play button is untouched", () => {
  test("a paused full clean still resumes with app_start", async () => {
    // CooperCGN confirmed this half already works, so it is the half that
    // must not move.
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 0 },
    });

    expect(sent).toEqual(["app_start"]);
  });

  test("a robot that does not report in_cleaning is treated as a full clean", async () => {
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71 },
    });

    expect(sent).toEqual(["app_start"]);
  });

  test("a B01 robot keeps today's behaviour rather than a guessed control code", async () => {
    // `service.set_room_clean` carries ctrl_value STOP/START/PAUSE and no
    // measured continue value. Guessing one would break the play button for
    // every B01 owner at once, so the dialect opts out and the limitation is
    // reported instead.
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 2 },
      api: { supportsSegmentResume: () => false },
    });

    expect(sent).toEqual(["app_start"]);
  });

  test("an API without the verb at all falls back rather than throwing", async () => {
    const { sent } = await pressPlay({
      status: { state: PAUSED, battery: 71, in_cleaning: 2 },
      api: { resume_segment_clean: undefined },
    });

    expect(sent).toEqual(["app_start"]);
  });
});
