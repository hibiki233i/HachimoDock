/**
 * [Input] The Agent ids to follow besides the dashboard's primary Agent, and dismissed-card signatures.
 * [Output] One isolated Session feed per fixed Agent; only requested Agents poll, the rest stay idle.
 * [Pos] Multi-Agent Session polling boundary beside the primary feed in DeviceDashboard.jsx.
 * [Sync] If this file changes, update `pc/src/dashboard/.folder.md` and `pc/src/.folder.md`.
 */

import { useMemo } from "react";
import { FIXED_AGENT_OPTIONS } from "../lib/agent-appearance-config.js";
import { useAgentSessionFeed } from "./useAgentSessionFeed.js";

const FIXED_AGENT_IDS = Object.freeze(FIXED_AGENT_OPTIONS.map((agent) => agent.id));

/**
 * Hooks cannot be called per followed Agent, but the set of Agents is fixed. Every Agent therefore
 * gets one `useAgentSessionFeed` call on every render, always in the same order; an Agent that is
 * not wanted is given an empty id, which the feed treats as idle (no polling, empty queue).
 */
export function useFollowedAgentFeeds({ agentIds, dismissedSessions }) {
  const wanted = new Set(agentIds);
  const feeds = {};
  for (const id of FIXED_AGENT_IDS) {
    // Constant iteration order keeps the hook order stable between renders.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    feeds[id] = useAgentSessionFeed({
      agentId: wanted.has(id) ? id : "",
      displayEnabled: true,
      dismissedSessions,
    });
  }
  // The feeds keep their arrays stable until something changes, so consumers can memoize on them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => feeds, FIXED_AGENT_IDS.flatMap((id) => [
    feeds[id].sessions, feeds[id].routingSessions, feeds[id].loaded,
  ]));
}
