// ESM entry point for the Homebridge custom UI server (this directory is
// "type": "module"). plugin-ui-utils v2+ is a pure ES module, so it is
// imported natively here; the compiled CommonJS server implementation is
// loaded via createRequire and instantiated with the imported base class.
import { createRequire } from "node:module";

import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

const require = createRequire(import.meta.url);
const {
  installChannelGoneGuard,
} = require("../roborockLib/lib/uiServerLifecycle.js");
const { RoborockUiServer } = require("../dist/ui/index.js");

// Before the server is built, not after: its constructor calls ready(), and
// that send is the one that crashed for a user who closed the settings page.
installChannelGoneGuard(process);

new RoborockUiServer(HomebridgePluginUiServer);
