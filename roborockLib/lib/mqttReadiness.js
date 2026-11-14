"use strict";

function readinessError(message, code = "MQTT_READINESS_TIMEOUT") {
  return Object.assign(new Error(message), {
    code,
    transientKind: "cloud unavailable",
    requestNotSent: true,
    unansweredRequest: false,
  });
}

// This gate observes readiness; it never reconnects or replays a command.
class MqttReadiness {
  constructor(isReady, generation) {
    this.isReady = isReady;
    this.generation = generation;
    this.stopped = false;
    this.waiters = new Set();
  }

  assertReady() {
    if (this.stopped || !this.isReady()) {
      throw readinessError(
        "MQTT reply subscription is not ready; this command was not sent.",
        "MQTT_SESSION_NOT_READY"
      );
    }
  }

  wait(timeoutMs = 10000) {
    if (this.stopped)
      return Promise.reject(
        readinessError(
          "MQTT is stopping; this command was not sent.",
          "MQTT_SHUTTING_DOWN"
        )
      );
    if (this.isReady()) return Promise.resolve(this.generation());
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        if (error) reject(error);
        else resolve(this.generation());
      };
      const waiter = {
        ready: () => finish(null),
        stop: () =>
          finish(
            readinessError(
              "MQTT stopped while waiting for readiness; this command was not sent.",
              "MQTT_SHUTTING_DOWN"
            )
          ),
      };
      this.waiters.add(waiter);
      timer = setTimeout(
        () =>
          finish(
            readinessError(
              `MQTT reply subscription did not become ready within ${timeoutMs}ms; this command was not sent.`
            )
          ),
        timeoutMs
      );
      timer.unref?.();
      this.changed();
    });
  }

  changed() {
    if (!this.stopped && this.isReady()) {
      for (const waiter of [...this.waiters]) waiter.ready();
    }
  }

  start() {
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    for (const waiter of [...this.waiters]) waiter.stop();
  }
}

module.exports = { MqttReadiness };
