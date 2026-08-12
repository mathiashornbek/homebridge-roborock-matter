import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";

/**
 * Timer helpers that go through `globalThis` when it has them.
 *
 * The indirection is not decoration. Jest's fake timers replace the global
 * `setTimeout`, and a module that captured `node:timers`' own function at
 * import time keeps calling the real one — so a test that advances the clock
 * proves nothing and the timer it was meant to exercise fires for real,
 * milliseconds after the test has finished. Anything scheduled in this plugin
 * therefore goes through here.
 */
export function scheduleTimer(
  callback: () => void,
  delayMs: number
): ReturnType<typeof nodeSetTimeout> {
  const setTimer =
    typeof globalThis.setTimeout === "function"
      ? globalThis.setTimeout
      : nodeSetTimeout;

  return setTimer(callback, delayMs);
}

/** A pending timer must never be why Homebridge cannot shut down. */
export function unrefTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  if (typeof timer === "object" && typeof timer.unref === "function") {
    timer.unref();
  }
}

export function clearTimer(timer: ReturnType<typeof nodeSetTimeout>): void {
  const clear =
    typeof globalThis.clearTimeout === "function"
      ? globalThis.clearTimeout
      : nodeClearTimeout;

  clear(timer);
}
