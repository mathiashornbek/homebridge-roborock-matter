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
      const deadline = performance.now() + timeoutMs;
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        this.waiters.delete(stop);
        if (error) reject(error);
        else resolve(this.generation());
      };
      const stop = () =>
        finish(
          readinessError(
            "MQTT stopped while waiting for readiness; this command was not sent.",
            "MQTT_SHUTTING_DOWN"
          )
        );
      const check = () => {
        if (this.isReady()) return finish(null);
        if (performance.now() >= deadline)
          return finish(
            readinessError(
              `MQTT reply subscription did not become ready within ${timeoutMs}ms; this command was not sent.`
            )
          );
        timer = setTimeout(check, Math.min(25, deadline - performance.now()));
        timer.unref?.();
      };
      this.waiters.add(stop);
      check();
    });
  }

  stop() {
    this.stopped = true;
    for (const stop of [...this.waiters]) stop();
  }
}

module.exports = { MqttReadiness };
