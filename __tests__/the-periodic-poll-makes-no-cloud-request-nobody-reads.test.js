"use strict";

// checkForNewFirmware() sat in the periodic poll chain and asked the Roborock
// cloud for `ota/firmware/<duid>/updatev2` once per robot per updateInterval
// (180 s by default). It never ran: its own gate read
//
//     const isLocalDevice = !this.isRemoteDevice(duid);
//
// and isRemoteDevice is `async`, so the expression negated a Promise — always
// truthy, so isLocalDevice was permanently false. Every other caller of that
// method awaits it; this one line did not.
//
// The obvious repair is to add the missing `await`, and that repair would have
// been a regression. The request's whole result goes to setObjectNotExistsAsync
// (a documented no-op in this plugin) and setStateAsync("Devices.<duid>
// .updateStatus.<field>"), which nothing in the plugin, the UI or the
// diagnostics export ever reads. Awaiting the gate would have bought ~480
// discarded cloud round-trips per robot per day, each of them awaited on the
// poll thread, plus a catchError path that can log a warning once per poll when
// the OTA endpoint is unhappy — the same never-throttled retry loop that 3.19.0,
// 3.19.1 and 3.19.5 each closed one instance of.
//
// So the call is gone rather than awaited, and this file pins the outcome
// rather than the implementation: a periodic poll may not spend a cloud
// round-trip on an answer no one can read. It fails whether the request comes
// back through checkForNewFirmware or through anything written later.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

function createHarness({ protocolVersion, model }) {
  const api = new Roborock({
    log: createLog(),
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "poll-cloud-")),
  });

  api.getProductAttribute = jest.fn(() => model);
  api.getRobotVersion = jest.fn(async () => protocolVersion);
  api.refreshMatterServiceAreaRoomMappings = jest.fn(async () => false);
  api.vacuums["duid-1"] = {
    features: { getFeatureList: () => ({ isCarpetSupported: true }) },
  };

  // Stand in for the authenticated cloud client. Every HTTPS call the poll
  // chain makes has to come through here, so recording it records all of them.
  const cloudGet = jest.fn(async () => ({ data: { result: {} } }));
  api.api = { get: cloudGet, post: jest.fn(async () => ({ data: {} })) };

  const robot = { getParameter: jest.fn(async () => undefined) };
  return { api, robot, cloudGet };
}

async function pollCycles({ protocolVersion, model, cycles }) {
  const { api, robot, cloudGet } = createHarness({ protocolVersion, model });

  for (let i = 0; i < cycles; i++) {
    await api.updateDataMinimumData("duid-1", robot, model);
  }

  return {
    api,
    robot,
    urls: cloudGet.mock.calls.map((call) => String(call[0])),
  };
}

// One full day of polling at the default 180 s interval.
const A_DAY_OF_POLLS = 480;

describe("the periodic poll spends no cloud request on an unread answer", () => {
  test.each([
    ["a Q7-generation B01 robot", "B01", "roborock.vacuum.sc05"],
    ["a Q10-generation B01 robot", "B01", "roborock.vacuum.ss07"],
    ["a classic v1 robot", "1.0", "roborock.vacuum.a70"],
  ])("%s asks for no OTA firmware state", async (_label, pv, model) => {
    const { urls } = await pollCycles({
      protocolVersion: pv,
      model,
      cycles: 20,
    });

    expect(urls.filter((url) => url.includes("ota/firmware"))).toEqual([]);
  });

  test("a day of polling makes no cloud request at all from the poll chain", async () => {
    const { urls } = await pollCycles({
      protocolVersion: "B01",
      model: "roborock.vacuum.sc05",
      cycles: A_DAY_OF_POLLS,
    });

    // Not "few" — none. Everything the poll chain needs travels over the
    // robot's own transport; a cloud round-trip in here is by definition
    // either unread or belongs somewhere it can be throttled.
    expect(urls).toEqual([]);
  });

  test("the writes that request fed were no-ops, so nothing lost a reader", async () => {
    const { api } = await pollCycles({
      protocolVersion: "B01",
      model: "roborock.vacuum.sc05",
      cycles: 3,
    });

    // The state ids checkForNewFirmware wrote. If a future change gives them a
    // reader, that reader needs its own throttled fetch — reviving the poll
    // chain call is not the way back.
    const updateStatusKeys = Object.keys(api.states).filter((id) =>
      id.includes(".updateStatus.")
    );

    expect(updateStatusKeys).toEqual([]);
  });
});

describe("the gate that hid it: an async predicate must be awaited", () => {
  test("isRemoteDevice returns a promise, so negating it unawaited is always false", async () => {
    const { api } = await pollCycles({
      protocolVersion: "B01",
      model: "roborock.vacuum.sc05",
      cycles: 1,
    });

    const pending = api.isRemoteDevice("duid-1");

    expect(typeof pending.then).toBe("function");
    // The shape of the original defect, kept here so the reason the dead code
    // looked alive stays legible: `!promise` is false for every promise there
    // has ever been, so the body behind such a gate can never run.
    expect(!pending).toBe(false);

    await pending;
  });
});
