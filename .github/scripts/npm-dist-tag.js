"use strict";

// Which npm dist-tag a given package version belongs on.
//
// npm 11 refuses to publish a prerelease version at all unless --tag is given
// ("You must specify a tag using --tag when publishing a prerelease version"),
// so the publish workflow cannot ship a beta without deriving one. It is a
// script rather than a few lines of shell in the workflow so that the rule can
// be tested on this machine instead of only being observed during a release:
// see __tests__/a-prerelease-must-never-publish-as-latest.test.js.
//
// The rule that carries the risk is the negative one. `latest` is the channel
// every existing installation follows, and the tag is derived from text a
// human types into package.json, so a prerelease must not be able to reach it
// by any spelling — including `3.11.0-latest.1`, which a naive "use the
// identifier" implementation hands through without noticing.

/**
 * @param {string} version A package version, e.g. "3.10.1" or "3.11.0-beta.1".
 * @returns {string} The dist-tag to publish it under.
 */
function distTagFor(version) {
  const text = String(version).trim();

  // Build metadata (`+build.9`) is not a prerelease and does not change the
  // channel, so it is discarded before anything else looks at the string.
  const withoutBuild = text.split("+")[0];

  const separator = withoutBuild.indexOf("-");
  if (separator === -1) {
    return "latest";
  }

  const prerelease = withoutBuild.slice(separator + 1);
  const identifier = prerelease
    .split(".")[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");

  // An empty, purely numeric, or `latest`-shaped identifier names no channel
  // anyone would install from. `next` is npm's conventional home for those.
  if (!identifier || /^[0-9]+$/.test(identifier) || identifier === "latest") {
    return "next";
  }

  return identifier;
}

module.exports = { distTagFor };

if (require.main === module) {
  const version = process.argv[2];

  if (!version) {
    process.stderr.write("usage: npm-dist-tag.js <version>\n");
    process.exit(1);
  }

  process.stdout.write(`${distTagFor(version)}\n`);
}
