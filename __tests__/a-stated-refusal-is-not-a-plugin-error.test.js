"use strict";

/**
 * Issue #22, second half.
 *
 * 3.21.3 made a refused reply visible instead of silently resolving it with
 * `undefined`. It threw a bare `Error` to do so, which carried no `code` and
 * matched none of `catchError`'s calm branches — so every refusal fell through
 * to the final `else` and was logged with `error.stack`.
 *
 * On the reporter's Saros 10R that is an ERROR line plus a ten-frame stack
 * trace naming our own MQTT handler, twice per poll cycle, forever, for a
 * robot that is behaving exactly as its firmware intends. The stack describes
 * nothing that went wrong and the repetition buries real errors.
 *
 * The rule these tests pin: a refusal the robot stated is a capability fact.
 * It is reported once per robot per method so the owner learns why a feature
 * is missing, it never carries a stack trace, and it never escalates to
 * `log.error`. Transport failures are deliberately left alone — a robot that
 * is unreachable must still shout.
 */

const {
  describeReplyRefusal,
  createRefusalError,
  METHOD_REFUSED_CODE,
} = require("../roborockLib/lib/describeReplyRefusal");

const { Roborock } = require("../roborockLib/roborockAPI");

function makeLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(String(m)),
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

/**
 * `catchError` only needs a log and a device describer. Building the whole
 * adapter here would test the constructor, not the branch.
 */
function makeAdapter(log) {
  const api = Object.create(Roborock.prototype);
  api.log = log;
  api.describeDevice = (duid) => (duid === "duid-1" ? "Rocky" : String(duid));
  return api;
}

const REAL_A144_REPLY = {
  id: 10,
  error: { code: -10007, message: "Not FCC robot" },
};

describe("a refusal the robot stated is tagged at construction", () => {
  test("createRefusalError carries the refused code, not just prose", () => {
    const error = createRefusalError("The robot refused x", REAL_A144_REPLY);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(METHOD_REFUSED_CODE);
    expect(error.robotErrorCode).toBe(-10007);
  });

  test("a reply with no error object still yields a tagged error", () => {
    const error = createRefusalError("The robot refused x", { id: 3 });

    expect(error.code).toBe(METHOD_REFUSED_CODE);
    expect(error.robotErrorCode).toBeUndefined();
  });

  test("the refusal text still reads as the robot's own words", () => {
    expect(describeReplyRefusal(REAL_A144_REPLY)).toBe(
      "Not FCC robot (code -10007)"
    );
  });
});

describe("catchError treats a stated refusal as a fact, not a failure", () => {
  test("the reporter's exact refusal is warned once and never as an error", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    const error = createRefusalError(
      "The robot refused get_server_timer (cloud id 10): Not FCC robot (code -10007)",
      REAL_A144_REPLY
    );

    await api.catchError(
      error,
      "get_server_timer",
      "duid-1",
      "roborock.vacuum.a144"
    );

    expect(log.lines.error).toHaveLength(0);
    expect(log.lines.warn).toHaveLength(1);
    expect(log.lines.warn[0]).toContain("Rocky");
    expect(log.lines.warn[0]).toContain("roborock.vacuum.a144");
    expect(log.lines.warn[0]).toContain("get_server_timer");
    expect(log.lines.warn[0]).toContain("Not FCC robot");
  });

  test("no stack trace reaches the log for a refusal", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    const error = createRefusalError(
      "The robot refused get_server_timer (cloud id 10): Not FCC robot (code -10007)",
      REAL_A144_REPLY
    );

    await api.catchError(
      error,
      "get_server_timer",
      "duid-1",
      "roborock.vacuum.a144"
    );

    const everything = [
      ...log.lines.debug,
      ...log.lines.info,
      ...log.lines.warn,
      ...log.lines.error,
    ].join("\n");

    expect(everything).not.toContain("    at ");
  });

  test("a poll cycle that repeats the refusal forever warns exactly once", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    // Two sends per cycle is what the reporter's log actually shows.
    for (let cycle = 0; cycle < 20; cycle += 1) {
      for (const id of [5, 10]) {
        await api.catchError(
          createRefusalError(
            `The robot refused get_server_timer (cloud id ${id}): Not FCC robot (code -10007)`,
            REAL_A144_REPLY
          ),
          "get_server_timer",
          "duid-1",
          "roborock.vacuum.a144"
        );
      }
    }

    expect(log.lines.warn).toHaveLength(1);
    expect(log.lines.error).toHaveLength(0);
    // The rest are still recoverable at debug for anyone diagnosing.
    expect(log.lines.debug.length).toBe(39);
  });

  test("a different method on the same robot is reported on its own", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    for (const method of ["get_server_timer", "get_timer"]) {
      await api.catchError(
        createRefusalError(`The robot refused ${method}`, REAL_A144_REPLY),
        method,
        "duid-1",
        "roborock.vacuum.a144"
      );
    }

    expect(log.lines.warn).toHaveLength(2);
  });

  test("a different robot refusing the same method is reported on its own", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    for (const duid of ["duid-1", "duid-2"]) {
      await api.catchError(
        createRefusalError(
          "The robot refused get_server_timer",
          REAL_A144_REPLY
        ),
        "get_server_timer",
        duid,
        "roborock.vacuum.a144"
      );
    }

    expect(log.lines.warn).toHaveLength(2);
  });
});

