/**
 * [Input] Followed Agent ids, each Agent's device-visible Session queue, joystick direction events, and the pet follow mode setting.
 * [Output] Pure focus-Agent state: earliest-active automatic selection, manual pin with release rules, and whether the pet appearance may switch.
 * [Pos] Pure multi-Agent focus engine in pc/src/lib; React hooks own timers and persistence, this file owns the decisions.
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

import {
  deviceSessionTerminalRemainingMs,
  isActiveDeviceSession,
  isTerminalDeviceSession,
} from "./session-display.js";

export const PET_FOLLOW_MODE_FOLLOW = "follow";
export const PET_FOLLOW_MODE_RESIDENT = "resident";
export const PET_FOLLOW_MODES = Object.freeze([PET_FOLLOW_MODE_FOLLOW, PET_FOLLOW_MODE_RESIDENT]);
export const PET_FOLLOW_MODE_STORAGE_KEY = "pet-manager.pet-follow-mode";

export const FOCUS_MODE_AUTO = "auto";
export const FOCUS_MODE_PINNED = "pinned";

/**
 * Why `focusAgentId` last changed. The UI uses it for the short on-device hint.
 * `""` means the focus has not changed since the state was created.
 */
export const FOCUS_REASON_EARLIEST_ACTIVE = "earliest-active";
export const FOCUS_REASON_PINNED = "pinned";
export const FOCUS_REASON_RELEASED = "released";
export const FOCUS_REASON_FOLLOW_CHANGED = "follow-changed";

export function normalizePetFollowMode(value) {
  return PET_FOLLOW_MODES.includes(value) ? value : PET_FOLLOW_MODE_FOLLOW;
}

export function createAgentFocusState() {
  return {
    focusAgentId: "",
    mode: FOCUS_MODE_AUTO,
    pinnedAgentId: "",
    pinnedWasActive: false,
    activeSince: {},
    reason: "",
  };
}

/**
 * An Agent is active while its queue holds a visible card: a working card, or a
 * done/error card still inside the 60-second terminal hold. The queue already
 * absorbs missed scans (15 s grace) and the terminal hold, so no extra debounce
 * is layered here.
 */
export function isAgentActive(sessions, nowMs = Date.now()) {
  return (Array.isArray(sessions) ? sessions : []).some((session) =>
    isActiveDeviceSession(session)
    || (isTerminalDeviceSession(session) && deviceSessionTerminalRemainingMs(session, nowMs) > 0));
}

function uniqueAgentIds(agentIds) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(agentIds) ? agentIds : []) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !seen.has(id)) {
      seen.add(id);
      output.push(id);
    }
  }
  return output;
}

function earliestActiveAgent(followIds, activeSince) {
  let best = "";
  for (const id of followIds) {
    if (!(id in activeSince)) continue;
    // `followIds` order breaks ties, so strict `<` keeps the earlier entry.
    if (!best || activeSince[id] < activeSince[best]) best = id;
  }
  return best;
}

/**
 * Advance the focus state from the latest queues. Call whenever any Agent's
 * queue or the follow set changes, and on a timer so terminal holds can expire.
 *
 * @param state previous state from `createAgentFocusState` / this function
 * @param context `{ nowMs, followAgentIds, sessionsByAgent, defaultAgentId }`
 */
export function reconcileAgentFocus(state, { nowMs = Date.now(), followAgentIds, sessionsByAgent = {}, defaultAgentId = "" } = {}) {
  const follow = uniqueAgentIds(followAgentIds);
  const followSet = new Set(follow);
  const activeNow = new Set(follow.filter((id) => isAgentActive(sessionsByAgent[id], nowMs)));

  const activeSince = {};
  const newlyActive = [];
  for (const id of activeNow) {
    if (id in state.activeSince) {
      activeSince[id] = state.activeSince[id];
    } else {
      activeSince[id] = nowMs;
      newlyActive.push(id);
    }
  }

  let { mode, pinnedAgentId, pinnedWasActive } = state;
  let released = false;
  if (mode === FOCUS_MODE_PINNED) {
    const pinnedActive = activeNow.has(pinnedAgentId);
    if (!followSet.has(pinnedAgentId)) {
      released = true;
    } else if (pinnedWasActive && !pinnedActive) {
      released = true;
    } else if (!pinnedWasActive && pinnedActive) {
      // The pinned idle Agent started working: it now behaves like a pin on an active Agent.
      pinnedWasActive = true;
    } else if (!pinnedWasActive && newlyActive.some((id) => id !== pinnedAgentId)) {
      released = true;
    }
    if (released) {
      mode = FOCUS_MODE_AUTO;
      pinnedAgentId = "";
      pinnedWasActive = false;
    }
  }

  let focusAgentId = state.focusAgentId;
  let reason = state.reason;
  const setFocus = (id, why) => {
    if (id === focusAgentId) return;
    focusAgentId = id;
    reason = why;
  };

  if (mode === FOCUS_MODE_PINNED) {
    setFocus(pinnedAgentId, FOCUS_REASON_PINNED);
  } else {
    const earliest = earliestActiveAgent(follow, activeSince);
    if (earliest) {
      setFocus(earliest, released ? FOCUS_REASON_RELEASED : FOCUS_REASON_EARLIEST_ACTIVE);
    } else if (!followSet.has(focusAgentId)) {
      // Nobody is active: keep the last focus, and only fall back when it is no longer followed.
      // The fallback is the Agent the user follows on the desktop, not merely the first in the list.
      setFocus(followSet.has(defaultAgentId) ? defaultAgentId : follow[0] || "", FOCUS_REASON_FOLLOW_CHANGED);
    }
  }

  return { focusAgentId, mode, pinnedAgentId, pinnedWasActive, activeSince, reason };
}

