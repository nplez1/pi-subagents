/**
 * progress.ts — the workflow progress model, ported from Claude Code.
 *
 * Progress is an **append-only event log**, not a tree. Agent entries are keyed
 * by `index` and last-write-wins, so a running agent is updated by appending a
 * fresh entry with the same index rather than mutating anything. Every view —
 * the inline card, the workflows dialog, the fleet widget — derives its shape
 * by collapsing that log. Keeping the log authoritative is what lets a batched
 * update carry several agents' changes in one message from the worker.
 *
 * Two vocabularies, deliberately distinct:
 *   - entry `state` is only start | progress | done | error, with `skipped`,
 *     `blocked` and `cached` as separate booleans;
 *   - the display state adds queued, running, interrupted, skipped, blocked and
 *     failed, and is *derived* (see `displayState`).
 * Mixing them up is the easiest way to get the rendering wrong, which is why
 * the derivation lives here as one function rather than inline in each renderer.
 *
 * Everything in this file is pure and framework-free so the whole model is
 * unit-testable without a terminal.
 */

import { formatSpan } from "../duration.js";
import type { WorkflowMeta, WorkflowPhaseMeta } from "./meta.js";

/** Raw entry lifecycle, as written by the runtime. */
export type WorkflowEntryState = "start" | "progress" | "done" | "error";

/** Derived per-agent state, as rendered. */
export type WorkflowDisplayState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "blocked"
  | "interrupted";

/** Why an agent is on a later attempt, shown next to its row. */
export type AttemptReason = "throttled" | "user-retry" | "stalled";

export interface WorkflowPhaseEntry {
  type: "workflow_phase";
  index: number;
  title: string;
  /**
   * The phase this one renders under, when a nested `workflow()` emitted it.
   *
   * Absent for the parent script's own phases. A nested run's *root* entry
   * (`▸ name`) points at the parent phase that awaited it, and the child's own
   * phases point at that root — so a whole run hangs off one row rather than
   * floating beside the parent's phases.
   */
  parentIndex?: number;
}

export interface WorkflowLogEntry {
  type: "workflow_log";
  message: string;
}

