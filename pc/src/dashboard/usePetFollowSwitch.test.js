import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { planPetSwitch } from "../lib/agent-focus.js";
import { createPetFollowController } from "../lib/resident-appearance.js";

test("an application restart confirms the focus pet instead of trusting the primary channel cache", async () => {
  let displayed = "pet-b";
  const calls = [], effects = [];
  const source = readFileSync(new URL("./usePetFollowSwitch.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function usePetFollowSwitch")).replace("export function", "function");
  // Execute the real hook's first committed effects; only React's mount scheduling is substituted.
  const mount = new Function("useCallback", "useEffect", "useMemo", "useRef", "planPetSwitch", "createPetFollowController", body + "\nreturn usePetFollowSwitch;")(
    (fn) => fn, (fn) => effects.push(fn), (fn) => fn(), (value) => ({ current: value }), planPetSwitch, createPetFollowController,
  );
  mount({
    enabled: true, boardDeviceId: "p4-1", focusAgentId: "codex", petFollowMode: "follow", residentAgentId: "codex",
    agentAppearanceMap: { codex: "pet-a", "claude-code": "pet-b" }, shownAppearanceId: "pet-a",
    invoke: async (command, args) => { calls.push(command); displayed = args.appearanceId; return { ok: true, state: "activated" }; },
  });
  effects.forEach((effect) => effect());
  await setImmediate();
  assert.equal(displayed, "pet-a");
  assert.deepEqual(calls, ["usb_activate_resident_appearance"]);
});
