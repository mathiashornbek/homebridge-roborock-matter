"use strict";

// A Q Revo S owner opened #10 with a screenshot of Apple Home's accessory
// details and one request: make the Manufacturer and Model rows read like a
// native HomeKit device instead of like a debug dump.
//
// Half of that is not ours — Homebridge hardcodes `vendorName: 'Homebridge'`
// for external Matter accessories and derives `productName` from the display
// name, discarding the manufacturer and model the plugin hands it
// (homebridge/homebridge#3996). The half that IS ours is what we hand it:
// `accessory.model` has always been the raw code the robot reports, so the
// Model row would read `roborock.vacuum.a104` even after upstream lands. The
// same string is already visible today on the HAP contact sensors, whose
// Model characteristic reads "roborock.vacuum.a70 Docked".
//
// The rule this file enforces, and the reason it enumerates rather than spot-
// checks: the marketing name is for DISPLAY ONLY. Every poll profile, feature
// lookup, capability branch and `isSupportedDevice` call in this codebase keys
// on the raw code, so resolving a name anywhere a model is *compared* would
// break model detection silently and in a way no single-case test would catch.
// So there are two halves here: every name must be well-formed, and the raw
// code must still be what the logic sees.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const {
  getModelMarketingName,
  getModelNameWithoutBrand,
  MODEL_MARKETING_NAMES,
} = require("../roborockLib/lib/deviceFeatures");

describe("the marketing-name table", () => {
  test("is exported and non-empty", () => {
    expect(typeof getModelMarketingName).toBe("function");
    expect(Object.keys(MODEL_MARKETING_NAMES).length).toBeGreaterThan(20);
  });

  // Enumerating the table, not sampling it. Each of these has bitten a
  // different surface: a stray code leaks the thing we are replacing, an
  // over-long name is silently truncated by the Matter BasicInformation
  // constraint (VendorName/ProductName are capped at 32), and a name that
  // does not start with the brand reads as a bare SKU in Apple Home.
  test("every entry is a well-formed marketing name", () => {
    const problems = [];

    for (const [model, name] of Object.entries(MODEL_MARKETING_NAMES)) {
      if (!/^roborock\.vacuum\.[a-z0-9]+$/.test(model)) {
        problems.push(`${model}: key is not a model code`);
      }
      if (typeof name !== "string" || name.trim() !== name || !name) {
        problems.push(`${model}: name is empty or padded`);
      }
      if (name.includes("roborock.vacuum.")) {
        problems.push(`${model}: name still contains the raw code`);
      }
      // Upstream disambiguates its own profiles with a trailing "(a104)".
      // That is their internal bookkeeping, not a name a user should read.
      if (/\([a-z]{1,2}\d+\)\s*$/.test(name)) {
        problems.push(`${model}: name carries upstream's code suffix`);
      }
      if (!name.startsWith("Roborock")) {
        problems.push(`${model}: name does not name the brand`);
      }
      // Matter BasicInformation caps VendorName and ProductName at 32.
      if (name.length > 32) {
        problems.push(
          `${model}: name is ${name.length} chars, over the 32 cap`
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test("resolves the model from the report that prompted it", () => {
    expect(getModelMarketingName("roborock.vacuum.a104")).toBe(
      "Roborock Qrevo S"
    );
  });

  // The three robots this project is developed against, so a regression here
  // shows up on the maintainer's own hardware.
  test("resolves the maintainer's own a70", () => {
    expect(getModelMarketingName("roborock.vacuum.a70")).toBe(
      "Roborock S8 Pro Ultra"
    );
  });

  // A wrong name is worse than a code, because a code is at least unambiguous.
  // Anything we cannot source from upstream stays a code.
  test("returns null rather than guessing for an unknown model", () => {
    expect(getModelMarketingName("roborock.vacuum.zz999")).toBeNull();
    expect(getModelMarketingName("")).toBeNull();
    expect(getModelMarketingName(undefined)).toBeNull();
    expect(getModelMarketingName(null)).toBeNull();
    expect(getModelMarketingName(42)).toBeNull();
  });

  // Guards the one way a table like this goes wrong quietly: a name inherited
  // from a prototype rather than an entry.
  test("does not resolve inherited object properties", () => {
    expect(getModelMarketingName("toString")).toBeNull();
    expect(getModelMarketingName("constructor")).toBeNull();
    expect(getModelMarketingName("__proto__")).toBeNull();
  });

  // Cross-check against this file's own documentation of itself. Every model
  // code that appears in the feature tables with a `// <name>` comment is a
  // model upstream has told us about; the table should agree with the comment
  // where both exist, or the two sources have drifted apart.
  test("agrees with the model comments in deviceFeatures.js", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "roborockLib/lib/deviceFeatures.js"),
      "utf8"
    );
    const commented = new Map();
    const pattern = /"(roborock\.vacuum\.[a-z0-9]+)",\s*\/\/\s*(.+)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      commented.set(match[1], match[2].trim());
    }

    const disagreements = [];
    for (const [model, comment] of commented) {
      const name = getModelMarketingName(model);
      if (!name) {
        continue;
      }
      // The comments are terse ("S8 Pro Ultra"); the names are branded
      // ("Roborock S8 Pro Ultra"). Compare on the part that carries meaning,
      // dropping the parenthetical variant hedges both sources use — the repo
      // comment writes the a97 as "S8 MaxV (Ultra)" where upstream commits to
      // "S8 MaxV Ultra", and the a27 as "S7 MaxV (Ultra)" against upstream's
      // "S7 MaxV (Pro/Ultra)".
      //
      // So one stripped form being a prefix of the other counts as agreement:
      // that is the hedge, and upstream is the authority on how to resolve it.
      // What this still catches is the failure that matters — a name attached
      // to the wrong robot, where neither string is a prefix of the other.
      const strip = (value) =>
        value
          .replace(/^Roborock\s+/, "")
          .replace(/\s*\([^)]*\)/g, "")
          .toLowerCase()
          .trim();
      const [tableName, commentName] = [strip(name), strip(comment)];
      const agrees =
        tableName.startsWith(commentName) || commentName.startsWith(tableName);
      if (!agrees) {
        disagreements.push(`${model}: table "${name}" vs comment "${comment}"`);
      }
    }

    expect(disagreements).toEqual([]);
  });
});

