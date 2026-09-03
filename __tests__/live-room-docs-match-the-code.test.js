"use strict";

// Live-room tracking is described in three places written at three different
// times, and by 3.25.0 two of them were stating things the code had stopped
// doing.
//
// `config.schema.json` still said the feature applies "while a B01/Q7-series
// robot is actively cleaning". Classic S/Q-series robots have been covered
// since 2.7.0 (`refreshClassicLiveRoom`, commit c07a1ae) — eighteen minor
// versions of a settings description telling a Q8 Max owner the feature is
// not for them. The same sentence, and the JSDoc over `refreshB01LiveRoom`,
// both claimed a ~20 second fetch gap while `B01_LIVE_ROOM_MIN_FETCH_GAP_MS`
// has been 10000. The README was the only surface that had been kept current,
// which is the tell: prose that nothing checks drifts one surface at a time.
//
// So this pins the class rather than the two sentences. Any prose that names a
// live-room fetch interval must name the constant's value, wherever it is
// written; and the settings description may not scope the feature to one
// protocol family while the dispatcher still routes to both.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const API_PATH = path.join(REPO, "roborockLib", "roborockAPI.js");

const apiSource = fs.readFileSync(API_PATH, "utf8");
const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const schema = JSON.parse(
  fs.readFileSync(path.join(REPO, "config.schema.json"), "utf8")
);

const liveRoomSetting =
  schema.schema.properties.enableLiveRoomTracking.description;

/** The one number every piece of prose below is describing. */
function fetchGapSeconds() {
  const match = apiSource.match(
    /const\s+B01_LIVE_ROOM_MIN_FETCH_GAP_MS\s*=\s*(\d+)/
  );
  expect(match).not.toBeNull();
  return Number(match[1]) / 1000;
}

/** "min 20s", "every ~20 seconds", "~10 s" — an interval stated in prose. */
const INTERVAL = /(?:min\s*~?|every\s*~?|~)\s*(\d+)\s*(?:s\b|seconds?\b)/gi;

function intervalsIn(text) {
  const found = [];
  let match;
  const pattern = new RegExp(INTERVAL.source, INTERVAL.flags);
  while ((match = pattern.exec(text)) !== null) {
    found.push(Number(match[1]));
  }
  return found;
}

/** Comment blocks and paragraphs that are talking about the live room. */
function liveRoomProse() {
  const mentionsLiveRoom = (text) => /live[-\s]?room/i.test(text);
  const prose = [];

  const comments =
    apiSource.match(
      /\/\*\*[\s\S]*?\*\/|(?:^[ \t]*\/\/.*(?:\r?\n[ \t]*\/\/.*)*)/gm
    ) || [];
  for (const comment of comments) {
    if (mentionsLiveRoom(comment)) {
      prose.push({ where: "roborockLib/roborockAPI.js", text: comment });
    }
  }

  for (const paragraph of readme.split(/\n\s*\n/)) {
    if (mentionsLiveRoom(paragraph)) {
      prose.push({ where: "README.md", text: paragraph });
    }
  }

  prose.push({ where: "config.schema.json", text: liveRoomSetting });
  return prose;
}

describe("live-room documentation matches the code it describes", () => {
  test("every documented fetch interval is the constant's value", () => {
    const expected = fetchGapSeconds();
    const wrong = [];

    for (const { where, text } of liveRoomProse()) {
      for (const seconds of intervalsIn(text)) {
        if (seconds !== expected) {
          wrong.push(`${where}: claims ${seconds}s, constant is ${expected}s`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  test("at least one surface states the interval, so the rule has something to hold", () => {
    const stated = liveRoomProse().flatMap(({ text }) => intervalsIn(text));
    expect(stated.length).toBeGreaterThan(0);
  });

  test("the setting description does not scope the feature to one protocol family", () => {
    // Read the dispatcher first: the description is only wrong about this
    // while both branches exist. If classic support is ever removed, this
    // test should stop demanding that the description mention it.
    const dispatcher = apiSource.slice(
      apiSource.indexOf("async refreshLiveRoomForDevice("),
      apiSource.indexOf("getLiveRoomForDevice(duid) {")
    );
    expect(dispatcher).toContain("refreshB01LiveRoom");
    expect(dispatcher).toContain("refreshClassicLiveRoom");

    // Both protocols are routed, so both must be findable in the description
    // a user reads before deciding the setting is not for their robot.
    expect(liveRoomSetting).toMatch(/B01|Q7/);
    expect(liveRoomSetting).toMatch(/classic/i);

    // And it must not open by restricting the whole feature to one of them.
    expect(liveRoomSetting).not.toMatch(/While a B01/i);
  });
});
