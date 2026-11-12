/**
 * workflow-dialog.ts — the `/agents → Workflows` tree inspector.
 *
 * ```
 *  review-changes
 *  Review changed files across dimensions              3/7 agents · 12m · 1.2M tok
 *
 *  ╭ Verify · 4 agents ────────────────────────────────────────────────╮
 *  │ ❯ ✔ Review                                              3/3 · 41s │
 *  │   ⠋ Verify ▸ cross-check                 4/6 · ✘ 1 failed · 2 run │
 *  │       ✔ auth.ts                                       2/2 · 8m     │
 *  │       ⠋ data.ts                             2/4 · 1 failed · 12s   │
 *  │   ◌ Report                                            0/1 · queued │
 *  ╰────────────────────────────────────────────────────────────────────╯
 *  ↑↓ select · ⏎ agents · f filter · x stop · esc close
 * ```
 *
 * One column, not two. Rows are the phases in the order their work started — a
 * run does not execute in declaration order, and a list that claims otherwise
 * makes the reader distrust it — with a nested `workflow()`'s phases indented
 * under the phase that awaited it. `⏎` expands a phase's agents in place; `⏎`
 * on an agent opens its detail, and `⏎` there opens the conversation.
 *
 * A phase with no agents gets no row: an empty row is indistinguishable from
 * work that stalled, so the declared-but-unstarted agenda is counted in the
 * header instead (`4 phases to go`).
 *
 * **Counts are settled, not successful.** A failed agent ran. Showing `1/2`
 * beside a ✘ reports an agent that never got a turn, which is a different and
 * worse failure than one that ran and broke, so the numerator counts both and
 * the failures are named separately (`2/2 · ✘ 1 failed`).
 *
 * **The glyphs are not the card's glyphs.** `workflow-card.ts` keys off the raw
 * entry `state`; this file keys off the *derived* `displayState(entry, active)`
 * and splits cases the card cannot see — skipped, blocked, queued and
 * interrupted all render as a plain ✘ or ⟳ inline but are distinct here. `◌`
 * (U+25CC) appears only in this file, and a running row animates a spinner where
 * the card draws a static `⟳`.
 *
 * **The layout is pure.** `layoutWorkflowDialog` returns coloured segments and
 * `handleWorkflowDialogKey` maps a keypress to the next state plus an optional
 * action; neither touches a theme, a terminal, or the workflow runtime. The
 * `WorkflowDialog` component is the thin shell that wires those to `ctx.ui`, and
 * the runtime side arrives as an injected `WorkflowDialogActions`.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import {
  type Component,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  buildPhaseTree,
  displayState,
  flattenPhaseTree,
  formatDuration,
  header,
  isLive,
  type PhaseNode,
  type PhaseTree,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
} from "../workflow/progress.js";
import { SPINNER, type Theme } from "./agent-widget.js";
import {
  ASCII_GLYPHS,
  clampLine,
  formatCompactTokens,
  formatModel,
  formatThinking,
  REPLAYED_ANNOTATION,
  styleWorkflowCardLines,
  UNICODE_GLYPHS,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;

/**
 * Most rows the frame will ever draw between its top and bottom edges.
 *
 * A cap, not a height: the box sizes itself to what it holds, and this is where
 * it stops growing so a 200-agent fan-out scrolls inside the pane instead of
 * pasting 200 rows into the conversation.
 */
export const DEFAULT_PANE_BODY_ROWS = 22;
/**
 * Fewest rows the frame will draw.
 *
 * Below this a pane stops reading as a pane, and the box would resize on
 * nearly every keypress — most phases hold a handful of agents, so a floor here
 * absorbs the ordinary movement and leaves the height alone.
 */
export const MIN_PANE_BODY_ROWS = 6;
/** Prompt lines shown before `expand` is offered. */
export const PROMPT_COLLAPSED_LINES = 4;
/** Spinner cadence. Unlike the card's 1s header tick, this row really animates. */
export const WORKFLOW_DIALOG_SPINNER_MS = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowDialogGlyphs {
  tick: string;
  cross: string;
  /** `◌` — queued or interrupted. The card has no row that draws this. */
  queued: string;
  /** `figures.pointer` — the selected row in either pane. */
  pointer: string;
  /** Marks whichever pane currently owns j/k. */
  focus: string;
  /** Running rows cycle these. */
  spinner: readonly string[];
  /** The pane frame: corners, edges and the tee where the two panes meet. */
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    topTee: string;
    bottomTee: string;
  };
  /** Trailing marker on a title the pane was too narrow to hold. */
  ellipsis: string;
  /** How the footer names the arrow keys and Enter. */
  upDown: string;
  enter: string;
}

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: UNICODE_GLYPHS.tick,
  cross: UNICODE_GLYPHS.cross,
  queued: "◌",
  pointer: "❯",
  focus: UNICODE_GLYPHS.pointer,
  spinner: SPINNER,
  box: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    topTee: "┬",
    bottomTee: "┴",
  },
  ellipsis: "…",
  upDown: "↑↓",
  enter: "⏎",
};