export interface WorkflowAgentEntry {
  type: "workflow_agent";
  /** Stable identity. Re-emitting this index replaces the previous entry. */
  index: number;
  label: string;
  /**
   * Absent when the agent ran before any `phase()` call. That is the signal —
   * not a default of 0 — that turns the whole run into one "Agents" group.
   */
  phaseIndex?: number;
  phaseTitle?: string;
  /**
   * Which loop pass spawned it, 1-based.
   *
   * The worker infers this from the script's own `phase()` sequence — a revisit
   * of a phase it already passed means the loop went round again — so a run of
   * `while (…) { phase('Wait'); …; phase('Report') }` reports round 7 instead of
   * a single agent total that climbs until the cap. Absent on entries written
   * before rounds existed, which is one round — hence {@link roundOf}.
   */
  roundIndex?: number;
  state: WorkflowEntryState;
  agentId?: string;
  /**
   * The manager's `AgentRecord` id, once the child has one.
   *
   * Distinct from {@link agentId}, which is the run's own `wf-agent-N` handle
   * and means nothing outside the runtime. This is what the inspector's `c`
   * key opens a conversation viewer on, so it is reported the moment the
   * manager issues it rather than with the effective model — a child that dies
   * before its session resolves still has a conversation worth reading.
   */
  recordId?: string;
  agentType?: string;
  /**
   * Short model label for tight rows, e.g. `haiku 4.5`.
   *
   * Seeded from what the script asked for and then REPLACED by what the child
   * actually ran on, once its session exists to report one — the same
   * effective-not-requested rule every other subagent surface follows (#168).
   * An `agent()` that named no model therefore starts blank and fills in.
   */
  model?: string;
  /** Canonical `provider/model-id`, for the dialog, which has room for it. */
  modelId?: string;
  /** The level actually in effect, once the child's session reports one. */
  thinking?: string;
  /**
   * What the call asked for, kept only when it did not get it — pi clamped the
   * level, or an agent file's frontmatter outranked the option (#182). Rendered
   * as `(asked max)` beside the effective value rather than silently replacing
   * it.
   */
  requestedThinking?: string;
  requestedModel?: string;
  fallbackModel?: string;
  isolation?: "worktree";
  error?: string;
  skipped?: boolean;
  blocked?: boolean;
  cached?: boolean;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  lastAttemptReason?: AttemptReason;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

export type WorkflowEntry = WorkflowPhaseEntry | WorkflowLogEntry | WorkflowAgentEntry;

/** Overall run status, mirroring the task record. */
export type WorkflowRunStatus = "running" | "completed" | "failed" | "killed" | "paused";

export interface CollapsedProgress {
  agents: WorkflowAgentEntry[];
  logs: string[];
  phaseTitles: Map<number, string>;
  /**
   * Phase index → the phase it should render under.
   *
   * A nested `workflow()` runs in the same worker, so its phases arrive in the
   * parent's log; this is what says they belong under the phase that awaited
   * the run rather than beside it. See `makeScope` in `worker-source.ts`.
   */
  phaseParents: Map<number, number>;
}

/** Row status of one phase in the tree. */
export type PhaseNodeStatus = "queued" | "running" | "done" | "failed";

/**
 * One row of the phase tree: a phase, or a phase of a nested run.
 *
 * Two things this carries that `PhaseGroup` could not: `depth` (a nested run's
 * phases sit under the phase that awaited them, not beside it) and `settled`
 * (a failed agent finished — it just finished badly, and a count that leaves it
 * out reads as an agent that never ran).
 */
export interface PhaseNode {
  /** Index of the phase entry that named it. Identity for the row. */
  index: number;
  /** Its own title, with a nested run's `▸ name › ` prefix stripped. */
  title: string;
  /** What the row prints: `Run ▸ ps-drive-tc` when the phase delegated. */
  label: string;
  /** 0 at the top level, 1 inside a nested run. */
  depth: number;
  /** Agents this phase launched itself. A nested run's are in its own nodes. */
  agents: WorkflowAgentEntry[];
  children: PhaseNode[];
  done: number;
  failed: number;
  /** Still expected to report: `running` plus `queued`. */
  live: number;
  /** Waiting for a slot — scheduled, not started. */
  queued: number;
  /** Done plus failed — everything that has produced an outcome. */
  settled: number;
  /** Rolled up through `children`. */
  total: number;
  tokens: number;
  durationMs: number;
  /** Earliest activity in the subtree, for reading order. `Infinity` if none. */
  order: number;
  status: PhaseNodeStatus;
}

/** Rolled-up counts for the whole run. */
export interface PhaseTotals {
  settled: number;
  failed: number;
  live: number;
  total: number;
  tokens: number;
}

export interface PhaseTree {
  /** Top-level phases, in the order their work started. */
  nodes: PhaseNode[];
  /**
   * Declared `meta.phases` that have produced nothing yet, in declared order.
   *
   * Not rows — a phase with no agents is a plan, not work — so this exists only
   * to be counted: `… · 3 phases to go`.
   */
  remaining: string[];
  totals: PhaseTotals;
}

export interface WorkflowStats {
  done: number;
  failedCount: number;
  running: boolean;
  total: number;
  started: number;
  complete: boolean;
}

/**
 * Fold the event log into its latest state.
 *
 * Agent entries collapse by index (last write wins); logs accumulate in order;
 * phase titles and their parents are lookups for grouping.
 */
export function collapse(progress: readonly WorkflowEntry[]): CollapsedProgress {
  const agents = new Map<number, WorkflowAgentEntry>();
  const logs: string[] = [];
  const phaseTitles = new Map<number, string>();
  const phaseParents = new Map<number, number>();

  for (const entry of progress) {
    if (entry.type === "workflow_agent") agents.set(entry.index, entry);
    else if (entry.type === "workflow_log") logs.push(entry.message);
    else {
      phaseTitles.set(entry.index, entry.title);
      if (entry.parentIndex !== undefined) phaseParents.set(entry.index, entry.parentIndex);
    }
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    logs,
    phaseTitles,
    phaseParents,
  };
}

/* ------------------------------------------------------------------------- *
 * Rounds
 * ------------------------------------------------------------------------- */

/** The round every agent belongs to before a loop has gone round again. */
export const FIRST_ROUND = 1;

/**
 * The round an agent belongs to.
 *
 * `?? FIRST_ROUND` rather than a migration: an entry logged before rounds
 * existed, or restored from a session entry an older build wrote, belongs to
 * the run's one and only round.
 */
export function roundOf(entry: WorkflowAgentEntry): number {
  return entry.roundIndex ?? FIRST_ROUND;
}

/**
 * One loop pass, rolled up — everything needed to fold it away.
 *
 * A looping run is unbounded, so no surface can keep drawing a row per agent:
 * the round is the unit that both settles (so it can be collapsed) and carries
 * the numbers worth reading (what this pass cost, whether it finished).
 */
export interface RoundSummary {
  /** 1-based, as the worker counted it. */
  index: number;
  /** Agents this round launched. */
  agents: number;
  /** Done plus failed — everything that produced an outcome. */
  settled: number;
  failed: number;
  /** Still expected to report: running plus queued. */
  live: number;
  queued: number;
  tokens: number;
  /** Wall-clock across the round's activity, not the sum of its agents. */
  durationMs: number;
  /** Earliest start and latest activity. Absent when nothing ran. */
  firstAt?: number;
  lastAt?: number;
  status: PhaseNodeStatus;
}

/**
 * Rounds whose agent rows have been pruned from memory.
 *
 * A loop left running for weeks makes the progress log the largest thing in the
 * session and there is no bound on how many rounds it will produce, so the task
 * keeps full rows for the newest rounds and collapses everything older into
 * this: counts, not rows. Nothing is lost that the card or the inspector draws —
 * an old round is a line either way — and the footprint stops growing with the
 * run.
 */
export interface ArchivedRounds {
  /** How many rounds were pruned. */
  rounds: number;
  /** Highest pruned round index, so a fold can read `rounds 1–40`. */
  through: number;
  agents: number;
  settled: number;
  failed: number;
  tokens: number;
  /** Summed across the pruned rounds, which ran one after another. */
  durationMs: number;
}

/** Everything folded away above the live round, whether pruned or merely old. */
export interface EarlierRounds {
  /** First and last round in the fold. */
  from: number;
  to: number;
  /** Total rounds in the fold, which is `to - from + 1` once nothing is missing. */
  rounds: number;
  agents: number;
  settled: number;
  failed: number;
  tokens: number;
  durationMs: number;
}

/**
 * The single line that stands in for every round before the one in flight.
 *
 * Shared so the card and the inspector fold identically — the same numbers in
 * the same order, whether the history is rows still held or rows already pruned.
 * `undefined` until a run has looped: a single-round run has nothing behind it.
 */
export function earlierRounds(
  summaries: readonly RoundSummary[],
  archived?: ArchivedRounds,
  /**
   * Fold only the rounds before this one.
   *
   * Defaults to the live round, which is what the card wants. The inspector
   * passes the round it is drawing, so a past round's fold does not claim the
   * round right below it.
   */
  before?: number,
): EarlierRounds | undefined {
  const cutoff = before ?? summaries[summaries.length - 1]?.index;
  const older = summaries.filter(round => cutoff === undefined || round.index < cutoff);
  if (archived === undefined && older.length === 0) return undefined;

  const totals = older.reduce(
    (acc, round) => ({
      agents: acc.agents + round.agents,
      settled: acc.settled + round.settled,
      failed: acc.failed + round.failed,
      tokens: acc.tokens + round.tokens,
      durationMs: acc.durationMs + round.durationMs,
    }),
    { agents: 0, settled: 0, failed: 0, tokens: 0, durationMs: 0 },
  );

  const agents = totals.agents + (archived?.agents ?? 0);
  const rounds = older.length + (archived?.rounds ?? 0);
  if (rounds === 0 || older.length === 0 && archived === undefined) return undefined;

  // Pruned rounds are always the oldest, so the fold starts at 1 unless nothing
  // was pruned — in which case it starts at the first round still held.
  const first = older.at(0)?.index;
  const last = older.at(-1)?.index;
  const from = archived !== undefined ? 1 : (first ?? 1);
  const to = last ?? archived?.through ?? from;

  return {
    from,
    to,
    rounds,
    agents,
    settled: totals.settled + (archived?.settled ?? 0),
    failed: totals.failed + (archived?.failed ?? 0),
    tokens: totals.tokens + (archived?.tokens ?? 0),
    durationMs: totals.durationMs + (archived?.durationMs ?? 0),
  };
}

/**
 * Cache of the derived views, keyed on the progress array and a version counter.
 *
 * Every surface used to re-walk the whole log per render: the inspector at the
 * 80 ms spinner cadence, the card on every transcript render. That was fine
 * while a run was a handful of agents; a loop left going for weeks makes the
 * log the largest thing in the session, and a walk per frame becomes a
 * permanent tax — thousands of agents is tens of thousands of entry visits,
 * twelve times a second, indefinitely. Keying on the caller's `progressVersion`
 * (bumped once per batch) turns that into one walk per batch.
 *
 * `version` is optional and nothing is cached without it, so the pure functions
 * stay pure for tests and one-shot callers.
 */
interface DerivedView {
  version: number;
  rounds?: RoundSummary[];
  trees: Map<string, PhaseTree>;
}

const derivedViews = new WeakMap<readonly WorkflowEntry[], DerivedView>();

function derivedView(progress: readonly WorkflowEntry[], version: number | undefined): DerivedView | undefined {
  if (version === undefined) return undefined;
  const existing = derivedViews.get(progress);
  if (existing !== undefined && existing.version === version) return existing;
  const fresh: DerivedView = { version, trees: new Map() };
  derivedViews.set(progress, fresh);
  return fresh;
}

/**
 * Fold the log into one summary per round, oldest first.
 *
 * This is what replaces the climbing total: the round in flight is drawn in
 * full and every round behind it collapses to a single line, so `3/7 agents`
 * keeps its meaning instead of becoming `47/∞`.
 */
export function roundSummaries(progress: readonly WorkflowEntry[], version?: number): RoundSummary[] {
  const view = derivedView(progress, version);
  if (view?.rounds !== undefined) return view.rounds;

  const byRound = new Map<number, WorkflowAgentEntry[]>();
  for (const agent of collapse(progress).agents) {
    const index = roundOf(agent);
    const bucket = byRound.get(index);
    if (bucket) bucket.push(agent);
    else byRound.set(index, [agent]);
  }

  const rounds = [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]): RoundSummary => {
      const counts = rollUp(list);
      return {
        index,
        agents: list.length,
        settled: counts.done + counts.failed,
        failed: counts.failed,
        live: counts.live,
        queued: counts.queued,
        tokens: counts.tokens,
        durationMs: counts.durationMs,
        ...(counts.firstAt !== undefined ? { firstAt: counts.firstAt } : {}),
        ...(counts.lastAt !== undefined ? { lastAt: counts.lastAt } : {}),
        status: statusOf({ live: counts.live, queued: counts.queued, failed: counts.failed, total: list.length }),
      };
    });

  if (view) view.rounds = rounds;
  return rounds;
}

