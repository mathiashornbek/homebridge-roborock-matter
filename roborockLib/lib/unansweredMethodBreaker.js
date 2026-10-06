"use strict";

/**
 * Stop asking a robot a question it has stopped answering.
 *
 * WHY THIS EXISTS, IN NUMBERS FROM REAL INSTALLATIONS.
 *
 * A Roborock request that gets no reply costs a full 10-second pending
 * request, and nothing in this plugin used to notice that the same request
 * had failed the same way a hundred times before. Measured:
 *
 * - `Stueetage` (`a70`) on my own server: `get_map_v1` had failed **95 times
 *   in a row** when I looked on 17 Sep 2026, and 225 in a row twelve days
 *   earlier. The robot has never answered that request; it was asked every
 *   ten seconds of every clean regardless.
 * - Issue #9 (`a75`): 40 in a row, while the same robot answered everything
 *   else — the log line is the only thing the user ever sees of it.
 * - Issues #22 (`a144`) and #24 (`a51`): 647 suppressed timeout warnings
 *   across `get_status`, `get_room_mapping`, `get_multi_maps_list`,
 *   `get_consumable`, `get_carpet_mode`, `get_carpet_clean_mode` and
 *   `get_water_box_custom_mode` in a single session.
 *
 * So this is a register, not a constant per finding: one place that counts
 * consecutive no-answers per robot per method, stops asking for a while once
 * the count is conclusive, and starts again by itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * - **It never trips on a refusal.** A robot that answers "I do not support
 *   that" has answered; `isPollCommandUnsupported` already handles those, and
 *   conflating the two would hide a real reply behind a silence.
 * - **It never trips on a transport error.** `EAI_AGAIN`, a dropped MQTT
 *   link or "not connected" is the network's problem, not the robot's, and it
 *   comes back on its own. Only a request that was sent and drew no answer at
 *   all counts.
 * - **It is not wired to `get_status` or to commands.** The tile lives on
 *   `get_status`, and a command the user just pressed must always be sent.
 *   Only the optional polls and the live-room map fetch go through it.
 *
 * It is also deliberately forgiving: one answer resets the count completely,
 * and an open breaker retries by itself after the cooldown, so a robot that
 * was merely busy for a few minutes loses nothing.
 */

/** Consecutive unanswered requests before a method is left alone. */
const OPEN_AFTER_CONSECUTIVE_TIMEOUTS = 6;

/**
 * How long a tripped method is skipped before it is tried again.
 *
 * Six hours is the same order as the transient-warning throttle the user
 * already sees, and it is long enough that a robot which genuinely cannot
 * answer costs 4 requests a day instead of 8,640.
 */
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Whether an error means "the request was sent and nothing came back".
 *
 * Matched on the message because that is what every layer below hands up:
 * `messageQueueHandler` rejects with `Cloud request with id N with method M
 * timed out after 10 seconds` (and the local equivalent). A transport failure
 * reads differently and is excluded by name, because retrying through a
 * network blip is right and tripping on one is not.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnansweredRequest(error) {
  // THE STRUCTURED ANSWER FIRST, because parsing prose has now been wrong
  // twice in two releases.
  //
  // 3.30.0 excluded transport failures by looking for `EAI_AGAIN`, `offline`
  // and friends — words the timeout message never contains. 3.31.0 replaced
  // that with a regex for `MQTT connection state: false`, which cannot occur
  // either: messageQueueHandler rejects a down link EARLIER, with a refusal
  // that has no "timed out after" in it at all, so the timeout arm is only
  // ever reached with the flag reading `true`. Both gates were dead code, and
  // both had a green test built from a hand-written string the code cannot
  // produce.
  //
  // So the timeout now carries what it knows as data. `transportWasUp` is
  // read at REJECTION time, not at send time — a link that died mid-flight is
  // the whole case the exclusion exists for.
  if (error && typeof error === "object" && "unansweredRequest" in error) {
    if (error.unansweredRequest !== true) {
      return false;
    }
    // A connected socket is not enough: the request layer may have
    // measured correlated account-wide silence on this particular read.
    // Keep the timeout visible to its caller, but do not blame the method.
    if (
      "accountSessionWasSilent" in error &&
      error.accountSessionWasSilent === true
    ) {
      return false;
    }
    return error.transportWasUp !== false;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!/timed out after/i.test(message)) {
    return false;
  }

  // Other error shapes that name the transport outright.
  if (
    /(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|not connected|offline)/i.test(
      message
    )
  ) {
    return false;
  }

  // THE ONE THAT ACTUALLY FIRES, and the reason 3.30.0's exclusion was dead
  // code. messageQueueHandler builds the two timeout messages with the
  // connection state interpolated as a BOOLEAN:
  //
  //   `… timed out after 10 seconds. MQTT connection state: ${mqttConnectionState}`
  //   `… timed out after 10 seconds Local connect state: ${localConnectionState}`
  //
  // so a link that was down while the request was pending reads
  // "MQTT connection state: false" — which matches none of the names above.
  // The whole exclusion had nothing left to exclude, and a four-minute
  // network blip could therefore trip the breaker and suppress a perfectly
  // healthy method for six hours, under a log line claiming this was "not a
  // connection failure". Read the boolean instead.
  if (/(MQTT connection state|Local connect state):\s*false/i.test(message)) {
    return false;
  }

  // The cloud timeout also carries describeCloudSilence's verdict. When it
  // says nothing at all is coming back over MQTT, the robot's silence is not
  // distinguishable from the link's, and the link is the likelier of the two.
  if (/nothing is coming back over MQTT at all/i.test(message)) {
    return false;
  }

  return true;
}