/** Pin the focus to `agentId` (joystick or a Session selected across Agents). */
export function pinAgentFocus(state, agentId, { nowMs = Date.now(), followAgentIds, sessionsByAgent = {} } = {}) {
  const follow = uniqueAgentIds(followAgentIds);
  if (!follow.includes(agentId)) return state;
  return {
    ...state,
    focusAgentId: agentId,
    mode: FOCUS_MODE_PINNED,
    pinnedAgentId: agentId,
    pinnedWasActive: isAgentActive(sessionsByAgent[agentId], nowMs),
    reason: agentId === state.focusAgentId && state.mode === FOCUS_MODE_PINNED ? state.reason : FOCUS_REASON_PINNED,
  };
}

/**
 * Joystick left/right: move to the previous/next followed Agent, wrapping around.
 * `direction` is -1 or +1. With fewer than two followed Agents nothing changes.
 */
export function stepAgentFocus(state, direction, context = {}) {
  const follow = uniqueAgentIds(context.followAgentIds);
  if (follow.length < 2) return state;
  const step = direction < 0 ? -1 : 1;
  const current = follow.indexOf(state.focusAgentId);
  const next = current < 0
    ? (step > 0 ? 0 : follow.length - 1)
    : (current + step + follow.length) % follow.length;
  return pinAgentFocus(state, follow[next], context);
}

/**
 * The pet appearance only follows the focus Agent in `follow` mode; `resident`
 * keeps the current pet while focus, Session selection and badges still move.
 */
export function petAppearanceAgentId(state, petFollowMode, residentAgentId = "") {
  return normalizePetFollowMode(petFollowMode) === PET_FOLLOW_MODE_RESIDENT
    ? (residentAgentId || state.focusAgentId)
    : state.focusAgentId;
}

/**
 * Decide whether a focus change should switch the pet on the board. `resident` mode never does; in
 * `follow` mode the focus Agent's appearance is shown unless it already is, or no appearance is
 * assigned to that Agent.
 */
export function planPetSwitch({ state, petFollowMode, residentAgentId = "", agentAppearanceMap = {}, shownAppearanceId = "" }) {
  const agentId = petAppearanceAgentId(state, petFollowMode, residentAgentId);
  const appearanceId = agentId ? agentAppearanceMap?.[agentId] || "" : "";
  if (normalizePetFollowMode(petFollowMode) === PET_FOLLOW_MODE_RESIDENT || !appearanceId || appearanceId === shownAppearanceId) {
    return { switchNeeded: false, agentId, appearanceId: shownAppearanceId };
  }
  return { switchNeeded: true, agentId, appearanceId };
}

/** Drop a manual pin and let the earliest-active rule choose again. */
export function releaseAgentFocus(state, context = {}) {
  if (state.mode !== FOCUS_MODE_PINNED) return state;
  return reconcileAgentFocus(
    { ...state, mode: FOCUS_MODE_AUTO, pinnedAgentId: "", pinnedWasActive: false },
    context,
  );
}

/** Whether two states would look the same to the UI, so React can skip a re-render. */
export function focusStatesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftActive = Object.keys(left.activeSince);
  return left.focusAgentId === right.focusAgentId
    && left.mode === right.mode
    && left.pinnedAgentId === right.pinnedAgentId
    && left.pinnedWasActive === right.pinnedWasActive
    && left.reason === right.reason
    && leftActive.length === Object.keys(right.activeSince).length
    && leftActive.every((id) => left.activeSince[id] === right.activeSince[id]);
}