/**
 * Derive what to render for one agent.
 *
 * `workflowActive` is false once the run has stopped: anything still mid-flight
 * at that point was cut off rather than finished, hence "interrupted".
 */
export function displayState(entry: WorkflowAgentEntry, workflowActive: boolean): WorkflowDisplayState {
  if (entry.state === "done") return "done";
  if (entry.state === "error") {
    if (entry.skipped) return "skipped";
    if (entry.blocked) return "blocked";
    return "failed";
  }
  if (!workflowActive) return "interrupted";
  // Queued means accepted but never given a slot. An entry with no queuedAt at
  // all predates the semaphore and is treated as running.
  return entry.queuedAt != null && entry.startedAt == null ? "queued" : "running";
}

/** True while an entry is still expected to change. */
export function isLive(entry: WorkflowAgentEntry): boolean {
  return entry.state === "start" || entry.state === "progress";
}

/** The `▸ ` a nested run prefixes onto every phase title it defines. */
const NESTED_MARK = "\u25b8 ";
/** Separates a nested run's name from the child phase's own title. */
const NESTED_SEP = " \u203a ";

/**
 * Read a phase title the way `scopedTitle` wrote it.
 *
 * `▸ ps-drive-tc` is the nested run itself; `▸ ps-drive-tc › Triage` is one of
 * its phases. The parent script's own phases carry no mark at all.
 */
