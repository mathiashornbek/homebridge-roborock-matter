"use strict";

/**
 * Friendly name for a robot, for use in user-visible log lines.
 *
 * `roborockAPI` has had its own `describeDevice` for a while, but the library
 * modules underneath it only have the adapter reference, so their log lines
 * kept printing the raw duid — a 22-character opaque string that tells the
 * reader nothing, in exactly the messages people are asked to paste into an
 * issue. This is the shared wrapper so the answer to "how is a robot named to
 * a human" lives in one place rather than being re-decided per module.
 *
 * The fallback matters: these lines are reachable before HomeData has been
 * fetched, and a log line is worth more than a crash, so an adapter without
 * the helper (or a robot with no cached name) degrades to the duid.
 *
 * @param {{ describeDevice?: (duid: string) => string } | null | undefined} adapter
 * @param {string} duid
 * @returns {string}
 */
function describeDevice(adapter, duid) {
  if (adapter && typeof adapter.describeDevice === "function") {
    const name = adapter.describeDevice(duid);

    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  }

  return String(duid);
}

module.exports = { describeDevice };
