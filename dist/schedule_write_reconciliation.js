"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAmbiguousScheduleWrite = isAmbiguousScheduleWrite;
/** A sent assignment may have taken effect even when its reply was lost. */
function isAmbiguousScheduleWrite(error) {
    var _a, _b;
    if (!error || typeof error !== "object")
        return false;
    const failure = error;
    if (failure.requestNotSent === true)
        return false;
    return (failure.unansweredRequest === true ||
        failure.code === "MQTT_SESSION_REPLACED" ||
        ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes((_a = failure.code) !== null && _a !== void 0 ? _a : "") ||
        (typeof ((_b = failure.response) === null || _b === void 0 ? void 0 : _b.status) === "number" &&
            failure.response.status >= 500));
}
//# sourceMappingURL=schedule_write_reconciliation.js.map