const fs = require("fs");
const os = require("os");
const path = require("path");
const { vacuum } = require("../roborockLib/lib/vacuum");
const { Roborock } = require("../roborockLib/roborockAPI");

const VACUUM_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "roborockLib", "lib", "vacuum.js"),
  "utf8"
);

// The window src/matter_vacuum_accessory.ts races the whole clean-mode prep
// against before it sends the start command.
const PREP_WINDOW_MS = 2500;

function createLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
}

/**
 * Extract the body of a method from the source, matching braces rather than
 * indentation. An anchor string would drift the moment something inside is
 * renamed, which is how a previous rule on this very file stopped testing its
 * rule while still passing.
 *
 * @param {string} source
 * @param {string} signature
 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`Method not found in vacuum.js: ${signature}`);
  }

  // The signature ends with the brace that opens the body. Searching for the
  // first `{` after `start` would latch onto the one in `options = {}`.
  let depth = 0;
  for (let i = start + signature.length - 1; i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
    } else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Unbalanced braces after ${signature}`);
}

/**
 * A robot whose LAN is dead in exactly the way skmzwanke's is: every read hangs
 * far past the prep window, while commands are acknowledged over the cloud
 * almost immediately.
 */
function createTransport({ hangMs = 3000, unsupported = [] } = {}) {
  const calls = [];
  const pending = [];

  const sendRequest = jest.fn(
    (duid, method, params, secure = false, photo = false, options = {}) => {
      calls.push({ method, options });

      if (method.startsWith("get_")) {
        return new Promise((resolve) => {
          pending.push(setTimeout(() => resolve([{}]), hangMs));
        });
      }

      return Promise.resolve(
        unsupported.includes(method) ? ["unknown method"] : ["ok"]
      );
    }
  );

  return {
    calls,
    sendRequest,
    methods: () => calls.map((call) => call.method),
    optionsFor: (method) =>
      calls.find((call) => call.method === method)?.options,
    cleanup: () => pending.forEach((timer) => clearTimeout(timer)),
  };
}

function createAdapter(transport) {
  return {
    log: createLog(),
    messageQueueHandler: { sendRequest: transport.sendRequest },
    catchError: jest.fn(),
    getStateAsync: jest.fn().mockResolvedValue({ val: 0 }),
    setStateAsync: jest.fn(),
    getObjectAsync: jest.fn().mockResolvedValue(null),
    createStateObjectHelper: jest.fn(),
    vacuums: {},
  };
}

