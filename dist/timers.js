"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleTimer = scheduleTimer;
exports.unrefTimer = unrefTimer;
exports.clearTimer = clearTimer;
const node_timers_1 = require("node:timers");
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
function scheduleTimer(callback, delayMs) {
    const setTimer = typeof globalThis.setTimeout === "function"
        ? globalThis.setTimeout
        : node_timers_1.setTimeout;
    return setTimer(callback, delayMs);
}
/** A pending timer must never be why Homebridge cannot shut down. */
function unrefTimer(timer) {
    if (typeof timer === "object" && typeof timer.unref === "function") {
        timer.unref();
    }
}
function clearTimer(timer) {
    const clear = typeof globalThis.clearTimeout === "function"
        ? globalThis.clearTimeout
        : node_timers_1.clearTimeout;
    clear(timer);
}
//# sourceMappingURL=timers.js.map