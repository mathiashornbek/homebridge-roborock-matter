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
    this.inFlight = null;
    this.readyAt = null;
    this.nextAllowedAt = 0;
    this.failures = 0;
    this.waits = new Set();
    this.timer = null;
  }

  install(candidate) {
    const connector = this.connector;
    const current = () => !this.stopped && connector.client === candidate;
    const acknowledge = (generation, error, granted) => {
      if (
        !current() ||
        generation !== connector.sessionDiagnostics.generation ||
        !connector.sessionDiagnostics.snapshot().connected
      )
        return;
      // mqtt.js handles resubscription itself; an empty callback is not a SUBACK.
      if (!error && Array.isArray(granted) && granted.length === 0) return;
      connector.sessionDiagnostics.onSubscribe(generation, error, granted);
      connector.connected =
        connector.sessionDiagnostics.snapshot().subscriptionAcknowledged;
      if (connector.connected) this.readyAt = performance.now();
      else {
        this.readyAt = null;
        connector.logConnectionIssue(
          "Roborock MQTT reply subscription was not acknowledged; cloud sends remain paused."
        );
      }
    };
    candidate.on("packetreceive", (packet) => {
      if (packet.cmd === "suback")
        acknowledge(
          connector.sessionDiagnostics.generation,
          null,
          (packet.granted || []).map((qos) => ({ qos }))
        );
    });
    candidate.on("connect", () => {
      if (!current()) return;
      connector.connected = false;
      this.readyAt = null;
      const generation = connector.sessionDiagnostics.onConnect();
      candidate.subscribe(
        `rr/m/o/${connector.rriot.u}/${connector.mqttUser}/#`,
        (error, granted) => {
          acknowledge(generation, error, granted);
        }
      );
    });
    for (const event of ["error", "close", "offline"]) {
      candidate.on(event, () => {
        if (!current()) return;
        connector.connected = false;
        this.readyAt = null;
        connector.sessionDiagnostics.onDisconnect();
      });
    }
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

  assertCanSend() {
    if (this.stopped || this.recovering || !this.connector.connected) {
      throw Object.assign(
        new Error(
          "The MQTT reply session is not ready; this command was not sent."
        ),
        {
          code: "MQTT_SESSION_NOT_READY",
          transientKind: "cloud unavailable",
          requestNotSent: true,
        }
      );
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
    candidate.removeAllListeners();
    // An error emitted while the retired socket closes must not become an
    // unhandled EventEmitter error after the lifecycle handlers are removed.
    candidate.on("error", () => {});
    // Retired clients cannot deliver a late event to this connector.
    if (this.connector.client === candidate) this.connector.client = null;
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
    // Close the send gate before yielding; requests building a payload must
    // check it again immediately before registering/publishing the request.
    this.lastReason = reason;
    this.lastResult = "in-progress";
    this.recovering = true;
    this.nextAllowedAt = performance.now() + COOLDOWN_MS;
    this.connector.sessionDiagnostics.emit(true);
    this.inFlight = Promise.resolve()
      .then(() => this.perform(reason))
      .finally(() => {
        this.recovering = false;
        this.inFlight = null;
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
      // Both upstream's baseline and correlated recovery use this timestamp.
      // Record actual teardown, including preventive/connection recovery, so a
      // second silence policy cannot immediately replace the new session again.
      if (this.adapter.cloudSessionHealth) {
        this.adapter.cloudSessionHealth.lastRestartAt = Date.now();
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
      this.install(connector.client);
      await connector.initMQTT_Message();
      const readyDeadline = performance.now() + READY_TIMEOUT_MS;
      while (
        !this.stopped &&
        !connector.connected &&
        performance.now() < readyDeadline
      )
        await this.pause(50);
      if (this.stopped) return false;
      if (!connector.connected)
        throw new Error("Connect and reply-subscription deadline expired");
      this.lastResult = "succeeded";
      this.failures = 0;
      this.nextAllowedAt = performance.now() + COOLDOWN_MS;
      this.adapter.log.info(
        `MQTT session recreation completed: reason=${reason}; generation=${connector.sessionDiagnostics.generation}; subscriptionAcknowledged=true; durationMs=${Math.round(performance.now() - startedAt)}.`
      );
      return true;
    } catch (error) {
      connector.connected = false;
      connector.sessionDiagnostics.onDisconnect();
      this.readyAt = null;
      this.lastResult = "failed";
      this.failures = Math.min(this.failures + 1, 5);
      const backoff = Math.min(
        COOLDOWN_MS * 2 ** (this.failures - 1),
        15 * 60_000
      );
      this.nextAllowedAt = performance.now() + backoff;
      try {
        await this.close(connector.client);
      } catch {
        /* already retired */
      }
      if (!this.stopped)
        this.adapter.log.warn(
          `MQTT session recreation failed: reason=${reason}; retryCooldownMs=${backoff}; ${error.message}.`
        );
      return false;
    }
  }

  stop() {
    if (this.recovering) this.lastResult = "stopped";
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const finish of [...this.waits]) finish();
    this.rejectPending();
  }
}

module.exports = { MqttSessionRecovery };
