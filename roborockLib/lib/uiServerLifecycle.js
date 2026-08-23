"use strict";

// The Homebridge UI runs this plugin's settings-page server as a child
// process and closes the IPC channel the moment the page goes away. Every
// answer that server gives is a `process.send()` — including the one-shot
// `ready()` handshake its constructor fires before it has served a single
// request — and a send that loses the race against that close does not throw.
// Node reports it asynchronously as an `'error'` event on `process`, and an
// `'error'` event with no listener is fatal.
//
// Measured in the wild on an a185 (issue #6, 23 August 2026): closing the
// settings page printed a full Node crash dump into the user's Homebridge log
// — `Error: write EPIPE` inside `HomebridgePluginUiServer.ready`, "Unhandled
// 'error' event", a stack trace and a `Node.js v24.19.0` banner — for a page
// they had already closed and a process that had nothing left to do. Nothing
// was broken. Nothing in the log said so.
//
// Checking `process.connected` before sending does not fix this: the channel
// can close between the check and the write. The listener does, so the child
// gets exactly one, installed before the server is constructed. A dead
// channel is a normal end of life and exits quietly; anything else is a real
// fault and stays exactly as loud as it was before this file existed.

/**
 * The error codes Node uses when the other end of the IPC channel is already
 * gone. `EPIPE` is the write losing the race, the `ERR_IPC_*` pair is the
 * same condition caught before the write is attempted, and `ECONNRESET` is
 * the parent tearing the socket down mid-write.
 *
 * @type {readonly string[]}
 */
const CHANNEL_GONE_CODES = Object.freeze([
  "EPIPE",
  "ERR_IPC_CHANNEL_CLOSED",
  "ERR_IPC_DISCONNECTED",
  "ECONNRESET",
]);

/**
 * Is this the parent having gone away, rather than a fault worth reporting?
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isChannelGoneError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = /** @type {{ code?: unknown }} */ (error).code;

  return typeof code === "string" && CHANNEL_GONE_CODES.includes(code);
}

/**
 * Install the one listener that keeps a closed settings page from looking
 * like a plugin crash.
 *
 * @param {NodeJS.EventEmitter & { exit?: (code?: number) => void }} proc
 *   The process to guard. Injected rather than closed over so the rule can be
 *   exercised without ending the test runner.
 * @param {(error: unknown) => void} [onChannelGone]
 *   What to do once the channel is confirmed gone. Defaults to exiting
 *   cleanly: the parent that asked for this server no longer exists, so
 *   lingering would leak a child process per opened settings page.
 * @returns {NodeJS.EventEmitter} the same process, for chaining.
 */
function installChannelGoneGuard(proc, onChannelGone) {
  const handleChannelGone =
    onChannelGone ||
    ((/** @type {unknown} */ _error) => {
      if (typeof proc.exit === "function") {
        proc.exit(0);
      }
    });

  proc.on("error", (error) => {
    if (isChannelGoneError(error)) {
      handleChannelGone(error);
      return;
    }

    // Not our case. Re-throwing from the listener turns this back into the
    // uncaught exception it would have been, stack intact.
    throw error;
  });

  return proc;
}

module.exports = {
  CHANNEL_GONE_CODES,
  isChannelGoneError,
  installChannelGoneGuard,
};
