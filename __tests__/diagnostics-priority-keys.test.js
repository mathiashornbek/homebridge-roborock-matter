"use strict";

// Wazza151's diagnostics export (issue #5) ended with `__truncatedKeys: 20`.
// A Roborock get_status payload runs to about fifty keys and the compactor
// kept the first thirty, which are largely housekeeping — msg_ver, msg_seq,
// lab_status, camera_status. The twenty it dropped included
// dock_error_status: the single field a question about the dock's water tanks
// turns on. Diagnostics that truncate away the answer are not diagnostics.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Roborock } = require("../roborockLib/roborockAPI");

function createApi() {
  return new Roborock({
    log: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
    storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "diag-priority-")),
  });
}

/** A get_status payload shaped like the field reports: filler first. */
function statusPayloadWithFillerBefore(interestingKeys) {
  const payload = {};
  for (let i = 0; i < 40; i += 1) {
    payload[`filler_${i}`] = i;
  }
  return { ...payload, ...interestingKeys };
}

describe("diagnostic compaction keeps what diagnostics are for", () => {
  test("dock and water fields survive even when they sit past the key cap", () => {
    const api = createApi();

    const compacted = api.compactDiagnosticPayload(
      statusPayloadWithFillerBefore({
        dock_error_status: 38,
        water_shortage_status: 1,
        water_box_carriage_status: 0,
        error_code: 8,
        state: 12,
      })
    );

    expect(compacted.dock_error_status).toBe(38);
    expect(compacted.water_shortage_status).toBe(1);
    expect(compacted.water_box_carriage_status).toBe(0);
    expect(compacted.error_code).toBe(8);
    expect(compacted.state).toBe(12);
  });

  test("the cap still applies to everything else", () => {
    const api = createApi();

    const compacted = api.compactDiagnosticPayload(
      statusPayloadWithFillerBefore({ dock_error_status: 0 })
    );

    // 40 filler keys, 30 of which fit; a rescued priority key must not become
    // a licence to dump the whole payload into a support thread.
    const fillerKept = Object.keys(compacted).filter((key) =>
      key.startsWith("filler_")
    );
    expect(fillerKept).toHaveLength(30);
    expect(compacted.__truncatedKeys).toBe(10);
  });

  test("rescuing a key does not rescue a secret", () => {
    const api = createApi();

    const compacted = api.compactDiagnosticPayload(
      statusPayloadWithFillerBefore({ dock_error_status: 38, localkey: "abc" })
    );

    expect(compacted.dock_error_status).toBe(38);
    expect(compacted).not.toHaveProperty("localkey", "abc");
  });
});
