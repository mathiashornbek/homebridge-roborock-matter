"use strict";

/**
 * A Roborock reply carries its payload in `result`. A reply that has an `id`
 * but no `result` at all is not an empty success — the robot took the request
 * and declined it, and when it says why, it says so in `error`.
 *
 * Both connectors used to hand `result` straight to the waiting promise, so
 * such a reply resolved with `undefined` and the refusal was dropped one line
 * before anyone could read it. Issue #22 is what that costs: a Saros 10R
 * (`roborock.vacuum.a144`) answers every other method and refuses
 * `get_server_timer`, and the only thing the plugin could tell its owner was
 * `get_server_timer returned undefined` — the same sentence it would print for
 * a timeout, a parser gap or a firmware that has no such method.
 *
 * Kept deliberately narrow: a reply that carries a `result` is never touched,
 * and a resultless reply with no error field still resolves as before. Only a
 * refusal the robot spelled out is turned into a rejection.
 *
 * @param {unknown} reply decoded reply body (protocol 102 over cloud, 4 over LAN)
 * @returns {string|null} the robot's own words, or null when there is no refusal to report
 */
function describeReplyRefusal(reply) {
  if (!reply || typeof reply !== "object") {
    return null;
  }

  if (typeof reply.result !== "undefined") {
    return null;
  }

  const error = reply.error;

  if (error === undefined || error === null || error === "") {
    return null;
  }

  if (typeof error !== "object") {
    return String(error);
  }

  const code = error.code;
  const message = error.message;
  const hasCode = code !== undefined && code !== null;
  const hasMessage = typeof message === "string" && message.length > 0;

  if (hasCode && hasMessage) {
    return `${message} (code ${code})`;
  }
  if (hasMessage) {
    return message;
  }
  if (hasCode) {
    return `code ${code}`;
  }

  // An error object in a shape nobody here has seen yet is still worth more
  // to the reader than `undefined`.
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

module.exports = { describeReplyRefusal };
