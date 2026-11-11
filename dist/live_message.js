"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveMessageForThisAccessory = getLiveMessageForThisAccessory;
function getLiveMessageForThisAccessory(data, context) {
    if (!data || typeof data !== "object") {
        return data;
    }
    if (Array.isArray(data)) {
        if (!context.shouldAcceptUnscopedLiveMessage()) {
            context.logDebug(`Ignoring unscoped live Roborock update for ${context.getVacuumName()} because multiple vacuums are configured.`);
            return null;
        }
        return data;
    }
    const message = data;
    if (Object.prototype.hasOwnProperty.call(message, "duid") &&
        Object.prototype.hasOwnProperty.call(message, "payload")) {
        if (String(message.duid) !== context.getDuid()) {
            return null;
        }
        return message.payload;
    }
    return data;
}
//# sourceMappingURL=live_message.js.map