function parsePhaseTitle(title: string): { run?: string; own: string } {
  if (!title.startsWith(NESTED_MARK)) return { own: title };
  const rest = title.slice(NESTED_MARK.length);
  const sep = rest.indexOf(NESTED_SEP);
  if (sep < 0) return { run: rest, own: rest };
  return { run: rest.slice(0, sep), own: rest.slice(sep + NESTED_SEP.length) };
}

/** Earliest activity among agents: when a row first had something to show. */
function firstActivity(agents: readonly WorkflowAgentEntry[]): number {
  let first = Number.POSITIVE_INFINITY;
  for (const agent of agents) {
    // `queuedAt` counts: a phase whose agents are all waiting has been
    // scheduled, and that is later than the row above it but earlier than
    // nothing at all.
    const at = agent.startedAt ?? agent.queuedAt;
    if (at !== undefined && at < first) first = at;
  }
  return first;
}

/** Roll one phase's own agents up into the counts its row shows. */
function rollUp(agents: readonly WorkflowAgentEntry[]): {
  done: number;
  failed: number;
  live: number;
  queued: number;
  tokens: number;
  durationMs: number;
  firstAt?: number;
  lastAt?: number;
} {
  let done = 0;
  let failed = 0;
  let live = 0;
  let queued = 0;
  let tokens = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = 0;

  for (const agent of agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
    else {
      live++;
      // Scheduled but never given a slot: `start` with no start time.
      if (agent.startedAt == null) queued++;
    }
    if (agent.tokens) tokens += agent.tokens;
    if (agent.startedAt != null) {
      if (agent.startedAt < minStart) minStart = agent.startedAt;
      // The agent's own duration is the only honest end time: `lastProgressAt`
      // is absent on a settled row, and reading it as the start made a phase
      // that ran for two minutes report the spread between its launches.
      const end = agent.startedAt + (agent.durationMs ?? 0);
      const last = agent.lastProgressAt ?? end;
      if (last > maxEnd) maxEnd = last;
    }
  }

  const started = minStart < Number.POSITIVE_INFINITY;
  return {
    done,
    failed,
    live,
    queued,
    tokens,
    // Wall-clock across the phase, not the sum of its agents: they overlap.
    durationMs: started ? Math.max(0, maxEnd - minStart) : 0,
    ...(started ? { firstAt: minStart } : {}),
    ...(started ? { lastAt: maxEnd } : {}),
  };
}

function statusOf(node: { live: number; queued: number; failed: number; total: number }): PhaseNodeStatus {
  if (node.live > node.queued) return "running";
  if (node.queued > 0 || node.total === 0) return "queued";
  return node.failed > 0 ? "failed" : "done";
}

/** Fold a node's children into its own rolled-up counts. */
function rollUpChildren(node: PhaseNode): void {
  for (const child of node.children) {
    node.done += child.done;
    node.failed += child.failed;
    node.live += child.live;
    node.queued += child.queued;
    node.tokens += child.tokens;
    node.durationMs += child.durationMs;
    if (child.order < node.order) node.order = child.order;
  }
  node.settled = node.done + node.failed;
  node.total = node.done + node.failed + node.live;
  node.status = statusOf(node);
}