/** The ASCII tier, one column per glyph so the panes stay aligned either way. */
export const ASCII_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  tick: ASCII_GLYPHS.tick,
  cross: ASCII_GLYPHS.cross,
  queued: "o",
  pointer: ">",
  focus: ASCII_GLYPHS.pointer,
  spinner: ["-", "\\", "|", "/"],
  box: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topTee: "+",
    bottomTee: "+",
  },
  ellipsis: "~",
  upDown: "up/down",
  enter: "enter",
};

/**
 * The recovered dialog mapping — keyed on the *display* state.
 *
 * Claude Code's `permission` colour has no pi equivalent; a blocked agent is
 * waiting on the user, so it maps to `warning` (selection maps to `accent`).
 */
export function dialogRowGlyph(
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
  switch (state) {
    case "done":
      return { text: glyphs.tick, color: "success" };
    case "failed":
      return { text: glyphs.cross, color: "error" };
    case "skipped":
      return { text: glyphs.cross, color: "dim" };
    case "blocked":
      return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted":
      return { text: glyphs.queued, color: "dim" };
    case "running":
      return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Verbatim copy
 * ------------------------------------------------------------------------- */

/**
 * Claude Code's own strings. Kept together and named so a reader can see at a
 * glance which surface each belongs to, and so none drifts under an edit.
 */
export const WORKFLOW_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  availableOnceStarted: "Available once the agent starts.",
  notAvailableYet: "Not available yet (agent still running).",
  noTranscript: "Transcript not available.",
  stoppedEarly: "The workflow stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noToolCallsYet: "No tool calls yet.",
  noToolCalls: "No tool calls.",
  noAgents: "No agents",
} as const;

/* ------------------------------------------------------------------------- *
 * State
 * ------------------------------------------------------------------------- */

/**
 * Which of the two levels is showing.
 *
 * `tree` is the overview — one column of phases in the order their work began,
 * with a phase's agents expanded in place. `agent` is the subview reached by
 * opening an agent row: the tree gives way to that agent's detail.
 *
 * The tree replaced a two-pane layout whose left column was 18 columns wide
 * (`leftPaneWidth`), which is nowhere near enough room to show that a nested
 * run's phases belong under the phase that awaited it. Indentation carries the
 * whole hierarchy here, and it needs a wide line to read.
 */
export type WorkflowDialogLevel = "tree" | "agent";

/** `all`, or exactly one display state. */
export type WorkflowDialogFilter = "all" | WorkflowDisplayState;

/** The order `f` cycles through. */
export const WORKFLOW_DIALOG_FILTERS: readonly WorkflowDialogFilter[] = [
  "all",
  "running",
  "queued",
  "done",
  "failed",
  "blocked",
  "skipped",
  "interrupted",
];

export interface WorkflowDialogState {
  /** Cursor over the rows the tree currently draws. */
  selectedRow: number;
  /**
   * Phase index whose agents are expanded inline, `-1` for none, or `undefined`
   * to follow the run — the first row with live work opens itself, so the
   * inspector lands on what is happening now rather than on a phase that
   * finished twenty minutes ago.
   */
  expanded?: number;
  level: WorkflowDialogLevel;
  filter: WorkflowDialogFilter;
  promptExpanded: boolean;
}

export function initialWorkflowDialogState(): WorkflowDialogState {
  return { selectedRow: 0, expanded: undefined, level: "tree", filter: "all", promptExpanded: false };
}

/** Everything the dialog reads about a run, so it can be driven from a stub. */
export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that reported. */
  agentCount?: number;
}

export interface WorkflowDialogInput extends WorkflowDialogSource {
  state: WorkflowDialogState;
  /**
   * Which actions the caller actually wired. Absent keys default to available,
   * so layout tests and read-only callers keep the full footer; a caller that
   * wires only some actions passes the map so the hints stay truthful.
   */
  available?: Partial<Record<keyof WorkflowDialogActions, boolean>>;
  now?: number;
  /** The *terminal* width; the content width is derived from it. */
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
  /**
   * Most rows the frame may use, overriding {@link DEFAULT_PANE_BODY_ROWS}.
   *
   * The frame still sizes to its content and still respects
   * {@link MIN_PANE_BODY_ROWS}; this only moves the ceiling.
   */
  bodyRows?: number;
}

/** The actions the dialog needs from the workflow runtime, injected. */
export interface WorkflowDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  /** `index` is the entry's stable `index`, not its row position. */
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
  /**
   * Open the selected agent's conversation.
   *
   * `recordId` is the manager's id for the child, which the entry carries once
   * the host has reported one — the dialog knows nothing about sessions, so
   * what happens to an id whose record has since been swept is the caller's to
   * say. The only key here that shows something rather than changing the run.
   */
  onOpenAgent?(recordId: string): void;
}

export type WorkflowDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number }
  | { kind: "open"; recordId: string };

/** One line of the tree: a phase, or an agent of an expanded one. */
export type WorkflowTreeRow =
  | { kind: "node"; node: PhaseNode; expanded: boolean }
  | { kind: "agent"; node: PhaseNode; entry: WorkflowAgentEntry };

