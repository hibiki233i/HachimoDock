/**
 * [Input] Synthetic board envelopes and Agent lists.
 * [Output] Coverage of which board events switch the Agent and what the board is told afterwards.
 * [Pos] test node for pc/src/lib/agent-switch.js
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { agentSwitchDirection, buildAgentFocusAnnouncement } from "./agent-switch.js";

const event = (overrides = {}) => ({
  topic: "input/event",
  payload: { boardDeviceId: "p4-1", action: "agent_next", context: "main", handledLocally: false, ...overrides },
});

test("agent_next and agent_previous on the pet home page switch the Agent in their direction", () => {
  assert.equal(agentSwitchDirection(event(), "p4-1"), 1);
  assert.equal(agentSwitchDirection(event({ action: "agent_previous" }), "p4-1"), -1);
});

test("other boards, other pages, other actions and locally handled keys are ignored", () => {
  assert.equal(agentSwitchDirection(event({ boardDeviceId: "p4-2" }), "p4-1"), 0);
  assert.equal(agentSwitchDirection(event(), ""), 0);
  assert.equal(agentSwitchDirection(event({ context: "app" }), "p4-1"), 0, "a running component keeps its own keys");
  assert.equal(agentSwitchDirection(event({ context: "components" }), "p4-1"), 0);
  assert.equal(agentSwitchDirection(event({ handledLocally: true }), "p4-1"), 0);
  assert.equal(agentSwitchDirection(event({ action: "session_next" }), "p4-1"), 0, "Session keys are not Agent keys");
  assert.equal(agentSwitchDirection({ topic: "state/active", payload: event().payload }, "p4-1"), 0);
  assert.equal(agentSwitchDirection(null, "p4-1"), 0);
});

test("the announcement names the focus Agent, its place among the followed ones, and whether to show the label", () => {
  const options = [{ id: "codex", label: "ChatGPT（Codex）" }, { id: "claude-code", label: "Claude" }];
  assert.deepEqual(
    buildAgentFocusAnnouncement({ followAgentIds: ["codex", "claude-code"], focusAgentId: "claude-code", agentOptions: options, hint: true }),
    { agentId: "claude-code", label: "Claude", index: 2, count: 2, hint: true },
  );
  assert.equal(buildAgentFocusAnnouncement({ followAgentIds: ["codex"], focusAgentId: "codex", agentOptions: options }).hint, false);
  assert.equal(buildAgentFocusAnnouncement({ followAgentIds: ["codex"], focusAgentId: "openclaw", agentOptions: options, hint: true }).hint, false, "not in the followed list");
  assert.equal(buildAgentFocusAnnouncement({ followAgentIds: ["x"], focusAgentId: "x", agentOptions: [] }).label, "x", "falls back to the id");
  assert.equal(buildAgentFocusAnnouncement({ followAgentIds: [], focusAgentId: "codex" }), null);
  assert.equal(buildAgentFocusAnnouncement({ followAgentIds: ["codex"], focusAgentId: "" }), null);
});
