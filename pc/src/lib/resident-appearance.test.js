/**
 * [Input] A scripted Tauri invoke adapter.
 * [Output] Coverage of the command payload, every activation outcome and its user-facing text.
 * [Pos] test node for pc/src/lib/resident-appearance.js
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { activateResidentAppearance, preloadResidentAppearance, residentActivationMessage, createPetFollowController } from "./resident-appearance.js";

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

test("preloading uses the no-replacement operation and reports cached or transferred packs", async () => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    return args.appearanceId === "cached"
      ? { ok: true, reusedSlot: true, fileCount: 0, byteCount: 0 }
      : { ok: true, reusedSlot: false, fileCount: 5, byteCount: 100 };
  };
  assert.deepEqual(await preloadResidentAppearance({ invoke, appearanceId: "cached", boardDeviceId: "p4-1" }), { ok: true, transferred: false, restored: true });
  assert.deepEqual(await preloadResidentAppearance({ invoke, appearanceId: "new", boardDeviceId: "p4-1" }), { ok: true, transferred: true, restored: true });
  assert.deepEqual(calls, [
    ["usb_sync_appearance", { appearanceId: "cached", boardDeviceId: "p4-1", preloadOnly: true }],
    ["usb_sync_appearance", { appearanceId: "new", boardDeviceId: "p4-1", preloadOnly: true }],
  ]);
});

test("full slots ignore the new appearance without an activation or replacement request", async () => {
  const calls = [];
  const outcome = await preloadResidentAppearance({ appearanceId: "pet-d", boardDeviceId: "p4-1",
    invoke: async (command, args) => { calls.push([command, args]); return { ok: false, slotsFull: true }; },
  });
  assert.deepEqual(outcome, { ok: false, ignored: true, state: "slotsFull", transferred: false });
  assert.deepEqual(calls, [["usb_sync_appearance", { appearanceId: "pet-d", boardDeviceId: "p4-1", preloadOnly: true }]]);
});

test("a failed preload or restore reports its failure instead of claiming the Agent was admitted", async () => {
  for (const result of [{ ok: false, error: "restore failed" }, new Error("USB 未连接")]) {
    const outcome = await preloadResidentAppearance({ appearanceId: "pet-c", invoke: async () => {
      if (result instanceof Error) throw result;
      return result;
    } });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, result.message || result.error);
  }
});

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
  const controller = createPetFollowController({ invoke: async (command, args) => {
    assert.equal(command, "usb_activate_resident_appearance");
    calls.push(args.appearanceId);
    if (args.appearanceId === "pet-b") { started.resolve(); await release.promise; }
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  } });
  await controller.setTarget(target("pet-a"));
  calls.length = 0;
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
  const controller = createPetFollowController({ invoke: async (_command, args) => {
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  } });
  await controller.setTarget(target("pet-b"));
  await controller.setTarget(target("pet-a"));
  assert.equal(displayed, "pet-a");
});

test("preloading C reconciles the focused B instead of the desktop channel A", async () => {
  let displayed = "pet-b";
  const calls = [];
  const controller = createPetFollowController({ invoke: async (command, args) => {
    calls.push([command, args.appearanceId]);
    if (command === "usb_sync_appearance") return { ok: true, byteCount: 0, reusedSlot: true };
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  } });
  await controller.setTarget(target("pet-b"));
  calls.length = 0;
  const outcome = await controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.restored, true);
  assert.equal(displayed, "pet-b");
  assert.deepEqual(calls, [["usb_sync_appearance", "pet-c"], ["usb_activate_resident_appearance", "pet-b"]]);
});

test("focus changes during a USB preload are applied afterwards without overlapping commands", async () => {
  const started = deferred(), release = deferred();
  let displayed = "pet-b", active = 0, maxActive = 0;
  const calls = [];
  const controller = createPetFollowController({ invoke: async (command, args) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push([command, args.appearanceId]);
    try {
      if (command === "usb_sync_appearance") {
        const previous = displayed;
        displayed = args.appearanceId;
        started.resolve(); await release.promise;
        displayed = previous;
        return { ok: true, byteCount: 100 };
      }
      displayed = args.appearanceId;
      return { ok: true, state: "activated" };
    } finally { active -= 1; }
  } });
  await controller.setTarget(target("pet-b"));
  calls.length = 0;
  const preload = controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  await started.promise;
  const focusChange = controller.setTarget(target("pet-d"));
  assert.equal(active, 1);
  release.resolve();
  await Promise.all([preload, focusChange]);
  assert.equal(displayed, "pet-d");
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [["usb_sync_appearance", "pet-c"], ["usb_activate_resident_appearance", "pet-d"]]);
});

test("resident mode preserves the device display without inventing a frontend appearance", async () => {
  let displayed = "pet-b";
  const calls = [];
  const controller = createPetFollowController({ invoke: async (command, args) => {
    calls.push([command, args.appearanceId]);
    if (command === "usb_sync_appearance") return { ok: true, byteCount: 100 };
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  } });
  await controller.setTarget(target(""));
  await controller.preload({ appearanceId: "pet-c", boardDeviceId: "p4-1" });
  assert.equal(displayed, "pet-b");
  assert.deepEqual(calls, [["usb_sync_appearance", "pet-c"]]);
});

test("reconnecting the same board confirms its display again", async () => {
  let displayed = "pet-b", activations = 0;
  const controller = createPetFollowController({ invoke: async (_command, args) => {
    activations += 1;
    displayed = args.appearanceId;
    return { ok: true, state: "activated" };
  } });
  await controller.setTarget(target("pet-a"));
  displayed = "pet-b";
  controller.invalidateShownAppearance();
  await controller.setTarget(target("pet-a"));
  assert.equal(displayed, "pet-a");
  assert.equal(activations, 2);
});
