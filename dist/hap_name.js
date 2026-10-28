"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HAP_NAME_MAX_LENGTH = exports.HAP_NAME_PATTERN = void 0;
exports.hapName = hapName;
/**
 * HAP-NodeJS 2.2 `checkName` (Homebridge 2.4): a name must start and end with
 * a letter or number; the middle may hold letters, numbers, space separators
 * and ’ ' & ! . _ : ; ( ) / , -. Anything else logs "has an invalid 'Name'
 * characteristic" for every accessory and service carrying it (#40).
 */
exports.HAP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{Zs}\u2019'&!._:;()/,-]*[\p{L}\p{N}]$/u;
/** Characteristic.Name maxLen. HAP cuts longer values mid-word. */
exports.HAP_NAME_MAX_LENGTH = 64;
/**
 * A HomeKit-safe name: `base`, cleaned, then ` suffix`.
 *
 * A name HAP already accepts comes back unchanged, so no valid accessory is
 * renamed. Otherwise "+" reads as " Plus " ("Q5 Max+" -> "Q5 Max Plus"),
 * any other unsupported character becomes a space, whitespace collapses, the
 * base is cut so the suffix always fits in 64, and the start is trimmed to a
 * letter or number — and, without a suffix, the end to a letter, number or
 * combining mark. Combining marks are kept: dropping them
 * would turn a Hindi or Thai word into a different word to silence a warning.
 * Fewer than two characters left means `fallback` is used instead.
 */
function hapName(base, fallback, suffix = "") {
    const tail = suffix ? ` ${suffix}` : "";
    const budget = exports.HAP_NAME_MAX_LENGTH - tail.length;
    const raw = typeof base === "string" ? base : "";
    // HAP judges the whole name, so a base ending in ")" or "'" is fine in
    // front of a suffix. A name HAP already accepts is never touched — not
    // even re-normalised.
    if (raw.length <= budget && exports.HAP_NAME_PATTERN.test(raw + tail)) {
        return raw + tail;
    }
    const spaced = raw
        .normalize("NFC")
        .replace(/\+/g, " Plus ")
        .replace(/[\uFE00-\uFE0F]/g, "")
        .replace(/[^\p{L}\p{Mn}\p{Mc}\p{N}\p{Zs}\u2019'&!._:;()/,-]+/gu, " ")
        .replace(/\s+/gu, " ")
        // "S8+)" became "S8 Plus )": no space before closing punctuation.
        .replace(/\s+(?=[)\u2019',.!:;])/gu, "");
    let cut = "";
    for (const character of spaced) {
        if (cut.length + character.length > budget)
            break;
        cut += character;
    }
    // The name must start with a letter or number, and end with one. A suffix
    // supplies the end, so in front of one only trailing spaces go: "Q5 Max+
    // (OG)" keeps its ")".
    const cleaned = tail
        ? cut.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+$/u, "")
        : cut.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{Mn}\p{Mc}\p{N}]+$/gu, "");
    return ([...cleaned].length >= 2 ? cleaned : fallback) + tail;
}
//# sourceMappingURL=hap_name.js.map