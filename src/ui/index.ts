import crypto from "crypto";
import path from "path";
import fs from "fs";
import net from "net";
import QRCode from "qrcode";
import { encryptSession } from "../crypto";

const roborockAuth = require("../../roborockLib/lib/roborockAuth");

const ACTIVE_LOCAL_TRANSPORT_MAX_AGE_MS = 5 * 60 * 1000;
const LOCAL_CONTROL_PORT = 58867;

// Type definition for HomebridgePluginUiServer to maintain type safety
interface IHomebridgePluginUiServer {
  homebridgeStoragePath?: string;
  onRequest(path: string, handler: (payload: any) => Promise<any>): void;
  ready(): void;
}

type HomebridgePluginUiServerConstructor = new () => IHomebridgePluginUiServer;

interface MatterPairingEntry {
  id: string;
  kind: "bridge" | "vacuum";
  name: string;
  serialNumber: string | null;
  matchedDuid: string | null;
  matchedSerial: string | null;
  qrCode: string | null;
  qrCodeDataUrl: string | null;
  manualPairingCode: string | null;
  setupCode: string | null;
  passcode: string | null;
  discriminator: string | null;
  commissioned: boolean;
  fabricCount: number | null;
  updatedAt: string | null;
  hint: string;
}

class RoborockUiServer {
  private homebridgePluginUiServer: IHomebridgePluginUiServer;
  private homebridgeStoragePath?: string;

  constructor(HomebridgePluginUiServer: HomebridgePluginUiServerConstructor) {
    this.homebridgePluginUiServer = new HomebridgePluginUiServer();
    this.homebridgeStoragePath =
      this.homebridgePluginUiServer.homebridgeStoragePath;

    this.homebridgePluginUiServer.onRequest(
      "/auth/send-2fa-email",
      this.sendTwoFactorEmail.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/verify-2fa-code",
      this.verifyTwoFactorCode.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/login",
      this.loginWithPassword.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/auth/logout",
      this.logout.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/diagnostics/state",
      this.getDiagnostics.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/diagnostics/test-local",
      this.testLocalConnections.bind(this)
    );
    this.homebridgePluginUiServer.onRequest(
      "/matter/pairing",
      this.getMatterPairing.bind(this)
    );

    this.homebridgePluginUiServer.ready();
  }

  private getStoragePath(): string {
    return this.homebridgeStoragePath || process.cwd();
  }

  private async getClientId(): Promise<string> {
    const storagePath = this.getStoragePath();
    if (storagePath) {
      const clientIdPath = path.join(storagePath, "roborock.clientID");
      try {
        const stored = JSON.parse(fs.readFileSync(clientIdPath, "utf8"));
        if (stored && stored.val) {
          return stored.val;
        }
      } catch (error) {
        // Ignore and generate a new client ID.
      }
      const clientId = crypto.randomUUID();
      fs.mkdirSync(storagePath, { recursive: true });
      fs.writeFileSync(
        clientIdPath,
        JSON.stringify({ val: clientId, ack: true }, null, 2),
        "utf8"
      );
      return clientId;
    }

    return crypto.randomUUID();
  }

  private async buildLoginApi(config: Record<string, any>) {
    const clientID = await this.getClientId();
    return roborockAuth.createLoginApi({
      baseURL: config.baseURL || "usiot.roborock.com",
      username: config.email,
      clientID,
      language: "en",
    });
  }

