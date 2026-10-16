"use strict";

// Real HTTP sockets produce the Axios errors passed through Roborock's API.
// The server can apply a PUT and then drop its acknowledgement.
const http = require("node:http");
const axios = require("axios");
const { Roborock } = require("../roborockLib/roborockAPI");
const moduleUnderTest = require("../src/hap_schedule_accessory.ts");
const { ScheduleAccountCoordinator } = moduleUnderTest;
let server, api, coordinator, scene, behavior, events, puts, gets;

beforeEach(async () => {
  events = [];
  puts = 0;
  gets = 0;
  behavior = { apply: true, drop: true };
  scene = {
    id: 7,
    name: "Morning",
    enabled: true,
    type: "WORKFLOW",
    param: JSON.stringify({
      triggers: [
        {
          id: 1,
          type: "TIMER",
          param: JSON.stringify({
            cron: "0 9 * * *",
            enabled: false,
            repeated: true,
            timeZoneId: "UTC",
          }),
        },
      ],
      action: { type: "S", items: [] },
    }),
  };
  server = http.createServer((req, res) => {
    events.push(`${req.method} ${req.url}`);
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(200, { Allow: "GET, PUT, OPTIONS" });
      res.end();
      return;
    }
    if (req.method === "GET") {
      gets++;
      if (behavior.failReads || (behavior.failVerification && gets >= 2))
        send(behavior.readStatus || 503, { success: false });
      else send(200, { success: true, result: [scene] });
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url.endsWith("/enable")) {
        scene.enabled = new URLSearchParams(body).get("enabled") === "true";
        send(200, { success: true });
        return;
      }
      puts++;
      if (behavior.throttle) {
        send(429, { success: false });
        return;
      }
      if (puts > 1 || behavior.apply) scene.param = body;
      if (puts === 1 && behavior.externalEdit) {
        const param = JSON.parse(scene.param);
        param.action = {
          type: "S",
          items: [
            {
              name: "edited in app",
              type: "CMD",
              param: JSON.stringify({ method: "app_start", params: [] }),
            },
          ],
        };
        scene.param = JSON.stringify(param);
      }
      if (puts === 1 && behavior.drop) req.socket.destroy();
      else send(200, { success: true });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = Object.create(Roborock.prototype);
  api.api = axios.create({
    baseURL: `http://127.0.0.1:${server.address().port}/`,
    timeout: 1000,
    proxy: false,
  });
  api.log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  api.getServerTimers = async () => [];
  coordinator = Object.create(moduleUnderTest.default.prototype);
  Object.assign(coordinator, {
    platform: { roborockAPI: api, log: api.log },
    duid: "robot-a",
    vacuumName: "Robot",
    scheduleAccessories: new Map(),
    routineSwitches: new Map(),
    disposed: false,
    cachedSchedules: [],
    lastServerTimerSchedules: [],
    lastCloudSceneSchedules: [],
    refreshGeneration: 0,
    lastScheduleRefreshAt: 0,
    consecutiveRefreshFailures: 0,
    scheduleBackoffRandom: () => 0.5,
    accountCoordinator: new ScheduleAccountCoordinator(),
    sync: jest.fn(),
    syncRoutines: jest.fn(),
    waitForScheduleVerification: async () => {},
    waitForScheduleWriteSpacing: async () => {},
  });
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});
const run = () =>
  coordinator.executeScheduleWriteBatch([
    { scheduleId: "scene:7", enabled: true },
  ]);

test("a scene PUT that applies before its socket drops is confirmed without another PUT", async () => {
  expect((await run()).size).toBe(0);
  expect(puts).toBe(1);
  expect(gets).toBe(2);
});

test("a dropped scene PUT that did not apply is retried once from fresh scene data", async () => {
  behavior.apply = false;
  behavior.externalEdit = true;
  expect((await run()).size).toBe(0);
  expect(puts).toBe(2);
  expect(gets).toBe(4);
  expect(JSON.parse(scene.param).action.items[0].name).toBe("edited in app");
  expect(events.some((e) => e.endsWith("/execute"))).toBe(false);
});

test("a partial scene enable finishes the top-level flag only after read-back", async () => {
  scene.enabled = false;
  expect((await run()).size).toBe(0);
  expect(scene.enabled).toBe(true);
  expect(puts).toBe(2);
  expect(events.filter((e) => e === "PUT /user/scene/7/enable")).toHaveLength(
    1
  );
});

test("an acknowledged scene PUT is not confirmed using cached state after a failed read", async () => {
  behavior.drop = false;
  behavior.failVerification = true;
  coordinator.lastCloudSceneSchedules = [
    { id: "scene:7", enabled: true, timer: [] },
  ];
  expect((await run()).has("scene:7")).toBe(true);
  expect(puts).toBe(1);
});

test("an HTTP 429 stops the batch without replay", async () => {
  behavior.throttle = true;
  expect((await run()).has("scene:7")).toBe(true);
  expect(puts).toBe(1);
  expect(gets).toBe(1);
});

test("a scene-read throttle stops timer fallback even when the timer source answered", async () => {
  behavior.failReads = true;
  behavior.readStatus = 429;
  api.getServerTimers = async () => [["timer-1", "off"]];
  const command = jest.fn(async () => ["ok"]);
  api.vacuums = { "robot-a": { command } };
  const failures = await coordinator.executeScheduleWriteBatch([
    { scheduleId: "timer-1", enabled: true },
  ]);
  expect(failures.has("timer-1")).toBe(true);
  expect(command).toHaveBeenCalledTimes(1);
  expect(coordinator.accountCoordinator.currentThrottleError()).toBeDefined();
});
