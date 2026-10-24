"use strict";

/**
 * Routine cloud events are logged at the level they deserve.
 *
 * The periodic refresh of the robot list is not fatal when it fails. During a
 * nightly network outage the maintainer's log said "Failed to update
 * updateHomeData with error: Error: getaddrinfo EAI_AGAIN api-eu.roborock.com"
 * — an error, an internal method name, and no word on what happens next. The
 * robots already known keep working and the next refresh tries again, so it
 * is a warning that says so.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const { Roborock } = require("../roborockLib/roborockAPI");

const created = [];

afterEach(async () => {
  for (const api of created.splice(0)) {
    await api.stopService();
  }
});

function makeApi() {
  const api = new Roborock({
    username: "a@b",
    password: "x",
    cloudOnlyMode: true,
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "home-refresh-")),
  });
  created.push(api);
  return api;
}

test("a refresh the network loses is a warning that says what happens next", async () => {
  const api = makeApi();
  // A real connection failure: nothing listens on port 1.
  api.api = axios.create({ baseURL: "http://127.0.0.1:1/", proxy: false });

  await api.updateHomeData(1);

  expect(api.log.error).not.toHaveBeenCalled();
  expect(api.log.warn).toHaveBeenCalledWith(
    "The robot list could not be refreshed from Roborock's cloud (connect ECONNREFUSED 127.0.0.1:1). The robots already known keep working; the next refresh tries again."
  );
});

test("a refresh Roborock answers without a home says so once", async () => {
  const api = makeApi();
  api.api = { get: jest.fn().mockResolvedValue({ data: { result: null } }) };

  await api.updateHomeData(1);

  expect(api.log.warn).toHaveBeenCalledWith(
    "The robot list could not be refreshed from Roborock's cloud (the cloud returned no home data for home 1). The robots already known keep working; the next refresh tries again."
  );
});

test("a Q7's pushed datapoints are named at debug, not on every start at info", () => {
  // The line is a note for whoever reads a debug log; on the maintainer's Pi
  // it was the one info line each Q7 wrote on every start.
  const api = makeApi();
  api.getProductAttribute = () => "roborock.vacuum.sc05";
  api.getStatus = jest.fn().mockResolvedValue(undefined);

  api.onB01DatapointPush("q7-duid", { 101: 5 });

  expect(api.log.info).not.toHaveBeenCalled();
  expect(api.log.debug).toHaveBeenCalledWith(
    expect.stringContaining("pushed datapoints")
  );
  expect(api.getStatus).toHaveBeenCalledWith("q7-duid", { force: true });
});