describe("both connectors tag the refusal rather than throwing a bare Error", () => {
  // The decode path is bound to a live socket in both connectors, so the
  // wiring is asserted against the source the same way the sibling suite
  // a-refused-reply-is-not-an-empty-answer.test.js already does. A bare
  // `new Error` here is the whole defect: it reaches catchError untagged and
  // falls through to the stack-trace branch.
  const fs = require("fs");
  const path = require("path");

  function connectorSource(file) {
    return fs.readFileSync(
      path.join(__dirname, "..", "roborockLib", "lib", file),
      "utf8"
    );
  }

  test("the cloud connector builds a tagged refusal", () => {
    const source = connectorSource("roborock_mqtt_connector.js");

    expect(source).toContain("createRefusalError");
    expect(source).toContain(
      "pending.reject(\n                createRefusalError("
    );
  });

  test("the local connector builds a tagged refusal", () => {
    const source = connectorSource("localConnector.js");

    expect(source).toContain("createRefusalError");
    expect(source).toContain("reject(\n          createRefusalError(");
  });

  test("neither connector settles a describeReplyRefusal result with an untagged Error", () => {
    // Scoped to the refusal branch on purpose. The cloud connector also
    // rejects a failed B01 command with a bare Error, and that one stays
    // loud: a command the robot would not carry out is a real failure the
    // owner needs to see, not a standing capability fact that repeats on
    // every poll. Widening this assertion to the whole file would force that
    // path onto the calm branch too.
    for (const file of ["roborock_mqtt_connector.js", "localConnector.js"]) {
      const source = connectorSource(file);
      const start = source.indexOf("describeReplyRefusal(");
      const refusalBranch = source.slice(start, start + 1600);
      expect(refusalBranch).toContain("createRefusalError(");
      expect(refusalBranch).not.toMatch(/reject\(\s*new Error\(/);
    }
  });
});

describe("the calm branch does not widen to things that are wrong", () => {
  test("an unreachable robot is still escalated, not quieted", async () => {
    const log = makeLog();
    const api = makeAdapter(log);

    // No `code`: an ordinary failure, which must keep its old loud path.
    await api.catchError(
      new Error("Something actually broke"),
      "get_status",
      "duid-1",
      "roborock.vacuum.a144"
    );

    expect(log.lines.warn).toHaveLength(0);
    expect(log.lines.error).toHaveLength(1);
  });

  test("a transient transport error keeps its own throttled warning path", async () => {
    const log = makeLog();
    const api = makeAdapter(log);
    api.getThrottledTransientWarning = (_kind, _attr, _duid, _model, message) =>
      message;

    const error = /** @type {any} */ (new Error("Cloud request timed out"));
    error.transientKind = "cloud timeout";

    await api.catchError(error, "get_status", "duid-1", "roborock.vacuum.a144");

    expect(log.lines.error).toHaveLength(0);
    expect(log.lines.warn).toHaveLength(1);
    expect(log.lines.warn[0]).toContain("Failed to execute get_status");
  });
});
