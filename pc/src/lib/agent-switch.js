/**
 * [Input] `usb-message` envelopes from the board, the followed Agent ids, the focus Agent and the Agent options.
 * [Output] The direction of a joystick Agent switch, and the `agent/focus` announcement the board needs to label it.
 * [Pos] Pure helpers in pc/src/lib for the device-side Agent switch; React hooks only subscribe and send.
 * [Sync] If this file changes, update `pc/src/.folder.md` and `firmware/protocol.md` (`agent/focus`, `agent_next`/`agent_previous`).
 */

export const AGENT_SWITCH_DIRECTIONS = Object.freeze({ agent_previous: -1, agent_next: 1 });

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * -1 / +1 for an `input/event` that asks to switch the Agent, else 0. The board reports the key even
 * on pages where it means nothing (a running component), so the page must be the pet home page; a
 * key the board already handled locally (the Session fallback) never reaches this action.
 */
export function agentSwitchDirection(envelope, boardDeviceId) {
  if (!envelope || envelope.topic !== "input/event") return 0;
  const payload = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  if (!boardDeviceId || text(payload.boardDeviceId) !== boardDeviceId) return 0;
  if (text(payload.context) !== "main" || payload.handledLocally === true) return 0;
  return AGENT_SWITCH_DIRECTIONS[text(payload.action)] || 0;
}

/** `agent/focus` payload fields, or null when there is nothing to announce. */
export function buildAgentFocusAnnouncement({ followAgentIds, focusAgentId, agentOptions = [], hint = false }) {
  const follow = Array.isArray(followAgentIds) ? followAgentIds : [];
  if (!focusAgentId || follow.length === 0) return null;
  const index = follow.indexOf(focusAgentId) + 1;
  const option = (agentOptions || []).find((agent) => agent?.id === focusAgentId);
  return {
    agentId: focusAgentId,
    label: text(option?.label) || focusAgentId,
    index,
    count: follow.length,
    hint: Boolean(hint) && index > 0,
  };
}
