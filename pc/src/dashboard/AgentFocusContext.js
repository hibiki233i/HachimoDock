/**
 * [Input] The focus state computed by the device dashboard.
 * [Output] A context that hands the focus Agent, mode and step/release actions to the Agent matrix without extra props.
 * [Pos] Shared focus channel between DeviceDashboard.jsx and ChannelMatrixCard.jsx.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { createContext, useContext } from "react";

const noop = () => {};

export const AgentFocusContext = createContext({
  followAgentIds: [],
  focusAgentId: "",
  mode: "auto",
  step: noop,
  release: noop,
});

export function useAgentFocusContext() {
  return useContext(AgentFocusContext);
}
