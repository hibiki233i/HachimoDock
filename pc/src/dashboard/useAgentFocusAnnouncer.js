/**
 * [Input] The focus Agent, the followed Agent ids, the Agent options and the bound board id.
 * [Output] Tells the board which Agent it shows and how many are followed (`agent/focus`), asking for the short label only when the focus actually changed.
 * [Pos] Desktop→device half of the joystick Agent switch in the device dashboard.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useEffect, useRef } from "react";
import { buildAgentFocusAnnouncement } from "../lib/agent-switch.js";

// The board forgets the announcement when it reboots while the cable stays connected.
const REANNOUNCE_MS = 15_000;

export function useAgentFocusAnnouncer({ enabled, invoke, boardDeviceId, followAgentIds, focusAgentId, agentOptions }) {
  const lastRef = useRef({ board: "", focus: "" });
  const contextRef = useRef({});
  contextRef.current = { invoke, boardDeviceId, followAgentIds, focusAgentId, agentOptions };
  const followKey = followAgentIds.join("|");

  useEffect(() => {
    if (!enabled || !boardDeviceId || !focusAgentId) return;
    const switched = lastRef.current.board === boardDeviceId
      && lastRef.current.focus !== ""
      && lastRef.current.focus !== focusAgentId;
    lastRef.current = { board: boardDeviceId, focus: focusAgentId };
    send(contextRef.current, switched);
  }, [enabled, boardDeviceId, focusAgentId, followKey]);

  useEffect(() => {
    if (!enabled || !boardDeviceId) return undefined;
    const timer = setInterval(() => send(contextRef.current, false), REANNOUNCE_MS);
    return () => clearInterval(timer);
  }, [enabled, boardDeviceId]);
}

function send({ invoke, boardDeviceId, followAgentIds, focusAgentId, agentOptions }, hint) {
  const announcement = buildAgentFocusAnnouncement({ followAgentIds, focusAgentId, agentOptions, hint });
  if (!announcement || typeof invoke !== "function") return;
  Promise.resolve(invoke("usb_send_agent_focus", { boardDeviceId, ...announcement })).catch(() => {});
}
