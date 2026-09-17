"use strict";

/**
 * Reconstruct the RvcOperationalState cluster from the writes the plugin made.
 *
 * WHY A TEST NEEDS THIS AT ALL. Since 3.30.0 the plugin writes this one
 * cluster in up to two transactions — everything but `operationalError`
 * first, `operationalError` second — because @matter/main 0.17.9 clears
 * `operationalError` on every write that carries `operationalState`, even a
 * write of the value already stored. That was the source of the tank
 * notification repeating every 2 minutes in #5, #9 and #26; the measurement
 * table is in writeOperationalStateCluster().
 *
 * So "the last rvcOperationalState write" is no longer the same thing as
 * "what the store holds", and every test that used to read the former meant
 * the latter. This models matter.js instead: writes are applied in order, and
 * a write carrying `operationalState` wipes the accumulated error, exactly as
 * measured.
 *
 * @param {Array<{cluster: string, attributes: Record<string, unknown>}>} matterUpdates
 * @returns {Record<string, unknown> | undefined} undefined when the cluster was never written
 */
function operationalStateCluster(matterUpdates) {
  let cluster;

  for (const update of matterUpdates) {
    if (update?.cluster !== "rvcOperationalState") {
      continue;
    }
    cluster = cluster || {};

    if (
      Object.prototype.hasOwnProperty.call(
        update.attributes,
        "operationalState"
      ) &&
      Object.prototype.hasOwnProperty.call(cluster, "operationalError")
    ) {
      // matter.js 0.17.9 clears the error here, whatever it was. Applied only
      // when the plugin had written one, so a test asking whether the
      // attribute was ever published can still tell; matter.js's own default
      // of `{ errorStateId: 0 }` would answer a different question. The
      // plugin re-asserts the error straight after a state write, so this
      // rarely survives to the end of a publish — which is the point.
      cluster.operationalError = { errorStateId: 0 };
    }

    Object.assign(cluster, update.attributes);
  }

  return cluster;
}

/** Every write made to the cluster, in order, for tests that pin the split. */
function operationalStateWrites(matterUpdates) {
  return matterUpdates
    .filter((update) => update?.cluster === "rvcOperationalState")
    .map((update) => update.attributes);
}

module.exports = { operationalStateCluster, operationalStateWrites };
