"use strict";

const PREVENTIVE_AGE_MS = 4 * 60 * 60 * 1000;
const COOLDOWN_MS = 60_000;
const SILENCE_COOLDOWN_MS = 30 * 60_000;
const READY_TIMEOUT_MS = 20_000;
const DRAIN_MS = 500;

// Opt-in lifecycle only. Observations and breaker policy remain usable without it.
class MqttSessionRecovery {
  constructor(connector) {
    this.connector = connector;
    this.adapter = connector.adapter;
    this.preventiveRefreshEnabled =
      this.adapter.config.enableMqttPreventiveRefresh === true;
    /** @type {string | null} */
    this.lastReason = null;
    this.lastResult = "never";
    this.stopped = false;
    this.recovering = false;
    this.sendPaused = false;
    this.inFlight = null;
    this.readyAt = null;
    this.nextAllowedAt = 0;
    this.failures = 0;
    this.waits = new Set();
    this.timer = null;
    this.retryTimer = null;
  }

  // Connection listeners and logging are installed by the same connector path
  // as ordinary MQTT. They use v3.39.0's listen/whileCurrent retirement guards.
  install() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (
          this.preventiveRefreshEnabled &&
          this.readyAt !== null &&
          performance.now() - this.readyAt >= PREVENTIVE_AGE_MS
        ) {
          void this.recreate("preventive");
        }
      }, 60_000);
      this.timer.unref?.();
    }
  }

  onSessionChanged() {
    const session = this.connector.sessionDiagnostics;
    if (session.connected && session.subscriptionAcknowledged) {
      if (this.readyAt === null) this.readyAt = performance.now();
      if (!this.recovering && this.lastResult === "failed") {
        this.lastResult = "recovered";
        this.failures = 0;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } else {
      this.readyAt = null;
    }
  }

  observeTimeout(observation) {
    if (
      observation?.requestWasSilent &&
      observation?.correlatedSilenceObserved
    ) {
      void this.recreate("correlated-silence");
    }
  }

  snapshot() {
    return {
      enabled: true,
      preventiveRefreshEnabled: this.preventiveRefreshEnabled,
      inProgress: this.recovering,
      lastReason: this.lastReason,
      lastResult: this.lastResult,
      cooldownRemainingMs: Math.max(
        0,
        Math.round(this.nextAllowedAt - performance.now())
      ),
      silenceCooldownRemainingMs: Math.max(
        0,
        (this.adapter.cloudSessionHealth?.lastRestartAt || 0) +
          SILENCE_COOLDOWN_MS -
          Date.now()
      ),
      consecutiveFailures: this.failures,
    };
  }

  pending() {
    return [
      ...[...(this.adapter.pendingRequests?.entries() || [])]
        .filter(([, request]) => request.transport === "cloud")
        .map(([key, request]) => ({
          map: this.adapter.pendingRequests,
          key,
          request,
        })),
      ...[...(this.adapter.pendingB01MapRequests?.entries() || [])].map(
        ([key, request]) => ({
          map: this.adapter.pendingB01MapRequests,
          key,
          request,
        })
      ),
    ];
  }

  rejectPending() {
    for (const { map, key, request } of this.pending()) {
      this.adapter.clearTimeout(request.timeout);
      map.delete(key);
      // Teardown is not a robot reply; keep upstream silence/breaker evidence.
      (request.abandon ?? request.reject)(
        Object.assign(
          new Error(
            "The MQTT session was replaced before a reply arrived. The command outcome is unknown; it was not replayed."
          ),
          {
            code: "MQTT_SESSION_REPLACED",
            transientKind: "mqtt session replaced",
            transportWasUp: false,
            unansweredRequest: false,
          }
        )
      );
    }
  }

  pause(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waits.add(finish);
    });
  }

  async close(candidate) {
    if (!candidate) return;
    // Keep mqtt.js's own close/error listeners so its CONNACK timer is cleared.
    // The connector's listen/whileCurrent wrappers ignore the retired client.
    if (this.connector.client === candidate) this.connector.client = undefined;
    if (candidate.endAsync) {
      const timeout = this.pause(2000);
      const cancel = [...this.waits].at(-1);
      try {
        await Promise.race([candidate.endAsync(true), timeout]);
      } finally {
        cancel?.();
      }
    } else candidate.end(true);
  }

  canRecoverSilence() {
    const lastRestartAt = this.adapter.cloudSessionHealth?.lastRestartAt || 0;
    return (
      !this.stopped &&
      !this.inFlight &&
      performance.now() >= this.nextAllowedAt &&
      (!lastRestartAt || Date.now() - lastRestartAt >= SILENCE_COOLDOWN_MS)
    );
  }

  recreate(reason) {
    if (this.inFlight) return this.inFlight;
    if (
      (reason === "correlated-silence" || reason === "cloud-silence") &&
      !this.canRecoverSilence()
    )
      return Promise.resolve(false);
    if (this.stopped || performance.now() < this.nextAllowedAt)
      return Promise.resolve(false);
    // A busy preventive refresh defers before touching the shared send gate.
    if (reason === "preventive" && this.pending().length) {
      this.lastReason = reason;
      this.lastResult = "deferred";
      this.connector.sessionDiagnostics.emit(true);
      return Promise.resolve(false);
    }
    // New sends wait on the ordinary readiness gate while the old client drains.
    this.lastReason = reason;
    this.lastResult = "in-progress";
    this.recovering = true;
    this.sendPaused = true;
    this.nextAllowedAt = performance.now() + COOLDOWN_MS;
    this.connector.sessionDiagnostics.emit(true);
    this.inFlight = Promise.resolve()
      .then(() => this.perform(reason))
      .finally(() => {
        this.recovering = false;
        this.sendPaused = false;
        this.inFlight = null;
        this.connector.readiness.changed();
        if (!this.stopped) this.connector.sessionDiagnostics.emit(true);
      });
    return this.inFlight;
  }

  async perform(reason) {
    const connector = this.connector;
    const startedAt = performance.now();
    const before = connector.sessionDiagnostics.captureRequest();
    try {
      const deadline = startedAt + DRAIN_MS;
      while (
        !this.stopped &&
        this.pending().length &&
        performance.now() < deadline
      )
        await this.pause(20);
      if (this.stopped) return false;
      // Never deliberately interrupt an active request for an age refresh.
      // New inbound evidence during a reactive drain also cancels the need.
      if (
        (reason === "preventive" && this.pending().length) ||
        (reason === "correlated-silence" &&
          before.rawSequence !==
            connector.sessionDiagnostics.captureRequest().rawSequence)
      ) {
        this.lastResult = "deferred";
        return false;
      }
      // Only silence-triggered replacements consume the 30-minute silence
      // cooldown. Preventive and health checks use the short general backoff.
      if (this.adapter.cloudSessionHealth) {
        if (reason === "correlated-silence" || reason === "cloud-silence") {
          this.adapter.cloudSessionHealth.lastRestartAt = Date.now();
        }
        this.adapter.cloudSessionHealth.consecutiveSilences = 0;
      }
      this.rejectPending();
      connector.discardSessionFragments();
      connector.connected = false;
      connector.sessionDiagnostics.onDisconnect();
      this.readyAt = null;
      await this.close(connector.client);
      if (this.stopped) return false;
      connector.createClient();
      await connector.initMQTT_Subscribe();
      await connector.initMQTT_Message();
      // The new client's SUBACK now owns readiness. Use the same gate as every
      // ordinary cloud request; there is no second assertCanSend policy.
      this.sendPaused = false;
      connector.readiness.changed();
      await connector.waitUntilReady({ timeoutMs: READY_TIMEOUT_MS });
      if (this.stopped) return false;
      this.lastResult = "succeeded";
      this.failures = 0;
      this.nextAllowedAt = performance.now() + COOLDOWN_MS;
      this.adapter.log.info(
        `MQTT session recreation completed: reason=${reason}; generation=${connector.sessionDiagnostics.generation}; subscriptionAcknowledged=true; durationMs=${Math.round(performance.now() - startedAt)}.`
      );
      return true;
    } catch (error) {
      if (this.stopped) return false;
      this.readyAt = null;
      this.lastResult = "failed";
      this.failures = Math.min(this.failures + 1, 5);
      const backoff = Math.min(
        COOLDOWN_MS * 2 ** (this.failures - 1),
        15 * 60_000
      );
      this.nextAllowedAt = performance.now() + backoff;
      // Leave a disconnected replacement alive: mqtt.js keeps reconnecting.
      // A connected client with a missing/refused SUBACK (or a synchronous
      // creation failure with no client) needs a bounded fresh attempt instead.
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (
          !this.stopped &&
          (!connector.client || (connector.connected && !connector.isReady()))
        ) {
          void this.recreate("connection-unavailable");
        }
      }, backoff);
      this.retryTimer.unref?.();
      if (!this.stopped)
        this.adapter.log.warn(
          `MQTT session recreation failed: reason=${reason}; retryCooldownMs=${backoff}; ${error.message}. The client keeps reconnecting in the background.`
        );
      return false;
    }
  }

  stop() {
    if (this.recovering) this.lastResult = "stopped";
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.timer);
    this.timer = null;
    for (const finish of [...this.waits]) finish();
    this.rejectPending();
  }
}

module.exports = { MqttSessionRecovery };