const sameTitle = (a: string, b: string) => a.toLowerCase().trim() === b.toLowerCase().trim();

/**
 * Build the tree the inspector and the card walk.
 *
 * Three things it fixes over the flat list it replaces:
 *
 * **Nesting.** A nested `workflow()`'s phases used to arrive as siblings with a
 * `▸ name › ` prefix in the title, so the parent phase that merely awaited the
 * run sat there with no agents of its own. Here the child's phases hang off
 * that parent row, whose label picks up the run's name (`Run ▸ ps-drive-tc`),
 * and the child's *root* entry — a container that usually owns no agents — is
 * folded away instead of rendering as an empty row.
 *
 * **Reading order.** Rows are ordered by when their work first appeared, not by
 * declaration order, because a run does not execute in declaration order: a
 * `pipeline()` starts stage 2 for item A while item B is still in stage 1, and
 * a nested run's phases are indexed whenever the child gets to them. Sorting by
 * first activity is what makes the list read top-to-bottom as it happened.
 *
 * **Nothing empty.** A declared phase with no agents produces no row at all; it
 * is counted in `remaining` instead, where `… · 3 phases to go` can say so
 * without drawing a row that looks like stalled work.
 */
export function buildPhaseTree(
  progress: readonly WorkflowEntry[],
  declared?: readonly WorkflowPhaseMeta[],
  options?: {
    /**
     * Draw one round instead of the whole run.
     *
     * Omitted, the tree covers every agent the run ever launched — the shape a
     * single-round run has always had. A looping run passes its live round so
     * the tree stops growing with the loop.
     */
    round?: number;
    /** The task's `progressVersion`; enables the per-batch cache. */
    version?: number;
  },
): PhaseTree {
  const view = derivedView(progress, options?.version);
  const round = options?.round;
  // Declared titles are part of the key because they decide `remaining`. They do
  // not change within a run; the count keeps the key from depending on the meta
  // object's identity.
  const cacheKey = `${round ?? "all"}|${declared?.length ?? 0}`;
  const cached = view?.trees.get(cacheKey);
  if (cached !== undefined) return cached;

  const collapsed = collapse(progress);
  const { phaseTitles, phaseParents } = collapsed;
  const agents = round === undefined ? collapsed.agents : collapsed.agents.filter(a => roundOf(a) === round);

  // Direct agents per phase. An agent that never named a phase is bucketed by
  // the index it carries (0), which is how an un-phased script reads as one
  // group rather than losing its agents.
  const direct = new Map<number, WorkflowAgentEntry[]>();
  for (const agent of agents) {
    const index = agent.phaseIndex ?? 0;
    const bucket = direct.get(index);
    if (bucket) bucket.push(agent);
    else direct.set(index, [agent]);
  }

  const ownTitle = (index: number): string => {
    const title = phaseTitles.get(index);
    if (title === undefined) return index === 0 ? "Agents" : `Phase ${index}`;
    return parsePhaseTitle(title).own;
  };

  /** The run a phase belongs to, when it is a nested run's phase. */
  const runOf = (index: number): string | undefined => {
    const title = phaseTitles.get(index);
    return title === undefined ? undefined : parsePhaseTitle(title).run;
  };

  // A nested run's phases point at the run's root entry, and the root points at
  // the phase that awaited it. Walk up to the phase a row should actually hang
  // under, recording how many runs it passed through.
  const effectiveParent = (index: number): { parent: number; depth: number } | undefined => {
    let parent = phaseParents.get(index);
    let depth = 0;
    while (parent !== undefined && runOf(parent) !== undefined) {
      const next = phaseParents.get(parent);
      if (next === undefined) break;
      parent = next;
      depth++;
    }
    if (parent === undefined) return depth > 0 ? { parent: -1, depth } : undefined;
    return { parent, depth };
  };

  const nodes = new Map<number, PhaseNode>();
  const node = (index: number): PhaseNode => {
    let existing = nodes.get(index);
    if (existing) return existing;
    const own = direct.get(index) ?? [];
    const counts = rollUp(own);
    existing = {
      index,
      title: ownTitle(index),
      label: ownTitle(index),
      depth: 0,
      agents: own,
      children: [],
      done: counts.done,
      failed: counts.failed,
      live: counts.live,
      queued: counts.queued,
      settled: counts.done + counts.failed,
      total: own.length,
      tokens: counts.tokens,
      durationMs: counts.durationMs,
      order: firstActivity(own),
      status: statusOf({ live: counts.live, queued: counts.queued, failed: counts.failed, total: own.length }),
    };
    nodes.set(index, existing);
    return existing;
  };

  // Every phase that owns agents, plus the parents they hang under. A parent
  // with no agents of its own still gets a node — it is the row the run's name
  // is printed on.
  for (const index of direct.keys()) {
    node(index);
    const up = effectiveParent(index);
    if (up !== undefined && up.parent >= 0) node(up.parent);
  }

  // The run each parent row delegates to, so its label can say so.
  const delegatedTo = new Map<number, string[]>();
  for (const [childIndex, parentIndex] of phaseParents) {
    const run = runOf(childIndex);
    // Only a run's *root* entry names the run; its phases carry the same name
    // and would otherwise be listed as separate delegations.
    const rootTitle = phaseTitles.get(childIndex);
    if (run === undefined || rootTitle === undefined) continue;
    if (parsePhaseTitle(rootTitle).own !== run) continue;
    const list = delegatedTo.get(parentIndex);
    if (list) list.push(run);
    else delegatedTo.set(parentIndex, [run]);
  }

  for (const [index, current] of nodes) {
    const up = effectiveParent(index);
    // A run whose `workflow()` was called before any `phase()` has nothing to
    // hang under, so it stays a top-level row rather than disappearing.
    if (up === undefined || up.parent < 0) {
      current.depth = 0;
      continue;
    }
    current.depth = up.depth + 1;
    nodes.get(up.parent)?.children.push(current);
  }

  for (const current of nodes.values()) {
    const runs = delegatedTo.get(current.index);
    if (runs && runs.length > 0) current.label = `${current.title} ${NESTED_MARK}${runs.join(" \u00b7 ")}`;
  }

  const top = [...nodes.values()].filter(current => current.depth === 0);
  for (const current of top) rollUpChildren(current);

  // Children read in the same order as the top level: by first activity, so a
  // nested run's phases also appear as they happened.
  const byActivity = (a: PhaseNode, b: PhaseNode) => (a.order === b.order ? a.index - b.index : a.order - b.order);
  const sortChildren = (current: PhaseNode) => {
    current.children.sort(byActivity);
    for (const child of current.children) sortChildren(child);
  };
  for (const current of top) sortChildren(current);

  // Chronological, with ties broken by phase index so the order is stable
  // between renders: a row must never move because an agent in another row
  // reported progress.
  top.sort((a, b) => (a.order === b.order ? a.index - b.index : a.order - b.order));

  const totals: PhaseTotals = { settled: 0, failed: 0, live: 0, total: 0, tokens: 0 };
  for (const current of top) {
    totals.settled += current.settled;
    totals.failed += current.failed;
    totals.live += current.live;
    totals.total += current.total;
    totals.tokens += current.tokens;
  }

  // A declared phase counts as reached when a top-level row carries its title.
  // Nested runs declare phases of their own, but `meta.phases` describes the
  // script that was launched, so only its own rows may satisfy it.
  //
  // A round with nothing live has nothing ahead of it by definition, whatever
  // `meta` declared: the pass ended, and "2 phases to go" beside a settled
  // round would read as work still owed. Only the live round can be behind.
  const liveInScope = agents.some(a => isLive(a));
  const remaining =
    round !== undefined && !liveInScope ? []
    : (declared ?? [])
        .filter(phase => !top.some(current => sameTitle(current.title, phase.title)))
        .map(phase => phase.title);

  const tree: PhaseTree = { nodes: top, remaining, totals };
  if (view) view.trees.set(cacheKey, tree);
  return tree;
}

