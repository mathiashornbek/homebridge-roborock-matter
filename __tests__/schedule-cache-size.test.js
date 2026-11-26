"use strict";

const {
  PlatformAccessory,
  hap,
  makeScheduleAccount,
  makeSchedulePlatform,
} = require("../test-support/schedule-account");
const RoborockHapScheduleAccessory =
  require("../src/hap_schedule_accessory.ts").default;
const { HAP_PLUGIN_IDENTIFIER, PLATFORM_NAME } = require("../src/settings");

const DUID = "cache-test-robot";
const TIMER = { id: "timer-1", enabled: true, timer: ["timer-1", "on"] };
const coordinators = [];

afterEach(() => {
  for (const coordinator of coordinators.splice(0)) coordinator.shutdown();
});

function accessory(kind = "Schedules") {
  const result = new PlatformAccessory(
    `Test Robot ${kind}`,
    hap.uuid.generate(`cache-size-${kind}`)
  );
  result._associatedPlugin = HAP_PLUGIN_IDENTIFIER;
  result._associatedPlatform = PLATFORM_NAME;
  return result;
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(PlatformAccessory.serialize(value)));
}

function coordinator(platform, manager) {
  const result = new RoborockHapScheduleAccessory(platform, manager, DUID);
  result.vacuumName = "Test Robot";
  coordinators.push(result);
  return result;
}

function scheduleSwitch(manager) {
  return manager.getServiceById(
    hap.Service.Switch,
    "roborock-schedule-timer-1"
  );
}

function nameDefinitions(service) {
  return service.optionalCharacteristics.filter(
    (entry) => entry.UUID === hap.Characteristic.ConfiguredName.UUID
  );
}

function inflate(service) {
  for (let i = 0; i < 8192; i++) {
    service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
  }
}

test("repeated schedule refreshes keep the serialized cache size constant", () => {
  const platform = makeSchedulePlatform(makeScheduleAccount({ duid: DUID }));
  const manager = accessory();
  const schedules = coordinator(platform, manager);
  schedules.sync([TIMER]);
  const service = scheduleSwitch(manager);
  service.setCharacteristic(hap.Characteristic.ConfiguredName, "Morning clean");
  const before = snapshot(manager);

  for (let i = 0; i < 1000; i++) schedules.sync([TIMER]);

  expect(scheduleSwitch(manager)).toBe(service);
  expect(nameDefinitions(service)).toHaveLength(1);
  expect(snapshot(manager)).toEqual(before);
});

test("a bloated cache is saved compactly before cloud reads, preserving identity and custom names", async () => {
  const account = makeScheduleAccount({
    duid: DUID,
    serverTimers: new Error("offline"),
  });
  account.getCloudScenes.mockRejectedValue(new Error("offline"));
  const platform = makeSchedulePlatform(account);
  const manager = accessory();
  coordinator(platform, manager).sync([TIMER]);
  const service = scheduleSwitch(manager);
  service.setCharacteristic(hap.Characteristic.ConfiguredName, "Morning clean");
  service.addOptionalCharacteristic(hap.Characteristic.StatusActive);
  const clean = snapshot(manager);
  inflate(service);
  const bloated = snapshot(manager);
  const restored = PlatformAccessory.deserialize(bloated);
  const originalServices = [...restored.services];
  const active = [...scheduleSwitch(restored).characteristics];
  const saved = [];
  platform.api.updatePlatformAccessories.mockImplementation((items) => {
    saved.push(...items.map(snapshot));
  });

  const schedules = coordinator(platform, restored);
  expect(account.getServerTimers).not.toHaveBeenCalled();
  expect(account.getCloudScenes).not.toHaveBeenCalled();
  expect(saved).toEqual([clean]);
  expect(JSON.stringify(saved[0]).length).toBeLessThan(
    JSON.stringify(bloated).length / 100
  );
  restored.services.forEach((entry, i) =>
    expect(entry).toBe(originalServices[i])
  );
  scheduleSwitch(restored).characteristics.forEach((entry, i) =>
    expect(entry).toBe(active[i])
  );

  await schedules.initialize("Test Robot");
  expect(nameDefinitions(scheduleSwitch(restored))).toHaveLength(1);
  expect(
    scheduleSwitch(restored).getCharacteristic(
      hap.Characteristic.ConfiguredName
    ).value
  ).toBe("Morning clean");
  expect(restored.UUID).toBe(manager.UUID);
  expect(scheduleSwitch(restored).subtype).toBe(service.subtype);
  expect(
    scheduleSwitch(restored).getCharacteristic(hap.Characteristic.On).value
  ).toBe(true);
  const restarted = PlatformAccessory.deserialize(snapshot(restored));
  coordinator(platform, restarted).restoreScheduleHandlersFromAccessory();
  expect(snapshot(restarted)).toEqual(snapshot(restored));
});

test("routine restoration compacts cached definitions and repeated renames stay bounded", () => {
  const platform = makeSchedulePlatform(makeScheduleAccount({ duid: DUID }));
  const schedules = coordinator(platform, accessory());
  const routines = accessory("Routines");
  const routine = {
    id: "17",
    name: "Kitchen clean",
    raw: {},
    schedule: null,
  };
  schedules.attachRoutineAccessory(routines);
  schedules.syncRoutines([routine]);
  const service = routines.getServiceById(
    hap.Service.Switch,
    "roborock-routine-17"
  );
  service.setCharacteristic(hap.Characteristic.ConfiguredName, "My kitchen");
  const clean = snapshot(routines);
  inflate(service);
  const restored = PlatformAccessory.deserialize(snapshot(routines));
  const saved = [];
  platform.api.updatePlatformAccessories.mockImplementation((items) => {
    saved.push(...items.map(snapshot));
  });
  const next = coordinator(platform, accessory());
  next.attachRoutineAccessory(restored);
  expect(saved).toContainEqual(clean);

  for (let i = 0; i < 100; i++) {
    next.syncRoutines([
      { ...routine, name: i % 2 ? "Kitchen clean" : "Kitchen run" },
    ]);
  }
  expect(snapshot(restored)).toEqual(clean);
});

test.each([0, 1])(
  "a cached switch with %i optional name definitions and no active name gets one name",
  (count) => {
    const platform = makeSchedulePlatform(makeScheduleAccount({ duid: DUID }));
    const manager = accessory();
    const service = manager.addService(
      hap.Service.Switch,
      "Test Robot Schedule 1",
      "roborock-schedule-timer-1"
    );
    if (count) {
      service.addOptionalCharacteristic(hap.Characteristic.ConfiguredName);
    }
    coordinator(platform, manager).restoreScheduleHandlersFromAccessory();
    expect(nameDefinitions(service)).toHaveLength(1);
    expect(service.testCharacteristic(hap.Characteristic.ConfiguredName)).toBe(
      true
    );
  }
);

test("clean caches and unrelated services do not trigger a migration write", () => {
  const platform = makeSchedulePlatform(makeScheduleAccount({ duid: DUID }));
  const manager = accessory();
  const other = manager.addService(hap.Service.Switch, "Other", "other-switch");
  inflate(other);
  const before = snapshot(manager);
  coordinator(platform, manager);
  expect(platform.api.updatePlatformAccessories).not.toHaveBeenCalled();
  expect(snapshot(manager).services).toEqual(before.services);
});
