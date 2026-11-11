"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_NAME = exports.HAP_PLUGIN_IDENTIFIER = exports.PLUGIN_NAME = void 0;
// The identifier this plugin has always passed to Homebridge's accessory
// registration calls. It does NOT match the `name` in package.json, and the
// comment that used to sit here claimed it did.
//
// Leaving it wrong is deliberate. Homebridge stores this string on every
// registered accessory as `_associatedPlugin` and matches it back to a loaded
// plugin at startup. Every Matter accessory in the field was registered under
// this value; changing it would make the Matter cache miss on the next
// restart, and because Matter locks the mode list at commissioning that means
// every user re-pairs every robot. That is the one outcome this codebase
// treats as unrecoverable (see unregisterStaleMatterAccessories).
exports.PLUGIN_NAME = "homebridge-roborock-vacuum";
// The real npm package name, used only for HAP accessory registration.
//
// The mismatch above is survivable for Matter because Matter keeps its own
// cache, but HAP's restore path is stricter: getPlugin("homebridge-roborock-
// vacuum") finds nothing, so Homebridge falls back to searching by dynamic
// platform name. That fallback works — it logs "the plugin name changed …
// Plugin association is now being transformed!" and repairs the entry — but it
// throws when more than one plugin claims the platform name, and a throw there
// means the accessory is reported orphaned and removed. Registering the HAP
// switches under the true package name keeps them off that fallback entirely.
// No accessory has ever been registered under the wrong name on the HAP side,
// because until now this plugin registered none, so there is no cache to
// migrate.
exports.HAP_PLUGIN_IDENTIFIER = "homebridge-roborock-matter";
// The platform the plugin creates (see config.json).
exports.PLATFORM_NAME = "RoborockVacuumPlatform";
//# sourceMappingURL=settings.js.map