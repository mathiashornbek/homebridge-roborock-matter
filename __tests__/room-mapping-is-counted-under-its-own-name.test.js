"use strict";

// Two users, two robots, one sentence that does not add up.
//
// DSimeone1989 (#22, `roborock.vacuum.a144`) and Marrand (#24,
// `roborock.vacuum.a51`) both pasted a line of this shape, independently, and
// Marrand asked the question outright — "some messages say `Failed to execute
// get_room_mapping`, but the actual error underneath says `method get_status
// timed out`; is the method name in that line misleading?":
//
//   Failed to execute get_room_mapping on robot Rocky (roborock.vacuum.a144):
//   Error: Cloud request with id 5563 with method get_status timed out after
//   10 seconds. MQTT connection state: true … 483 similar warning(s) across
//   get_status (359), get_room_mapping (119) … were suppressed.
//
// The name is not misleading. It is the diagnosis. `get_room_mapping` is the
// CALLER's label; `get_status` is what actually went on the wire, because the
// classic room-mapping branch opens by fetching `get_status` purely to read
// `map_status` and derive a floor number. #14 found the same shape on B01 in
// 3.11.0 and it was fixed there by returning early; the classic path kept it.
//
// THE PART THAT WAS NOT KNOWN UNTIL NOW: that extra request also puts this
// poll permanently out of reach of the give-up register.
//
// From 3.32.0 the register is fed by `messageQueueHandler`, which counts the
// method that goes on the WIRE, and it only counts pairs a skipping caller
// has claimed with `govern()`. `pollParameter` claims `get_room_mapping` —
// and then the wire sees `get_status`, a method the register must NEVER
// govern, so the timeout is discarded by design. The claimed pair records
// nothing, ever. Six strikes are unreachable.
//
// That is why Marrand's 3.32.0 report lists `get_multi_maps_list`,
// `get_consumable`, `get_server_timer`, `get_timer`, `get_carpet_mode`,
// `get_carpet_clean_mode` and `get_water_box_custom_mode` reaching their
// cooldown — and not `get_room_mapping`, the method with 119 suppressed
// warnings in #22. The one users name most often was the one method the new
// register could not see.
//
// The rule these tests pin, which is bigger than this branch: A POLL THAT
// CLAIMS A METHOD MUST PUT THAT METHOD ON THE WIRE FIRST. Any future branch
// that fronts a governed poll with a different request re-opens this hole,
// and fails here rather than in someone's log six weeks later.

const { vacuum } = require("../roborockLib/lib/vacuum");
const {
  UnansweredMethodBreaker,
} = require("../roborockLib/lib/unansweredMethodBreaker");

const DUID = "duid-classic";

function timeout(method) {
  return new Error(
    `Cloud request with id 5563 with method ${method} timed out after 10 seconds. MQTT connection state: true`
  );
}

function createAdapter({
  cachedMapStatus,
  roomMappingAnswers = true,
  statusAnswers = true,
} = {}) {
  /** @type {Record<string, {val: unknown}>} */
  const states = {};
  if (cachedMapStatus !== undefined) {
    states[`Devices.${DUID}.deviceStatus.map_status`] = {
      val: cachedMapStatus,
    };
  }

  return {
    states,
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest: jest.fn((duid, method) => {
        if (method === "get_status") {
          // 8 >> 2 === 2. The same floor the cached state carries, so a test
          // that reads the wrong source still gets a plausible number and
          // has to be caught by the wire assertions rather than by luck.
          return statusAnswers
            ? Promise.resolve([{ map_status: 8 }])
            : Promise.reject(timeout("get_status"));
        }
        if (method === "get_room_mapping") {
          return roomMappingAnswers
            ? Promise.resolve([[101, 55]])
            : Promise.reject(timeout("get_room_mapping"));
        }
        return Promise.resolve([]);
      }),
    },
    isB01Device: jest.fn(() => false),
    catchError: jest.fn(),
    config: { updateInterval: 60 },
    socket: null,
    getStateAsync: jest.fn((id) => states[id]),
    getObjectAsync: jest.fn().mockResolvedValue({}),
    roomIDs: {},
    isCleaning: jest.fn().mockReturnValue(false),
    startMapUpdater: jest.fn(),
    stopMapUpdater: jest.fn(),
    manageDeviceIntervals: jest.fn(),
    updateRoomMappingCache: jest.fn(),
    updateMapListCache: jest.fn(),
    createStateObjectHelper: jest.fn().mockResolvedValue(undefined),
    setStateAsync: jest.fn().mockResolvedValue(undefined),
    setStateChangedAsync: jest.fn().mockResolvedValue(undefined),
    setObjectAsync: jest.fn().mockResolvedValue(undefined),
    vacuums: {
      [DUID]: {
        features: {
          getConsumablesDivider: jest.fn(),
          getStatusDivider: jest.fn(),
          hasDeviceStatusAttribute: jest.fn(() => true),
          processDockType: jest.fn(),
          getFirmwareFeature: jest.fn(),
        },
      },
    },
  };
}