export interface ResolvedWorkflowDialog {
  tree: PhaseTree;
  /** Rows to draw, in reading order. */
  rows: WorkflowTreeRow[];
  clampedRow: number;
  /** The phase currently expanded inline, if any. */
  expandedIndex: number | undefined;
  /** The phase row under the cursor. */
  selectedNode: PhaseNode | undefined;
  /** The agent under the cursor, or the one being inspected. */
  selectedEntry: WorkflowAgentEntry | undefined;
  /** The expanded phase's agents, after the state filter. */
  visibleAgents: WorkflowAgentEntry[];
  workflowActive: boolean;
  paused: boolean;
}

/** Content width. The 6 columns are the dialog's border and padding. */
export function workflowDialogContentWidth(terminalWidth: number): number {
  return Math.max(12, terminalWidth - 6);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

/** Every agent in a subtree, in launch order. */
function subtreeAgents(node: PhaseNode): WorkflowAgentEntry[] {
  const out = [...node.agents];
  for (const child of node.children) out.push(...subtreeAgents(child));
  return out.sort((a, b) => a.index - b.index);
}

/**
 * Settle the view against the data actually present.
 *
 * Selection is stored raw and clamped on read, so a phase finishing (and rows
 * dropping out of a filtered view) never leaves the cursor past the end — the
 * same trick `fleet-list.ts` plays, minus the mutation.
 */
export function resolveWorkflowDialog(input: WorkflowDialogInput): ResolvedWorkflowDialog {
  const tree = buildPhaseTree(input.progress, input.meta?.phases);
  const workflowActive = input.task.status === "running" || input.task.status === "paused";
  const flat = flattenPhaseTree(tree);

  // `undefined` follows the run; `-1` means the reader collapsed everything.
  //
  // The deepest live row, not the first one: a phase that delegated inherits its
  // nested run's liveness, and opening the parent would list a child's agents
  // one level too high while the child's own phase rows vanished. A settled run
  // has nothing live, so it opens on whatever ran last — the ending is what
  // anyone opening a finished run came to read.
  const live = flat.find(node => node.live > 0 && !node.children.some(child => child.live > 0));
  const lastActive = flat.reduce<PhaseNode | undefined>((best, node) => {
    if (!Number.isFinite(node.order)) return best;
    return best === undefined || node.order >= best.order ? node : best;
  }, undefined);
  const auto = live ?? lastActive ?? flat[0];
  const expandedIndex =
    input.state.expanded === undefined ? auto?.index
    : input.state.expanded < 0 ? undefined
    : input.state.expanded;

  const rows: WorkflowTreeRow[] = [];
  const walk = (nodes: readonly PhaseNode[]) => {
    for (const node of nodes) {
      const expanded = node.index === expandedIndex;
      rows.push({ kind: "node", node, expanded });
      if (!expanded) {
        walk(node.children);
        continue;
      }
      // An expanded row shows its whole subtree's agents and hides the child
      // rows beneath it: the same agents listed twice, once per level, is not a
      // tree — it is the same work drawn twice.
      for (const entry of subtreeAgents(node)) {
        if (input.state.filter !== "all" && displayState(entry, workflowActive) !== input.state.filter) continue;
        rows.push({ kind: "agent", node, entry });
      }
    }
  };
  walk(tree.nodes);

  const clampedRow = clampIndex(input.state.selectedRow, rows.length);
  const row = rows[clampedRow];
  const expandedNode = expandedIndex === undefined ? undefined : flat.find(node => node.index === expandedIndex);

  return {
    tree,
    rows,
    clampedRow,
    expandedIndex,
    selectedNode: row?.kind === "node" ? row.node : undefined,
    selectedEntry: row?.kind === "agent" ? row.entry : undefined,
    visibleAgents:
      expandedNode === undefined
        ? []
        : subtreeAgents(expandedNode).filter(entry =>
            input.state.filter === "all" ? true : displayState(entry, workflowActive) === input.state.filter,
          ),
    workflowActive,
    paused: input.task.status === "paused",
  };
}

/* ------------------------------------------------------------------------- *
 * Row pieces
 * ------------------------------------------------------------------------- */

/**
 * The `·`-separated annotations between an agent's label and its stats.
 *
 * These say *why* a row looks the way it does — a retry and its cause, a cache
 * hit replayed from the resume journal, how long a queued agent has been
 * waiting. The stat tail (agentType, model, tokens, tool calls, duration) is the
 * card's and is appended after.
 */
export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.isolation) parts.push(entry.isolation);
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if (entry.lastAttemptReason) {
    parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  }
  if (entry.attempt != null && entry.attempt > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/** Place `right` flush to `width`, cutting `left` first so the stats survive. */
function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

/**
 * Window a list around its selection, so a 200-agent fan-out still shows the
 * row you are on. Mirrors `fleet-list.ts`'s arithmetic.
 */
function windowRange(selected: number, total: number, max: number): { start: number; end: number } {
  const visible = Math.min(max, total);
  const start = selected < visible ? 0 : selected - visible + 1;
  return { start, end: start + visible };
}

/* ------------------------------------------------------------------------- *
 * The pane frame
 * ------------------------------------------------------------------------- */

/** Fill a title out to the cell width with rule, so the corners stay put. */
function padTitle(line: WorkflowCardLine, width: number, horizontal: string): WorkflowCardLine {
  const gap = Math.max(0, width - lineWidth(line));
  return gap > 0 ? [...line, { text: horizontal.repeat(gap), color: "dim" }] : line;
}

/** One pane row, padded to exactly `width` so the frame stays vertical. */
function padCell(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped = clampLine(line, width);
  const gap = Math.max(0, width - lineWidth(clamped));
  return gap > 0 ? [...clamped, { text: " ".repeat(gap) }] : clamped;
}

/** A title as it sits in the frame's top edge: ` Title ` then rule to `width`. */
function frameTitle(title: string, width: number, glyphs: WorkflowDialogGlyphs): WorkflowCardSegment[] {
  const room = Math.max(0, width - 2);
  // Truncated with the marker rather than simply cut: `Discover · 1 ag…` has to
  // read as "there was more", not as a title that happens to end oddly. Pi's
  // own truncation does the width arithmetic, including wide characters; its
  // ellipsis arrives wrapped in resets, which are stripped for the same reason
  // `clampLine` strips them — the layout stays plain text until it is themed.
  const shown = stripTerminalSequences(truncateToWidth(title, room, glyphs.ellipsis));
  const rule = Math.max(0, width - visibleWidth(shown) - 2);
  // Clamped as well as computed: at a terminal narrow enough that `room` hits
  // zero the marker alone is already wider than the cell, and a title that
  // overflows tears the frame open on every row below it.
  return clampLine(
    [
      { text: " ", color: "dim" },
      { text: shown, color: "muted", bold: true },
      { text: ` ${glyphs.box.horizontal.repeat(rule)}`, color: "dim" },
    ],
    width,
  );
}

/**
 * Draw the tree into one framed column.
 *
 * One cell rather than two: the hierarchy is indentation, and an 18-column left
 * pane (what the two-pane layout gave a phase) cannot show it. Rows are padded
 * to `bodyRows` so the frame keeps its height as the cursor moves.
 */
function treeFrame(options: {
  title: string;
  rows: WorkflowCardLine[];
  width: number;
  bodyRows: number;
  glyphs: WorkflowDialogGlyphs;
}): WorkflowCardLine[] {
  const { glyphs, width } = options;
  const box = glyphs.box;
  const inner = Math.max(1, width - 2);

  const lines: WorkflowCardLine[] = [];
  lines.push([
    { text: box.topLeft, color: "dim" },
    ...padTitle(frameTitle(options.title, inner, glyphs), inner, box.horizontal),
    { text: box.topRight, color: "dim" },
  ]);
  for (let row = 0; row < options.bodyRows; row++) {
    lines.push([
      { text: box.vertical, color: "dim" },
      ...padCell(options.rows[row] ?? [], inner),
      { text: box.vertical, color: "dim" },
    ]);
  }
  lines.push([
    { text: box.bottomLeft, color: "dim" },
    { text: box.horizontal.repeat(inner), color: "dim" },
    { text: box.bottomRight, color: "dim" },
  ]);
  return lines;
}

/** A phase row's glyph: what has happened there, not how far along it is. */
function nodeGlyph(
  node: PhaseNode,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame: number,
  expanded: boolean,
): string {
  void expanded;
  switch (node.status) {
    case "done":
      return glyphs.tick;
    case "failed":
      return glyphs.cross;
    case "queued":
      return glyphs.queued;
    case "running":
      return glyphs.spinner[spinnerFrame % glyphs.spinner.length];
  }
}

/**
 * A phase row's stat tail.
 *
 * `settled/total`, not `done/total`: a failed agent ran. Counting only successes
 * left a finished phase reading `2/3` next to a ✘ — the same lie as an agent
 * that never got a turn — so the failure is counted as work done and then named
 * separately.
 */
function nodeStats(
  node: PhaseNode,
  glyphs: WorkflowDialogGlyphs,
  now: number,
): WorkflowCardLine {
  const parts: WorkflowCardLine = [];
  if (node.total === 0) return parts;
  parts.push({ text: `${node.settled}/${node.total}`, color: "dim" });
  const tail: string[] = [];
  if (node.failed > 0) tail.push(`${glyphs.cross} ${node.failed} failed`);
  const running = node.live - node.queued;
  if (running > 0) tail.push(`${running} running`);
  if (node.queued > 0) tail.push(`${node.queued} queued`);
  for (const part of tail) parts.push({ text: ` · ${part}`, color: "dim" });
  if (node.durationMs > 0) parts.push({ text: ` · ${formatDuration(node.durationMs)}`, color: "dim" });
  void now;
  return parts;
}

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/** Split a preview into lines, treating an empty preview as absent. */
const previewLines = (preview: string | undefined) => (preview ? preview.split("\n") : []);

/** What the Activity body says. There is a count of tool calls, never a list. */
function activityBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  if (state === "queued") return WORKFLOW_DIALOG_COPY.availableOnceStarted;
  if ((entry.toolCalls ?? 0) > 0) return WORKFLOW_DIALOG_COPY.noTranscript;
  return isLive(entry) ? WORKFLOW_DIALOG_COPY.noToolCallsYet : WORKFLOW_DIALOG_COPY.noToolCalls;
}

