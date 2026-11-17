/**
 * task.ts — the background record one workflow run lives in.
 *
 * A `SubagentWorkflow` tool call returns a task id immediately and the run continues
 * without it, so the run's state cannot live in the tool call's closure: the
 * inline card, the completion notification and (later) the `/agents → Workflows` dialog
 * all read it after `execute` has returned. This is that record, shaped after
 * Claude Code's `local_workflow` task so the fields line up with what the
 * renderers already expect.
 *
 * The progress log is append-only in emission order but last-write-wins by
 * index (see `progress.ts`), so an agent's queued, started and settled rows are
 * one row that gets rewritten. That is exactly what {@link updateWorkflowProgressBatch}
 * does — writes in place — and the counters are moved by the difference rather
 * than recomputed, because a loop can keep a run going for weeks and both the
 * fourfold log growth and the per-batch full fold were costs that only show up
 * at that scale.
 */

import { randomUUID } from "node:crypto";
import { escapeXml } from "../xml.js";
import type { WorkflowJournalEntry } from "./journal.js";
import type { WorkflowMeta } from "./meta.js";
import {
  type ArchivedRounds,
  elapsedMs,
  roundOf,
  stats,
  type WorkflowEntry,
  type WorkflowRunStatus,
} from "./progress.js";
import type { WorkflowControl, WorkflowRunResult } from "./runtime.js";