/**
 * Flatten a tree into the rows a renderer prints, depth first.
 *
 * Separate from `buildPhaseTree` because the two callers indent differently:
 * the inspector draws a real tree, the card has one column and relies on the
 * label alone.
 */
export function flattenPhaseTree(tree: PhaseTree): PhaseNode[] {
  const out: PhaseNode[] = [];
  const walk = (nodes: readonly PhaseNode[]) => {
    for (const current of nodes) {
      out.push(current);
      walk(current.children);
    }
  };
  walk(tree.nodes);
  return out;
}

/**
 * Aggregate counts for the header line.
 *
 * `agentCount` is the number the runtime has *scheduled*, which can exceed the
 * number that has emitted an entry — a fan-out reports its size before its
 * agents start, so the total does not visibly climb as they trickle in.
 *
 * Collapsed first, because the log is append-only and last-write-wins: one
 * agent writes a queued row, a started row and a settle row under the same
 * index, so counting raw entries reports four or five "agents" for every real
 * one. That is where an eighteen-agent run came to read `16/85 agents`, and
 * because each emit adds another line the denominator kept climbing while the
 * run worked, which reads as the run gaining tasks.
 */
export function stats(progress: readonly WorkflowEntry[], agentCount = 0): WorkflowStats {
  const { agents } = collapse(progress);
  let done = 0;
  let failed = 0;
  let started = 0;
  let anyLive = false;

  for (const entry of agents) {
    if (entry.state === "done") {
      done++;
      started++;
    } else if (entry.state === "error") {
      failed++;
      started++;
    } else {
      anyLive = true;
      // Counted as started unless it is provably still waiting for a slot.
      if (entry.startedAt !== undefined || entry.queuedAt === undefined) started++;
    }
  }

  const total = Math.max(agentCount, agents.length);
  return {
    done,
    failedCount: failed,
    running: anyLive,
    total,
    started,
    // `!anyLive` is implied by the count test — `total >= agents.length`, and
    // the agents array holds live rows too, so `done + failed >= total` can only
    // hold when none are live. Kept for parity with Claude Code and as a guard
    // should `total` ever stop deriving from the agent count; no test can reach
    // it as written.
    complete: !anyLive && agents.length > 0 && done + failed >= total,
  };
}

