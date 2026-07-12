"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Decorates the Homebridge logger to only log debug messages when debug mode is enabled.
 */
class RoborockPlatformLogger {
    constructor(logger, debugMode) {
        this.logger = logger;
        this.debugMode = debugMode;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit(fn, messages) {
        for (let i = 0; i < messages.length; i++) {
            fn(messages[i]);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    debug(...messages) {
        if (this.debugMode) {
            this.emit((message) => this.logger.debug(message), messages);
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    info(...messages) {
        this.emit((message) => this.logger.info(message), messages);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    warn(...messages) {
        this.emit((message) => this.logger.warn(message), messages);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error(...messages) {
        this.emit((message) => this.logger.error(message), messages);
    }
}
exports.default = RoborockPlatformLogger;
//# sourceMappingURL=logger.js.map