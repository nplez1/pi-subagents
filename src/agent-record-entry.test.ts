/**
 * agent-record-entry.test.ts — the session entry a finished agent leaves behind.
 *
 * The live record is evicted ten minutes after an agent finishes and every record
 * is gone after a reload, while the completion notification's preview still
 * points at `get_subagent_result` for the full text. This entry is what that
 * pointer resolves to, so its two jobs are pinned here: the snapshot keeps the
 * fields a later lookup needs, and the finder answers by id first, by handle and
 * alias second, and only when the caller asked it to.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  AGENT_RECORD_ENTRY_TYPE,
  type AgentRecordEntryData,
  agentRecordEntryData,
  findAgentRecordEntry,
} from "./agent-record-entry.js";
import type { AgentRecord } from "./types.js";

function entry(data: Partial<AgentRecordEntryData>) {
  return {
    type: "custom",
    customType: AGENT_RECORD_ENTRY_TYPE,
    data: {
      id: "agent-1",
      type: "Explore",
      description: "look around",
      status: "completed",
      startedAt: 1_000,
      ...data,
    },
  };
}

function ctxWith(branch: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

describe("agentRecordEntryData", () => {
  it("keeps what a later lookup needs and drops per-activation stats", () => {
    const record = {
      id: "agent-1",
      type: "Explore",
      description: "look around",
      status: "completed",
      result: "done",
      startedAt: 1_000,
      completedAt: 2_000,
      sessionFile: "/tmp/s.jsonl",
      handle: "explore",
      alias: "auth-audit",
      toolUses: 7,
      turnCount: 3,
      lifetimeUsage: { input: 10, output: 20 },
    } as unknown as AgentRecord;

    expect(agentRecordEntryData(record)).toEqual({
      id: "agent-1",
      type: "Explore",
      description: "look around",
      status: "completed",
      result: "done",
      error: undefined,
      startedAt: 1_000,
      completedAt: 2_000,
      sessionFile: "/tmp/s.jsonl",
      handle: "explore",
      alias: "auth-audit",
    });
  });
});

describe("findAgentRecordEntry", () => {
  it("returns the last entry for an id, since a resumed agent appends again", () => {
    const branch = [entry({ result: "old" }), entry({ result: "new" })];
    expect(findAgentRecordEntry(ctxWith(branch), "agent-1")?.result).toBe("new");
  });

  it("ignores entries on other branches and other custom types", () => {
    const branch = [
      entry({ result: "mine" }),
      { type: "custom", customType: "something-else", data: { id: "agent-1" } },
      entry({ id: "agent-2", result: "theirs" }),
    ];
    expect(findAgentRecordEntry(ctxWith(branch), "agent-1")?.result).toBe("mine");
    expect(findAgentRecordEntry(ctxWith(branch), "agent-3")).toBeUndefined();
  });

  it("matches a handle or alias only when asked, case-insensitively", () => {
    const branch = [entry({ handle: "Explore", alias: "auth-Audit" })];

    // A lookup answers by name — after a reload there is no tombstone to turn a
    // handle back into an id.
    expect(findAgentRecordEntry(ctxWith(branch), "explore", true)?.id).toBe("agent-1");
    expect(findAgentRecordEntry(ctxWith(branch), "AUTH-AUDIT", true)?.id).toBe("agent-1");

    // A resume must not: it would reopen a saved session while the live record
    // for that handle still exists.
    expect(findAgentRecordEntry(ctxWith(branch), "explore", false)).toBeUndefined();
  });

  it("prefers an id match over a name match anywhere in the branch", () => {
    const branch = [
      entry({ id: "agent-1" }),
      entry({ id: "agent-2", handle: "agent-1" }),
    ];
    expect(findAgentRecordEntry(ctxWith(branch), "agent-1", true)?.id).toBe("agent-1");
  });

  it("ignores malformed entry data rather than answering with it", () => {
    const branch = [
      { type: "custom", customType: AGENT_RECORD_ENTRY_TYPE, data: { id: 42 } },
      entry({ result: "good" }),
    ];
    expect(findAgentRecordEntry(ctxWith(branch), "agent-1")?.result).toBe("good");
  });
});
