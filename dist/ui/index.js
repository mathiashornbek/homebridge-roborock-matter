"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoborockUiServer = void 0;
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const net_1 = __importDefault(require("net"));
const qrcode_1 = __importDefault(require("qrcode"));
const crypto_2 = require("../crypto");
const roborockAuth = require("../../roborockLib/lib/roborockAuth");
// What the report says about a robot's transport lives in plain JavaScript, so
// the test suite — which runs before any build — can exercise the wording
// directly instead of grepping this file for it.
const { describeConnectionState, describeLocalProbeSkip, isCloudFallbackLikely, isCloudOnlyProtocol, } = require("../../roborockLib/lib/connectionState");
const ACTIVE_LOCAL_TRANSPORT_MAX_AGE_MS = 5 * 60 * 1000;
const LOCAL_CONTROL_PORT = 58867;
class RoborockUiServer {
    constructor(HomebridgePluginUiServer) {
        this.homebridgePluginUiServer = new HomebridgePluginUiServer();
        this.homebridgeStoragePath =
            this.homebridgePluginUiServer.homebridgeStoragePath;
        this.homebridgePluginUiServer.onRequest("/auth/send-2fa-email", this.sendTwoFactorEmail.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/verify-2fa-code", this.verifyTwoFactorCode.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/login", this.loginWithPassword.bind(this));
        this.homebridgePluginUiServer.onRequest("/auth/logout", this.logout.bind(this));
        this.homebridgePluginUiServer.onRequest("/diagnostics/state", this.getDiagnostics.bind(this));
        this.homebridgePluginUiServer.onRequest("/diagnostics/test-local", this.testLocalConnections.bind(this));
        this.homebridgePluginUiServer.onRequest("/matter/pairing", this.getMatterPairing.bind(this));
        this.homebridgePluginUiServer.ready();
    }
    getStoragePath() {
        return this.homebridgeStoragePath || process.cwd();
    }
    async getClientId() {
        const storagePath = this.getStoragePath();
        if (storagePath) {
            const clientIdPath = path_1.default.join(storagePath, "roborock.clientID");
            try {
                const stored = JSON.parse(fs_1.default.readFileSync(clientIdPath, "utf8"));
                if (stored && stored.val) {
                    return stored.val;
                }
            }
            catch (error) {
                // Ignore and generate a new client ID.
            }
            const clientId = crypto_1.default.randomUUID();
            fs_1.default.mkdirSync(storagePath, { recursive: true });
            fs_1.default.writeFileSync(clientIdPath, JSON.stringify({ val: clientId, ack: true }, null, 2), "utf8");
            return clientId;
        }
        return crypto_1.default.randomUUID();
    }
    /**
     * The server a login goes to: the custom server when the page names one
     * (#43), otherwise the region. Throws the validation message for a custom
     * server URL that is not https://host[:port] — an empty one included, which
     * must never fall back to the region.
     */
    loginServer(config) {
        return typeof config.serverURL === "string"
            ? roborockAuth.parseServerURL(config.serverURL)
            : config.baseURL || "usiot.roborock.com";
    }
    async buildLoginApi(config) {
        const clientID = await this.getClientId();
        return roborockAuth.createLoginApi({
            baseURL: this.loginServer(config),
            username: config.email,
            clientID,
            language: "en",
        });
    }
    async sendTwoFactorEmail(payload) {
        const email = payload.email;
        if (!email) {
            return { ok: false, message: "Email is required." };
        }
        try {
            const loginApi = await this.buildLoginApi({
                email,
                baseURL: payload.baseURL,
                serverURL: payload.serverURL,
            });
            await roborockAuth.requestEmailCode(loginApi, email);
            return { ok: true, message: "Verification email sent." };
        }
        catch (error) {
            console.error("2FA email request failed:", (error === null || error === void 0 ? void 0 : error.message) || error);
            return {
                ok: false,
                message: (error === null || error === void 0 ? void 0 : error.message) || "Failed to send verification email.",
            };
        }
    }
    async verifyTwoFactorCode(payload) {
        const email = payload.email;
        if (!email) {
            return { ok: false, message: "Email is required." };
        }
        if (!payload.code) {
            return { ok: false, message: "Verification code is required." };
        }
        return this.performSignedLogin({
            email,
            baseURL: payload.baseURL,
            serverURL: payload.serverURL,
            requestFailedLogLabel: "2FA verification request failed:",
            requestFailedFallbackMessage: "Verification failed.",
            successMessage: "Login completed and token saved.",
            failureLogLabel: "2FA verification failed:",
            failureFallbackMessage: "Verification failed.",
            credentials: { code: payload.code },
        });
    }
    async loginWithPassword(payload) {
        const email = payload.email;
        const password = payload.password;
        if (!email || !password) {
            return { ok: false, message: "Email and password are required." };
        }
        return this.performSignedLogin({
            email,
            baseURL: payload.baseURL,
            serverURL: payload.serverURL,
            requestFailedLogLabel: "Login request failed:",
            requestFailedFallbackMessage: "Login failed.",
            successMessage: "Login successful. Token saved.",
            failureLogLabel: "Login failed:",
            failureFallbackMessage: "Login failed. Check your credentials.",
            checkTwoFactorRequired: true,
            credentials: { password },
        });
    }
    // Shared by verifyTwoFactorCode and loginWithPassword: both build a login
    // API, log in through roborockAuth.signedLogin (the plugin's own login
    // uses it too), then map the response to the same success/failure shape
    // (loginWithPassword additionally treats code 2031 as "two-factor
    // required").
    async performSignedLogin(options) {
        const { email, baseURL, serverURL, requestFailedLogLabel, requestFailedFallbackMessage, successMessage, failureLogLabel, failureFallbackMessage, checkTwoFactorRequired, credentials, } = options;
        let loginResult;
        try {
            const loginApi = await this.buildLoginApi({ email, baseURL, serverURL });
            loginResult = await roborockAuth.signedLogin(loginApi, {
                email,
                server: this.loginServer({ baseURL, serverURL }),
                customServer: typeof serverURL === "string",
                ...credentials,
            });
        }
        catch (error) {
            console.error(requestFailedLogLabel, (error === null || error === void 0 ? void 0 : error.message) || error);
            return {
                ok: false,
                message: (error === null || error === void 0 ? void 0 : error.message) || requestFailedFallbackMessage,
            };
        }
        if (loginResult && loginResult.code === 200 && loginResult.data) {
            const encrypted = (0, crypto_2.encryptSession)(loginResult.data, this.getStoragePath());
            return {
                ok: true,
                message: successMessage,
                encryptedToken: encrypted,
            };
        }
        if (checkTwoFactorRequired && loginResult && loginResult.code === 2031) {
            return {
                ok: false,
                twoFactorRequired: true,
                message: "Two-factor authentication required.",
            };
        }
        console.error(failureLogLabel, loginResult);
        // Roborock's own text ("user agreement not accepted") does not say what
        // to do; the known refusals do.
        const refusal = roborockAuth.describeLoginRefusal(loginResult);
        return {
            ok: false,
            message: (refusal === null || refusal === void 0 ? void 0 : refusal.hint) || (loginResult === null || loginResult === void 0 ? void 0 : loginResult.msg) || failureFallbackMessage,
        };
    }
    async logout() {
        const storagePath = this.getStoragePath();
        if (!storagePath) {
            return { ok: true, message: "Logged out. Token cleared." };
        }
        // HomeData goes with the session: it caches every robot's localKey, the
        // credential that decrypts all LAN traffic. Leaving it behind meant a user
        // who had explicitly disconnected the account still had per-device keys on
        // disk. It is re-fetched on the next successful login.
        const removed = [];
        for (const file of ["roborock.UserData", "roborock.HomeData"]) {
            const target = path_1.default.join(storagePath, file);
            try {
                if (fs_1.default.existsSync(target)) {
                    fs_1.default.unlinkSync(target);
                    removed.push(file);
                }
            }
            catch (error) {
                // Ignore file removal errors.
            }
        }
        return {
            ok: true,
            message: removed.length
                ? "Logged out. Session and cached device keys cleared."
                : "Logged out. Token cleared.",
        };
    }
    async getDiagnostics() {
        try {
            const storagePath = this.getStoragePath();
            const homeDataState = this.readJsonFile(path_1.default.join(storagePath, "roborock.HomeData"));
            const userDataState = this.readJsonFile(path_1.default.join(storagePath, "roborock.UserData"));
            const transportDiagnosticsState = this.readJsonFile(path_1.default.join(storagePath, "roborock.TransportDiagnostics"));
            const roborockDiagnosticsState = this.readJsonFile(path_1.default.join(storagePath, "roborock.RoborockDiagnostics"));
            const mqttSessionState = this.readJsonFile(path_1.default.join(storagePath, "roborock.MqttSessionDiagnostics"));
            const mqttSession = this.parseStatePayload(mqttSessionState === null || mqttSessionState === void 0 ? void 0 : mqttSessionState.val);
            const homeData = this.parseStatePayload(homeDataState === null || homeDataState === void 0 ? void 0 : homeDataState.val);
            const transportDiagnostics = this.parseStatePayload(transportDiagnosticsState === null || transportDiagnosticsState === void 0 ? void 0 : transportDiagnosticsState.val) || {};
            const roborockDiagnostics = this.parseStatePayload(roborockDiagnosticsState === null || roborockDiagnosticsState === void 0 ? void 0 : roborockDiagnosticsState.val) || {};
            const products = Array.isArray(homeData === null || homeData === void 0 ? void 0 : homeData.products)
                ? homeData.products
                : [];
            const devices = this.collectDevices(homeData);
            const diagnostics = devices.map((device) => {
                var _a, _b;
                const product = products.find((entry) => entry.id == device.productId);
                const deviceModel = this.firstNonEmptyString([
                    device.model,
                    device.productModel,
                    device.productCode,
                    device.modelId,
                ]);
                const productModel = this.firstNonEmptyString([
                    product === null || product === void 0 ? void 0 : product.model,
                    product === null || product === void 0 ? void 0 : product.productModel,
                    product === null || product === void 0 ? void 0 : product.productCode,
                    product === null || product === void 0 ? void 0 : product.modelId,
                ]);
                const resolvedModel = deviceModel || productModel || "unknown";
                const localKey = this.firstNonEmptyString([device.localKey]);
                const transport = transportDiagnostics[device.duid] || {};
                const roborockDiagnostic = roborockDiagnostics[device.duid] || {};
                const connection = this.describeConnectionState(device, transport, Boolean(localKey));
                return {
                    name: device.name || device.duid || "Unknown device",
                    duid: device.duid || "",
                    serialNumber: device.sn || null,
                    productId: device.productId || null,
                    resolvedModel,
                    deviceModel: deviceModel || null,
                    productModel: productModel || null,
                    hasLocalKey: Boolean(localKey),
                    connectionStatus: connection.status,
                    connectionHealth: connection.health,
                    connectionHint: connection.hint,
                    localConnectivityState: connection.status,
                    localIp: transport.localIp || null,
                    localDiscoveryState: transport.localDiscoveryState || null,
                    tcpConnectionState: transport.tcpConnectionState || null,
                    isRemote: (_a = transport.isRemote) !== null && _a !== void 0 ? _a : null,
                    remoteReason: transport.remoteReason || null,
                    lastTransport: transport.lastTransport || null,
                    lastTransportReason: transport.lastTransportReason || null,
                    lastCommandMethod: transport.lastCommandMethod || null,
                    transportUpdatedAt: transport.updatedAt || null,
                    roborockDiagnosticUpdatedAt: roborockDiagnostic.updatedAt || null,
                    lastStatusDiagnostic: roborockDiagnostic.lastStatus || null,
                    lastServerTimerDiagnostic: roborockDiagnostic.lastServerTimer || null,
                    lastTimerDiagnostic: roborockDiagnostic.lastTimer || null,
                    lastCloudMessageDiagnostic: roborockDiagnostic.lastCloudMessage || null,
                    lastLocalMessageDiagnostic: roborockDiagnostic.lastLocalMessage || null,
                    homeDataSource: Array.isArray(homeData === null || homeData === void 0 ? void 0 : homeData.receivedDevices) &&
                        homeData.receivedDevices.some((entry) => entry.duid === device.duid)
                        ? "receivedDevices"
                        : "devices",
                    online: (_b = device.online) !== null && _b !== void 0 ? _b : null,
                };
            });
            return {
                ok: true,
                generatedAt: new Date().toISOString(),
                pluginVersion: this.getPackageVersion(),
                nodeVersion: process.version,
                storagePath,
                hasEncryptedToken: Boolean(userDataState === null || userDataState === void 0 ? void 0 : userDataState.val),
                hasHomeData: Boolean(homeData),
                mqttSession: mqttSession || null,
                deviceCount: diagnostics.length,
                devices: diagnostics,
            };
        }
        catch (error) {
            return {
                ok: false,
                message: (error === null || error === void 0 ? void 0 : error.message) || "Failed to load diagnostics.",
            };
        }
    }
    async testLocalConnections(payload) {
        const startedAt = Date.now();
        const diagnostics = await this.getDiagnostics();
        if (!diagnostics.ok) {
            return diagnostics;
        }
        const devices = Array.isArray(diagnostics.devices)
            ? diagnostics.devices.filter((device) => {
                return !(payload === null || payload === void 0 ? void 0 : payload.duid) || device.duid === payload.duid;
            })
            : [];
        if ((payload === null || payload === void 0 ? void 0 : payload.duid) && devices.length === 0) {
            return {
                ok: false,
                message: "No matching device was found in cached HomeData.",
            };
        }
        const results = await Promise.all(devices.map((device) => this.testLocalConnection(device, Boolean(payload === null || payload === void 0 ? void 0 : payload.cloudOnlyMode))));
        return {
            ok: true,
            generatedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            deviceCount: results.length,
            devices: results,
        };
    }
    async getMatterPairing() {
        try {
            const storagePath = this.getStoragePath();
            const homeDataState = this.readJsonFile(path_1.default.join(storagePath, "roborock.HomeData"));
            const homeData = this.parseStatePayload(homeDataState === null || homeDataState === void 0 ? void 0 : homeDataState.val);
            const devices = this.collectDevices(homeData);
            // Index devices by BOTH duid and serial number. The Matter accessory
            // serial in the commissioning file is the robot's SN for vacuum nodes,
            // so a duid-only map never matched and every node fell back to the
            // generic bridge label.
            const deviceByIdentifier = new Map();
            for (const device of devices) {
                if (typeof device.duid === "string" && device.duid) {
                    deviceByIdentifier.set(device.duid, device);
                }
                if (typeof device.sn === "string" && device.sn) {
                    deviceByIdentifier.set(device.sn, device);
                }
            }
            const matterPaths = this.getMatterSearchPaths(storagePath);
            const files = this.findActiveCommissioningFiles(matterPaths);
            const entries = await Promise.all(files.map(async (filePath) => {
                const commissioning = this.readJsonFile(filePath);
                if (!commissioning) {
                    return null;
                }
                return this.buildMatterPairingEntry(commissioning, filePath, deviceByIdentifier);
            }));
            const pairingEntries = entries
                .filter((entry) => Boolean(entry))
                .sort((a, b) => {
                var _a, _b;
                const weight = { bridge: 0, vacuum: 1, unknown: 2 };
                return (((_a = weight[a.kind]) !== null && _a !== void 0 ? _a : 2) -
                    ((_b = weight[b.kind]) !== null && _b !== void 0 ? _b : 2) ||
                    String(a.name).localeCompare(String(b.name)));
            });
            return {
                ok: true,
                generatedAt: new Date().toISOString(),
                storagePath,
                matterPath: matterPaths[0] || path_1.default.join(storagePath, "matter"),
                matterPaths,
                hasMatterDirectory: matterPaths.some((matterPath) => fs_1.default.existsSync(matterPath)),
                entries: pairingEntries,
            };
        }
        catch (error) {
            return {
                ok: false,
                message: (error === null || error === void 0 ? void 0 : error.message) || "Failed to load Matter pairing codes.",
            };
        }
    }
    getMatterSearchPaths(storagePath) {
        return Array.from(new Set([
            path_1.default.join(storagePath, "matter"),
            "/var/lib/homebridge/matter",
            "/homebridge/matter",
        ]));
    }
    findActiveCommissioningFiles(matterPaths) {
        const files = [];
        const seen = new Set();
        for (const matterPath of matterPaths) {
            if (!fs_1.default.existsSync(matterPath)) {
                continue;
            }
            try {
                for (const entry of fs_1.default.readdirSync(matterPath, {
                    withFileTypes: true,
                })) {
                    if (!entry.isDirectory() || entry.name.includes(".")) {
                        continue;
                    }
                    const filePath = path_1.default.join(matterPath, entry.name, "commissioning.json");
                    if (!fs_1.default.existsSync(filePath)) {
                        continue;
                    }
                    const key = this.getRealPath(filePath);
                    if (seen.has(key)) {
                        continue;
                    }
                    seen.add(key);
                    files.push(filePath);
                }
            }
            catch (_a) {
                // Ignore unreadable Matter storage locations and continue searching.
            }
        }
        return files;
    }
    getRealPath(filePath) {
        try {
            return fs_1.default.realpathSync(filePath);
        }
        catch (_a) {
            return path_1.default.resolve(filePath);
        }
    }
    async buildMatterPairingEntry(commissioning, filePath, deviceByIdentifier) {
        const serialNumber = this.firstNonEmptyString([commissioning.serialNumber]);
        const matchedDevice = serialNumber
            ? deviceByIdentifier.get(serialNumber)
            : undefined;
        const kind = matchedDevice ? "vacuum" : "bridge";
        const manualPairingCode = this.firstNonEmptyString([
            commissioning.manualPairingCode,
        ]);
        const qrCode = this.firstNonEmptyString([commissioning.qrCode]);
        const setupCode = manualPairingCode
            ? manualPairingCode.replace(/\D/g, "")
            : null;
        const qrCodeDataUrl = qrCode
            ? await qrcode_1.default.toDataURL(qrCode, {
                errorCorrectionLevel: "M",
                margin: 1,
                width: 180,
            })
            : null;
        return {
            id: path_1.default.basename(path_1.default.dirname(filePath)),
            kind,
            name: (matchedDevice === null || matchedDevice === void 0 ? void 0 : matchedDevice.name) ||
                (kind === "bridge" ? "Matter Roborock Bridge" : "Matter accessory"),
            serialNumber: serialNumber || null,
            matchedDuid: (matchedDevice === null || matchedDevice === void 0 ? void 0 : matchedDevice.duid) || null,
            matchedSerial: (matchedDevice === null || matchedDevice === void 0 ? void 0 : matchedDevice.sn) || null,
            qrCode,
            qrCodeDataUrl,
            manualPairingCode,
            setupCode,
            passcode: commissioning.passcode === undefined || commissioning.passcode === null
                ? null
                : String(commissioning.passcode),
            discriminator: commissioning.discriminator === undefined ||
                commissioning.discriminator === null
                ? null
                : String(commissioning.discriminator),
            commissioned: Boolean(commissioning.commissioned),
            fabricCount: typeof commissioning.fabricCount === "number"
                ? commissioning.fabricCount
                : null,
            updatedAt: this.getFileUpdatedAt(filePath),
            // Both hints used to describe a pairing order that cannot happen:
            // Homebridge publishes a robotic vacuum as a Matter node of its own, so
            // the robot never arrives inside the bridge node and Apple Home is never
            // in a position to offer it as an extra afterwards. Reported in issue #7
            // by a user who had to reverse the instruction to get paired at all.
            hint: kind === "bridge"
                ? "This code commissions the child bridge itself. The robots do not need it — each robot has its own Matter pairing code in this list."
                : "Add this robot to Apple Home with its own 11-digit Matter setup code. Nothing else has to be paired for it to work.",
        };
    }
    getFileUpdatedAt(filePath) {
        try {
            return fs_1.default.statSync(filePath).mtime.toISOString();
        }
        catch (_a) {
            return null;
        }
    }
    async testLocalConnection(device, cloudOnlyMode) {
        const localIp = device.localIp;
        const port = LOCAL_CONTROL_PORT;
        const cloudFallbackLikely = isCloudFallbackLikely(device);
        const baseResult = {
            name: device.name || device.duid || "Unknown device",
            duid: device.duid || "",
            localIp: localIp || null,
            port,
            checkedAt: new Date().toISOString(),
            cloudFallbackLikely,
            cachedConnectionStatus: device.connectionStatus || "unknown",
            cachedTcpState: device.tcpConnectionState || "n/a",
            cachedLastTransport: device.lastTransport || "n/a",
            cachedLastReason: device.lastTransportReason || "n/a",
            cachedTransportUpdatedAt: device.transportUpdatedAt || null,
            connectionSource: "tcp-probe",
            latencyMs: null,
        };
        const probeSkip = describeLocalProbeSkip({
            cloudOnlyProtocol: isCloudOnlyProtocol(device),
            cloudOnlyMode,
            hasLocalKey: Boolean(device.hasLocalKey),
            online: device.online,
            localIp,
        });
        if (probeSkip) {
            return {
                ...baseResult,
                status: "skipped",
                health: probeSkip.health,
                message: probeSkip.message,
            };
        }
        const activeLocalConnection = this.describeActiveLocalConnection(device);
        if (activeLocalConnection) {
            return {
                ...baseResult,
                status: "passed",
                health: "good",
                connectionSource: activeLocalConnection.source,
                message: activeLocalConnection.message,
            };
        }
        try {
            const probe = await this.probeTcp(localIp, port, 3500);
            return {
                ...baseResult,
                status: "passed",
                health: "good",
                latencyMs: probe.latencyMs,
                message: `TCP probe reached ${localIp}:${port} in ${probe.latencyMs} ms.`,
            };
        }
        catch (error) {
            return {
                ...baseResult,
                status: "failed",
                health: "warn",
                message: `Could not open a TCP connection to ${localIp}:${port}. ${this.formatProbeError(error)}`,
            };
        }
    }
    describeActiveLocalConnection(device) {
        const localIp = device.localIp;
        const port = LOCAL_CONTROL_PORT;
        const lastCommand = device.lastCommandMethod
            ? ` Last local command: ${device.lastCommandMethod}.`
            : "";
        if (device.tcpConnectionState === "connected") {
            return {
                source: "cached-active-tcp",
                message: `Homebridge already has an active LAN TCP connection to ${localIp}:${port}, so the diagnostics test did not open a second probe.${lastCommand}`,
            };
        }
        const transportUpdatedAt = this.parseTimestamp(device.transportUpdatedAt);
        if (device.lastTransport === "local" &&
            transportUpdatedAt !== null &&
            Date.now() - transportUpdatedAt <= ACTIVE_LOCAL_TRANSPORT_MAX_AGE_MS) {
            return {
                source: "cached-recent-local-command",
                message: `Homebridge used LAN control for this vacuum within the last ${this.formatAge(Date.now() - transportUpdatedAt)}, so the cached local path is healthy.${lastCommand}`,
            };
        }
        return null;
    }
    parseTimestamp(value) {
        if (typeof value !== "string" || !value.trim()) {
            return null;
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    formatAge(ageMs) {
        const seconds = Math.max(0, Math.round(ageMs / 1000));
        if (seconds < 60) {
            return `${seconds} second${seconds === 1 ? "" : "s"}`;
        }
        const minutes = Math.round(seconds / 60);
        return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    probeTcp(host, port, timeoutMs) {
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const socket = new net_1.default.Socket();
            let settled = false;
            // Ensure socket doesn't keep process alive
            socket.unref();
            const finish = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                socket.removeAllListeners();
                // Ensure socket is properly destroyed
                try {
                    socket.destroy();
                }
                catch (_a) {
                    // Ignore errors during destroy
                }
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ latencyMs: Date.now() - startedAt });
            };
            const timer = setTimeout(() => {
                finish(new Error(`Timed out after ${timeoutMs} ms.`));
            }, timeoutMs);
            socket.once("connect", () => finish());
            socket.once("error", (error) => finish(error));
            socket.connect(port, host);
        });
    }
    formatProbeError(error) {
        const code = (error === null || error === void 0 ? void 0 : error.code) ? `${error.code}: ` : "";
        const message = (error === null || error === void 0 ? void 0 : error.message) || String(error);
        return `${code}${message}`;
    }
    readJsonFile(filePath) {
        try {
            if (!fs_1.default.existsSync(filePath)) {
                return null;
            }
            return JSON.parse(fs_1.default.readFileSync(filePath, "utf8"));
        }
        catch (_a) {
            return null;
        }
    }
    parseStatePayload(value) {
        if (typeof value !== "string") {
            return null;
        }
        try {
            return JSON.parse(value);
        }
        catch (_a) {
            return null;
        }
    }
    collectDevices(homeData) {
        if (!homeData) {
            return [];
        }
        const devices = Array.isArray(homeData.devices) ? homeData.devices : [];
        const receivedDevices = Array.isArray(homeData.receivedDevices)
            ? homeData.receivedDevices
            : [];
        return [...devices, ...receivedDevices];
    }
    firstNonEmptyString(values) {
        for (const value of values) {
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }
        return null;
    }
    describeConnectionState(device, transport, hasLocalCredentials) {
        return describeConnectionState(device, transport, hasLocalCredentials);
    }
    getPackageVersion() {
        try {
            const packageJson = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, "../../package.json"), "utf8"));
            return packageJson.version || "unknown";
        }
        catch (_a) {
            return "unknown";
        }
    }
}
exports.RoborockUiServer = RoborockUiServer;
//# sourceMappingURL=index.js.map