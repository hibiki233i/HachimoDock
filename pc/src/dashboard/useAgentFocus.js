/**
 * [Input] Followed Agent ids, each Agent's device-visible Session queue, and the preferred fallback Agent.
 * [Output] The focus Agent, its auto/pinned mode, and step/release actions for the joystick-style Agent switch.
 * [Pos] React shell around lib/agent-focus.js; all decisions live there, this file only owns state and the clock.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAgentFocusState,
  focusStatesEqual,
  reconcileAgentFocus,
  releaseAgentFocus,
  stepAgentFocus,
} from "../lib/agent-focus.js";

const FOCUS_CLOCK_MS = 1000;

export function useAgentFocus({ followAgentIds, sessionsByAgent, defaultAgentId = "" }) {
  const [state, setState] = useState(createAgentFocusState);
  const contextRef = useRef({ followAgentIds, sessionsByAgent, defaultAgentId });
  contextRef.current = { followAgentIds, sessionsByAgent, defaultAgentId };
  const followKey = followAgentIds.join("|");

  const reconcile = useCallback(() => {
    setState((previous) => {
      const next = reconcileAgentFocus(previous, { nowMs: Date.now(), ...contextRef.current });
      return focusStatesEqual(previous, next) ? previous : next;
    });
  }, []);

  useEffect(reconcile, [reconcile, followKey, sessionsByAgent, defaultAgentId]);
  // A finished Session stays "active" for its 60 s hold; the clock lets that expiry take effect
  // even when no feed changes.
  useEffect(() => {
    const timer = setInterval(reconcile, FOCUS_CLOCK_MS);
    return () => clearInterval(timer);
  }, [reconcile]);

  const step = useCallback((direction) => {
    setState((previous) => stepAgentFocus(previous, direction, { nowMs: Date.now(), ...contextRef.current }));
  }, []);
  const release = useCallback(() => {
    setState((previous) => releaseAgentFocus(previous, { nowMs: Date.now(), ...contextRef.current }));
  }, []);

  return { focusAgentId: state.focusAgentId, mode: state.mode, reason: state.reason, step, release };
}
