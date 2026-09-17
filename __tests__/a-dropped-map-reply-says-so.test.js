"use strict";

/**
 * THE OLDEST OPEN BUG IN THIS PROJECT, and why nobody could diagnose it.
 *
 * `get_map_v1` on a classic robot times out after 10 seconds, forever, while
 * the same robot answers everything else: 95 consecutive failures on my own
 * a70 (225 twelve days earlier), 40 on the a75 in #9.
 *
 * Map replies do not come back on the ordinary reply path. They arrive as
 * protocol 301 frames, and the 301 handler had several ways to drop one, all
 * of them a bare `return` — no log, no counter, nothing. A dropped 301 leaves
 * the pending request to die on its timer, which is indistinguishable from a
 * robot that never answered. That is why this was never diagnosed: there was
 * nothing to diagnose it WITH.
 *
 * One of those drops was also wrong. The endpoint guard read
 *
 *     if (!endpoint.startsWith(data2.endpoint)) return;
 *
 * where `endpoint` is our own 8-character key and `data2.endpoint` is a
 * 15-byte wire field with only TRAILING nulls stripped. python-roborock, the
 * reference implementation, compares it the other way round —
 * `received.startswith(ours)`. As written, any byte after our 8 characters
 * that is not a trailing null makes the received string longer than 8, and an
 * 8-character string can never `startsWith` a longer one. It failed closed,
 * on a reply addressed to us, in silence.
 *
 * These tests do not claim this IS the cause of the a70 timeouts — that is a
 * measurement the next clean will make, now that the drop says so. They pin
 * the comparison against the reference implementation, and that no path drops
 * a 301 without saying why.
 */

const fs = require("fs");
const path = require("path");

const SOURCE = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "roborockLib",
    "lib",
    "roborock_mqtt_connector.js"
  ),
  "utf8"
);

/** The comparison, extracted so it can be exercised directly. */
function isAddressedToUs(ourEndpoint, wireEndpoint) {
  return String(wireEndpoint || "").startsWith(ourEndpoint);
}

describe("the endpoint comparison matches the reference implementation", () => {
  const ours = "Ab3dEf7h"; // 8 chars, base64, no padding

  test("an exact echo is ours", () => {
    expect(isAddressedToUs(ours, ours)).toBe(true);
  });

  test("our 8 characters followed by junk is STILL ours — this is the bug", () => {
    // binary-parser strips trailing NULs only, so a robot that pads with
    // anything else leaves a longer string. The old comparison rejected this;
    // python-roborock accepts it.
    expect(isAddressedToUs(ours, ours + String.fromCharCode(0) + "x")).toBe(
      true
    );
    expect(isAddressedToUs(ours, ours + "  ")).toBe(true);
    expect(isAddressedToUs(ours, ours + "zz")).toBe(true);
  });

  test("a different endpoint is not ours", () => {
    expect(isAddressedToUs(ours, "Zz9yXw1v")).toBe(false);
    expect(isAddressedToUs(ours, "")).toBe(false);
  });

  test("a truncated echo is not ours", () => {
    expect(isAddressedToUs(ours, ours.slice(0, 6))).toBe(false);
  });

  test("the old, inverted comparison is gone from the source", () => {
    expect(SOURCE).not.toMatch(/endpoint\.startsWith\(data2\.endpoint\)/);
    expect(SOURCE).toMatch(
      /String\(data2\.endpoint \|\| ""\)\.startsWith\(endpoint\)/
    );
  });
});

describe("no protocol 301 frame is dropped in silence", () => {
  const region = (() => {
    const start = SOURCE.indexOf("} else if (data.protocol == 301) {");
    return SOURCE.slice(start, start + 9000);
  })();

  test("the branch was found", () => {
    expect(region.length).toBeGreaterThan(500);
  });

  test("the endpoint drop explains itself, and names the robot", () => {
    const at = region.indexOf(
      'String(data2.endpoint || "").startsWith(endpoint)'
    );
    expect(at).toBeGreaterThan(-1);
    const after = region.slice(at, at + 1200);
    expect(after).toMatch(/log\.(debug|info|warn)/);
    expect(after).toMatch(/endpoint/);
    expect(after).toMatch(/\$\{duid\}/);
  });

  test("an unmatched request id explains itself", () => {
    expect(region).toMatch(/no request is waiting for that id/i);
  });
});

describe("one robot unfinished photo cannot swallow another robot map", () => {
  test("the chunk buffer is per robot, not per process", () => {
    // `let photoGzipChunks = []` / `let photoChunkID = 0` at module scope were
    // shared by every robot on the account, and cleared only when a transfer
    // COMPLETED. One robot going offline between chunk 1 and chunk 2 left the
    // id set forever, and from then on every 301 frame with seq == 2 from ANY
    // robot was swallowed into that stale buffer.
    expect(SOURCE).not.toMatch(/^let photoGzipChunks = \[\];$/m);
    expect(SOURCE).not.toMatch(/^let photoChunkID = 0;$/m);
    expect(SOURCE).toMatch(/photoBuffers = new Map\(\)/);
    expect(SOURCE).toMatch(/function photoBufferFor\(duid\)/);
  });

  test("a buffer whose request is no longer waiting is discarded", () => {
    expect(SOURCE).toMatch(
      /photoBuffer\.chunkId !== 0 &&\s*!this\.adapter\.pendingRequests\.has\(photoBuffer\.chunkId\)/
    );
  });

  test("the module still loads with the rewritten buffer", () => {
    expect(
      require("../roborockLib/lib/roborock_mqtt_connector.js")
    ).toBeTruthy();
  });
});
