"use strict";

const PREVENTIVE_AGE_MS = 4 * 60 * 60 * 1000;
const COOLDOWN_MS = 60_000;
const READY_TIMEOUT_MS = 20_000;
const DRAIN_MS = 500;

// Opt-in lifecycle only. Observations and breaker policy remain usable without it.
class MqttSessionRecovery {
  constructor(connector) {
    this.connector = connector;
    this.adapter = connector.adapter;
    this.preventiveRefreshEnabled =
      this.adapter.config.enableMqttPreventiveRefresh === true;
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
    candidate.on("connect", () => {
      if (!current()) return;
      connector.connected = false;
      this.readyAt = null;
      const generation = connector.sessionDiagnostics.onConnect();
      candidate.subscribe(
        `rr/m/o/${connector.rriot.u}/${connector.mqttUser}/#`,
        (error, granted) => {
          if (
            !current() ||
            generation !== connector.sessionDiagnostics.generation
          )
            return;
          connector.sessionDiagnostics.onSubscribe(generation, error, granted);
          connector.connected =
            connector.sessionDiagnostics.snapshot().subscriptionAcknowledged;
          if (connector.connected) this.readyAt = performance.now();
          else
            connector.logConnectionIssue(
              "Roborock MQTT reply subscription was not acknowledged; cloud sends remain paused."
            );
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
      request.reject(
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

  recreate(reason) {
    if (this.inFlight) return this.inFlight;
    if (this.stopped || performance.now() < this.nextAllowedAt)
      return Promise.resolve(false);
    // Close the send gate before yielding; requests building a payload must
    // check it again immediately before registering/publishing the request.
    this.recovering = true;
    this.nextAllowedAt = performance.now() + COOLDOWN_MS;
    this.inFlight = Promise.resolve()
      .then(() => this.perform(reason))
      .finally(() => {
        this.recovering = false;
        this.inFlight = null;
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
      )
        return false;
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
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const finish of [...this.waits]) finish();
    this.rejectPending();
  }
}

module.exports = { MqttSessionRecovery };
