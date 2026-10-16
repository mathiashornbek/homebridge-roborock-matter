/** A sent assignment may have taken effect even when its reply was lost. */
export function isAmbiguousScheduleWrite(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as {
    requestNotSent?: boolean;
    unansweredRequest?: boolean;
    code?: string;
    response?: { status?: number };
  };
  if (failure.requestNotSent === true) return false;
  return (
    failure.unansweredRequest === true ||
    failure.code === "MQTT_SESSION_REPLACED" ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(
      failure.code ?? ""
    ) ||
    (typeof failure.response?.status === "number" &&
      failure.response.status >= 500)
  );
}
