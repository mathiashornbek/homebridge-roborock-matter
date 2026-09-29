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
  statusReply,
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
            ? Promise.resolve(statusReply ?? [{ map_status: 8 }])
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
    //
    // THE ORDER IS THE POINT, AND IT CHANGED IN 3.34.0. 3.33.0 asked for the
    // floor first and only then for the rooms, which put an unclaimable
    // request in front of the claimed one on exactly the robots that needed
    // the register most. The claimed method goes first; the floor is
    // resolved afterwards.
    const { adapter, wireMethods } = await pollRoomMapping({});

    expect(wireMethods).toEqual(["get_room_mapping", "get_status"]);
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(DUID, 2, [
      [101, 55],
    ]);
  });

  test("a non-numeric cached value is treated as no value", async () => {
    const { wireMethods } = await pollRoomMapping({ cachedMapStatus: null });

    expect(wireMethods).toEqual(["get_room_mapping", "get_status"]);
  });
});

// The register keys on (robot, WIRE method) and ignores anything no skipping
// caller claimed. So "claimed name === first wire name" is not a stylistic
// preference — it is the precondition for the register working at all.
function feedRegisterFrom(wireMethods, { governed }) {
  const breaker = new UnansweredMethodBreaker({ now: () => 1_000 });
  breaker.govern(DUID, governed);

  // Six poll cycles, every request timing out, exactly as the message layer
  // would report them.
  for (let cycle = 0; cycle < 6; cycle += 1) {
    for (const method of wireMethods) {
      breaker.recordFailure(DUID, method, new Error("timed out after 10"));
    }
  }

  return breaker;
}

describe("a claimed poll is counted under the name it claimed", () => {
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
    // pair records nothing and six strikes are unreachable.
    const breaker = feedRegisterFrom(["get_status"], {
      governed: "get_room_mapping",
    });

    expect(breaker.shouldSkip(DUID, "get_room_mapping")).toBe(false);
  });
});

// WHAT 3.33.0 STILL GOT WRONG, AND WHY IT IS THE SAME BUG TWICE.
//
// 3.33.0 moved the floor to the cached status and left a `get_status`
// fallback for "no status has landed yet", reasoning that the status poll
// runs on its own 60-second interval so the fallback would fire at most once
// per restart. Marrand ran 3.33.0 overnight on his a51 and measured the
// opposite (#24, 24 Sept): `get_room_mapping` STILL reported `get_status`
// timing out, at 17:04, 23:04 and 05:04, and still never reached the
// six-strike cooldown that seven other governed methods reached that same
// night. DSimeone1989's a144 log says the same thing (#22, 23 Sept):
// `get_status (248)`, `get_room_mapping (83)` suppressed side by side.
//
// The premise was wrong. `Devices.<duid>.deviceStatus.map_status` is written
// by a SUCCESSFUL status poll — and on both of those robots `get_status` is
// the method that never answers. So the cache is never written, the fallback
// is not the first cycle but every cycle forever, and the branch went on
// opening with a request the register must never govern.
//
// The rule below is the one that had to be stated outright, because "the
// fallback stays rare" was an assumption about someone else's network:
// THE CLAIMED METHOD GOES FIRST EVEN WHEN THE FLOOR IS UNKNOWN. A fallback
// that needs the network is allowed to run second and allowed to fail; it is
// never allowed to decide whether the claimed request happens at all.
describe("the fallback cannot front the method the poll claimed", () => {
  test("with nothing cached and the status poll dead, the rooms are asked for first", async () => {
    // Marrand's and DSimeone1989's robots exactly: no `map_status` has ever
    // been cached because `get_status` has never answered. Under 3.33.0 the
    // wire saw `get_status` alone and the poll died there without ever
    // asking for rooms. The floor lookup may still follow — it just may no
    // longer come first, and may no longer decide whether the claimed
    // request happens.
    const { wireMethods } = await pollRoomMapping({ statusAnswers: false });

    expect(wireMethods[0]).toBe("get_room_mapping");
  });

  test("and six such cycles finally reach the cooldown Marrand was missing", async () => {
    // The whole point, in one assertion: when the rooms go unanswered too —
    // which is what every other method on his a51 does — the register now
    // sees six strikes under the name the caller claimed, and the flood
    // stops. Under 3.33.0 this pair recorded nothing, ever.
    const { wireMethods } = await pollRoomMapping({
      statusAnswers: false,
      roomMappingAnswers: false,
    });
    const breaker = feedRegisterFrom(wireMethods, {
      governed: "get_room_mapping",
    });

    expect(wireMethods).toEqual(["get_room_mapping"]);
    expect(breaker.shouldSkip(DUID, "get_room_mapping")).toBe(true);
  });

  test("rooms that arrived without a floor are returned, not filed under a guess", async () => {
    // The other half. On a robot where the rooms answer and the status does
    // not, 3.33.0 threw at the first `await` and lost the room list entirely.
    // It is kept now — but it is NOT stamped with an invented floor:
    // `updateRoomMappingCache` writes that number onto every room as its map
    // id, and a working Matter service-area cache must not be overwritten
    // with a map that does not exist. Unfiled for one cycle, correct on the
    // next status poll.
    const { adapter } = await pollRoomMapping({ statusAnswers: false });

    expect(adapter.updateRoomMappingCache).not.toHaveBeenCalled();
    expect(adapter.createStateObjectHelper).not.toHaveBeenCalledWith(
      expect.stringContaining(`Devices.${DUID}.floors.`),
      expect.anything(),
      "boolean",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  test("a status reply with no map selected is an answer, and still files the rooms", async () => {
    // The distinction the branch has to keep: a reply that carries no
    // `map_status` says the robot has no map selected, and `-1` has been the
    // sentinel for that for far longer than the register has existed. Only an
    // UNANSWERED request means nothing was learnt.
    const { adapter, wireMethods } = await pollRoomMapping({
      statusReply: [{}],
    });

    expect(wireMethods).toEqual(["get_room_mapping", "get_status"]);
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(DUID, -1, [
      [101, 55],
    ]);
  });

  test("the status poll is still never governed, however this branch fails", async () => {
    // Unchanged guarantee: the tile lives on `get_status`, and nothing here
    // may close it — not even now that `get_status` can fail in this branch.
    const { wireMethods } = await pollRoomMapping({});
    const breaker = feedRegisterFrom(wireMethods, {
      governed: "get_room_mapping",
    });

    expect(breaker.shouldSkip(DUID, "get_status")).toBe(false);
  });
});
