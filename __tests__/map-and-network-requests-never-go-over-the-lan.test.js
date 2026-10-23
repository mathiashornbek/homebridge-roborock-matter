"use strict";

/**
 * The requests python-roborock 7.13.0 sends over MQTT only, even to a robot
 * whose LAN socket is up:
 *
 *  - get_multi_maps_list and load_multi_map — `MapsTrait` is decorated
 *    `@common.mqtt_rpc_channel` (devices/traits/v1/maps.py), so both its read
 *    and its `set_current_map` go through the MQTT-only channel;
 *  - get_map_v1 — `MapContentTrait`, `@common.map_rpc_channel`;
 *  - get_photo — `ObstaclePhotoTrait`, the blob channel;
 *  - get_network_info — `V1Channel._get_networking_info` uses
 *    `mqtt_rpc_channel`.
 *
 * On 18 Oct the maintainer's a70 had get_multi_maps_list closed by the give-up
 * register after six local timeouts; python-roborock never asks the LAN for it.
 */

const {
  createRealRoborockOnFakeWire,
} = require("../test-support/real-roborock-wire");

const DUID = "duid-a70";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function send(api, method, params = [], secure = false, options = {}) {
  const request = api.messageQueueHandler
    .sendRequest(DUID, method, params, secure, false, options)
    .catch((error) => error);
  // load_multi_map waits 30 s, everything else 10 s.
  await jest.advanceTimersByTimeAsync(31_000);
  await request;
}

test.each([
  ["get_multi_maps_list", [], false],
  ["load_multi_map", [1], false],
  ["get_map_v1", [], true],
  ["get_network_info", [], false],
  ["get_photo", { img_id: "1" }, false],
])(
  "%s goes over the cloud although the LAN socket is up",
  async (method, params, secure) => {
    const { api } = createRealRoborockOnFakeWire({ transport: "local" });

    await send(api, method, params, secure);

    expect(api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.localConnector.sendMessage).not.toHaveBeenCalled();
  }
);

test("a command that prefers the LAN does not open a socket for a cloud-only method", async () => {
  const { api } = createRealRoborockOnFakeWire({ transport: "cloud" });
  api.isRemoteDevice = jest.fn(async () => false);
  api.ensureLocalConnection = jest.fn(async () => true);

  await send(api, "load_multi_map", [1], false, { preferLocal: true });

  expect(api.ensureLocalConnection).not.toHaveBeenCalled();
  expect(api.rr_mqtt_connector.sendMessage).toHaveBeenCalledTimes(1);
});

test("everything else still prefers the LAN", async () => {
  const { api } = createRealRoborockOnFakeWire({ transport: "local" });
  // The robot answers on the LAN, so nothing is retried over the cloud.
  api.localConnector.sendMessage.mockImplementation(() => {
    for (const [id, entry] of api.pendingRequests) {
      api.clearTimeout(entry.timeout);
      api.pendingRequests.delete(id);
      entry.resolve([[16, "1"]]);
    }
  });

  await send(api, "get_room_mapping");

  expect(api.localConnector.sendMessage).toHaveBeenCalledTimes(1);
  expect(api.rr_mqtt_connector.sendMessage).not.toHaveBeenCalled();
});