  private async sendTwoFactorEmail(payload: {
    email?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    if (!email) {
      return { ok: false, message: "Email is required." };
    }

    try {
      const loginApi = await this.buildLoginApi({
        email,
        baseURL: payload.baseURL,
      });
      await roborockAuth.requestEmailCode(loginApi, email);
      return { ok: true, message: "Verification email sent." };
    } catch (error: any) {
      console.error("2FA email request failed:", error?.message || error);
      return {
        ok: false,
        message: error?.message || "Failed to send verification email.",
      };
    }
  }

  private async verifyTwoFactorCode(payload: {
    email?: string;
    code: string;
    baseURL?: string;
  }) {
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
      requestFailedLogLabel: "2FA verification request failed:",
      requestFailedFallbackMessage: "Verification failed.",
      successMessage: "Login completed and token saved.",
      failureLogLabel: "2FA verification failed:",
      failureFallbackMessage: "Verification failed.",
      performLogin: async (loginApi, nonce, k) => {
        const region = roborockAuth.getRegionConfig(
          payload.baseURL || "usiot.roborock.com"
        );
        return roborockAuth.loginWithCode(loginApi, {
          email,
          code: payload.code,
          country: region.country,
          countryCode: region.countryCode,
          k,
          s: nonce,
        });
      },
    });
  }

  private async loginWithPassword(payload: {
    email?: string;
    password?: string;
    baseURL?: string;
  }) {
    const email = payload.email;
    const password = payload.password;

    if (!email || !password) {
      return { ok: false, message: "Email and password are required." };
    }

    return this.performSignedLogin({
      email,
      baseURL: payload.baseURL,
      requestFailedLogLabel: "Login request failed:",
      requestFailedFallbackMessage: "Login failed.",
      successMessage: "Login successful. Token saved.",
      failureLogLabel: "Login failed:",
      failureFallbackMessage: "Login failed. Check your credentials.",
      checkTwoFactorRequired: true,
      performLogin: (loginApi, nonce, k) =>
        roborockAuth.loginByPassword(loginApi, {
          email,
          password,
          k,
          s: nonce,
        }),
    });
  }

  // Shared by verifyTwoFactorCode and loginWithPassword: both build a login
  // API, sign a nonce, invoke a login function with the resulting `k`, then
  // map the response to the same success/failure shape (loginWithPassword
  // additionally treats code 2031 as "two-factor required").
  private async performSignedLogin(options: {
    email: string;
    baseURL?: string;
    requestFailedLogLabel: string;
    requestFailedFallbackMessage: string;
    successMessage: string;
    failureLogLabel: string;
    failureFallbackMessage: string;
    checkTwoFactorRequired?: boolean;
    performLogin: (loginApi: any, nonce: string, k: string) => Promise<any>;
  }) {
    const {
      email,
      baseURL,
      requestFailedLogLabel,
      requestFailedFallbackMessage,
      successMessage,
      failureLogLabel,
      failureFallbackMessage,
      checkTwoFactorRequired,
      performLogin,
    } = options;

    let loginResult;
    try {
      const loginApi = await this.buildLoginApi({ email, baseURL });
      const nonce = this.buildNonce();
      const signData = await roborockAuth.signRequest(loginApi, nonce);
      if (!signData || !signData.k) {
        return { ok: false, message: "Failed to create login signature." };
      }

      loginResult = await performLogin(loginApi, nonce, signData.k);
    } catch (error: any) {
      console.error(requestFailedLogLabel, error?.message || error);
      return {
        ok: false,
        message: error?.message || requestFailedFallbackMessage,
      };
    }

    if (loginResult && loginResult.code === 200 && loginResult.data) {
      const encrypted = encryptSession(loginResult.data, this.getStoragePath());
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
    return { ok: false, message: loginResult?.msg || failureFallbackMessage };
  }

  private async logout() {
    const storagePath = this.getStoragePath();
    if (!storagePath) {
      return { ok: true, message: "Logged out. Token cleared." };
    }

    const userDataPath = path.join(storagePath, "roborock.UserData");
    try {
      if (fs.existsSync(userDataPath)) {
        fs.unlinkSync(userDataPath);
      }
    } catch (error) {
      // Ignore file removal errors.
    }

    return { ok: true, message: "Logged out. Token cleared." };
  }

  private async getDiagnostics() {
    try {
      const storagePath = this.getStoragePath();
      const homeDataState = this.readJsonFile(
        path.join(storagePath, "roborock.HomeData")
      );
      const userDataState = this.readJsonFile(
        path.join(storagePath, "roborock.UserData")
      );
      const transportDiagnosticsState = this.readJsonFile(
        path.join(storagePath, "roborock.TransportDiagnostics")
      );
      const roborockDiagnosticsState = this.readJsonFile(
        path.join(storagePath, "roborock.RoborockDiagnostics")
      );
      const homeData = this.parseStatePayload(homeDataState?.val);
      const transportDiagnostics =
        this.parseStatePayload(transportDiagnosticsState?.val) || {};
      const roborockDiagnostics =
        this.parseStatePayload(roborockDiagnosticsState?.val) || {};

      const products = Array.isArray(homeData?.products)
        ? homeData.products
        : [];
      const devices = this.collectDevices(homeData);
      const diagnostics = devices.map((device: Record<string, any>) => {
        const product = products.find(
          (entry: Record<string, any>) => entry.id == device.productId
        );
        const deviceModel = this.firstNonEmptyString([
          device.model,
          device.productModel,
          device.productCode,
          device.modelId,
        ]);
        const productModel = this.firstNonEmptyString([
          product?.model,
          product?.productModel,
          product?.productCode,
          product?.modelId,
        ]);
        const resolvedModel = deviceModel || productModel || "unknown";
        const localKey = this.firstNonEmptyString([device.localKey]);
        const transport = transportDiagnostics[device.duid] || {};
        const roborockDiagnostic = roborockDiagnostics[device.duid] || {};
        const connection = this.describeConnectionState(
          device,
          transport,
          Boolean(localKey)
        );

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
          isRemote: transport.isRemote ?? null,
          remoteReason: transport.remoteReason || null,
          lastTransport: transport.lastTransport || null,
          lastTransportReason: transport.lastTransportReason || null,
          lastCommandMethod: transport.lastCommandMethod || null,
          transportUpdatedAt: transport.updatedAt || null,
          roborockDiagnosticUpdatedAt: roborockDiagnostic.updatedAt || null,
          lastStatusDiagnostic: roborockDiagnostic.lastStatus || null,
          lastServerTimerDiagnostic: roborockDiagnostic.lastServerTimer || null,
          lastTimerDiagnostic: roborockDiagnostic.lastTimer || null,
          lastCloudMessageDiagnostic:
            roborockDiagnostic.lastCloudMessage || null,
          lastLocalMessageDiagnostic:
            roborockDiagnostic.lastLocalMessage || null,
          homeDataSource:
            Array.isArray(homeData?.receivedDevices) &&
            homeData.receivedDevices.some(
              (entry: Record<string, any>) => entry.duid === device.duid
            )
              ? "receivedDevices"
              : "devices",
          online: device.online ?? null,
        };
      });

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        pluginVersion: this.getPackageVersion(),
        nodeVersion: process.version,
        storagePath,
        hasEncryptedToken: Boolean(userDataState?.val),
        hasHomeData: Boolean(homeData),
        deviceCount: diagnostics.length,
        devices: diagnostics,
      };
    } catch (error: any) {
      return {
        ok: false,
        message: error?.message || "Failed to load diagnostics.",
      };
    }
  }

  private async testLocalConnections(payload?: {
    duid?: string;
    cloudOnlyMode?: boolean;
  }) {
    const startedAt = Date.now();
    const diagnostics = await this.getDiagnostics();

    if (!diagnostics.ok) {
      return diagnostics;
    }

    const devices = Array.isArray(diagnostics.devices)
      ? diagnostics.devices.filter((device: Record<string, any>) => {
          return !payload?.duid || device.duid === payload.duid;
        })
      : [];

    if (payload?.duid && devices.length === 0) {
      return {
        ok: false,
        message: "No matching device was found in cached HomeData.",
      };
    }

    const results = await Promise.all(
      devices.map((device: Record<string, any>) =>
        this.testLocalConnection(device, Boolean(payload?.cloudOnlyMode))
      )
    );

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      deviceCount: results.length,
      devices: results,
    };
  }

  private async getMatterPairing() {
    try {
      const storagePath = this.getStoragePath();
      const homeDataState = this.readJsonFile(
        path.join(storagePath, "roborock.HomeData")
      );
      const homeData = this.parseStatePayload(homeDataState?.val);
      const devices = this.collectDevices(homeData);
      // Index devices by BOTH duid and serial number. The Matter accessory
      // serial in the commissioning file is the robot's SN for vacuum nodes,
      // so a duid-only map never matched and every node fell back to the
      // generic bridge label.
      const deviceByIdentifier = new Map<string, Record<string, any>>();
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
      const entries = await Promise.all(
        files.map(async (filePath) => {
          const commissioning = this.readJsonFile(filePath);
          if (!commissioning) {
            return null;
          }

          return this.buildMatterPairingEntry(
            commissioning,
            filePath,
            deviceByIdentifier
          );
        })
      );
      const pairingEntries = entries
        .filter((entry): entry is MatterPairingEntry => Boolean(entry))
        .sort((a, b) => {
          const weight = { bridge: 0, vacuum: 1, unknown: 2 };
          return (
            (weight[a.kind as keyof typeof weight] ?? 2) -
              (weight[b.kind as keyof typeof weight] ?? 2) ||
            String(a.name).localeCompare(String(b.name))
          );
        });

      return {
        ok: true,
        generatedAt: new Date().toISOString(),
        storagePath,
        matterPath: matterPaths[0] || path.join(storagePath, "matter"),
        matterPaths,
        hasMatterDirectory: matterPaths.some((matterPath) =>
          fs.existsSync(matterPath)
        ),
        entries: pairingEntries,
      };
    } catch (error: any) {
      return {
        ok: false,
        message: error?.message || "Failed to load Matter pairing codes.",
      };
    }
  }

  private getMatterSearchPaths(storagePath: string): string[] {
    return Array.from(
      new Set([
        path.join(storagePath, "matter"),
        "/var/lib/homebridge/matter",
        "/homebridge/matter",
      ])
    );
  }

  private findActiveCommissioningFiles(matterPaths: string[]): string[] {
    const files: string[] = [];
    const seen = new Set<string>();

    for (const matterPath of matterPaths) {
      if (!fs.existsSync(matterPath)) {
        continue;
      }

      try {
        for (const entry of fs.readdirSync(matterPath, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || entry.name.includes(".")) {
            continue;
          }

          const filePath = path.join(
            matterPath,
            entry.name,
            "commissioning.json"
          );
          if (!fs.existsSync(filePath)) {
            continue;
          }

          const key = this.getRealPath(filePath);
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          files.push(filePath);
        }
      } catch {
        // Ignore unreadable Matter storage locations and continue searching.
      }
    }

    return files;
  }

  private getRealPath(filePath: string): string {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }

  private async buildMatterPairingEntry(
    commissioning: Record<string, any>,
    filePath: string,
    deviceByIdentifier: Map<string, Record<string, any>>
  ): Promise<MatterPairingEntry> {
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
      ? await QRCode.toDataURL(qrCode, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 180,
        })
      : null;

    return {
      id: path.basename(path.dirname(filePath)),
      kind,
      name:
        matchedDevice?.name ||
        (kind === "bridge" ? "Matter Roborock Bridge" : "Matter accessory"),
      serialNumber: serialNumber || null,
      matchedDuid: matchedDevice?.duid || null,
      matchedSerial: matchedDevice?.sn || null,
      qrCode,
      qrCodeDataUrl,
      manualPairingCode,
      setupCode,
      passcode:
        commissioning.passcode === undefined || commissioning.passcode === null
          ? null
          : String(commissioning.passcode),
      discriminator:
        commissioning.discriminator === undefined ||
        commissioning.discriminator === null
          ? null
          : String(commissioning.discriminator),
      commissioned: Boolean(commissioning.commissioned),
      fabricCount:
        typeof commissioning.fabricCount === "number"
          ? commissioning.fabricCount
          : null,
      updatedAt: this.getFileUpdatedAt(filePath),
      hint:
        kind === "bridge"
          ? "Scan this QR code first when adding the Roborock child/daughter bridge to Apple Home."
          : "Use this 11-digit setup code if Apple Home asks to add the external Roborock vacuum after the bridge is paired.",
    };
  }

  private getFileUpdatedAt(filePath: string): string | null {
    try {
      return fs.statSync(filePath).mtime.toISOString();
    } catch {
      return null;
    }
  }

  private async testLocalConnection(
    device: Record<string, any>,
    cloudOnlyMode: boolean
  ) {
    const localIp = device.localIp;
    const port = LOCAL_CONTROL_PORT;
    const cloudFallbackLikely =
      device.lastTransport === "cloud" ||
      device.connectionStatus === "Cloud fallback";
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
      latencyMs: null as number | null,
    };

    const skip = (message: string) => ({
      ...baseResult,
      status: "skipped",
      health: "warn",
      message,
    });

    if (cloudOnlyMode) {
      return skip(
        "Use Roborock cloud only is enabled, so local LAN probing is skipped until cloud-only mode is disabled and Homebridge is restarted."
      );
    }

    if (!device.hasLocalKey) {
      return skip(
        "No local credential is cached for this vacuum, so a LAN control test cannot run yet."
      );
    }

    if (device.online === false) {
      return skip(
        "Roborock currently reports this vacuum offline. Wake the vacuum or place it on the dock, then test again."
      );
    }

    if (!localIp) {
      return skip(
        "No local IP address is cached yet. Let the plugin complete startup or press Refresh after the vacuum wakes up."
      );
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
    } catch (error: any) {
      return {
        ...baseResult,
        status: "failed",
        health: "warn",
        message: `Could not open a TCP connection to ${localIp}:${port}. ${this.formatProbeError(error)}`,
      };
    }
  }

  private describeActiveLocalConnection(
    device: Record<string, any>
  ): { source: string; message: string } | null {
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
    if (
      device.lastTransport === "local" &&
      transportUpdatedAt !== null &&
      Date.now() - transportUpdatedAt <= ACTIVE_LOCAL_TRANSPORT_MAX_AGE_MS
    ) {
      return {
        source: "cached-recent-local-command",
        message: `Homebridge used LAN control for this vacuum within the last ${this.formatAge(Date.now() - transportUpdatedAt)}, so the cached local path is healthy.${lastCommand}`,
      };
    }

    return null;
  }

  private parseTimestamp(value: unknown): number | null {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private formatAge(ageMs: number): string {
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    if (seconds < 60) {
      return `${seconds} second${seconds === 1 ? "" : "s"}`;
    }

    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  private probeTcp(
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<{ latencyMs: number }> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const socket = new net.Socket();
      let settled = false;

      // Ensure socket doesn't keep process alive
      socket.unref();

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();

        // Ensure socket is properly destroyed
        try {
          socket.destroy();
        } catch {
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

  private formatProbeError(error: any): string {
    const code = error?.code ? `${error.code}: ` : "";
    const message = error?.message || String(error);
    return `${code}${message}`;
  }

  private buildNonce(): string {
    return crypto
      .randomBytes(12)
      .toString("base64")
      .substring(0, 16)
      .replace(/\+/g, "X")
      .replace(/\//g, "Y");
  }

  private readJsonFile(filePath: string): any | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  private parseStatePayload(value: unknown): Record<string, any> | null {
    if (typeof value !== "string") {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private collectDevices(
    homeData: Record<string, any> | null
  ): Record<string, any>[] {
    if (!homeData) {
      return [];
    }

    const devices = Array.isArray(homeData.devices) ? homeData.devices : [];
    const receivedDevices = Array.isArray(homeData.receivedDevices)
      ? homeData.receivedDevices
      : [];
    return [...devices, ...receivedDevices];
  }

  private firstNonEmptyString(values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }

  private describeConnectionState(
    device: Record<string, any>,
    transport: Record<string, any>,
    hasLocalCredentials: boolean
  ): { status: string; health: "good" | "warn"; hint: string } {
    const tcpState = transport.tcpConnectionState;
    const lastTransportReason =
      transport.lastTransportReason || transport.remoteReason || null;
    const hasLocalIp = Boolean(transport.localIp);

    if (
      lastTransportReason === "cloud-only-mode" ||
      transport.localDiscoveryState === "disabled" ||
      tcpState === "disabled"
    ) {
      return {
        status: "Cloud only",
        health: "good",
        hint: "Cloud-only mode is enabled, so local LAN discovery and local TCP control are disabled for this plugin.",
      };
    }

    if (tcpState === "connected") {
      return {
        status: "Local connected",
        health: "good",
        hint: "The plugin has an active LAN TCP connection to this vacuum.",
      };
    }

    if (device.online === false || lastTransportReason === "device-offline") {
      return {
        status: "Device offline",
        health: "warn",
        hint: hasLocalCredentials
          ? "Roborock currently reports this vacuum offline. Local credentials are available, but the plugin cannot use them until the vacuum wakes up and rejoins Wi-Fi."
          : "Roborock currently reports this vacuum offline, and no local credentials were found for LAN control.",
      };
    }

    if (transport.lastTransport === "cloud") {
      return {
        status: "Cloud fallback",
        health: "warn",
        hint: hasLocalCredentials
          ? "The plugin has local credentials but the last command used Roborock cloud transport, usually because LAN TCP was not connected at that moment."
          : "The last command used Roborock cloud transport because local LAN credentials are not available.",
      };
    }

    if (hasLocalCredentials && hasLocalIp) {
      return {
        status: "Ready for local connection",
        health: "warn",
        hint: "The plugin has local credentials and a discovered IP address, but no active LAN TCP connection is currently cached.",
      };
    }

    if (hasLocalCredentials) {
      return {
        status: "Local credentials available",
        health: "warn",
        hint: "The plugin has the credential needed for LAN control, but it has not discovered or connected to the vacuum locally yet.",
      };
    }

    return {
      status: "Cloud-only fallback likely",
      health: "warn",
      hint: "No local LAN credential was found for this vacuum, so the plugin will likely rely on Roborock cloud transport.",
    };
  }

  private getPackageVersion(): string {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")
      );
      return packageJson.version || "unknown";
    } catch {
      return "unknown";
    }
  }
}

// This module deliberately has no side effects. @homebridge/plugin-ui-utils
// v2+ is a pure ES module that cannot be require()d from CommonJS output, so
// the ESM entry point homebridge-ui/server.js (its directory is marked
// "type": "module") performs the native `import` of plugin-ui-utils and then
// instantiates the exported class below. No dynamic-code-evaluation shims.
export { RoborockUiServer };
