// @ts-check
"use strict";

/**
 * A robot that drops off the network — Wi-Fi blip, power, a restart — is ONE
 * event, and the log should say it once.
 *
 * Measured on the maintainer's a70 on 14 Nov 2026: the robot was gone for
 * about 45 seconds, and the log said so four times as warnings, one per
 * symptom: the LAN socket stopped answering, a status read failed on both
 * the LAN and the cloud, the cloud reported the robot offline, and a room
 * read was not sent because the robot was offline. Each line was true, and
 * together they read like four faults.
 *
 * An episode opens on the first of those symptoms and closes on the first
 * sign of life: any reply, an answered keep-alive or hello, or the cloud
 * reporting the robot online. While it is open, the per-request failures it
 * causes go to debug (the hourly transport line still counts every one), and
 * the symptoms that follow the first are told as part of the same story at
 * info. A LAN-only problem closes the episode at the robot's next cloud reply,
 * so it never hides a cloud failure for longer than that.
 */

/** @typedef {"lan" | "presence" | "both-silent"} EpisodeCause */

class UnreachableEpisodes {
  /** @param {() => number} [now] */
  constructor(now = () => Date.now()) {
    this.now = now;
    /** @type {Map<string, {since: number, causes: Set<EpisodeCause>}>} */
    this.episodes = new Map();
  }

  /**
   * @param {string} duid
   * @param {EpisodeCause} cause
   * @returns {boolean} whether this opened the episode (false: already open)
   */
  open(duid, cause) {
    const key = String(duid);
    const existing = this.episodes.get(key);
    if (existing) {
      existing.causes.add(cause);
      return false;
    }
    this.episodes.set(key, { since: this.now(), causes: new Set([cause]) });
    return true;
  }

  /** @param {string} duid @returns {boolean} */
  isOpen(duid) {
    return this.episodes.has(String(duid));
  }

  /**
   * The robot showed a sign of life.
   *
   * @param {string} duid
   * @returns {number | null} how long the episode lasted, or null if none was open
   */
  close(duid) {
    const key = String(duid);
    const episode = this.episodes.get(key);
    if (!episode) {
      return null;
    }
    this.episodes.delete(key);
    return Math.max(0, this.now() - episode.since);
  }
}

/**
 * @param {number} ms
 * @returns {string} "45 s", "3 min", "2 h 5 min"
 */
function describeOutage(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

module.exports = { UnreachableEpisodes, describeOutage };
