// @ts-check
"use strict";

/**
 * How each robot's requests fared, per transport, summed over an hour and
 * logged once at info when anything in that hour failed.
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
    /** @type {Map<string, {startedAt: number, counts: ReturnType<typeof emptyCounts>}>} */
    this.windows = new Map();
  }

  /**
   * @param {string} duid
   * @param {Transport} transport
   * @param {Outcome} outcome
   * @returns {void}
   */
  note(duid, transport, outcome) {
    const now = this.now();
    let window = this.windows.get(duid);
    if (window && now - window.startedAt >= SUMMARY_WINDOW_MS) {
      this.report(duid, window.counts);
      window = undefined;
    }
    if (!window) {
      window = { startedAt: now, counts: emptyCounts() };
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
   * @param {string} duid
   * @param {ReturnType<typeof emptyCounts>} counts
   * @returns {void}
   */
  report(duid, counts) {
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
      `${this.describe(duid)}, requests in the last hour: ${parts.join("; ")}.`
    );
  }
}

module.exports = { TransportTally, SUMMARY_WINDOW_MS };
