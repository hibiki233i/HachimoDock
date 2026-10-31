/**
 * [Input] A scripted Tauri invoke adapter.
 * [Output] Coverage of the command payload, every activation outcome and its user-facing text.
 * [Pos] test node for pc/src/lib/resident-appearance.js
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { activateResidentAppearance, preloadResidentAppearance, residentActivationMessage } from "./resident-appearance.js";

test("the command is called with the appearance and board, and each outcome is reported", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return { ok: args.appearanceId !== "absent", state: args.appearanceId === "absent" ? "notResident" : "activated" };
  };
  assert.deepEqual(await activateResidentAppearance({ invoke, appearanceId: "pet-a", boardDeviceId: "p4-1" }), { ok: true, state: "activated" });
  assert.deepEqual(calls[0], ["usb_activate_resident_appearance", { appearanceId: "pet-a", boardDeviceId: "p4-1" }]);
  assert.deepEqual(await activateResidentAppearance({ invoke, appearanceId: "absent" }), { ok: false, state: "notResident" });
  assert.equal(calls[1][1].boardDeviceId, null, "an unknown board is left to the backend to resolve");
});

test("a rejected command and missing input become an error outcome instead of throwing", async () => {
  const failing = async () => { throw new Error("设备未连接，无法切换桌宠"); };
  const outcome = await activateResidentAppearance({ invoke: failing, appearanceId: "pet-a" });
  assert.deepEqual(outcome, { ok: false, state: "error", error: "设备未连接，无法切换桌宠" });
  assert.equal((await activateResidentAppearance({ invoke: failing, appearanceId: "" })).state, "error");
  assert.equal((await activateResidentAppearance({ appearanceId: "pet-a" })).state, "error");
});

test("only a non-resident pack and a failure produce a message", () => {
  assert.equal(residentActivationMessage({ state: "active" }), "");
  assert.equal(residentActivationMessage({ state: "activated" }), "");
  assert.match(residentActivationMessage({ state: "notResident" }), /USB/);
  assert.match(residentActivationMessage({ state: "error", error: "x" }), /切换桌宠失败：x/);
});

function scriptedInvoke({ resident = [], syncResult = { ok: true } } = {}) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args.appearanceId]);
    if (command === "usb_sync_appearance") {
      if (syncResult instanceof Error) throw syncResult;
      return syncResult;
    }
    const known = resident.includes(args.appearanceId);
    return { ok: known, state: known ? "activated" : "notResident" };
  };
  return { invoke, calls };
}

test("an appearance already in a slot is only activated, then the shown pet is restored", async () => {
  const { invoke, calls } = scriptedInvoke({ resident: ["pet-a", "pet-b"] });
  const outcome = await preloadResidentAppearance({ invoke, appearanceId: "pet-b", boardDeviceId: "p4-1", restoreAppearanceId: "pet-a" });
  assert.deepEqual(outcome, { ok: true, transferred: false, restored: true });
  assert.deepEqual(calls, [["usb_activate_resident_appearance", "pet-b"], ["usb_activate_resident_appearance", "pet-a"]]);
});

test("a missing appearance is synced over USB and the previous pet is put back", async () => {
  const { invoke, calls } = scriptedInvoke({ resident: ["pet-a"] });
  const outcome = await preloadResidentAppearance({ invoke, appearanceId: "pet-c", restoreAppearanceId: "pet-a" });
  assert.deepEqual(outcome, { ok: true, transferred: true, restored: true });
  assert.deepEqual(calls.map(([command]) => command), [
    "usb_activate_resident_appearance", "usb_sync_appearance", "usb_activate_resident_appearance",
  ]);
});

test("a failed sync reports the reason and never claims the pet is stored", async () => {
  const rejected = scriptedInvoke({ syncResult: { ok: false, error: "P4 appearance videos require 9 bytes" } });
  assert.deepEqual(
    await preloadResidentAppearance({ invoke: rejected.invoke, appearanceId: "pet-c", restoreAppearanceId: "pet-a" }),
    { ok: false, transferred: false, error: "P4 appearance videos require 9 bytes" },
  );
  assert.equal(rejected.calls.length, 2, "no restore after a failure");
  const thrown = scriptedInvoke({ syncResult: new Error("USB 未连接") });
  assert.equal((await preloadResidentAppearance({ invoke: thrown.invoke, appearanceId: "pet-c" })).error, "USB 未连接");
});

test("the same pet needs no restore, and a failed restore does not undo the preload", async () => {
  const same = scriptedInvoke({ resident: ["pet-a"] });
  await preloadResidentAppearance({ invoke: same.invoke, appearanceId: "pet-a", restoreAppearanceId: "pet-a" });
  assert.equal(same.calls.length, 1);
  const gone = scriptedInvoke({ resident: ["pet-b"] });
  const outcome = await preloadResidentAppearance({ invoke: gone.invoke, appearanceId: "pet-b", restoreAppearanceId: "pet-x" });
  assert.deepEqual(outcome, { ok: true, transferred: false, restored: false });
});


// The device adapter is the only fake: these tests observe the actual displayed pet and
// command ordering while the real coordinator handles target changes and preloading.
import * as resident from "./resident-appearance.js";

function followController(invoke, onNotice = () => {}) {
  assert.equal(typeof resident.createPetFollowController, "function", "resident switching needs a shared coordinator");
  return resident.createPetFollowController({ invoke, onNotice });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const target = (appearanceId) => ({ enabled: true, boardDeviceId: "p4-1", appearanceId });

test("returning to A while B is activating restores A after the uncancellable request", async () => {
  const started = deferred(), release = deferred();
  let displayed = "pet-a";
  const calls = [];
  const controller = followController(async (command, args) => {
    assert.equal(command, "usb_activate_resident_appearance");
    calls.push(args.appearanceId);
    if (args.appearanceId === "pet-b") { started.resolve(); await release.promise; }
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  });
  controller.setShownAppearance(target("pet-a"));
  await controller.setTarget(target("pet-a"));
  const toB = controller.setTarget(target("pet-b"));
  await started.promise;
  const backToA = controller.setTarget(target("pet-a"));
  release.resolve();
  await Promise.all([toB, backToA]);
  assert.equal(displayed, "pet-a");
  assert.deepEqual(calls, ["pet-b", "pet-a"]);
});

test("removing the focused extra Agent restores the sole remaining primary pet", async () => {
  let displayed = "pet-b";
  const controller = followController(async (_command, args) => {
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  });
  controller.setShownAppearance(target("pet-b"));
  await controller.setTarget(target("pet-b"));
  await controller.setTarget(target("pet-a"));
  assert.equal(displayed, "pet-a");
});

test("preloading C restores the focused B instead of the desktop channel A", async () => {
  let displayed = "pet-b";
  const calls = [];
  const controller = followController(async (command, args) => {
    calls.push([command, args.appearanceId]);
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  });
  controller.setShownAppearance(target("pet-b"));
  await controller.setTarget(target("pet-b"));
  const outcome = await controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.restored, true);
  assert.equal(displayed, "pet-b");
  assert.deepEqual(calls, [["usb_activate_resident_appearance", "pet-c"], ["usb_activate_resident_appearance", "pet-b"]]);
});

test("focus changes during a USB preload are applied afterwards without overlapping commands", async () => {
  const started = deferred(), release = deferred();
  let displayed = "pet-b", active = 0, maxActive = 0;
  const calls = [];
  const controller = followController(async (command, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push([command, args.appearanceId]);
    try {
      if (command === "usb_activate_resident_appearance" && args.appearanceId === "pet-c") {
        return { ok: false, state: "notResident" };
      }
      if (command === "usb_sync_appearance") { started.resolve(); await release.promise; }
      displayed = args.appearanceId;
      return { ok: true, state: "activated" };
    } finally { active -= 1; }
  });
  controller.setShownAppearance(target("pet-b"));
  await controller.setTarget(target("pet-b"));
  const preload = controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  await started.promise;
  const focusChange = controller.setTarget(target("pet-d"));
  assert.equal(active, 1);
  release.resolve();
  await Promise.all([preload, focusChange]);
  assert.equal(displayed, "pet-d");
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [["usb_activate_resident_appearance", "pet-c"], ["usb_sync_appearance", "pet-c"], ["usb_activate_resident_appearance", "pet-d"]]);
});

test("resident mode preserves the pet that was showing before a preload", async () => {
  let displayed = "pet-b";
  const controller = followController(async (_command, args) => {
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  });
  controller.setShownAppearance(target("pet-b"));
  await controller.setTarget(target(""));
  await controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  assert.equal(displayed, "pet-b");
});