/** What the Outcome body says, which is a different sentence for every state. */
function outcomeBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "skipped":
      return WORKFLOW_DIALOG_COPY.skippedByUser;
    case "interrupted":
      return WORKFLOW_DIALOG_COPY.stoppedEarly;
    case "queued":
      return WORKFLOW_DIALOG_COPY.waitingForSlot;
    case "running":
      return WORKFLOW_DIALOG_COPY.notAvailableYet;
    case "failed":
    case "blocked":
      return entry.error ?? WORKFLOW_DIALOG_COPY.noTranscript;
    case "done":
      return entry.resultPreview ?? WORKFLOW_DIALOG_COPY.noTranscript;
  }
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/**
 * Which of the per-agent actions the selected row can currently take.
 *
 * The window for both is the one in which the agent's `agent()` call is still
 * unanswered. Skip covers that whole window; retry needs a child to stop and
 * start again, so it begins only once one exists. Once the call has settled its
 * value is already the script's, and there is nothing either key could change.
 */
export function agentActions(
  entry: WorkflowAgentEntry | undefined,
  workflowActive: boolean,
): { skip: boolean; retry: boolean } {
  if (entry === undefined || !workflowActive) return { skip: false, retry: false };
  const state = displayState(entry, workflowActive);
  return { skip: state === "queued" || state === "running", retry: state === "running" };
}

