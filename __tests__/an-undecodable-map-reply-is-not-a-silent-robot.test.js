"use strict";

/**
 * A map reply that arrives but cannot be decoded is reported as exactly that,
 * at once, and never as a robot that did not answer.
 *
 * The protocol-301 handler decrypted and gunzipped a classic map reply inline,
 * so a corrupt or truncated payload threw to the handler's outer catch (an
 * error with a stack) and the waiting `get_map_v1` was neither resolved nor
 * rejected. It then timed out "MQTT connection state: true", counted toward
 * the unanswered-method breaker, and could end in "the robot did not answer
 * the map request" — the recurring "unanswered while the link is up" family,
 * for a robot that had answered.
 *
 * Driven through the real MQTT handler: the reply is framed with the plugin's
 * own V1 cipher and its map layer encrypted with the plugin's nonce.
 */

const zlib = require("zlib");

jest.mock(
  "mqtt",
  () => require("../test-support/b01-robot-on-a-fake-broker").fakeMqttModule
);

const {
  createB01Robots,
} = require("../test-support/b01-robot-on-a-fake-broker");
const {
  isUnansweredRequest,
} = require("../roborockLib/lib/unansweredMethodBreaker");
const {
  describeDroppedFrames,
  resetFrameCounters,
} = require("../roborockLib/lib/roborock_mqtt_connector");

const DUID = "duid-a70";

describe("a map reply that cannot be decoded", () => {
  let robots;

  beforeEach(async () => {
    resetFrameCounters();
    robots = await createB01Robots({
      robots: [
        {
          duid: DUID,
          name: "Stueetage",
          model: "roborock.vacuum.a70",
          pv: "1.0",
        },
      ],
    });
  });

  afterEach(() => robots.api.clearTimersAndIntervals());

  async function mapRequest() {
    const request = robots.api.messageQueueHandler.sendRequest(
      DUID,
      "get_map_v1",
      [],
      true
    );
    const [sent] = await robots.waitForSent(DUID);
    const { id } = JSON.parse(sent.dps["101"]);
    return { request, id };
  }

  test("fails its request at once, as a reply that could not be read", async () => {
    const { request, id } = await mapRequest();
    const outcome = request.catch((error) => error);

    await robots.v1MapReply(DUID, id, Buffer.from("not a gzip stream"));
    const error = await outcome;

    expect(error.message).toMatch(/arrived but could not be decoded/);
    expect(error.message).toMatch(/get_map_v1/);
    expect(isUnansweredRequest(error)).toBe(false);
    expect(robots.log.error).not.toHaveBeenCalled();
  });

  test("a reply that decodes still resolves with the map", async () => {
    const { request, id } = await mapRequest();
    await robots.v1MapReply(DUID, id, zlib.gzipSync(Buffer.from("rr-map")));
    await expect(request).resolves.toEqual(Buffer.from("rr-map"));
  });

  test("one nobody waits for is counted, not logged as a plugin error", async () => {
    await robots.v1MapReply(DUID, 4242, Buffer.from("not a gzip stream"));
    expect(describeDroppedFrames(DUID).byReason.undecodable).toBe(1);
    expect(robots.log.error).not.toHaveBeenCalled();
  });
});
