"use strict";

/**
 * Strip account and robot secrets out of a value before it is logged.
 *
 * Why this exists: the debug line `HomeData notifyDeviceUpdater:` printed the
 * cloud's home data verbatim, and that payload carries every robot's
 * `localKey` — the AES key for the LAN protocol — and serial number. Users
 * paste debug logs into GitHub issues, which is exactly what they are asked
 * to do, and three such logs were public before anyone noticed what was in
 * them (#22). A debug log has to be safe to paste, or it is not a debug log.
 *
 * Roborock nests JSON inside JSON strings (`{val: "<json>", ack: true}`), so
 * a key match on the outer object is not enough: strings that parse as JSON
 * are redacted inside and re-serialised.
 *
 * Pure and total: never throws, never mutates its input.
 */

/** Keys whose values are secrets wherever they appear, compared lowercased. */
const SECRET_KEYS = new Set([
  "localkey",
  "sn",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "encryptedtoken",
  // The whole rriot block goes: its `h` (HMAC key) and `k` (MQTT key) are the
  // account's signing material, and on their own those one-letter names are
  // too common to redact everywhere.
  "rriot",
  "tuyauuid",
]);

const REDACTED = "<redacted>";

/**
 * @param {unknown} value anything about to be logged
 * @param {number} [depth] recursion guard
 * @returns {unknown} a copy with secrets replaced by `<redacted>`
 */
function redactSecrets(value, depth = 0) {
  if (depth > 12) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trimStart();
    if (
      trimmed.length > 1 &&
      (trimmed.startsWith("{") || trimmed.startsWith("["))
    ) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(redactSecrets(parsed, depth + 1));
        }
      } catch {
        // Not JSON after all; an ordinary string carries nothing to redact
        // by key.
      }
    }
    return value;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry, depth + 1));
  }

  /** @type {Record<string, unknown>} */
  const copy = {};
  for (const [key, entry] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.has(lowered)) {
      copy[key] = entry === null || entry === undefined ? entry : REDACTED;
      continue;
    }
    copy[key] = redactSecrets(entry, depth + 1);
  }
  return copy;
}

module.exports = { redactSecrets, REDACTED };
