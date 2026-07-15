/**
 * Shared helper for RoborockVacuumAccessory and RoborockMatterVacuumAccessory.
 *
 * Live Roborock push messages ("CloudMessage"/"LocalMessage") arrive either as
 * an unscoped array (when the account has a single vacuum) or as a
 * `{ duid, payload }` envelope scoped to a specific device. This unwraps the
 * message and, for the scoped shape, filters it down to the accessory whose
 * duid matches - returning `null` when the message should be ignored.
 */
export interface LiveMessageAccessoryContext {
  /** The duid of the accessory this message is being resolved for. */
  getDuid(): string;
  /** Display name used in the "ignoring unscoped message" debug log. */
  getVacuumName(): string;
  /** Whether an unscoped array message may be accepted by this accessory. */
  shouldAcceptUnscopedLiveMessage(): boolean;
  /** Debug logger used when an unscoped message is ignored. */
  logDebug(message: string): void;
}

export function getLiveMessageForThisAccessory(
  data: unknown,
  context: LiveMessageAccessoryContext
): unknown | null {
  if (!data || typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    if (!context.shouldAcceptUnscopedLiveMessage()) {
      context.logDebug(
        `Ignoring unscoped live Roborock update for ${context.getVacuumName()} because multiple vacuums are configured.`
      );
      return null;
    }

    return data;
  }

  const message = data as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(message, "duid") &&
    Object.prototype.hasOwnProperty.call(message, "payload")
  ) {
    if (String(message.duid) !== context.getDuid()) {
      return null;
    }

    return message.payload;
  }

  return data;
}
