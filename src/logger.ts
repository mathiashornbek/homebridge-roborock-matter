import { Logger } from "homebridge";

/**
 * Decorates the Homebridge logger to only log debug messages when debug mode is enabled.
 */
export default class RoborockPlatformLogger {
  constructor(
    private readonly logger: Logger,
    private readonly debugMode: boolean
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private emit(fn: (message: any) => void, messages: any[]) {
    for (let i = 0; i < messages.length; i++) {
      fn(messages[i]);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(...messages: any[]) {
    if (this.debugMode) {
      this.emit((message) => this.logger.debug(message), messages);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info(...messages: any[]) {
    this.emit((message) => this.logger.info(message), messages);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn(...messages: any[]) {
    this.emit((message) => this.logger.warn(message), messages);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error(...messages: any[]) {
    this.emit((message) => this.logger.error(message), messages);
  }
}
