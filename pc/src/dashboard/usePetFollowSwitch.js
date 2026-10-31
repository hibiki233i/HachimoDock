/**
 * [Input] The focus Agent, the pet follow mode, the Agent→appearance map, the desktop assignment revision, and a notice sink.
 * [Output] Serializes focus-driven resident activation and preloading, confirms the latest focus after initialization, reconnection and preloading, and warns once for an unavailable appearance.
 * [Pos] Focus-driven pet switching in the device dashboard; never transfers assets.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { planPetSwitch } from "../lib/agent-focus.js";
import { createPetFollowController } from "../lib/resident-appearance.js";

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
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;
  const controller = useMemo(() => createPetFollowController({
    invoke,
    onNotice: (notice) => noticeRef.current?.(notice),
  }), [invoke]);

  useEffect(() => {
    controller.invalidateShownAppearance();
  }, [controller, enabled, boardDeviceId, shownAppearanceId]);

  useEffect(() => {
    const plan = planPetSwitch({
      state: { focusAgentId }, petFollowMode, residentAgentId, agentAppearanceMap,
    });
    controller.setTarget({ enabled, boardDeviceId, appearanceId: plan.switchNeeded ? plan.appearanceId : "" });
  }, [controller, enabled, boardDeviceId, focusAgentId, petFollowMode, residentAgentId, agentAppearanceMap, shownAppearanceId]);

  useEffect(() => () => { controller.setTarget({ enabled: false }); }, [controller]);

  return useCallback((input) => controller.preload(input), [controller]);
}
