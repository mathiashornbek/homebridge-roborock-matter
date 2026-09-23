"use strict";

// Observations only. Nothing in this class reconnects, gates requests, or
// makes breaker decisions. Silence while idle is normal.
const SILENCE_WINDOW_MS = 60_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_ROBOTS = 128;

/** @typedef {"raw" | "attributed" | "decoded" | "correlated" | "local"} ActivityStage */
class MqttSessionDiagnostics {
  /** @param {(snapshot: ReturnType<MqttSessionDiagnostics["snapshot"]>) => void} publish */
  constructor(publish = () => {}) {
    this.publish = publish;
    this.generation = 0;
    this.connected = false;
    this.subscriptionAcknowledged = false;
    this.rawSequence = 0;
    /** @type {number | null} */
    this.connectedAt = null;
    /** @type {Record<ActivityStage, number | null>} */
    this.activity = {
      raw: null,
      attributed: null,
      decoded: null,
      correlated: null,
      local: null,
    };
    /** @type {Map<string, number>} */
    this.silentReads = new Map();
    /** @type {number | null} */
    this.lastPublishedAt = null;
  }

  onConnect() {
    this.generation += 1;
    this.connected = true;
    this.subscriptionAcknowledged = false;
    this.connectedAt = performance.now();
    this.activity = {
      raw: null,
      attributed: null,
      decoded: null,
      correlated: null,
      local: null,
    };
    this.silentReads.clear();
    this.emit(true);
    return this.generation;
  }

  onDisconnect() {
    this.connected = false;
    this.subscriptionAcknowledged = false;
    this.silentReads.clear();
    this.emit(true);
  }

  /** @param {number} generation @param {unknown} error @param {unknown} granted */
  onSubscribe(generation, error, granted) {
    if (generation !== this.generation || !this.connected) return;
    this.subscriptionAcknowledged =
      !error &&
      Array.isArray(granted) &&
      granted.length > 0 &&
      granted.every((entry) => [0, 1, 2].includes(entry.qos));
    this.emit(true);
  }

  /** @param {ActivityStage} stage */
  noteActivity(stage) {
    this.activity[stage] = performance.now();
    if (stage === "raw") {
      this.rawSequence += 1;
      this.silentReads.clear();
    }
  }

  captureRequest() {
    return { generation: this.generation, rawSequence: this.rawSequence };
  }

  /**
   * @param {string} duid
   * @param {string} method
   * @param {{generation: number, rawSequence: number} | undefined} request
   */
  noteTimeout(duid, method, request) {
    this.prune();
    // Only active, unanswered reads on an acknowledged, connected session
    // can contribute. A write may have succeeded even without its reply.
    const requestWasSilent = Boolean(
      this.connected &&
        this.subscriptionAcknowledged &&
        request &&
        request.generation === this.generation &&
        request.rawSequence === this.rawSequence &&
        /^get_/.test(method)
    );
    if (requestWasSilent) {
      if (!this.silentReads.has(duid) && this.silentReads.size >= MAX_ROBOTS) {
        const oldest = this.silentReads.keys().next().value;
        if (oldest !== undefined) this.silentReads.delete(oldest);
      }
      this.silentReads.set(duid, performance.now());
    }
    this.emit(true);
    // The account observation alone must not exempt a write, a request
    // spanning generations, or one that saw inbound traffic while pending.
    return { ...this.snapshot(), requestWasSilent };
  }

  prune() {
    const cutoff = performance.now() - SILENCE_WINDOW_MS;
    for (const [duid, at] of this.silentReads) {
      if (at < cutoff) this.silentReads.delete(duid);
    }
  }

  snapshot() {
    this.prune();
    const now = performance.now();
    /** @param {number | null} at */
    const age = (at) =>
      at === null ? null : Math.max(0, Math.round(now - at));
    return {
      capturedAt: new Date().toISOString(),
      generation: this.generation,
      connected: this.connected,
      subscriptionAcknowledged: this.subscriptionAcknowledged,
      connectedAgeMs: age(this.connectedAt),
      lastRawInboundAgeMs: age(this.activity.raw),
      lastAttributedInboundAgeMs: age(this.activity.attributed),
      lastDecodedInboundAgeMs: age(this.activity.decoded),
      lastCorrelatedReplyAgeMs: age(this.activity.correlated),
      lastLocalReplyAgeMs: age(this.activity.local),
      silentReadRobotCount: this.silentReads.size,
      correlatedSilenceObserved: this.silentReads.size >= 2,
      observationWindowMs: SILENCE_WINDOW_MS,
    };
  }

  emit(force = false) {
    const now = performance.now();
    if (
      !force &&
      this.lastPublishedAt !== null &&
      now - this.lastPublishedAt < SNAPSHOT_INTERVAL_MS
    )
      return;
    this.lastPublishedAt = now;
    // Telemetry failure must not interfere with message handling.
    try {
      this.publish(this.snapshot());
    } catch {
      /* observation only */
    }
  }
}

module.exports = { MqttSessionDiagnostics };