/** Elapsed run time, excluding any time spent paused. */
export function elapsedMs(
  task: { startTime: number; endTime?: number; totalPausedMs?: number },
  now: number,
): number {
  return Math.max(0, (task.endTime ?? now) - task.startTime - (task.totalPausedMs ?? 0));
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/** `1m12s` / `9s` / `340ms` / `7h04m` / `3d04h` — the shared ladder in `duration.ts`. */
export function formatDuration(ms: number): string {
  return formatSpan(ms, "precise");
}

/** `18.4k` / `1.2M` / `3.4B` — bare magnitude, since the row already reads as a stat. */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

export interface WorkflowHeader {
  name: string;
  subtext: string;
  stats: string;
}

/**
 * The one-line summary above the tree: `3/7 agents · 1m12s`, plus a terminal
 * suffix once the run stops. Deliberately carries no phase count.
 *
 * A run with more than one round reports differently, because the shape of the
 * number has to change with it. `settled/total agents` is a progress bar: it
 * means something when the total is a plan and nothing when the total is
 * whatever the loop has got to so far — a looping run reported `47/85` and then
 * `48/86`, climbing until the cap. So a looping run leads with the round it is
 * in and that round's own `settled/total`, which can reach its denominator, and
 * carries the run's settled total beside it as a quantity rather than a
 * fraction.
 */
export function header(
  task: {
    status: WorkflowRunStatus;
    workflowName?: string;
    summary?: string;
    description?: string;
    startTime: number;
    endTime?: number;
    totalPausedMs?: number;
  },
  meta: WorkflowMeta | undefined,
  tree: PhaseTree,
  agentCount: number,
  now: number,
  rounds: readonly RoundSummary[] = [],
  /**
   * Rounds the task pruned from memory, whose rows are gone from the log.
   *
   * Without them the run's totals would *fall* at every prune — the settled
   * count, the failures and the tokens are exactly what a prune leaves behind in
   * `task.archived` — and the header would contradict the fold line beside it.
   */
  archived?: ArchivedRounds,
): WorkflowHeader {
  const suffix =
    task.status === "completed" ? " · done"
    : task.status === "killed" ? " · stopped"
    : task.status === "paused" ? " · paused"
    : task.status === "failed" ? " · failed"
    : "";

  const parts: string[] = [];
  if (rounds.length > 1) {
    const live = rounds[rounds.length - 1] as RoundSummary;
    // Held rounds plus pruned ones: the run's totals have to cover the rounds
    // whose rows are no longer in the log.
    const overallSettled = rounds.reduce((sum, round) => sum + round.settled, 0) + (archived?.settled ?? 0);
    const failed = rounds.reduce((sum, round) => sum + round.failed, 0) + (archived?.failed ?? 0);
    const tokens = rounds.reduce((sum, round) => sum + round.tokens, 0) + (archived?.tokens ?? 0);
    // The round's own denominator, never the run's: `live.live` is what the
    // round still owes, so this is the count that can finish.
    const roundTotal = Math.max(live.agents, live.settled + live.live);
    parts.push(`round ${live.index}`);
    parts.push(roundTotal > 0 ? `${live.settled}/${roundTotal}` : "0 agents");
    // `settled`, not `done`: a failed agent finished. Said as a quantity, so the
    // failures named beside it are not read as included in it twice.
    parts.push(`${overallSettled} settled`);
    if (failed > 0) parts.push(`${failed} failed`);
    const ahead = task.status === "running" || task.status === "paused" ? tree.remaining.length : 0;
    if (ahead > 0) parts.push(`${ahead} ${plural(ahead, "phase")} to go`);
    parts.push(formatDuration(elapsedMs(task, now)));
    if (tokens > 0) parts.push(`${formatCompactTokens(tokens)} tok`);
  } else {
    // Settled, not succeeded: a failed agent finished. Reporting only successes
    // made a run with one failure read `29/31` forever, as if two agents had never
    // run — and one of them had, and failed. The failure is named beside the
    // count instead of being hidden inside it.
    const { settled, failed } = tree.totals;
    const total = Math.max(agentCount, tree.totals.total, settled);
    parts.push(`${settled}/${total} ${plural(total, "agent")}`);
    if (failed > 0) parts.push(`${failed} failed`);
    // What is left of the declared agenda, counted rather than drawn: an empty
    // phase is a plan, not work, and a row of it would read as stalled agents.
    const ahead = task.status === "running" || task.status === "paused" ? tree.remaining.length : 0;
    if (ahead > 0) parts.push(`${ahead} ${plural(ahead, "phase")} to go`);
    parts.push(formatDuration(elapsedMs(task, now)));
    if (tree.totals.tokens > 0) parts.push(`${formatCompactTokens(tree.totals.tokens)} tok`);
  }

  return {
    name: task.workflowName ?? meta?.name ?? task.summary ?? task.description ?? "workflow",
    subtext: meta?.description ?? task.description ?? task.summary ?? "",
    stats: `${parts.join(" · ")}${suffix}`,
  };
}

/* ------------------------------------------------------------------------- *
 * Size warning
 * ------------------------------------------------------------------------- */

export const DEFAULT_AGENT_CAP = 25;
export const DEFAULT_TOKEN_CAP = 1_500_000;
/** Assumed spend per agent before any has reported, for the projection. */
export const ASSUMED_TOKENS_PER_AGENT = 70_000;

export interface SizeWarning {
  axis: "agents" | "tokens" | "both";
  scheduledAgents: number;
  totalTokens: number;
  projectedTokens: number;
  agentCap: number;
  tokenCap: number;
}

/**
 * Warn when a run is about to get expensive.
 *
 * The projection matters more than the current total: a 200-agent fan-out is
 * worth flagging at agent 3, not after it has already spent the budget.
 */
export function sizeWarning(input: {
  scheduledAgents: number;
  startedAgents: number;
  totalTokens: number;
  agentCap?: number;
  tokenCap?: number;
}): SizeWarning | undefined {
  const agentCap = input.agentCap ?? DEFAULT_AGENT_CAP;
  const tokenCap = input.tokenCap ?? DEFAULT_TOKEN_CAP;
  const perAgent = input.startedAgents > 0 ? input.totalTokens / input.startedAgents : ASSUMED_TOKENS_PER_AGENT;
  const projectedTokens = Math.max(input.totalTokens, Math.round(perAgent * input.scheduledAgents));

  const overAgents = input.scheduledAgents > agentCap;
  const overTokens = input.totalTokens > tokenCap || projectedTokens > tokenCap;
  if (!overAgents && !overTokens) return undefined;

  return {
    axis: overAgents && overTokens ? "both" : overAgents ? "agents" : "tokens",
    scheduledAgents: input.scheduledAgents,
    totalTokens: input.totalTokens,
    projectedTokens,
    agentCap,
    tokenCap,
  };
}

/* ------------------------------------------------------------------------- *
 * Footer phase label
 * ------------------------------------------------------------------------- */

/** Words whose gerund is irregular, or which read better left alone. */
const GERUND_OVERRIDES = new Map<string, string | null>([
  ["commit", "committing"],
  ["submit", "submitting"],
  ["format", "formatting"],
  ["setup", null],
  ["cleanup", null],
]);

const VOWELS = "aeiou";
const GERUND_CANDIDATE = /^[A-Za-z]{3,12}$/;

/**
 * Render a phase title as an activity: `Scan` → `Scanning`.
 *
 * Only applied in the footer, where the line reads as "what is happening now".
 * Anything that is not a plain short word is left untouched.
 */
export function gerund(word: string): string {
  if (!GERUND_CANDIDATE.test(word)) return word;
  const lower = word.toLowerCase();

  const override = GERUND_OVERRIDES.get(lower);
  if (override !== undefined) return override === null ? word : word[0] + override.slice(1);

  if (lower.endsWith("ing")) return word;
  if (lower.endsWith("ie")) return `${word.slice(0, -2)}ying`;
  if (lower.endsWith("e") && !lower.endsWith("ee") && !lower.endsWith("ye")) return `${word.slice(0, -1)}ing`;

  // Short consonant-vowel-consonant words double the final consonant: run →
  // running. `w`, `x` and `y` never double.
  const last = lower.at(-1) ?? "";
  if (
    lower.length <= 4 &&
    !VOWELS.includes(lower.at(-3) ?? "") &&
    VOWELS.includes(lower.at(-2) ?? "") &&
    !VOWELS.includes(last) &&
    !"wxy".includes(last)
  ) {
    return `${word}${last}ing`;
  }
  return `${word}ing`;
}

/** Truncation width for a footer phase title. */
const FOOTER_TITLE_WIDTH = 16;

const truncate = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

/**
 * The footer's "what is this run doing" label.
 *
 * One active phase shows its position; two concurrent phases are joined, since
 * a barrier-free pipeline routinely has work in more than one at a time.
 */
export function footerPhaseLabel(input: {
  titles: readonly string[];
  positionStart: number;
  totalPhases: number;
}): string {
  const titles = input.titles.map(gerund);
  if (titles.length === 0) return "";
  if (titles.length === 1) {
    return `${truncate(titles[0], FOOTER_TITLE_WIDTH)} (${input.positionStart}/${input.totalPhases})`;
  }
  return titles.map(t => truncate(t, FOOTER_TITLE_WIDTH)).join(" & ");
}