describe("a state refresh never spends the caller's budget", () => {
  test("the command resolves on the robot's acknowledgement, not on the refresh", async () => {
    const transport = createTransport({ hangMs: 3000 });
    const robot = new vacuum(createAdapter(transport), "roborock.vacuum.a144");

    const startedAt = Date.now();
    await robot.command("device-1", "set_water_box_custom_mode", 200, {
      preferCloud: true,
      requestTimeoutMs: PREP_WINDOW_MS,
      throwOnError: true,
    });
    const elapsed = Date.now() - startedAt;

    // The set was acknowledged in microseconds here. Anything close to the
    // refresh's duration means the refresh is inside the caller's latency
    // again, which is the whole defect.
    expect(elapsed).toBeLessThan(1000);
    expect(transport.methods()).toContain("set_water_box_custom_mode");
    transport.cleanup();
  });

  test("the refresh inherits the caller's transport but not the caller's deadline", async () => {
    const transport = createTransport({ hangMs: 50 });
    const robot = new vacuum(createAdapter(transport), "roborock.vacuum.a144");

    await robot.command("device-1", "set_water_box_custom_mode", 200, {
      preferCloud: true,
      requestTimeoutMs: PREP_WINDOW_MS,
      throwOnError: true,
    });
    // The refresh is fired, not awaited, so give the microtask queue its turn.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(transport.optionsFor("set_water_box_custom_mode")).toEqual({
      preferCloud: true,
      requestTimeoutMs: PREP_WINDOW_MS,
    });
    // Same robot, same setting, so the same transport — a caller that asked for
    // cloud must not be handed a local request it never asked for.
    expect(transport.optionsFor("get_water_box_custom_mode")).toEqual({
      preferCloud: true,
    });
    transport.cleanup();
  });

  test("a refresh that fails does not fail the command", async () => {
    const transport = createTransport({ hangMs: 10 });
    transport.sendRequest.mockImplementation((duid, method) =>
      method.startsWith("get_")
        ? Promise.reject(new Error("Local request timed out after 10 seconds"))
        : Promise.resolve(["ok"])
    );
    const adapter = createAdapter(transport);
    const robot = new vacuum(adapter, "roborock.vacuum.a144");

    await expect(
      robot.command("device-1", "set_custom_mode", 104, {
        throwOnError: true,
      })
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test("a command with no `set` in its name is not re-sent as its own refresh", async () => {
    const transport = createTransport({ hangMs: 10 });
    const robot = new vacuum(createAdapter(transport), "roborock.vacuum.a144");

    await robot.command("device-1", "app_goto_target", [1, 2], {
      throwOnError: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      transport.methods().filter((method) => method === "app_goto_target")
    ).toHaveLength(1);
    transport.cleanup();
  });

  test("getParameter carries the caller's options on branches other than get_status", async () => {
    const transport = createTransport({ hangMs: 10 });
    const robot = new vacuum(createAdapter(transport), "roborock.vacuum.a144");

    await robot.getParameter("device-1", "get_water_box_mode", undefined, {
      preferCloud: true,
      requestTimeoutMs: 1234,
    });

    expect(transport.optionsFor("get_water_box_mode")).toEqual({
      preferCloud: true,
      requestTimeoutMs: 1234,
    });
    transport.cleanup();
  });

  // The end-to-end shape of #8, through the real vacuum class rather than a
  // stub of it. The existing prep tests replace `api.vacuums[duid].command`
  // wholesale, which is precisely why ten seconds could hide inside it.
  test("a hanging refresh no longer eats the prep window from the fallback command", async () => {
    const log = createLog();
    const api = new Roborock({
      log,
      storagePath: fs.mkdtempSync(path.join(os.tmpdir(), "refresh-budget-")),
    });
    await api.setStateAsync("HomeData", {
      val: JSON.stringify({
        products: [
          {
            id: "product-1",
            schema: [
              { id: 123, code: "fan_power" },
              { id: 124, code: "water_box_mode" },
            ],
          },
        ],
        devices: [{ duid: "device-1", productId: "product-1", name: "Weebo" }],
        receivedDevices: [],
      }),
      ack: true,
    });
    api.isInited = () => true;

    // set_water_box_mode is acknowledged but answers "unknown method", so the
    // fallback set_water_box_custom_mode is the command that actually carries
    // the user's choice. Its turn only exists if the refresh after the first
    // one did not spend the window.
    const transport = createTransport({
      hangMs: 3000,
      unsupported: ["set_water_box_mode"],
    });
    api.messageQueueHandler = { sendRequest: transport.sendRequest };
    api.vacuums["device-1"] = new vacuum(api, "roborock.vacuum.a144");

    const startedAt = Date.now();
    await api.applyMatterCleanModeSettings(
      "device-1",
      { cleanMode: 0, fanPower: 104, waterBoxMode: 200 },
      { preferCloud: true, prepWindowMs: PREP_WINDOW_MS, waitForResult: true }
    );
    const elapsed = Date.now() - startedAt;

    expect(transport.methods()).toContain("set_water_box_custom_mode");
    expect(elapsed).toBeLessThan(PREP_WINDOW_MS);
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("did not confirm the water mode")
    );
    transport.cleanup();
  }, 30000);
});

describe("the rule: a request issued for a caller carries that caller's options", () => {
  for (const { signature, worksAt } of [
    {
      signature: "async command(duid, parameter, value, options = {}) {",
      worksAt: "switch (parameter) {",
    },
    {
      signature:
        "async getParameter(duid, parameter, attribute, options = {}) {",
      worksAt: 'if (parameter == "get_network_info") {',
    },
  ]) {
    test(`${signature.slice(6, signature.indexOf("("))} issues no bare sendRequest`, () => {
      const body = methodBody(VACUUM_SOURCE, signature);
      // Each method opens by declaring one option-carrying helper, and that
      // helper is the only permitted way to the queue from there on. Any other
      // call site reverts to the local transport and messageQueueHandler's
      // ten-second default, whatever the caller asked for.
      const workStart = body.indexOf(worksAt);
      expect(workStart).toBeGreaterThan(0);

      expect(body.slice(0, workStart)).toContain(
        "buildForwardedRequestOptions("
      );
      expect(body.slice(workStart)).not.toContain(
        "messageQueueHandler.sendRequest("
      );
    });
  }

  test("every getParameter call inside command forwards the caller's options", () => {
    const body = methodBody(
      VACUUM_SOURCE,
      "async command(duid, parameter, value, options = {}) {"
    );
    const calls = body.match(/this\.getParameter\([^;]*?\)/gs) ?? [];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/options\s*\)/);
    }
  });

  test("only one place decides which options travel with a request", () => {
    // Two hand-kept copies of this list is the fault shape that produced the
    // defect: `command` forwarded preferCloud, the refresh it triggered did not.
    const deciders = VACUUM_SOURCE.match(/options\.preferCloud/g) ?? [];
    expect(deciders).toHaveLength(1);
    expect(VACUUM_SOURCE).toContain("function buildForwardedRequestOptions(");
  });

  test("the refresh drops the caller's deadline deliberately, not by omission", () => {
    const body = methodBody(
      VACUUM_SOURCE,
      "refreshStateAfterCommand(duid, parameter, options) {"
    );

    expect(body).toContain("buildForwardedRequestOptions(options)");
    expect(body).toContain("requestTimeoutMs");
    // Not awaited: the caller is waiting for the robot's acknowledgement.
    expect(body).not.toMatch(/await\s+this\.getParameter/);
  });
});
