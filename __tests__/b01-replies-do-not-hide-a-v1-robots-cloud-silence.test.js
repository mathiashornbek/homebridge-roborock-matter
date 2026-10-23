"use strict";

/**
 * The "3 unanswered cloud requests → fresh MQTT session" rule, counted the way
 * python-roborock's HealthManager counts it (mqtt/health_manager.py, fed from
 * devices/rpc/v1_channel.py `RpcChannel._send_rpc`):
 *
 *  - only V1 requests sent over MQTT feed it. The B01 Q7/Q10 channels never
 *    call `on_timeout` or `on_success`, so a Q7 answering every 15 seconds
 *    cannot reset the count a silent V1 robot is building;
 *  - a V1 reply resets it (`on_success`), but a reply that is an API error
 *    does not: `_send_rpc` raises before it reaches `on_success`;
 *  - a timeout counts whatever else that robot's frames did meanwhile — the
 *    map strategy's decoder ignores the protocol-102 acknowledgement, so a
 *    get_map_v1 whose map never follows is a timeout like any other;
 *  - 3 in a row restart the session, at most once every 30 minutes.
 *
 * The account shape is the maintainer's: one S8 Pro Ultra (a70, V1) and two
 * Q7s (sc05, B01) on one MQTT session. On 3.39.0 the Q7 replies reset the
 * count between the a70's cloud timeouts, and the a70's receipt counter stayed
 * frozen for 2.3 days with ~600 failed status reads and no restart.
 */

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const A70 = "duid-a70";
const Q7_GARAGE = "duid-q7-garage";
const Q7_SAL = "duid-q7-sal";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function mixedAccount() {
  const wire = createRealRoborockOnFakeWire({ transport: "cloud" });
  const { api } = wire;
  api.getRobotVersion = jest.fn(async (duid) => (duid === A70 ? "1.0" : "B01"));
  api.getProductAttribute = (duid, attribute) =>
    attribute === "model" && duid !== A70 ? "roborock.vacuum.sc05" : undefined;
  api.rr_mqtt_connector.reconnectClient = jest.fn(async () => true);
  return wire;
}

/** The pending entry the MQTT receiver would settle for this request. */
function pendingFor(api, predicate) {
  for (const [id, entry] of api.pendingRequests) {
    if (predicate(id, entry)) return { id, entry };
  }
  throw new Error("no pending request matched");
}

/** A Q7 status read that the robot answers, as resolveB01PendingResponse does. */
async function q7Answers(api, duid) {
  const request = api.messageQueueHandler.sendRequest(duid, "get_prop", [
    "get_status",
  ]);
  await jest.advanceTimersByTimeAsync(0);
  const { id, entry } = pendingFor(api, (key) => typeof key === "string");
  api.clearTimeout(entry.timeout);
  api.pendingRequests.delete(id);
  entry.resolve({ status: 8 });
  await request;
}

/** An a70 status read over the cloud that nothing answers. */
async function a70TimesOut(api, method = "get_prop", secure = false) {
  const request = api.messageQueueHandler
    .sendRequest(A70, method, ["get_status"], secure)
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(11_000);
  const outcome = await request;
  expect(String(outcome?.message)).toMatch(/timed out/);
}

function restarts(api) {
  return api.rr_mqtt_connector.reconnectClient.mock.calls.length;
}

test("Q7 replies between the a70's cloud timeouts do not stop the third from restarting the session", async () => {
  const { api, log } = mixedAccount();

  await a70TimesOut(api);
  await q7Answers(api, Q7_GARAGE);
  await q7Answers(api, Q7_SAL);
  await a70TimesOut(api);
  await q7Answers(api, Q7_GARAGE);
  await q7Answers(api, Q7_SAL);
  expect(restarts(api)).toBe(0);

  await a70TimesOut(api);
  await jest.advanceTimersByTimeAsync(0);

  expect(restarts(api)).toBe(1);
  expect(api.rr_mqtt_connector.reconnectClient).toHaveBeenCalledWith(true);
  expect(
    log.info.mock.calls.some(([line]) =>
      /starting a fresh MQTT session/.test(line)
    )
  ).toBe(true);
});

test("an a70 reply starts the count again", async () => {
  const { api } = mixedAccount();

  await a70TimesOut(api);
  await a70TimesOut(api);

  const request = api.messageQueueHandler.sendRequest(A70, "get_prop", [
    "get_status",
  ]);
  await jest.advanceTimersByTimeAsync(0);
  const { entry } = pendingFor(api, (key) => typeof key === "number");
  api.clearTimeout(entry.timeout);
  entry.resolve([{ state: 8 }]);
  await request;

  await a70TimesOut(api);
  await a70TimesOut(api);
  await jest.advanceTimersByTimeAsync(0);
  expect(restarts(api)).toBe(0);

  await a70TimesOut(api);
  await jest.advanceTimersByTimeAsync(0);
  expect(restarts(api)).toBe(1);
});

test("a refusal from the a70 is not a success, so it does not reset the count", async () => {
  const { api } = mixedAccount();

  await a70TimesOut(api);
  await a70TimesOut(api);

  const request = api.messageQueueHandler
    .sendRequest(A70, "get_prop", ["get_status"])
    .catch((error) => error);
  await jest.advanceTimersByTimeAsync(0);
  const { id, entry } = pendingFor(api, (key) => typeof key === "number");
  api.clearTimeout(entry.timeout);
  api.pendingRequests.delete(id);
  entry.reject(new Error("The robot refused get_prop: unknown_method"));
  await request;

  await a70TimesOut(api);
  await jest.advanceTimersByTimeAsync(0);
  expect(restarts(api)).toBe(1);
});

test("Q7 timeouts never count, so two silent Q7s do not restart a session the a70 is answering on", async () => {
  const { api } = mixedAccount();

  for (let i = 0; i < 4; i += 1) {
    const request = api.messageQueueHandler
      .sendRequest(i % 2 ? Q7_SAL : Q7_GARAGE, "get_prop", ["get_status"])
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(11_000);
    await request;
  }
  await jest.advanceTimersByTimeAsync(0);

  expect(restarts(api)).toBe(0);
});

test("a map request whose acknowledgement arrives but whose map never follows counts, as python-roborock counts it", async () => {
  const { api } = mixedAccount();

  for (let i = 0; i < 3; i += 1) {
    const request = api.messageQueueHandler
      .sendRequest(A70, "get_map_v1", [], true)
      .catch((error) => error);
    await jest.advanceTimersByTimeAsync(50);
    // The receiver decoded the a70's protocol-102 ["ok"] for this request.
    api.noteCloudMessageReceived(A70);
    await jest.advanceTimersByTimeAsync(11_000);
    expect(String((await request)?.message)).toMatch(/timed out/);
  }
  await jest.advanceTimersByTimeAsync(0);

  expect(restarts(api)).toBe(1);
});
