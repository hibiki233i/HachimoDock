/**
 * [Input] The bound board id and a step callback.
 * [Output] Turns the board's joystick Agent-switch events into focus steps.
 * [Pos] Device→desktop half of the joystick Agent switch in the device dashboard.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { agentSwitchDirection } from "../lib/agent-switch.js";

export function useAgentSwitchEvents({ enabled, boardDeviceId, onStep }) {
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  useEffect(() => {
    if (!enabled || !boardDeviceId) return undefined;
    let disposed = false;
    let unlisten = null;
    listen("usb-message", (event) => {
      const direction = agentSwitchDirection(event?.payload, boardDeviceId);
      if (direction) stepRef.current?.(direction);
    })
      .then((stop) => {
        if (disposed) stop?.();
        else unlisten = stop;
      })
      .catch((error) => console.warn("[device] failed to listen for Agent switch events", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, boardDeviceId]);
}