// The reporter of #10 came back after the Manufacturer row was fixed upstream
// and read the pair as a duplicate: Manufacturer "Roborock", Model "Roborock
// Qrevo S". He is right, and his original request was for both rows. So the
// table keeps the brand — upstream's names are the authority and the
// cross-check above compares in that form — and the row is de-branded at the
// display edge instead.
//
// This block enumerates rather than spot-checks for the same reason as above:
// the failure mode is one entry that de-brands to something wrong or empty,
// and no single-case test would find it.
describe("the model row does not repeat the manufacturer", () => {
  test("every entry de-brands to a non-empty name that is a suffix of it", () => {
    const problems = [];

    for (const model of Object.keys(MODEL_MARKETING_NAMES)) {
      const branded = getModelMarketingName(model);
      const row = getModelNameWithoutBrand(model);

      if (typeof row !== "string" || !row || row.trim() !== row) {
        problems.push(`${model}: row is empty or padded`);
        continue;
      }
      if (/^Roborock\b/.test(row)) {
        problems.push(`${model}: row still starts with the brand ("${row}")`);
      }
      // The row must be a piece of the vetted name, never a rewrite of it.
      if (!branded.endsWith(row)) {
        problems.push(`${model}: row "${row}" is not a suffix of "${branded}"`);
      }
      // Matter BasicInformation caps ProductName at 32. De-branding only ever
      // shortens, so this cannot regress — assert it anyway, cheaply.
      if (row.length > 32) {
        problems.push(`${model}: row is ${row.length} chars, over the 32 cap`);
      }
    }

    expect(problems).toEqual([]);
  });

  test("reads as the reporter of #10 asked for", () => {
    expect(getModelNameWithoutBrand("roborock.vacuum.a104")).toBe("Qrevo S");
  });

  test("de-brands the maintainer's own a70", () => {
    expect(getModelNameWithoutBrand("roborock.vacuum.a70")).toBe(
      "S8 Pro Ultra"
    );
  });

  // The guard that matters most. An unknown model must fall through to the raw
  // reported code untouched: `roborock.vacuum.sc05` is the robot's own string,
  // and trimming a brand off it would invent a model that does not exist. Two
  // of the maintainer's three robots are exactly this case.
  test("never rewrites a code it cannot resolve", () => {
    expect(getModelNameWithoutBrand("roborock.vacuum.sc05")).toBeNull();
    expect(getModelNameWithoutBrand("roborock.vacuum.zz999")).toBeNull();
    expect(getModelNameWithoutBrand("")).toBeNull();
    expect(getModelNameWithoutBrand(undefined)).toBeNull();
    expect(getModelNameWithoutBrand(null)).toBeNull();
    expect(getModelNameWithoutBrand(42)).toBeNull();
    expect(getModelNameWithoutBrand("__proto__")).toBeNull();
  });

  // The table is the data and must stay upstream-verbatim; only the display
  // helper strips. If a future edit "simplifies" this by de-branding the table
  // itself, the upstream cross-check silently starts comparing the wrong form.
  test("the table itself still carries the brand", () => {
    expect(getModelMarketingName("roborock.vacuum.a104")).toBe(
      "Roborock Qrevo S"
    );
  });

  // Every surface that shows the model shows the manufacturer beside it, which
  // is the whole premise of de-branding. If a caller ever sets `model` without
  // setting `manufacturer` on the same accessory, the row becomes a bare SKU
  // and this decision needs revisiting — so pin the pairing in the source.
  test("both writers of accessory.model also set the manufacturer", () => {
    const files = ["src/platform.ts", "src/matter_vacuum_accessory.ts"];

    const unpaired = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        if (!/^\s*(this\.)?accessory\.model\s*=/.test(line)) {
          return;
        }
        // Scan backwards to the start of the enclosing method rather than a
        // fixed number of lines: the two assignments are 1 line apart in
        // platform.ts and 18 apart in matter_vacuum_accessory.ts, where a
        // comment block sits between them, so a tight window would fail on
        // correct code. A method opener at two-space indent is the boundary.
        let start = 0;
        for (let i = index - 1; i >= 0; i -= 1) {
          if (
            /^ {2}(private |public |protected )?[\w]+\(.*\{\s*$/.test(lines[i])
          ) {
            start = i;
            break;
          }
        }
        const method = lines.slice(start, index).join("\n");
        if (!/accessory\.manufacturer\s*=\s*"Roborock"/.test(method)) {
          unpaired.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(unpaired).toEqual([]);
  });
});

describe("the raw code still drives every decision", () => {
  // This is the half that would fail silently. `getVacuumModel` feeds display
  // surfaces, so it is allowed to resolve a name — but the model comparisons
  // must keep reading `getProductAttribute(duid, "model")` directly. If a
  // future edit routes one of those through the display helper, model
  // detection breaks for every robot whose name we happen to know, and every
  // other test in this suite still passes.
  test("model comparisons read the product attribute, not the display name", () => {
    const files = ["src/platform.ts", "roborockLib/roborockAPI.js"];

    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        // A model being compared, switched on, or used for a lookup must not
        // come from the display helper.
        if (
          /getVacuumModel\s*\(/.test(line) &&
          /(===|!==|==|!=|\.has\(|switch\s*\(|isSupportedDevice)/.test(line)
        ) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test("isSupportedDevice is still fed the raw code", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/platform.ts"), "utf8");
    // The stale-accessory sweep decides which robots still belong in Apple
    // Home. It must key on the code: a robot whose name we learn later must
    // not read as a different device and get unregistered, because
    // unregistering a Matter accessory costs the owner a re-pair.
    expect(source).toMatch(
      /isSupportedDevice\(\s*\n?\s*this\.roborockAPI\.getProductAttribute\(\s*\n?\s*device\.duid,\s*\n?\s*"model"\s*\n?\s*\)\s*\n?\s*\)/
    );
  });
});

describe("the display surfaces use the name", () => {
  test("the platform's model getter resolves the marketing name", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/platform.ts"), "utf8");
    const getter = source.slice(source.indexOf("getVacuumModel(duid: string)"));
    const body = getter.slice(0, getter.indexOf("\n  }"));
    expect(body).toMatch(/getModelNameWithoutBrand/);
  });

  test("the Matter accessory's metadata resolves the marketing name", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src/matter_vacuum_accessory.ts"),
      "utf8"
    );
    const updateMetadata = source.slice(
      source.indexOf("updateMetadata(device: RoborockDevice)")
    );
    const body = updateMetadata.slice(0, updateMetadata.indexOf("\n  }"));
    expect(body).toMatch(/getVacuumModel|getModelNameWithoutBrand/);
  });
});
