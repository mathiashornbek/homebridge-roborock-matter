"use strict";

/**
 * Marks an error as "the robot answered and declined", as opposed to anything
 * that went wrong on our side or on the wire. `catchError` keys its calm
 * branch on this.
 */
const METHOD_REFUSED_CODE = "ROBOROCK_METHOD_REFUSED";

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

/**
 * A robot that answers a request and declines it has told us a fact about
 * itself. It is not a plugin failure, and it must not be rendered as one.
 *
 * 3.21.3 made the refusal visible but threw it as a bare `Error`, so it
 * carried no code and matched none of `catchError`'s calm branches. It landed
 * on the final `else` and was logged with `error.stack` — an ERROR line plus a
 * ten-frame JavaScript stack trace pointing at our own MQTT handler, twice per
 * poll cycle, for as long as the robot is on the account. Issue #22's Saros 10R
 * refuses `get_server_timer` with `Not FCC robot (code -10007)` on every poll:
 * the stack trace describes nothing that went wrong, and the repetition buries
 * real errors.
 *
 * Tagging the error at the point of construction is what puts it on a calm
 * branch by construction, rather than leaving every caller to recognise a
 * refusal from its prose — the failure mode `getTransientErrorKind` already
 * documents.
 *
 * @param {string} message human-readable refusal, already naming method and id
 * @param {unknown} reply the decoded reply the refusal came from
 * @returns {Error & { code: string, robotErrorCode?: unknown }}
 */
function createRefusalError(message, reply) {
  const error =
    /** @type {Error & { code: string, robotErrorCode?: unknown }} */ (
      new Error(message)
    );
  error.code = METHOD_REFUSED_CODE;

  const replyError =
    reply && typeof reply === "object"
      ? /** @type {any} */ (reply).error
      : null;
  if (replyError && typeof replyError === "object") {
    const code = /** @type {any} */ (replyError).code;
    if (code !== undefined && code !== null) {
      error.robotErrorCode = code;
    }
  }

  return error;
}

module.exports = {
  describeReplyRefusal,
  createRefusalError,
  METHOD_REFUSED_CODE,
};
