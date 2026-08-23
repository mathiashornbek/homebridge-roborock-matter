"use strict";

// The Homebridge UI spawns this plugin's settings-page server as a child
// process and closes the IPC channel as soon as the page goes away. Every
// answer that server gives is a `process.send()`, and the very first one —
// the `ready()` handshake in `RoborockUiServer`'s constructor — fires before
// the server has served a single request. A send that loses the race against
// that close does not throw. Node reports it asynchronously as an `'error'`
// event on `process`, and an `'error'` event with no listener kills the
// process.
//
// A user on an a185 (issue #6) posted the result: a full Node crash dump in
// their Homebridge log — `Error: write EPIPE` at
// `HomebridgePluginUiServer.ready`, "Unhandled 'error' event", a stack trace
// into `dist/ui/index.js`, and a `Node.js v24.19.0` banner — for a settings
// page they had already closed. Nothing was broken; the log said otherwise.
//
// The rule under test is therefore not "swallow EPIPE". It is:
//
//   1. A dead IPC channel ends the child quietly, whichever of the four codes
//      Node picks for it.
//   2. Anything else stays exactly as fatal as it was before the guard.
//   3. The guard is installed before the server is constructed, because the
//      crashing send happens in the constructor.
//
// The first case is checked twice: once against the module, and once by
// running a real Node child on a real closed IPC channel — with an unguarded
// control in the same test, so the day the guard stops mattering the control
// fails too.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");

const {
  CHANNEL_GONE_CODES,
  isChannelGoneError,
  installChannelGoneGuard,
} = require("../roborockLib/lib/uiServerLifecycle");

const REPO = path.join(__dirname, "..");
const GUARD_MODULE = path.join(REPO, "roborockLib", "lib", "uiServerLifecycle");

function errorWithCode(code) {
  const error = new Error(`write ${code}`);
  error.code = code;
  return error;
}

describe("a channel that is already gone", () => {
  test.each(CHANNEL_GONE_CODES)(
    "%s is recognised as the parent having left",
    (code) => {
      expect(isChannelGoneError(errorWithCode(code))).toBe(true);
    }
  );

  test.each([
    ["a plain error with no code", new Error("boom")],
    ["an unrelated code", errorWithCode("ENOENT")],
    ["a numeric code", Object.assign(new Error("boom"), { code: 32 })],
    ["null", null],
    ["undefined", undefined],
    ["a bare string", "EPIPE"],
  ])("%s is not", (_label, value) => {
    expect(isChannelGoneError(value)).toBe(false);
  });

  test("EPIPE is listed, because that is the code the field report carried", () => {
    expect(CHANNEL_GONE_CODES).toContain("EPIPE");
  });
});

describe("the guard", () => {
  test.each(CHANNEL_GONE_CODES)(
    "retires the process quietly on %s instead of rethrowing",
    (code) => {
      const proc = new EventEmitter();
      const exitCodes = [];
      proc.exit = (exitCode) => exitCodes.push(exitCode);

      installChannelGoneGuard(proc);

      expect(() => proc.emit("error", errorWithCode(code))).not.toThrow();
      expect(exitCodes).toEqual([0]);
    }
  );

  test("lets a real fault stay fatal", () => {
    const proc = new EventEmitter();
    proc.exit = () => {
      throw new Error("must not exit for an unrelated error");
    };

    installChannelGoneGuard(proc);

    expect(() => proc.emit("error", errorWithCode("ENOENT"))).toThrow(
      "write ENOENT"
    );
  });

  test("hands the caller control of what a dead channel means", () => {
    const proc = new EventEmitter();
    const seen = [];
    proc.exit = () => {
      throw new Error("the injected handler should have been used instead");
    };

    installChannelGoneGuard(proc, (error) => seen.push(error.code));
    proc.emit("error", errorWithCode("EPIPE"));

    expect(seen).toEqual(["EPIPE"]);
  });
});

describe("a real child on a real closed channel", () => {
  // A real Node child with a real IPC channel, sending into it after the
  // channel is gone. The code this raises is ERR_IPC_CHANNEL_CLOSED rather
  // than the EPIPE the a185 report carried — EPIPE needs the parent to die
  // mid-write, which is not reproducible on demand — but it is the same
  // asynchronous `'error'`-on-`process` path, from the same `target.send`,
  // with the same "Unhandled 'error' event" ending. That is the path the
  // guard has to survive, and both codes are in its list.
  const child = (guarded) =>
    [
      guarded
        ? `require(${JSON.stringify(GUARD_MODULE)}).installChannelGoneGuard(process);`
        : "",
      "process.disconnect();",
      'process.send({ hello: "settings page" });',
    ].join("\n");

  const run = (source) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, ["-e", source], {
        // The fourth entry is what makes process.send() exist in the child.
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });

      let stderr = "";
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.on("exit", (code, signal) => resolve({ code, signal, stderr }));
    });

  test("crashes without the guard — the failure this fixes is real", async () => {
    const control = await run(child(false));

    expect(control.code).not.toBe(0);
    expect(control.stderr).toMatch(/Unhandled 'error' event/);
  });

  test("exits cleanly with the guard, printing no stack trace", async () => {
    const guarded = await run(child(true));

    expect(guarded.code).toBe(0);
    expect(guarded.stderr).not.toMatch(/Unhandled 'error' event/);
    expect(guarded.stderr).toBe("");
  });
});

describe("the settings-page entry point", () => {
  const source = fs.readFileSync(
    path.join(REPO, "homebridge-ui", "server.js"),
    "utf8"
  );

  test("installs the guard", () => {
    expect(source).toMatch(/installChannelGoneGuard\(process\)/);
  });

  test("installs it before constructing the server, not after", () => {
    // The crashing send is ready(), and ready() is called from the
    // constructor. A guard installed on the next line is a guard installed
    // too late.
    const guardAt = source.indexOf("installChannelGoneGuard(process)");
    const constructAt = source.indexOf("new RoborockUiServer(");

    expect(guardAt).toBeGreaterThan(-1);
    expect(constructAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(constructAt);
  });
});