class UnansweredMethodBreaker {
  /**
   * @param {{openAfter?: number, cooldownMs?: number, now?: () => number}} [options]
   */
  constructor(options = {}) {
    this.openAfter = options.openAfter ?? OPEN_AFTER_CONSECUTIVE_TIMEOUTS;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {failures: number, openedAt: number, retryAt: number}>} */
    this.entries = new Map();
    /** @type {Set<string>} pairs a skipping caller has claimed; see govern() */
    this.governed = new Set();
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @returns {string}
   */
  key(duid, method) {
    return `${duid}:${method}`;
  }

  /**
   * Declare that a request is one this register governs.
   *
   * WHY THIS EXISTS. From 3.32.0 the register is fed by the message layer —
   * the only place that actually knows whether a request was answered — and
   * that layer sees EVERY request, including `get_status` and every command.
   * Counting those would break the promise this class is built on: the tile
   * lives on `get_status`, and a button the user just pressed must always be
   * sent.
   *
   * So a (robot, method) pair is counted only after the caller that CAN skip
   * it has said so. `pollParameter` and the two live-room fetches call this
   * before sending; nothing else does, so nothing else can ever be closed.
   *
   * @param {string} duid
   * @param {string} method
   * @returns {void}
   */
  govern(duid, method) {
    this.governed.add(this.key(duid, method));
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @returns {boolean}
   */
  isGoverned(duid, method) {
    return this.governed.has(this.key(duid, method));
  }

  /**
   * Whether this method should be skipped right now.
   *
   * Asking also *closes* the breaker when the cooldown has run out, so the
   * next attempt goes through and either answers (full reset) or trips it
   * again (one request per cooldown, not a storm).
   *
   * @param {string} duid
   * @param {string} method
   * @returns {boolean}
   */
  shouldSkip(duid, method) {
    const entry = this.entries.get(this.key(duid, method));
    if (!entry || entry.retryAt === 0) {
      return false;
    }
    if (this.now() >= entry.retryAt) {
      // Let one request through. The counter is kept, so a robot that is
      // still silent trips again on its very next failure rather than
      // needing another six.
      entry.retryAt = 0;
      return false;
    }
    return true;
  }

  /**
   * Record a request that answered.
   *
   * @param {string} duid
   * @param {string} method
   * @returns {boolean} true when this answer ended a period of silence worth
   *   reporting — the caller owns the wording, this only owns the fact
   */
  recordAnswer(duid, method) {
    const key = this.key(duid, method);
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    this.entries.delete(key);
    return entry.failures >= this.openAfter;
  }

  /**
   * Record a request that drew no answer.
   *
   * @param {string} duid
   * @param {string} method
   * @param {unknown} error the rejection, so a refusal or a network blip can
   *   be told from a silence
   * @returns {{counted: boolean, failures: number, opened: boolean, retryInMs: number}}
   */
  recordFailure(duid, method, error) {
    // Only requests a skipping caller has claimed. See govern().
    if (!this.isGoverned(duid, method)) {
      return { counted: false, failures: 0, opened: false, retryInMs: 0 };
    }
    if (!isUnansweredRequest(error)) {
      return { counted: false, failures: 0, opened: false, retryInMs: 0 };
    }

    const key = this.key(duid, method);
    const entry = this.entries.get(key) ?? {
      failures: 0,
      openedAt: 0,
      retryAt: 0,
    };
    entry.failures += 1;

    // `opened` is true only on the transition, so the caller logs once per
    // period of silence rather than once per failed request.
    const opened = entry.failures === this.openAfter;
    if (entry.failures >= this.openAfter) {
      entry.openedAt = this.now();
      entry.retryAt = entry.openedAt + this.cooldownMs;
    }
    this.entries.set(key, entry);

    return {
      counted: true,
      failures: entry.failures,
      opened,
      retryInMs: entry.retryAt === 0 ? 0 : entry.retryAt - this.now(),
    };
  }

  /**
   * Forget everything for one robot (it came back online, re-login,
   * re-discovery, shutdown).
   *
   * @param {string} duid
   * @returns {number} how many counters were dropped, so the caller can stay
   *   quiet when there was nothing to forget.
   */
  forgetDevice(duid) {
    const prefix = `${duid}:`;
    let forgotten = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        forgotten += 1;
      }
    }
    return forgotten;
  }

  /** Forget everything. */
  clear() {
    this.entries.clear();
  }

  /**
   * The open breakers, for the diagnostics export.
   *
   * @returns {Array<{duid: string, method: string, failures: number, retryInMs: number}>}
   */
  describeOpen() {
    const open = [];
    for (const [key, entry] of this.entries) {
      if (entry.failures < this.openAfter) {
        continue;
      }
      const separator = key.indexOf(":");
      open.push({
        duid: key.slice(0, separator),
        method: key.slice(separator + 1),
        failures: entry.failures,
        retryInMs: Math.max(0, entry.retryAt - this.now()),
      });
    }
    return open;
  }
}

module.exports = {
  UnansweredMethodBreaker,
  isUnansweredRequest,
  OPEN_AFTER_CONSECUTIVE_TIMEOUTS,
  COOLDOWN_MS,
};