/** `wf_` + hex, matching Claude Code's `^wf_[a-z0-9-]{6,}$` run ids. */
export function workflowRunId(): string {
  return `wf_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export interface WorkflowTask {
  /** Discriminator, alongside Claude Code's `local_agent` / `local_bash`. */
  type: "local_workflow";
  id: string;
  status: WorkflowRunStatus;
  script: string;
  /** Where the script can be edited and re-run from. */
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  workflowName?: string;
  /** The `tool_use_id` of the call that started this, when one did. */
  toolCallId?: string;

  /**
   * Pause, skip and retry, once the run is up.
   *
   * Absent before the runtime hands it over and after the run settles — the
   * dialog treats "no control" as "those keys do nothing", which is the same
   * thing it does for a run that has finished.
   */
  control?: WorkflowControl;
  /** When the current pause started, so `totalPausedMs` can be closed out. */
  pausedAt?: number;

  /** Where this run records its own settled calls, for a later resume. */
  journalPath?: string;
  /** A previous run's journal, when this call asked to resume one. */
  replay?: readonly WorkflowJournalEntry[];
  /** The run id this one resumed, for the result line that says so. */
  resumedFrom?: string;
  /** How many agents came back from {@link replay} instead of being spawned. */
  replayedCount: number;

  /** The append-only event log, in emission order. */
  workflowProgress: WorkflowEntry[];
  /** Bumped once per applied batch, so a renderer can tell nothing changed. */
  progressVersion: number;
  /**
   * Agent index → its slot in {@link workflowProgress}.
   *
   * What makes a re-emit a rewrite instead of an append. See the module note.
   */
  agentSlots: Map<number, number>;
  /** The round in flight. Anything below it is history and never changes again. */
  liveRound: number;
  /** Log lines currently in the log, so a chatty run is bounded too. */
  logLines: number;
  /**
   * Rounds whose rows have been pruned — the fold every surface draws.
   *
   * A weeks-long loop has no bound on rounds, so per-agent rows are held for the
   * newest {@link WORKFLOW_ROW_RETENTION} and everything older collapses to
   * counts here. Without it the log is the largest thing in the session and it
   * grows forever.
   */
  archived: ArchivedRounds;
  agentCount: number;
  /**
   * Agents that have settled successfully, recomputed with the other counters.
   *
   * Cached rather than derived on read because the fleet list asks five times a
   * second: deriving it there would walk the whole append-only log on every
   * tick, which for a thousand-agent run is real work in the render loop.
   */
  doneCount: number;
  /**
   * Agents that have produced an outcome, success or failure.
   *
   * Distinct from {@link doneCount} on purpose: `doneCount` is successes only,
   * and a row that shows it as the numerator reports `2/3` under a ✘ — which
   * reads as an agent that never ran, not one that ran and failed.
   */
  settledCount: number;
  failedCount: number;
  totalTokens: number;
  totalToolCalls: number;

  abortController: AbortController;
  startTime: number;
  endTime?: number;
  /** Excluded from the elapsed clock the header shows. */
  totalPausedMs: number;

  /** The script's return value, once the run produced one. */
  value?: unknown;
  error?: string;
}

export function createWorkflowTask(init: {
  id: string;
  script: string;
  scriptPath?: string;
  args?: unknown;
  meta?: WorkflowMeta;
  toolCallId?: string;
  startTime?: number;
  journalPath?: string;
  replay?: readonly WorkflowJournalEntry[];
  resumedFrom?: string;
}): WorkflowTask {
  return {
    type: "local_workflow",
    id: init.id,
    status: "running",
    script: init.script,
    scriptPath: init.scriptPath,
    args: init.args,
    meta: init.meta,
    workflowName: init.meta?.name,
    toolCallId: init.toolCallId,
    journalPath: init.journalPath,
    replay: init.replay,
    resumedFrom: init.resumedFrom,
    replayedCount: 0,
    workflowProgress: [],
    progressVersion: 0,
    agentSlots: new Map(),
    liveRound: 1,
    logLines: 0,
    archived: { rounds: 0, through: 0, agents: 0, settled: 0, failed: 0, tokens: 0, durationMs: 0 },
    agentCount: 0,
    doneCount: 0,
    settledCount: 0,
    failedCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    startTime: init.startTime ?? Date.now(),
    totalPausedMs: 0,
  };
}

/**
 * Apply one batch of progress entries.
 *
 * Batched rather than per-entry because that is how the worker emits them. Two
 * costs used to be paid per batch and both grow with the run: the log kept every
 * write (four rows per agent), and the whole thing was folded to recompute the
 * counters. A loop left going for weeks makes both unbounded, so this writes
 * each agent's row in place and moves the counters by the difference — O(1) per
 * entry, O(agents) memory, no full fold.
 */
export function updateWorkflowProgressBatch(
  task: WorkflowTask,
  entries: readonly WorkflowEntry[],
): void {
  if (entries.length === 0) return;

  for (const entry of entries) {
    if (entry.type !== "workflow_agent") {
      // Phases are emitted once per title per scope, so a phase entry is always
      // new; a log line is new by definition. Both are pruned by age in
      // `pruneOverflow`, since neither is rewritten in place.
      task.workflowProgress.push(entry);
      if (entry.type === "workflow_log") {
        task.logLines++;
        if (task.logLines > WORKFLOW_LOG_RETENTION + WORKFLOW_OVERFLOW_SLACK) pruneOverflow(task);
      }
      continue;
    }

    const round = roundOf(entry);
    const slot = task.agentSlots.get(entry.index);
    if (slot === undefined) {
      task.agentSlots.set(entry.index, task.workflowProgress.length);
      task.workflowProgress.push(entry);
      // `agentCount` is what the runtime has scheduled, which can lead what the
      // log has seen — never let it walk backwards. Keyed off the index, not off
      // `agentSlots.size`: pruning old rounds removes rows, and a size would then
      // report the rows still held as the number of agents that ever ran.
      task.agentCount = Math.max(task.agentCount, entry.index + 1);
      if (task.agentSlots.size > WORKFLOW_ROW_RETENTION + WORKFLOW_OVERFLOW_SLACK) pruneOverflow(task);
    } else {
      // Rolled back before the replacement is counted, so a re-emit moves a row
      // between states instead of adding to the totals.
      const previous = task.workflowProgress[slot];
      if (previous.type === "workflow_agent") {
        task.totalTokens -= previous.tokens ?? 0;
        task.totalToolCalls -= previous.toolCalls ?? 0;
        if (previous.state === "done") {
          task.doneCount--;
          task.settledCount--;
        } else if (previous.state === "error") {
          task.failedCount--;
          task.settledCount--;
        }
      }
      task.workflowProgress[slot] = entry;
    }

    task.totalTokens += entry.tokens ?? 0;
    task.totalToolCalls += entry.toolCalls ?? 0;
    if (entry.state === "done") {
      task.doneCount++;
      task.settledCount++;
    } else if (entry.state === "error") {
      task.failedCount++;
      task.settledCount++;
    }

    // A straggler from an earlier round — a long-running agent that settles
    // after the loop moved on — is stripped as it lands, because its round's
    // one-shot pass has already been and gone.
    if (round < task.liveRound && (entry.state === "done" || entry.state === "error")) slimEntry(entry);

    if (round > task.liveRound) {
      task.liveRound = round;
      retireRounds(task);
    }
  }

  task.progressVersion++;
}

/**
 * Agent rows kept in memory before the oldest rounds are pruned to counts.
 *
 * Sized for inspection rather than for the run: the round in flight is what
 * anyone reads, and the few hundred behind it are there so stepping back in the
 * inspector works. A settled row is ~120 bytes, so the log stays a couple of
 * megabytes however long the loop runs.
 */
export const WORKFLOW_ROW_RETENTION = 10_000;

/**
 * Drop what only ever mattered while a row was worth reading in full.
 *
 * The prompt and result previews are most of a settled row's bytes, so a run
 * that goes for weeks turns the log into the largest thing in the session for
 * text nobody scrolls back to. Everything that makes the row inspectable stays:
 * index, label, state, tokens, duration, and the `recordId` an inspector's `c`
 * opens a conversation with.
 */
function slimEntry(entry: WorkflowEntry): void {
  if (entry.type !== "workflow_agent") return;
  delete entry.promptPreview;
  delete entry.resultPreview;
}

/**
 * Fold finished rounds away as the loop moves on.
 *
 * Runs once per round boundary rather than per batch, and walks only the rows
 * still held, so its cost is bounded by {@link WORKFLOW_ROW_RETENTION} no matter
 * how long the run is:
 *
 * 1. strip the previews of every settled row in a finished round;
 * 2. while the held rows are over the bound, freeze the oldest round into
 *    {@link WorkflowTask.archived} and drop its rows.
 *
 * A round still holding a running agent is skipped, never pruned: dropping it
 * would hide live work to save memory, which is the wrong trade.
 */
function retireRounds(task: WorkflowTask): void {
  const byRound = new Map<number, number[]>();
  const entries = task.workflowProgress;
  for (let slot = 0; slot < entries.length; slot++) {
    const entry = entries[slot];
    if (entry.type !== "workflow_agent") continue;
    const round = roundOf(entry);
    if (round >= task.liveRound) continue;
    if (entry.state === "done" || entry.state === "error") slimEntry(entry);
    const slots = byRound.get(round);
    if (slots) slots.push(slot);
    else byRound.set(round, [slot]);
  }
  if (byRound.size === 0) return;

  let retained = task.agentSlots.size;
  if (retained <= WORKFLOW_ROW_RETENTION) return;

  const drop = new Set<number>();
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    if (retained <= WORKFLOW_ROW_RETENTION) break;
    const slots = byRound.get(round) as number[];
    const hasLive = slots.some(slot => {
      const entry = entries[slot];
      return entry.type === "workflow_agent" && (entry.state === "start" || entry.state === "progress");
    });
    if (hasLive) continue;

    // Frozen before the rows go: this is all the card and the inspector will
    // have to say about the round from here on.
    let agents = 0;
    let settled = 0;
    let failed = 0;
    let tokens = 0;
    let firstAt = Number.POSITIVE_INFINITY;
    let lastAt = 0;
    for (const slot of slots) {
      const entry = entries[slot];
      if (entry.type !== "workflow_agent") continue;
      agents++;
      if (entry.state === "done") settled++;
      else if (entry.state === "error") {
        settled++;
        failed++;
      }
      tokens += entry.tokens ?? 0;
      if (entry.startedAt !== undefined) {
        if (entry.startedAt < firstAt) firstAt = entry.startedAt;
        const end = entry.startedAt + (entry.durationMs ?? 0);
        if (end > lastAt) lastAt = end;
      }
    }

    task.archived.rounds++;
    task.archived.through = Math.max(task.archived.through, round);
    task.archived.agents += agents;
    task.archived.settled += settled;
    task.archived.failed += failed;
    task.archived.tokens += tokens;
    task.archived.durationMs += firstAt < Number.POSITIVE_INFINITY ? Math.max(0, lastAt - firstAt) : 0;

    for (const slot of slots) drop.add(slot);
    retained -= slots.length;
  }
  if (drop.size > 0) compactProgress(task, drop);
}

/**
 * Keep at most this many log lines. The card draws the last few; the rest are
 * kept for the same reason the rows are — so a recent scroll-back still reads.
 */
const WORKFLOW_LOG_RETENTION = 200;

/**
 * Inserts allowed past the row bound before the overflow walk runs, so the walk
 * is amortised rather than per batch. Exported because it is part of the bound
 * callers can rely on, not an implementation detail of when the walk happens.
 */
export const WORKFLOW_OVERFLOW_SLACK = 512;

/**
 * Drop the oldest detail when the bound is exceeded with nothing to retire.
 *
 * `retireRounds` needs a round boundary, and a loop can have none to give it:
 * `while (…) { await agent(…) }` never calls `phase()`, so it stays in round one
 * forever and would otherwise keep every row for the rest of the run. Here the
 * oldest settled rows and the oldest log lines go instead. The counters are
 * untouched — they are maintained per entry, not derived from the rows — so the
 * header, the fleet row and the round's own summary stay exact; only the detail
 * list is bounded.
 */
function pruneOverflow(task: WorkflowTask): void {
  const overflow = task.agentSlots.size - WORKFLOW_ROW_RETENTION;
  const excessLogs = Math.max(0, task.logLines - WORKFLOW_LOG_RETENTION);
  if (overflow <= 0 && excessLogs === 0) return;

  const drop = new Set<number>();
  let dropped = 0;
  let logBudget = excessLogs;
  const entries = task.workflowProgress;

  for (let slot = 0; slot < entries.length; slot++) {
    const entry = entries[slot];
    if (entry.type === "workflow_log") {
      // Oldest first: the tail is what the card draws.
      if (logBudget > 0) {
        drop.add(slot);
        logBudget--;
      }
      continue;
    }
    if (entry.type !== "workflow_agent") continue;
    if (dropped >= overflow) continue;
    // Live work is never dropped to save memory.
    if (entry.state === "start" || entry.state === "progress") continue;
    drop.add(slot);
    dropped++;
  }
  if (drop.size > 0) compactProgress(task, drop);
}

/**
 * Rebuild the log without the pruned slots.
 *
 * A rebuild rather than in-place splice because every surviving slot index
 * shifts, and the map that turns an agent index into one has to follow. It runs
 * once per {@link WORKFLOW_ROW_RETENTION} agents, not per batch.
 */
function compactProgress(task: WorkflowTask, drop: Set<number>): void {
  const kept = task.workflowProgress.filter((_entry, slot) => !drop.has(slot));
  task.workflowProgress = kept;
  task.agentSlots = new Map();
  task.logLines = 0;
  for (let slot = 0; slot < kept.length; slot++) {
    const entry = kept[slot];
    if (entry.type === "workflow_agent") task.agentSlots.set(entry.index, slot);
    else if (entry.type === "workflow_log") task.logLines++;
  }
}

/**
 * Hold the run, and stop its clock.
 *
 * The elapsed figure every surface shows subtracts `totalPausedMs`, so a run
 * left paused overnight does not come back reading as a twelve-hour run.
 */
export function pauseWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "running" || task.control === undefined) return false;
  task.control.pause();
  task.status = "paused";
  task.pausedAt = now;
  return true;
}

/** Let it go again, banking however long it was held. */
export function resumeWorkflowTask(task: WorkflowTask, now = Date.now()): boolean {
  if (task.status !== "paused" || task.control === undefined) return false;
  task.control.resume();
  task.status = "running";
  task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, now - (task.pausedAt ?? now));
  task.pausedAt = undefined;
  return true;
}

/** Settle a task from the run's own result. */
export function completeWorkflowTask(task: WorkflowTask, result: WorkflowRunResult): void {
  // Banked before the status moves off "paused": a run that finished while held
  // still spent that time held, and the elapsed figure has to say so.
  if (task.pausedAt !== undefined) {
    task.totalPausedMs = (task.totalPausedMs ?? 0) + Math.max(0, Date.now() - task.pausedAt);
    task.pausedAt = undefined;
  }
  // Nothing left to control, and holding the handle would let the dialog offer
  // pause on a run that has already stopped.
  task.control = undefined;
  task.status = result.status;
  task.meta ??= result.meta;
  task.workflowName ??= result.meta.name;
  task.agentCount = Math.max(task.agentCount, result.agentCount);
  task.replayedCount = result.replayedCount;
  task.value = result.value;
  task.error = result.error;
  task.endTime = Date.now();
}

/**
 * Settle a task that never produced a result — a script rejected before the
 * worker started (bad `meta`, oversized source, non-JSON `args`).
 */
export function failWorkflowTask(task: WorkflowTask, error: string): void {
  task.control = undefined;
  task.pausedAt = undefined;
  task.status = "failed";
  task.error = error;
  task.endTime = Date.now();
}

/**
 * The bus payload that names a workflow run when it starts.
 *
 * A run goes out on the same `subagents:started` channel an agent uses, so every
 * host that tracks running work (keep-alive, pi-codex-goal's background-work
 * tracker, Orca's status pane) sees the run as live, not just its agents. `mode`
 * and `runId` are the fields Orca reads to tell a workflow from an agent. The
 * run's own agents stay private to it and emit nothing.
 */
export function workflowStartedEvent(task: WorkflowTask): Record<string, unknown> {
  return {
    id: task.id,
    runId: task.id,
    type: "workflow",
    mode: "workflow",
    description: task.workflowName ?? task.meta?.name ?? task.id,
  };
}

/**
 * The bus event that settles a workflow run, or undefined while it is still live.
 *
 * `paused` is not settled: a held run is still going to resume, so hosts keep
 * treating it as running. A killed run settles as `subagents:failed`, the same
 * way a stopped agent does.
 */
export function workflowSettledEvent(
  task: WorkflowTask,
  now = Date.now(),
): { channel: "subagents:completed" | "subagents:failed"; data: Record<string, unknown> } | undefined {
  if (task.status === "running" || task.status === "paused") return undefined;
  return {
    channel: task.status === "completed" ? "subagents:completed" : "subagents:failed",
    data: {
      ...workflowStartedEvent(task),
      status: task.status,
      durationMs: elapsedMs(task, now),
      tokens: task.totalTokens,
      toolUses: task.totalToolCalls,
      ...(task.error !== undefined ? { error: task.error } : {}),
    },
  };
}

/** The run's outcome as text, for the notification and the LLM-facing result. */
export function workflowResultText(task: WorkflowTask): string {
  if (task.error !== undefined) return task.error;
  if (task.value === undefined) return "No output.";
  if (typeof task.value === "string") return task.value;
  return JSON.stringify(task.value, null, 2);
}

/**
 * Resolve a `resumeFromRunId` against the runs this session has seen.
 *
 * Same-session only, and deliberately so: the journal lives beside the
 * session's task files, and a run id from another session would silently find
 * nothing to replay — reporting that as "resumed" would be a lie the caller
 * could not see through. An unknown id is an error rather than a cold start,
 * because a caller that asked to resume is expecting not to pay.
 */
export function resolveResumeTarget(
  runId: string | undefined,
  tasks: ReadonlyMap<string, WorkflowTask>,
):
  | undefined
  | { ok: true; runId: string; journalPath: string; scriptPath: string }
  | { ok: false; message: string } {
  const id = runId?.trim();
  if (id === undefined || id === "") return undefined;

  const prior = tasks.get(id);
  if (prior === undefined) {
    const known = [...tasks.keys()];
    return {
      ok: false,
      message:
        `No workflow run "${id}" in this session. ` +
        (known.length > 0
          ? `Runs this session: ${known.join(", ")}.`
          : "Nothing has run yet — call this without `resumeFromRunId`."),
    };
  }
  if (prior.status === "running") {
    return {
      ok: false,
      message: `Workflow "${id}" is still running. Stop it from /agents → Workflows before resuming it.`,
    };
  }
  if (prior.journalPath === undefined) {
    return { ok: false, message: `Workflow "${id}" has no journal to resume from.` };
  }
  return {
    ok: true,
    runId: id,
    journalPath: prior.journalPath,
    // The persisted copy, which is what `scriptPath` holds when the call had
    // no file of its own.
    scriptPath: prior.scriptPath ?? "",
  };
}

/** `<task-notification>`, in the same shape a finished background agent sends. */
export function formatWorkflowNotification(task: WorkflowTask, now = Date.now()): string {
  const totals = stats(task.workflowProgress, task.agentCount);
  const status =
    task.status === "completed" ? "Done"
    : task.status === "killed" ? "Stopped"
    : `Error: ${task.error ?? "unknown"}`;
  const result = workflowResultText(task);
  return [
    `<task-notification>`,
    `<task-id>${task.id}</task-id>`,
    task.toolCallId ? `<tool-use-id>${escapeXml(task.toolCallId)}</tool-use-id>` : null,
    task.scriptPath ? `<script>${escapeXml(task.scriptPath)}</script>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Workflow "${escapeXml(task.workflowName ?? task.id)}" ${task.status} — ${totals.done + totals.failedCount}/${totals.total} agents${
      totals.failedCount > 0 ? ` (${totals.failedCount} failed)` : ""
    }${
      task.replayedCount > 0 ? `, ${task.replayedCount} replayed from ${escapeXml(task.resumedFrom ?? "an earlier run")}` : ""
    }</summary>`,
    `<result>${escapeXml(result.length > 4000 ? `${result.slice(0, 4000)}\n...(truncated)` : result)}</result>`,
    `<usage><total_tokens>${task.totalTokens}</total_tokens><tool_uses>${task.totalToolCalls}</tool_uses><duration_ms>${elapsedMs(task, now)}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join("\n");
}
