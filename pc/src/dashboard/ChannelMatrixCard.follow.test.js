/**
 * [Input] The real appearance-change handler, focus planner and resident controller, with a simulated device.
 * [Output] Behavior coverage for replacing a simultaneously followed Agent's pet without saving an unavailable appearance or stealing focus.
 * [Pos] test node for ChannelMatrixCard.jsx in pc/src/dashboard
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { assignAppearanceToAgent, channelLabelForId } from "../lib/agent-appearance-config.js";
import { planPetSwitch } from "../lib/agent-focus.js";
import { createPetFollowController } from "../lib/resident-appearance.js";
import {
  APPEARANCE_SYNC_CANCELLED_MESSAGE,
  APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE,
} from "../lib/desktop-pet-assignment.js";

const source = readFileSync(new URL("./ChannelMatrixCard.jsx", import.meta.url), "utf8");
const handler = source.slice(source.indexOf("  const handleConfirmAppearance ="), source.indexOf("  const requestFollow ="));
const replacement = { id: "pet-c", name: "Cat" };

async function appearanceChangeFixture({
  usb = { connected: true, transport: "serial", boardDeviceId: "p4-1" },
  petFollowMode = "follow",
  preloadResult = { ok: true, fileCount: 1, byteCount: 100 },
  preloadWait,
} = {}) {
  let map = { codex: "pet-a", "claude-code": "pet-b" };
  let focusAgentId = "claude-code", displayed = "pet-b", busyId = "";
  const resident = new Set(["pet-a", "pet-b"]);
  const calls = [], notices = [], effects = [];
  const controller = createPetFollowController({
    onNotice: (notice) => notices.push(notice),
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "usb_sync_appearance") {
        assert.deepEqual(args, { appearanceId: "pet-c", boardDeviceId: "p4-1", preloadOnly: true });
        await preloadWait;
        if (preloadResult instanceof Error) throw preloadResult;
        if (preloadResult.ok) resident.add(args.appearanceId);
        return preloadResult;
      }
      assert.equal(command, "usb_activate_resident_appearance");
      if (!resident.has(args.appearanceId)) return { ok: false, state: "notResident" };
      displayed = args.appearanceId;
      return { ok: true, state: "activated" };
    },
  });
  const reconcile = () => {
    const plan = planPetSwitch({ state: { focusAgentId }, petFollowMode, residentAgentId: "codex", agentAppearanceMap: map });
    return controller.setTarget({ enabled: usb.connected, boardDeviceId: "p4-1", appearanceId: plan.switchNeeded ? plan.appearanceId : "" });
  };
  await reconcile();
  calls.length = 0;
  // Capture the actual callback without rendering JSX. Keep the save-to-focus effect and device controller real.
  const bindings = {
    useCallback: (fn) => fn,
    activeAgentId: "codex",
    closePicker: () => {},
    saveAgentAppearance: (agentId, appearanceId) => {
      map = assignAppearanceToAgent(map, agentId, appearanceId);
      effects.push(reconcile());
    },
    push: (notice) => notices.push(notice),
    agentOptions: [{ id: "claude-code", label: "Claude Code" }],
    applyDesktopPet: () => { throw new Error("Changing an extra Agent must not select a new primary channel"); },
    channelLabelForId,
    APPEARANCE_SYNC_CANCELLED_MESSAGE,
    APPEARANCE_CHANGE_USB_REQUIRED_MESSAGE,
    deviceFollowAgents: ["claude-code"],
    usb,
    focus: { preloadAppearance: (input) => controller.preload(input) },
    setFollowBusyId: (value) => { busyId = value; },
  };
  const confirm = new Function(...Object.keys(bindings), handler + "\nreturn handleConfirmAppearance;")(...Object.values(bindings));
  return {
    get map() { return map; },
    get displayed() { return displayed; },
    get busyId() { return busyId; },
    calls,
    notices,
    async change(agentId = "claude-code") {
      await confirm(agentId, replacement);
      await Promise.all(effects);
    },
    focus(agentId) { focusAgentId = agentId; return reconcile(); },
  };
}

test("a focused extra Agent's replacement is stored on the board before it is selected", async () => {
  const fixture = await appearanceChangeFixture();
  await fixture.change();
  assert.equal(fixture.map["claude-code"], "pet-c");
  assert.equal(fixture.map.codex, "pet-a");
  assert.equal(fixture.displayed, "pet-c");
  assert.equal(fixture.notices.some((notice) => notice.tone === "warning"), false);
  assert.equal(fixture.busyId, "");
});

test("an extra Agent keeps its old assignment until preload finishes and preserves a newer focus", async () => {
  let release;
  const preloadWait = new Promise((resolve) => { release = resolve; });
  const fixture = await appearanceChangeFixture({ preloadWait });
  const changing = fixture.change();
  try {
    assert.equal(fixture.map["claude-code"], "pet-b");
    assert.equal(fixture.busyId, "claude-code");
    await setImmediate();
    const focusChanged = fixture.focus("codex");
    release();
    await Promise.all([changing, focusChanged]);
    assert.equal(fixture.map["claude-code"], "pet-c");
    assert.equal(fixture.displayed, "pet-a");
    await fixture.focus("claude-code");
    assert.equal(fixture.displayed, "pet-c");
  } finally {
    release();
    await changing;
  }
});

test("replacing an extra Agent's pet in resident mode preserves the pet on screen", async () => {
  const fixture = await appearanceChangeFixture({ petFollowMode: "resident" });
  await fixture.change();
  assert.equal(fixture.map["claude-code"], "pet-c");
  assert.equal(fixture.displayed, "pet-b");
  assert.equal(fixture.calls.length, 1);
});

for (const [name, preloadResult] of [
  ["full slots", { ok: false, slotsFull: true, error: "slots full" }],
  ["a failed transfer", { ok: false, error: "transfer failed" }],
  ["a disconnected device during transfer", new Error("USB disconnected")],
]) {
  test(`${name} preserves the extra Agent's original appearance assignment`, async () => {
    const fixture = await appearanceChangeFixture({ preloadResult });
    await fixture.change();
    assert.equal(fixture.map["claude-code"], "pet-b");
    assert.equal(fixture.displayed, "pet-b");
    assert.equal(fixture.notices.some((notice) => notice.tone === "success"), false);
    assert.equal(fixture.notices.length, 1);
    assert.equal(fixture.busyId, "");
  });
}

for (const [name, usb] of [
  ["disconnected", { connected: false, boardDeviceId: "p4-1" }],
  ["using Wi-Fi", { connected: true, transport: "wifi", boardDeviceId: "p4-1" }],
]) {
  test(`an extra Agent's replacement needs USB when the device is ${name}`, async () => {
    const fixture = await appearanceChangeFixture({ usb });
    await fixture.change();
    assert.equal(fixture.map["claude-code"], "pet-b");
    assert.deepEqual(fixture.calls, []);
    assert.equal(fixture.notices[0].tone, "warning");
  });
}

test("an Agent outside the follow set can still save an appearance locally without USB", async () => {
  const fixture = await appearanceChangeFixture({ usb: { connected: false } });
  await fixture.change("openclaw");
  assert.equal(fixture.map.openclaw, "pet-c");
  assert.equal(fixture.map["claude-code"], "pet-b");
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.notices[0].tone, "success");
});