/** Status word the detail pane leads with, one per display state. */
function statusWord(state: WorkflowDisplayState): string {
  switch (state) {
    case "done": return "Completed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    case "blocked": return "Blocked";
    case "queued": return "Queued";
    case "interrupted": return "Stopped";
    case "running": return "Running";
  }
}

/** `Prompt · 5 lines · ⏎ expand` — a detail heading and its dim suffixes. */
function detailHeading(title: string, suffixes: readonly string[], width: number): WorkflowCardLine {
  const line: WorkflowCardLine = [{ text: " " }, { text: title, color: "muted", bold: true }];
  for (const suffix of suffixes) {
    line.push({ text: " · ", color: "dim" }, { text: suffix, color: "dim" });
  }
  return clampLine(line, width);
}

/** A detail body line, indented under its heading. */
const detailBody = (text: string, width: number): WorkflowCardLine =>
  clampLine([{ text: `   ${text}`, color: "dim" }], width);

/** The row for one agent, as it appears in whichever pane is listing agents. */
function agentRow(options: {
  entry: WorkflowAgentEntry;
  selected: boolean;
  compact: boolean;
  width: number;
  glyphs: WorkflowDialogGlyphs;
  workflowActive: boolean;
  spinnerFrame: number;
  now: number;
  /**
   * Columns to sit in from the frame's edge.
   *
   * The tree indents a phase's agents one level inside it; the detail view and
   * the card's own rows pass nothing and start at the margin.
   */
  indent?: string;
}): WorkflowCardLine {
  const { entry, selected, glyphs, width } = options;
  const display = displayState(entry, options.workflowActive);
  const head: WorkflowCardLine = [
    { text: " " },
    { text: selected ? glyphs.pointer : " ", color: "accent" },
    { text: " " },
    { text: options.indent ?? "" },
    dialogRowGlyph(display, glyphs, options.spinnerFrame),
    { text: " " },
    { text: entry.label, color: selected ? "accent" : undefined },
  ];
  // The narrow pane holds the label and nothing else; there is no room for a
  // stat tail, and clamping one would just spend columns on a truncated word.
  if (options.compact) return clampLine(head, width);

  const model = formatModel(entry);
  if (model) head.push({ text: ` ${model}`, color: "dim" });
  for (const part of [...subStatusAnnotations(entry, display, options.now), ...rowStatSegments(entry)]) {
    head.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
  }
  // The duration sits flush right, so a column of rows reads as a column of
  // durations rather than as ragged text.
  const duration = entry.durationMs ? [{ text: `${formatDuration(entry.durationMs)} `, color: "dim" as const }] : [];
  return duration.length > 0 ? rightAlign(head, duration, width) : clampLine(head, width);
}

/** The agent row's dot-separated tail. The model is not in it — it leads. */
function rowStatSegments(entry: WorkflowAgentEntry): string[] {
  return entry.tokens ? [`${formatCompactTokens(entry.tokens)} tok`] : [];
}

/**
 * Build the dialog.
 *
 * Two panes side by side inside one frame, and two levels of depth: phases with
 * the selected phase's agents beside them, then — on opening one — those agents
 * with the selected agent's detail beside them. The frame is a fixed height so
 * the dialog does not jump as the selection moves through runs of very
 * different sizes.
 */
