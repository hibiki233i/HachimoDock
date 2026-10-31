/**
 * [Input] Synthetic per-Agent Session queues advanced through time.
 * [Output] Behavioral coverage of earliest-active focus, terminal-hold activity, manual pin release, and pet follow mode.
 * [Pos] test node for pc/src/lib/agent-focus.js
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  FOCUS_MODE_AUTO,
  FOCUS_MODE_PINNED,
  PET_FOLLOW_MODE_RESIDENT,
  createAgentFocusState,
  focusStatesEqual,
  isAgentActive,
  normalizePetFollowMode,
  petAppearanceAgentId,
  releaseAgentFocus,
  planPetSwitch,
  pinAgentFocus,
  reconcileAgentFocus,
  stepAgentFocus,
} from "./agent-focus.js";
import { DEVICE_SESSION_TERMINAL_HOLD_MS } from "./session-display.js";

const working = (id) => ({ id, state: "working" });
const doneUntil = (id, untilMs) => ({ id, state: "done", __p4TerminalUntilMs: untilMs });

function run(steps, follow = ["codex", "claude-code", "openclaw"]) {
  let state = createAgentFocusState();
  const history = [];
  for (const [nowMs, sessionsByAgent] of steps) {
    state = reconcileAgentFocus(state, { nowMs, followAgentIds: follow, sessionsByAgent });
    history.push(state.focusAgentId);
  }
  return { state, history };
}

test("the Agent that became active first owns the focus and later Agents do not preempt it", () => {
  const { history } = run([
    [1000, { codex: [working("a")] }],
    [2000, { codex: [working("a")], "claude-code": [working("b")] }],
    [3000, { codex: [working("a")], "claude-code": [working("b")] }],
  ]);
  assert.deepEqual(history, ["codex", "codex", "codex"]);
});

test("focus passes to the next earliest active Agent when the first one goes idle", () => {
  const { history } = run([
    [1000, { codex: [working("a")] }],
    [2000, { codex: [working("a")], "claude-code": [working("b")] }],
    [3000, { codex: [], "claude-code": [working("b")] }],
  ]);
  assert.deepEqual(history, ["codex", "codex", "claude-code"]);
});

test("a later Agent keeps its own activation time when an earlier one restarts", () => {
  const { history } = run([
    [1000, { codex: [working("a")] }],
    [2000, { codex: [working("a")], "claude-code": [working("b")] }],
    [3000, { codex: [], "claude-code": [working("b")] }],
    [4000, { codex: [working("a2")], "claude-code": [working("b")] }],
  ]);
  assert.deepEqual(history, ["codex", "codex", "claude-code", "claude-code"]);
});

test("Agents that become active in the same pass resolve by follow order", () => {
  const { history } = run([[1000, { "claude-code": [working("b")], codex: [working("a")] }]]);
  assert.deepEqual(history, ["codex"]);
});

test("with no active Agent the last focus is kept instead of bouncing back", () => {
  const { history } = run([
    [1000, { "claude-code": [working("b")] }],
    [2000, { "claude-code": [] }],
    [3000, {}],
  ]);
  assert.deepEqual(history, ["claude-code", "claude-code", "claude-code"]);
});

test("a finished Agent still counts as active for the 60 second terminal hold", () => {
  const now = 10_000;
  const held = [doneUntil("a", now + DEVICE_SESSION_TERMINAL_HOLD_MS)];
  assert.equal(isAgentActive(held, now), true);
  assert.equal(isAgentActive(held, now + DEVICE_SESSION_TERMINAL_HOLD_MS), false);
  assert.equal(isAgentActive([doneUntil("a", 0)], now), false);

  const { history } = run([
    [1000, { codex: [working("a")] }],
    [2000, { codex: [doneUntil("a", 2000 + DEVICE_SESSION_TERMINAL_HOLD_MS)], "claude-code": [working("b")] }],
    [30_000, { codex: [doneUntil("a", 2000 + DEVICE_SESSION_TERMINAL_HOLD_MS)], "claude-code": [working("b")] }],
    [2000 + DEVICE_SESSION_TERMINAL_HOLD_MS, { codex: [doneUntil("a", 2000 + DEVICE_SESSION_TERMINAL_HOLD_MS)], "claude-code": [working("b")] }],
  ]);
  assert.deepEqual(history, ["codex", "codex", "codex", "claude-code"]);
});

test("an Agent removed from the follow set stops owning the focus", () => {
  let state = reconcileAgentFocus(createAgentFocusState(), {
    nowMs: 1000,
    followAgentIds: ["codex", "claude-code"],
    sessionsByAgent: { codex: [working("a")], "claude-code": [working("b")] },
  });
  assert.equal(state.focusAgentId, "codex");
  state = reconcileAgentFocus(state, {
    nowMs: 2000,
    followAgentIds: ["claude-code"],
    sessionsByAgent: { codex: [working("a")], "claude-code": [working("b")] },
  });
  assert.equal(state.focusAgentId, "claude-code");
  assert.equal("codex" in state.activeSince, false);
});

test("stepping moves through the followed Agents, wraps, and pins the choice", () => {
  const follow = ["codex", "claude-code", "openclaw"];
  const context = { nowMs: 1000, followAgentIds: follow, sessionsByAgent: { codex: [working("a")] } };
  let state = reconcileAgentFocus(createAgentFocusState(), context);
  state = stepAgentFocus(state, 1, context);
  assert.equal(state.focusAgentId, "claude-code");
  assert.equal(state.mode, FOCUS_MODE_PINNED);
  state = stepAgentFocus(state, 1, context);
  state = stepAgentFocus(state, 1, context);
  assert.equal(state.focusAgentId, "codex");
  state = stepAgentFocus(state, -1, context);
  assert.equal(state.focusAgentId, "openclaw");
});

test("stepping with a single followed Agent changes nothing", () => {
  const context = { nowMs: 1000, followAgentIds: ["codex"], sessionsByAgent: { codex: [working("a")] } };
  const state = reconcileAgentFocus(createAgentFocusState(), context);
  assert.equal(stepAgentFocus(state, 1, context), state);
});

test("a pin on an active Agent holds while it works and releases when it ends", () => {
  const follow = ["codex", "claude-code"];
  const busy = { codex: [working("a")], "claude-code": [working("b")] };
  let state = reconcileAgentFocus(createAgentFocusState(), { nowMs: 1000, followAgentIds: follow, sessionsByAgent: busy });
  state = pinAgentFocus(state, "claude-code", { nowMs: 1500, followAgentIds: follow, sessionsByAgent: busy });
  state = reconcileAgentFocus(state, { nowMs: 2000, followAgentIds: follow, sessionsByAgent: busy });
  assert.equal(state.focusAgentId, "claude-code");
  assert.equal(state.mode, FOCUS_MODE_PINNED);

  state = reconcileAgentFocus(state, {
    nowMs: 3000,
    followAgentIds: follow,
    sessionsByAgent: { codex: [working("a")], "claude-code": [] },
  });
  assert.equal(state.mode, FOCUS_MODE_AUTO);
  assert.equal(state.focusAgentId, "codex");
});

test("a pin on an idle Agent holds until a different Agent becomes active", () => {
  const follow = ["codex", "claude-code", "openclaw"];
  let state = reconcileAgentFocus(createAgentFocusState(), { nowMs: 1000, followAgentIds: follow, sessionsByAgent: {} });
  state = pinAgentFocus(state, "openclaw", { nowMs: 1100, followAgentIds: follow, sessionsByAgent: {} });
  state = reconcileAgentFocus(state, { nowMs: 2000, followAgentIds: follow, sessionsByAgent: {} });
  assert.equal(state.focusAgentId, "openclaw");
  assert.equal(state.mode, FOCUS_MODE_PINNED);

  state = reconcileAgentFocus(state, {
    nowMs: 3000,
    followAgentIds: follow,
    sessionsByAgent: { codex: [working("a")] },
  });
  assert.equal(state.mode, FOCUS_MODE_AUTO);
  assert.equal(state.focusAgentId, "codex");
});

test("an idle pinned Agent that starts working stays pinned until its own work ends", () => {
  const follow = ["codex", "openclaw"];
  let state = reconcileAgentFocus(createAgentFocusState(), { nowMs: 1000, followAgentIds: follow, sessionsByAgent: {} });
  state = pinAgentFocus(state, "openclaw", { nowMs: 1100, followAgentIds: follow, sessionsByAgent: {} });
  state = reconcileAgentFocus(state, {
    nowMs: 2000,
    followAgentIds: follow,
    sessionsByAgent: { openclaw: [working("o")] },
  });
  assert.equal(state.mode, FOCUS_MODE_PINNED);
  state = reconcileAgentFocus(state, {
    nowMs: 3000,
    followAgentIds: follow,
    sessionsByAgent: { openclaw: [working("o")], codex: [working("a")] },
  });
  assert.equal(state.focusAgentId, "openclaw");
  state = reconcileAgentFocus(state, {
    nowMs: 4000,
    followAgentIds: follow,
    sessionsByAgent: { openclaw: [], codex: [working("a")] },
  });
  assert.equal(state.mode, FOCUS_MODE_AUTO);
  assert.equal(state.focusAgentId, "codex");
});

test("pinning an Agent outside the follow set is ignored", () => {
  const state = reconcileAgentFocus(createAgentFocusState(), {
    nowMs: 1000,
    followAgentIds: ["codex"],
    sessionsByAgent: {},
  });
  assert.equal(pinAgentFocus(state, "claude-code", { followAgentIds: ["codex"] }), state);
});

test("resident mode keeps the pet appearance Agent while follow mode tracks the focus", () => {
  const state = { ...createAgentFocusState(), focusAgentId: "claude-code" };
  assert.equal(petAppearanceAgentId(state, "follow", "codex"), "claude-code");
  assert.equal(petAppearanceAgentId(state, PET_FOLLOW_MODE_RESIDENT, "codex"), "codex");
  assert.equal(petAppearanceAgentId(state, PET_FOLLOW_MODE_RESIDENT, ""), "claude-code");
  assert.equal(normalizePetFollowMode("nonsense"), "follow");
});

test("a focus change switches the pet only in follow mode and only to a different assigned appearance", () => {
  const map = { codex: "pet-a", "claude-code": "pet-b" };
  const focus = { ...createAgentFocusState(), focusAgentId: "claude-code" };
  assert.deepEqual(
    planPetSwitch({ state: focus, petFollowMode: "follow", agentAppearanceMap: map, shownAppearanceId: "pet-a" }),
    { switchNeeded: true, agentId: "claude-code", appearanceId: "pet-b" },
  );
  assert.equal(planPetSwitch({ state: focus, petFollowMode: "follow", agentAppearanceMap: map, shownAppearanceId: "pet-b" }).switchNeeded, false);
  assert.equal(planPetSwitch({ state: focus, petFollowMode: "resident", residentAgentId: "codex", agentAppearanceMap: map, shownAppearanceId: "pet-a" }).switchNeeded, false);
  assert.equal(planPetSwitch({ state: { ...focus, focusAgentId: "openclaw" }, petFollowMode: "follow", agentAppearanceMap: map, shownAppearanceId: "pet-a" }).switchNeeded, false, "no appearance assigned");
  assert.equal(planPetSwitch({ state: createAgentFocusState(), petFollowMode: "follow", agentAppearanceMap: map }).switchNeeded, false, "no focus yet");
});

test("with nobody active the focus starts on the preferred followed Agent, not the first in the list", () => {
  const state = reconcileAgentFocus(createAgentFocusState(), {
    nowMs: 1000,
    followAgentIds: ["codex", "claude-code"],
    sessionsByAgent: {},
    defaultAgentId: "claude-code",
  });
  assert.equal(state.focusAgentId, "claude-code");
  const unfollowed = reconcileAgentFocus(createAgentFocusState(), {
    nowMs: 1000, followAgentIds: ["codex", "claude-code"], sessionsByAgent: {}, defaultAgentId: "openclaw",
  });
  assert.equal(unfollowed.focusAgentId, "codex");
});

test("releasing a pin returns to the earliest-active Agent and is a no-op when nothing is pinned", () => {
  const follow = ["codex", "claude-code"];
  const busy = { codex: [working("a")], "claude-code": [working("b")] };
  const context = { nowMs: 1000, followAgentIds: follow, sessionsByAgent: busy };
  let state = reconcileAgentFocus(createAgentFocusState(), context);
  assert.equal(releaseAgentFocus(state, context), state);
  state = stepAgentFocus(state, 1, context);
  assert.equal(state.focusAgentId, "claude-code");
  const released = releaseAgentFocus(state, context);
  assert.equal(released.mode, FOCUS_MODE_AUTO);
  assert.equal(released.focusAgentId, "codex");
});

test("state equality ignores identity but notices any change the UI would show", () => {
  const base = reconcileAgentFocus(createAgentFocusState(), {
    nowMs: 1000, followAgentIds: ["codex"], sessionsByAgent: { codex: [working("a")] },
  });
  assert.equal(focusStatesEqual(base, { ...base, activeSince: { ...base.activeSince } }), true);
  assert.equal(focusStatesEqual(base, { ...base, focusAgentId: "claude-code" }), false);
  assert.equal(focusStatesEqual(base, { ...base, mode: FOCUS_MODE_PINNED }), false);
  assert.equal(focusStatesEqual(base, { ...base, activeSince: {} }), false);
  assert.equal(focusStatesEqual(base, null), false);
});

