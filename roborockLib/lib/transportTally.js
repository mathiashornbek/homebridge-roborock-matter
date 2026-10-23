// @ts-check
"use strict";

/**
 * How each robot's requests fared, per transport, summed over an hour and
 * logged once at info when anything in that hour failed: when the hour ends,
 * and at shutdown for the hour not yet over.
 *
 * The per-failure "Failed to execute …" warning is throttled, which kept the
 * log readable and hid the rate: on the maintainer's a70, 36 lines stood for
 * about 1,418 failures in 6.5 days, and a failure every 180 s was visible only
 * by arithmetic on request ids. The first failure of each kind still logs as
 * it happens; this line says how many there were.
 */

const SUMMARY_WINDOW_MS = 60 * 60 * 1000;

/** @typedef {"local" | "cloud"} Transport */
/**
 * @typedef {"ok" | "timeout" | "lost" | "notSent" | "retried" | "socketClosed"} Outcome
 *   ok: answered (a refusal is an answer); timeout: no reply in time; lost:
 *   its LAN socket closed under it; notSent: the publish was refused;
 *   retried: a LAN failure retried over the cloud; socketClosed: the LAN
 *   socket went, with or without a request on it.
 */

function emptyCounts() {
  return {
    local: { ok: 0, timeout: 0, lost: 0, socketClosed: 0 },
    cloud: { ok: 0, timeout: 0, notSent: 0 },
    retried: 0,
  };
}

class TransportTally {
  /**
   * @param {{info: (message: string) => void}} log
   * @param {(duid: string) => string} describe
   * @param {() => number} [now]
   */
  constructor(log, describe, now = () => Date.now()) {
    this.log = log;
    this.describe = describe;
    this.now = now;
    /** @type {Map<string, {startedAt: number, counts: ReturnType<typeof emptyCounts>, timer: ReturnType<typeof setTimeout>}>} */
    this.windows = new Map();
  }

  /**
   * @param {string} duid
   * @param {Transport} transport
   * @param {Outcome} outcome
   * @returns {void}
   */
  note(duid, transport, outcome) {
    let window = this.windows.get(duid);
    if (!window) {
      // Closed by its own timer. It used to be reported by the first outcome
      // after it ended, so a robot with nothing to report for hours got a
      // line about "the last hour" that described an hour long gone, and the
      // hour before a shutdown was never reported at all.
      const timer = setTimeout(() => this.close(duid), SUMMARY_WINDOW_MS);
      timer.unref?.();
      window = { startedAt: this.now(), counts: emptyCounts(), timer };
      this.windows.set(duid, window);
    }
    if (outcome === "retried") {
      window.counts.retried += 1;
      return;
    }
    const counts = /** @type {Record<string, number>} */ (
      window.counts[transport]
    );
    if (outcome in counts) {
      counts[outcome] += 1;
    }
  }

  /**
   * Report a robot's window and start the next one with its next outcome.
   *
   * @param {string} duid
   * @returns {void}
   */
  close(duid) {
    const window = this.windows.get(duid);
    if (!window) {
      return;
    }
    clearTimeout(window.timer);
    this.windows.delete(duid);
    const minutes = Math.max(
      1,
      Math.round((this.now() - window.startedAt) / 60000)
    );
    this.report(
      duid,
      window.counts,
      minutes >= SUMMARY_WINDOW_MS / 60000
        ? "the last hour"
        : `the last ${minutes} minute(s)`
    );
  }

  /**
   * Shutdown: report every window, the hour not yet over included.
   *
   * @returns {void}
   */
  flush() {
    for (const duid of [...this.windows.keys()]) {
      this.close(duid);
    }
  }

  /**
   * @param {string} duid
   * @param {ReturnType<typeof emptyCounts>} counts
   * @param {string} period
   * @returns {void}
   */
  report(duid, counts, period) {
    const { local, cloud, retried } = counts;
    const failed =
      local.timeout +
      local.lost +
      local.socketClosed +
      cloud.timeout +
      cloud.notSent +
      retried;
    if (failed === 0) {
      return;
    }
    const parts = [];
    if (local.ok + local.timeout + local.lost + local.socketClosed > 0) {
      parts.push(
        `over the LAN ${local.ok} answered, ${local.timeout} timed out, ${local.lost} lost when the socket closed (the socket closed ${local.socketClosed} time(s))`
      );
    }
    if (cloud.ok + cloud.timeout + cloud.notSent > 0) {
      parts.push(
        `over the cloud ${cloud.ok} answered, ${cloud.timeout} timed out, ${cloud.notSent} not sent`
      );
    }
    if (retried > 0) {
      parts.push(`${retried} retried over the cloud after the LAN failed`);
    }
    this.log.info(
      `${this.describe(duid)}, requests in ${period}: ${parts.join("; ")}.`
    );
  }
}

module.exports = { TransportTally, SUMMARY_WINDOW_MS };
