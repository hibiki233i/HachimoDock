/**
 * [Input] The focus Agent, the pet follow mode, the Agent→appearance map, the appearance the board shows, and a notice sink.
 * [Output] Switches the board to the focus Agent's resident appearance and warns once when that appearance is not stored on the board.
 * [Pos] Focus-driven pet switching in the device dashboard; never transfers assets.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useEffect, useRef } from "react";
import { planPetSwitch } from "../lib/agent-focus.js";
import { activateResidentAppearance, residentActivationMessage } from "../lib/resident-appearance.js";

export function usePetFollowSwitch({
  enabled,
  invoke,
  boardDeviceId,
  focusAgentId,
  petFollowMode,
  residentAgentId,
  agentAppearanceMap,
  shownAppearanceId,
  onNotice,
}) {
  const shownRef = useRef(shownAppearanceId);
  const warnedRef = useRef(new Set());
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  // An explicit change from the dashboard (setting a desktop pet) re-bases what the board shows.
  useEffect(() => {
    shownRef.current = shownAppearanceId;
  }, [shownAppearanceId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const plan = planPetSwitch({
      state: { focusAgentId },
      petFollowMode,
      residentAgentId,
      agentAppearanceMap,
      shownAppearanceId: shownRef.current,
    });
    if (!plan.switchNeeded) return undefined;
    let cancelled = false;
    (async () => {
      const outcome = await activateResidentAppearance({
        invoke,
        appearanceId: plan.appearanceId,
        boardDeviceId,
      });
      if (cancelled) return;
      if (outcome.ok) {
        shownRef.current = plan.appearanceId;
        return;
      }
      const message = residentActivationMessage(outcome);
      const key = `${plan.appearanceId}:${outcome.state}`;
      if (message && !warnedRef.current.has(key)) {
        warnedRef.current.add(key);
        noticeRef.current?.({ tone: "warning", title: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, invoke, boardDeviceId, focusAgentId, petFollowMode, residentAgentId, agentAppearanceMap]);
}
