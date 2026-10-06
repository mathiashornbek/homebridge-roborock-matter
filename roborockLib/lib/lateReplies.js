// @ts-check
"use strict";

/**
 * Replies that arrive AFTER their request has already timed out.
 *
 * A request that dies on its 10-second timer is removed from
 * `pendingRequests`, and a reply that turns up a second later finds nothing
 * waiting for it. Until 3.35.0 that reply was dropped without a word on the
 * local socket, at debug level on the cloud, and as "discarded by the plugin
 * — a bug here" on the map path. So a robot that answers in 12 seconds looked
 * exactly like a robot that never answers, and the give-up line told users
 * (#24, #28) that the reply "is not arriving at all".
 *
 * This remembers the last few hundred timed-out request ids for ten minutes
 * and counts replies that match one, per robot and method, so the give-up
 * line can say which of the two it is.
 */

const { describeDevice } = require("./describeDevice");

const DEFAULT_CAPACITY = 256;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

class LateReplyTracker {
  /**
   * @param {{capacity?: number, windowMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {duid: string, method: string, timedOutAt: number, counted?: boolean}>} */
    this.timedOut = new Map();
    /** @type {Map<string, number>} */
    this.lateCounts = new Map();
  }

  /**
   * @param {unknown} id
   * @returns {string}
   */
  idKey(id) {
    return String(id);
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @returns {string}
   */
  countKey(duid, method) {
    return `${duid}:${method}`;
  }

  /**
   * A request just died on its timer.
   *
   * @param {unknown} id
   * @param {string} duid
   * @param {string} method
   * @returns {void}
   */
  noteTimedOut(id, duid, method) {
    if (id === undefined || id === null) {
      return;
    }
    const key = this.idKey(id);
    this.timedOut.delete(key);
    this.timedOut.set(key, { duid, method, timedOutAt: this.now() });
    while (this.timedOut.size > this.capacity) {
      const oldest = this.timedOut.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.timedOut.delete(oldest);
    }
  }

  /**
   * A reply arrived that nothing was waiting for. Returns what it was a
   * reply to when it matches a request that timed out within the window, and
   * null otherwise (an unsolicited push, or a reply to another app).
   *
   * @param {unknown} id
   * @param {string} duid
   * @returns {{method: string, lateByMs: number} | null}
   */
  noteReply(id, duid) {
    if (id === undefined || id === null) {
      return null;
    }
    const key = this.idKey(id);
    const entry = this.timedOut.get(key);
    if (!entry || entry.duid !== duid) {
      return null;
    }
    const lateByMs = this.now() - entry.timedOutAt;
    if (lateByMs > this.windowMs) {
      this.timedOut.delete(key);
      return null;
    }
    // Kept, not deleted: a map request is answered twice — a protocol-102
    // acknowledgement and then the protocol-301 payload — and both can be
    // late. The request counts once; each frame is still recognised.
    if (!entry.counted) {
      entry.counted = true;
      const countKey = this.countKey(duid, entry.method);
      this.lateCounts.set(countKey, (this.lateCounts.get(countKey) ?? 0) + 1);
    }
    return { method: entry.method, lateByMs };
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @returns {number}
   */
  count(duid, method) {
    return this.lateCounts.get(this.countKey(duid, method)) ?? 0;
  }

  /**
   * The method was answered: its late replies belong to a run that is over.
   *
   * @param {string} duid
   * @param {string} method
   * @returns {void}
   */
  resetMethod(duid, method) {
    this.lateCounts.delete(this.countKey(duid, method));
  }

  /**
   * @param {string} duid
   * @returns {void}
   */
  forgetDevice(duid) {
    for (const [key, entry] of this.timedOut) {
      if (entry.duid === duid) {
        this.timedOut.delete(key);
      }
    }
    for (const key of this.lateCounts.keys()) {
      if (key.startsWith(`${duid}:`)) {
        this.lateCounts.delete(key);
      }
    }
  }
}

/**
 * A reply nothing was waiting for: say so when it answers a request that had
 * already timed out. Shared by the cloud connector and the local socket.
 *
 * @param {any} adapter
 * @param {string} duid
 * @param {unknown} id
 * @param {"cloud" | "local"} transport
 * @returns {{method: string, lateByMs: number} | null}
 */
function noteLateReply(adapter, duid, id, transport) {
  const late = adapter?.lateReplies?.noteReply?.(id, duid) ?? null;
  if (late) {
    adapter.log?.debug?.(
      `Reply to ${late.method} (${transport} id ${id}) from ${describeDevice(adapter, duid)} arrived ${Math.round(late.lateByMs / 1000)} s after the request had already timed out. The robot answered; it answered too late to be used.`
    );
  }
  return late;
}

module.exports = { LateReplyTracker, noteLateReply };
