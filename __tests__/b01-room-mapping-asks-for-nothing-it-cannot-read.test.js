"use strict";

// niclasreich (#14) runs a Q10 S5 (`roborock.vacuum.ss07`, B01 protocol,
// cloud-only) and reported this line once a poll cycle:
//
//   Failed to execute get_room_mapping on robot Saugroboter
//   (roborock.vacuum.ss07): Error: Cloud request with id 948214125889 with
//   method prop.get timed out after 10 seconds. MQTT connection state: true
//
// The two names in that sentence disagree on purpose, and that is the whole
// clue: `get_room_mapping` is the CALLER's label, `prop.get` is what actually
// went on the wire. The classic room-mapping branch in `vacuum.getParameter`
// opens by fetching `get_status` purely to read `map_status` and derive a
// floor number — and on B01 `get_status` translates to a real `prop.get`.
//
// `map_status` is a v1-only field. B01 status responses are Q7 dictionaries
// and have never carried it (see the 3.11.0 note in CHANGELOG.md). So the
// request is one that cannot be answered usefully no matter what the robot
// replies: a full cloud round-trip per poll cycle per robot, with its own ten
// second timeout, spent on a field that is not in the response.
//
// `get_room_mapping` itself is already harmless on B01 — the send choke point
// answers it from NEUTRAL_RESPONSES with `[]` without touching the network.
// That is exactly why `pollParameter`'s dialect skip does not catch this:
// `canAnswerV1Method("get_room_mapping")` is true, so the poll is allowed
// through, and the damage is done by the *other* request the branch makes.
//
// This tests the class rather than the one field. The rule is: on a B01
// robot the classic room-mapping flow puts NOTHING on the wire. A future
// branch that adds another v1-shaped probe in front of the neutral one fails
// here instead of in someone's log.

const { vacuum } = require("../roborockLib/lib/vacuum");
const { Roborock } = require("../roborockLib/roborockAPI");
const b01Q7Adapter = require("../roborockLib/lib/b01Q7Adapter");

function createAdapter({ isB01 }) {
  return {
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    messageQueueHandler: {
      sendRequest: jest.fn((duid, method) => {
        if (method === "get_status") {
          return Promise.resolve([{ map_status: 8 }]);
        }
        if (method === "get_room_mapping") {
          // What the B01 choke point hands back for this method.
          return Promise.resolve(isB01 ? [] : [[101, 55]]);
        }
        return Promise.resolve([]);
      }),
    },
    isB01Device: jest.fn(() => isB01),
    config: { updateInterval: 60 },
    socket: null,
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
      "duid-q10": {
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

async function roomMappingRequests({ isB01, model }) {
  const adapter = createAdapter({ isB01 });
  const robot = new vacuum(adapter, model);

  await robot.getParameter("duid-q10", "get_room_mapping");

  return {
    adapter,
    methods: adapter.messageQueueHandler.sendRequest.mock.calls.map(
      (call) => call[1]
    ),
  };
}

describe("the classic room-mapping flow stays off the wire on B01 robots", () => {
  test("a B01 robot is asked for nothing at all", async () => {
    const { methods } = await roomMappingRequests({
      isB01: true,
      model: "roborock.vacuum.ss07",
    });

    expect(methods).toEqual([]);
  });

  test("no request is made whose answer the dialect cannot carry", async () => {
    const { methods } = await roomMappingRequests({
      isB01: true,
      model: "roborock.vacuum.ss07",
    });

    // The rule, not the one field: any v1-shaped request issued here is one
    // whose response is a Q7 dictionary the branch does not know how to read.
    for (const method of methods) {
      expect(b01Q7Adapter.translateOutgoing(method, [])).toBeNull();
    }
    expect(methods).not.toContain("get_status");
  });

  test("a B01 robot produces no empty-room noise once a poll cycle", async () => {
    const { adapter } = await roomMappingRequests({
      isB01: true,
      model: "roborock.vacuum.ss07",
    });

    // Unthrottled, and the poller runs it every cycle per robot. Room data on
    // these robots arrives over the protobuf map channel, so "no room
    // mappings returned" is not news — it is the shape of the model.
    const said = adapter.log.info.mock.calls.map((call) => String(call[0]));
    expect(said).not.toContainEqual(
      expect.stringContaining("No room mappings returned")
    );
    expect(adapter.updateRoomMappingCache).not.toHaveBeenCalled();
  });

  test("a v1 robot still runs the full classic flow", async () => {
    // The control that keeps the guard load-bearing: the day this stops
    // reading map_status for the robots that do send it, this goes red.
    const { adapter, methods } = await roomMappingRequests({
      isB01: false,
      model: "roborock.vacuum.a08",
    });

    expect(methods).toEqual(["get_status", "get_room_mapping"]);
    expect(adapter.updateRoomMappingCache).toHaveBeenCalledWith(
      "duid-q10",
      2, // map_status 8 >> 2
      [[101, 55]]
    );
  });
});

describe("isB01Device is the single source of truth for the dialect", () => {
  // Four call sites in roborockAPI.js spelled this comparison out by hand
  // before it had a name. A fifth was about to be added in vacuum.js, which
  // is one hand-written copy too many for a value that decides which wire
  // protocol a robot speaks.
  const isB01Device = Roborock.prototype.isB01Device;

  test("true for the B01 protocol version", () => {
    const api = { getVacuumDeviceInfo: jest.fn(() => "B01") };
    expect(isB01Device.call(api, "duid-q10")).toBe(true);
    expect(api.getVacuumDeviceInfo).toHaveBeenCalledWith("duid-q10", "pv");
  });

  test("it reads the constant rather than the literal", () => {
    const api = {
      getVacuumDeviceInfo: () => b01Q7Adapter.B01_PROTOCOL_VERSION,
    };
    expect(isB01Device.call(api, "duid-q10")).toBe(true);
  });

  test.each(["1.0", "A01", "L01", "", undefined])(
    "false for protocol version %p",
    (version) => {
      const api = { getVacuumDeviceInfo: () => version };
      expect(isB01Device.call(api, "duid-q10")).toBe(false);
    }
  );
});