export function layoutWorkflowDialog(input: WorkflowDialogInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = workflowDialogContentWidth(input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();
  const view = resolveWorkflowDialog(input);
  const { state } = input;
  // What the frame may *hold*; the frame's height is settled below, once there
  // is something to measure.
  const capacity = Math.max(MIN_PANE_BODY_ROWS, input.bodyRows ?? DEFAULT_PANE_BODY_ROWS);
  const spinnerFrame = input.spinnerFrame ?? 0;

  const lines: WorkflowCardLine[] = [];

  // ---- Header: the run's name, then its description with the stats flush right.
  const head = header(input.task, input.meta, view.tree, input.agentCount ?? 0, now);
  lines.push(clampLine([{ text: " " }, { text: head.name, color: "toolTitle", bold: true }], width));
  lines.push(
    rightAlign(
      head.subtext ? [{ text: " " }, { text: head.subtext, color: "dim" }] : [],
      [{ text: head.stats, color: "dim" }],
      width,
    ),
  );
  lines.push([]);

  const frameWidth = width - 1;
  const contentWidth = frameWidth - 2;
  const inTree = state.level === "tree";
  const entry = view.selectedEntry;

  // ---- The tree: one row per phase, in the order its work started.
  const treeRows: WorkflowCardLine[] = [];
  const rows = windowRange(view.clampedRow, view.rows.length, capacity);
  for (let i = rows.start; i < Math.min(rows.end, view.rows.length); i++) {
    const row = view.rows[i];
    const selected = i === view.clampedRow;
    if (row.kind === "agent") {
      treeRows.push(
        agentRow({
          entry: row.entry,
          selected,
          compact: false,
          width: contentWidth,
          glyphs,
          workflowActive: view.workflowActive,
          spinnerFrame,
          now,
          // One level in from the phase that owns it, so an expanded phase's
          // agents are visibly below it rather than beside it.
          indent: "  ".repeat(row.node.depth + 1),
        }),
      );
      continue;
    }
    const node = row.node;
    const color: WorkflowCardColor =
      selected ? "accent"
      : node.status === "done" ? "success"
      : node.status === "failed" ? "error"
      : "dim";
    // Two columns of indent per level, under a fixed pointer column, so the
    // glyphs line up in a column and the nesting reads at a glance.
    const indent = "  ".repeat(node.depth);
    const left: WorkflowCardLine = [
      { text: " " },
      { text: selected ? glyphs.pointer : " ", color: "accent" },
      { text: " " },
      { text: indent },
      { text: nodeGlyph(node, glyphs, spinnerFrame, row.expanded), color },
      { text: " " },
      { text: node.label, color },
    ];
    treeRows.push(rightAlign(left, nodeStats(node, glyphs, now), contentWidth));
  }

  // ---- Detail: what one agent did, full width. Reachable from an agent row.
  const detailRows: WorkflowCardLine[] = [];
  if (!inTree && entry) {
    const display = displayState(entry, view.workflowActive);
    // Prefers the canonical `provider/model-id` here — two providers can serve
    // models whose short names read alike, and this pane has the width for it.
    const model = formatModel(entry, { canonical: true });
    detailRows.push(
      clampLine(
        [
          { text: " " },
          dialogRowGlyph(display, glyphs, spinnerFrame),
          { text: ` ${statusWord(display)}`, color: "muted" },
          ...(model ? [{ text: " · ", color: "dim" as const }, { text: model, color: "dim" as const }] : []),
        ],
        contentWidth,
      ),
    );
    // Rebuilt rather than filtered out of `agentStatSegments`: the model and the
    // agent type are already on the line above, and the token count wants its
    // unit here exactly as it has one in the row.
    const stats: string[] = [];
    // The thinking level lives here rather than on a tree row: it is per-agent
    // configuration, which is what someone opening this pane came to see, and
    // `thinking: medium` on every row of a fan-out would be noise.
    const thinking = formatThinking(entry);
    if (thinking) stats.push(thinking);
    if (entry.tokens) stats.push(`${formatCompactTokens(entry.tokens)} tok`);
    if (entry.toolCalls) stats.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
    if (entry.durationMs) stats.push(formatDuration(entry.durationMs));
    if (stats.length > 0) {
      detailRows.push(clampLine([{ text: ` ${stats.join(" · ")}`, color: "dim" }], contentWidth));
    }

    const prompt = previewLines(entry.promptPreview);
    const collapsed = !state.promptExpanded && prompt.length > PROMPT_COLLAPSED_LINES;
    const promptSuffix: string[] = [];
    if (prompt.length > 0) promptSuffix.push(`${prompt.length} ${prompt.length === 1 ? "line" : "lines"}`);
    if (prompt.length > PROMPT_COLLAPSED_LINES) {
      promptSuffix.push(`e ${state.promptExpanded ? "collapse" : "expand"}`);
    }
    detailRows.push([]);
    detailRows.push(detailHeading("Prompt", promptSuffix, contentWidth));
    if (prompt.length === 0) {
      detailRows.push(detailBody(WORKFLOW_DIALOG_COPY.availableOnceStarted, contentWidth));
    } else {
      const shown = collapsed ? prompt.slice(0, PROMPT_COLLAPSED_LINES) : prompt;
      for (const text of shown) detailRows.push(detailBody(text, contentWidth));
      // Named rather than silently cut: the reader has to know the prompt goes on.
      if (collapsed) {
        const hidden = prompt.length - PROMPT_COLLAPSED_LINES;
        detailRows.push(detailBody(`${glyphs.ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}`, contentWidth));
      }
    }

    const toolCalls = entry.toolCalls ?? 0;
    detailRows.push([]);
    detailRows.push(
      detailHeading(
        "Activity",
        toolCalls > 0 ? [`${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`] : [],
        contentWidth,
      ),
    );
    detailRows.push(detailBody(activityBody(entry, display), contentWidth));

    detailRows.push([]);
    detailRows.push(detailHeading("Outcome", [], contentWidth));
    // Wrapped, not clamped: the outcome is the thing the reader came for, and
    // cutting it at the pane edge would hide the half that matters.
    for (const text of wrapTextWithAnsi(outcomeBody(entry, display), Math.max(1, contentWidth - 4))) {
      detailRows.push(detailBody(text, contentWidth));
    }
  }

  // With a filter on, the count is of what survived it — so the title says
  // which filter, rather than leaving "3 agents" looking like the whole phase.
  const shown = view.visibleAgents.length;
  const expandedLabel = view.visibleAgents.length === 0 ? undefined : view.rows.find(row => row.kind === "node" && row.expanded);
  const expandedTitle =
    expandedLabel?.kind === "node" ?
      `${expandedLabel.node.label} · ${
        state.filter === "all" ? `${shown} agent${shown === 1 ? "" : "s"}` : `${shown} ${state.filter}`
      }`
    : undefined;
  const title =
    inTree ? (expandedTitle ?? "Phases")
    : (entry?.label ?? WORKFLOW_DIALOG_COPY.noAgents);
  const bodyRows = inTree ? treeRows : detailRows;
  lines.push(
    ...treeFrame({
      title,
      rows: bodyRows,
      width: frameWidth,
      // Tall enough for what it holds, and no taller: a three-phase run is not
      // twenty rows of nothing.
      bodyRows: Math.max(MIN_PANE_BODY_ROWS, Math.min(capacity, bodyRows.length)),
      glyphs,
    }).map(line => [{ text: " " }, ...line]),
  );

  // ---- Key hints ----
  // Only the actions the run can currently take, so the footer never advertises
  // a key that does nothing. Gated on `available` as well as run state: a caller
  // that wires only some of the actions must not get a footer advertising keys
  // that do nothing. Omitting `available` entirely keeps every hint, which is
  // what the layout tests want.
  const can = (action: keyof WorkflowDialogActions) => input.available?.[action] ?? true;
  const hints: string[] = [];
  if (inTree) {
    hints.push(`${glyphs.upDown} select`);
    // Enter does the one thing the row under the cursor can do: open a phase's
    // agents, or open the agent itself. Said per row, so the key never promises
    // something the row cannot deliver.
    if (view.selectedNode) {
      const node = view.selectedNode;
      const hasAgents = subtreeAgents(node).length > 0 || node.children.length > 0;
      if (hasAgents) hints.push(`${glyphs.enter} ${view.expandedIndex === node.index ? "collapse" : "agents"}`);
    } else if (entry?.recordId !== undefined && can("onOpenAgent")) {
      hints.push(`${glyphs.enter} convo`);
    }
    hints.push("f filter");
  } else {
    hints.push(`${glyphs.upDown} agent`);
    if (entry?.recordId !== undefined && can("onOpenAgent")) hints.push(`${glyphs.enter} convo`);
    if (previewLines(entry?.promptPreview).length > PROMPT_COLLAPSED_LINES) {
      hints.push("e prompt");
    }
    const actions = agentActions(entry, view.workflowActive);
    if (actions.skip && can("onSkipAgent")) hints.push("s skip");
    if (actions.retry && can("onRetryAgent")) hints.push("r retry");
  }
  if (view.paused && can("onResume")) hints.push("p resume");
  else if (view.workflowActive && can("onPause")) hints.push("p pause");
  if (view.workflowActive && can("onKill")) hints.push("x stop");
  hints.push(inTree ? "esc close" : "esc back");
  // `c` opens the conversation from either level, on any row that has a child
  // behind it.
  if (inTree && view.selectedEntry?.recordId !== undefined && can("onOpenAgent")) hints.push("c convo");
  lines.push(clampLine([{ text: ` ${hints.join(" · ")}`, color: "dim" }], width));

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

const nextFilter = (filter: WorkflowDialogFilter): WorkflowDialogFilter =>
  WORKFLOW_DIALOG_FILTERS[(WORKFLOW_DIALOG_FILTERS.indexOf(filter) + 1) % WORKFLOW_DIALOG_FILTERS.length];

/**
 * Map a keypress to the next state and, where the key is an action, what the
 * caller should do about it. Pure: `undefined` means "not ours".
 *
 * Movement clamps at both ends rather than wrapping — a long agent list should
 * not jump back to the top under a held `j`.
 */
export function handleWorkflowDialogKey(
  data: string,
  state: WorkflowDialogState,
  view: ResolvedWorkflowDialog,
): { state: WorkflowDialogState; action?: WorkflowDialogAction } | undefined {
  // Ctrl+C is the reflex for backing out of a full-screen overlay, so it closes
  // outright from EITHER level — the conversation viewer's #255 fix, which this
  // dialog is reached the same way as. Deliberately not folded into the `esc`
  // branch below: stepping back a level on the reflex key still leaves the
  // overlay on screen, which is the stuck feeling the key exists to avoid.
  if (matchesKey(data, "ctrl+c")) return { state, action: { kind: "cancel" } };

  // Back one level before out of the dialog: `esc` in the detail returns to the
  // tree, and only closes from there. Anything else would make a wrong turn
  // cost the whole dialog.
  if (matchesKey(data, "escape") || matchesKey(data, "q")) {
    if (state.level === "agent") return { state: { ...state, level: "tree", promptExpanded: false } };
    return { state, action: { kind: "cancel" } };
  }
  if (matchesKey(data, "left")) {
    if (state.level === "agent") return { state: { ...state, level: "tree", promptExpanded: false } };
    // Collapsing keeps the cursor on the row that was open, which is the row
    // whose agents just disappeared.
    if (view.expandedIndex !== undefined) return { state: { ...state, expanded: -1 } };
  }

  const down = matchesKey(data, "j") || matchesKey(data, "down");
  const up = matchesKey(data, "k") || matchesKey(data, "up");
  if (down || up) {
    const delta = down ? 1 : -1;
    const next = clampIndex(view.clampedRow + delta, view.rows.length);
    return { state: next === view.clampedRow ? state : { ...state, selectedRow: next } };
  }

  const descend = matchesKey(data, "enter") || matchesKey(data, "right");
  if (matchesKey(data, "e") && state.level === "agent") {
    return { state: { ...state, promptExpanded: !state.promptExpanded } };
  }

  // Enter does what the row under the cursor can do: a phase opens its agents
  // in place, an agent opens its detail. In the detail it opens the
  // conversation, which is the only thing left to show.
  if (descend && state.level === "tree") {
    const node = view.selectedNode;
    if (node) {
      const open = view.expandedIndex === node.index;
      return { state: { ...state, expanded: open ? -1 : node.index } };
    }
    if (view.selectedEntry) return { state: { ...state, level: "agent", promptExpanded: false } };
    return { state };
  }

  // The one key that opens something instead of changing the run, so unlike
  // skip/retry it works at both levels and on a settled agent. A row with no
  // record id has no conversation to open, and falls through as unbound.
  if ((descend && state.level === "agent") || matchesKey(data, "c")) {
    const recordId = view.selectedEntry?.recordId;
    return recordId === undefined ? undefined : { state, action: { kind: "open", recordId } };
  }

  // The filter re-points the agent rows, so it belongs to the tree rather than
  // to the level showing a single agent's detail.
  if (matchesKey(data, "f") && state.level === "tree") {
    const at = view.rows.findIndex(row => row.kind === "node" && row.node.index === view.expandedIndex);
    return { state: { ...state, filter: nextFilter(state.filter), selectedRow: at < 0 ? state.selectedRow : at } };
  }

  // Gated on the run being live, exactly as the footer's hints are. A settled
  // run has nothing left to stop, and firing `kill` at one aborts a controller
  // that is already done and reports a stop that never happened.
  if (matchesKey(data, "x")) return view.workflowActive ? { state, action: { kind: "kill" } } : undefined;
  if (matchesKey(data, "p")) {
    if (!view.workflowActive) return undefined;
    return { state, action: { kind: view.paused ? "resume" : "pause" } };
  }
  const actions = agentActions(view.selectedEntry, view.workflowActive);
  if (matchesKey(data, "s") && actions.skip && view.selectedEntry) {
    return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  }
  if (matchesKey(data, "r") && actions.retry && view.selectedEntry) {
    return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  }

  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The dialog as plain text — what the layout tests assert against. */
export function plainWorkflowDialogLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/**
 * The `/agents → Workflows` overlay.
 *
 * Deliberately thin: it owns the spinner timer and the theme, and delegates
 * everything else to the two pure functions above. `source` is re-read every
 * render so a live run updates in place without any subscription plumbing.
 */
export class WorkflowDialog implements Component {
  private state: WorkflowDialogState;
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TUI,
    private source: () => WorkflowDialogSource,
    private theme: Theme,
    private done: (result: undefined) => void,
    private actions: WorkflowDialogActions = {},
  ) {
    this.state = initialWorkflowDialogState();
    this.timer = setInterval(() => {
      this.spinnerFrame++;
      if (!this.closed) this.tui.requestRender();
    }, WORKFLOW_DIALOG_SPINNER_MS);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    const input: WorkflowDialogInput = { ...this.source(), state: this.state };
    const result = handleWorkflowDialogKey(data, this.state, resolveWorkflowDialog(input));
    if (!result) return;
    this.state = result.state;
    if (result.action) this.dispatch(result.action);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = layoutWorkflowDialog({
      ...this.source(),
      state: this.state,
      // Derived from what was actually injected, so the footer advertises only
      // the keys this dialog can service.
      available: {
        onKill: this.actions.onKill !== undefined,
        onPause: this.actions.onPause !== undefined,
        onResume: this.actions.onResume !== undefined,
        onSkipAgent: this.actions.onSkipAgent !== undefined,
        onRetryAgent: this.actions.onRetryAgent !== undefined,
        onOpenAgent: this.actions.onOpenAgent !== undefined,
      },
      width,
      spinnerFrame: this.spinnerFrame,
    });
    return styleWorkflowCardLines(lines, this.theme);
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private dispatch(action: WorkflowDialogAction): void {
    switch (action.kind) {
      case "cancel":
        this.closed = true;
        this.done(undefined);
        return;
      case "kill":
        this.actions.onKill?.();
        return;
      case "pause":
        this.actions.onPause?.();
        return;
      case "resume":
        this.actions.onResume?.();
        return;
      case "skip":
        this.actions.onSkipAgent?.(action.index);
        return;
      case "retry":
        this.actions.onRetryAgent?.(action.index);
        return;
      case "open":
        this.actions.onOpenAgent?.(action.recordId);
        return;
    }
  }
}