async function pollRoomMapping(options) {
  const adapter = createAdapter(options);
  const robot = new vacuum(adapter, "roborock.vacuum.a144");

  await robot.getParameter(DUID, "get_room_mapping");

  return {
    adapter,
    wireMethods: adapter.messageQueueHandler.sendRequest.mock.calls.map(
      (call) => call[1]
    ),
  };
}

describe("the classic room-mapping poll asks for room mappings", () => {
  test("the only request it makes is the one it is named after", async () => {
    const { wireMethods } = await pollRoomMapping({ cachedMapStatus: 2 });

    expect(wireMethods).toEqual(["get_room_mapping"]);
  });

  test("the floor comes from the status the plugin already polled", async () => {
    const { adapter } = await pollRoomMapping({ cachedMapStatus: 2 });

    // `Devices.<duid>.deviceStatus.map_status` is written by the status poll
    // ALREADY SHIFTED (vacuum.js does `>> 2` before storing it), which is why
    // `app_segment_clean` has always read `roomFloor.val` straight. Shifting
    // it a second time here would file every room under floor 0.
    expect(adapter.getStateAsync).toHaveBeenCalledWith(
      `Devices.${DUID}.deviceStatus.map_status`
    );
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(DUID, 2, [
      [101, 55],
    ]);
  });

  test("a cached floor of 0 is a floor, not a missing value", async () => {
    // The falsy trap: floor 0 is the common case for a single-map home.
    const { adapter, wireMethods } = await pollRoomMapping({
      cachedMapStatus: 0,
    });

    expect(wireMethods).toEqual(["get_room_mapping"]);
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(DUID, 0, [
      [101, 55],
    ]);
  });

  test("with no status cached yet it still asks, rather than guessing a floor", async () => {
    // First cycle after a restart: the status interval and this one start
    // together, so the cache can genuinely be empty. Filing rooms under a
    // made-up floor would hide them from `app_segment_clean`, which looks
    // them up under the real one. Asking once is the lesser cost.
    const { adapter, wireMethods } = await pollRoomMapping({});

    expect(wireMethods).toEqual(["get_status", "get_room_mapping"]);
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(DUID, 2, [
      [101, 55],
    ]);
  });

  test("a non-numeric cached value is treated as no value", async () => {
    const { wireMethods } = await pollRoomMapping({ cachedMapStatus: null });

    expect(wireMethods).toEqual(["get_status", "get_room_mapping"]);
  });
});

describe("a claimed poll is counted under the name it claimed", () => {
  // The register keys on (robot, WIRE method) and ignores anything no
  // skipping caller claimed. So "claimed name === first wire name" is not a
  // stylistic preference — it is the precondition for the register working
  // at all.
  function feedRegisterFrom(wireMethods, { governed }) {
    const breaker = new UnansweredMethodBreaker({ now: () => 1_000 });
    breaker.govern(DUID, governed);

    // Six poll cycles, every request timing out, exactly as the message
    // layer would report them.
    for (let cycle = 0; cycle < 6; cycle += 1) {
      for (const method of wireMethods) {
        breaker.recordFailure(DUID, method, new Error("timed out after 10"));
      }
    }

    return breaker;
  }

  test("the robot in #22 and #24 is asked the question it is failing", async () => {
    // Their exact case: `get_status` is the request that times out. Before
    // this change that killed the branch before `get_room_mapping` was ever
    // sent, so the robot was never actually asked for its rooms AND the
    // register saw nothing to count. Both halves are fixed by not making the
    // request at all.
    const { wireMethods } = await pollRoomMapping({
      cachedMapStatus: 2,
      statusAnswers: false,
      roomMappingAnswers: false,
    });

    expect(wireMethods).toEqual(["get_room_mapping"]);
  });

  test("six unanswered room-mapping polls finally stop the flood", async () => {
    const { wireMethods } = await pollRoomMapping({
      cachedMapStatus: 2,
      statusAnswers: false,
      roomMappingAnswers: false,
    });
    const breaker = feedRegisterFrom(wireMethods, {
      governed: "get_room_mapping",
    });

    expect(breaker.shouldSkip(DUID, "get_room_mapping")).toBe(true);
  });

  test("the register still refuses to govern the status poll itself", async () => {
    // The guarantee that must survive this change: the tile lives on
    // `get_status`, and nothing here may ever close it.
    const { wireMethods } = await pollRoomMapping({});
    const breaker = feedRegisterFrom(wireMethods, {
      governed: "get_room_mapping",
    });

    expect(breaker.shouldSkip(DUID, "get_status")).toBe(false);
  });

  test("a poll fronted by an unclaimable request can never be counted", async () => {
    // The old shape, kept as the control: when `get_status` goes first and
    // dies, `get_room_mapping` never reaches the wire at all, so the claimed
    // pair records nothing and six strikes are unreachable. This is still
    // true on the fallback path above, which is precisely why the fallback
    // must stay rare rather than be the normal case.
    const breaker = feedRegisterFrom(["get_status"], {
      governed: "get_room_mapping",
    });

    expect(breaker.shouldSkip(DUID, "get_room_mapping")).toBe(false);
  });
});
