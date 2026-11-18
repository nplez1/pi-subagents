/**
 * agent-record-entry.ts — what a finished top-level agent leaves behind in the
 * session.
 *
 * The live record is evicted about ten minutes after the agent finishes, read or
 * not, and every record is gone after a reload or a restart (this fork's
 * tombstones live in memory only). The completion notification carries just a
 * preview of the result and points at `get_subagent_result` for the rest, so that
 * pointer has to outlive the record: the final record is appended to the session
 * as one of these entries, and `get_subagent_result` falls back to it.
 *
 * Ported from upstream's `agent-record-entry.ts` (#429), minus the resume half —
 * this fork reopens agents through its own tombstones, and wiring the saved entry
 * into that is a separate change.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";

/** `customType` of the session entry a finished top-level agent appends. */
export const AGENT_RECORD_ENTRY_TYPE = "subagents:record";

/** The persisted snapshot of a finished agent. */
export interface AgentRecordEntryData {
  id: string;
  type: AgentRecord["type"];
  description: string;
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /**
   * The agent's persisted pi session, when it has one. Kept so a later
   * `@handle` or resume can find the conversation again; the retrieval fallback
   * below does not need it.
   */
  sessionFile?: string;
  /** Names to give back to the reopened agent, as the `@handle` path does. */
  handle?: string;
  alias?: string;
}

/**
 * Snapshot a finished record for {@link AGENT_RECORD_ENTRY_TYPE}.
 *
 * Only the fields the fallback reads or a caller may later want are kept: the
 * live record's activity counters and usage are per-activation state, and
 * copying them into the session would make an old run's spend look current.
 */
export function agentRecordEntryData(record: AgentRecord): AgentRecordEntryData {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    sessionFile: record.sessionFile,
    handle: record.handle,
    alias: record.alias,
  };
}

function isAgentRecordEntryData(data: unknown): data is AgentRecordEntryData {
  if (typeof data !== "object" || data === null) return false;
  const { id, type, status, startedAt } = data as Record<string, unknown>;
  return (
    typeof id === "string" &&
    typeof type === "string" &&
    typeof status === "string" &&
    typeof startedAt === "number"
  );
}

/**
 * The latest persisted record of `id` on the current branch. A resumed agent
 * appends a new entry on each finish, so the last one wins; an entry on an
 * abandoned branch is not this conversation's.
 *
 * `getBranch()` rather than `getEntries()`: after `/tree` navigation the last
 * entry is not the leaf, and an entry on a branch the user left is not this
 * conversation either.
 *
 * When `matchHandle` is set, the handle and alias match too, case-insensitively
 * like `@handle`, and only when no entry's id is `id`. Callers pass it when they
 * are answering a lookup rather than reopening: after a reload there is no
 * tombstone to turn a handle into an id, so the entry's own names have to match.
 */
export function findAgentRecordEntry(
  ctx: ExtensionContext,
  id: string,
  matchHandle = false,
): AgentRecordEntryData | undefined {
  const entries = ctx.sessionManager.getBranch();
  const wanted = id.toLowerCase();
  let named: AgentRecordEntryData | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== AGENT_RECORD_ENTRY_TYPE) continue;
    if (!isAgentRecordEntryData(entry.data)) continue;
    if (entry.data.id === id) return entry.data;
    if (
      matchHandle &&
      named === undefined &&
      (entry.data.handle?.toLowerCase() === wanted || entry.data.alias?.toLowerCase() === wanted)
    ) {
      named = entry.data;
    }
  }
  return named;
}
