/**
 * workflow-card.ts — the inline transcript card for a running workflow.
 *
 * ```
 * ▸ Workflow  review-changes                       3/7 agents · 1m12s
 *   Review changed files across dimensions, verify each finding
 *   ╭─ Review
 *   │ ├─ ✔ review:bugs      · Explore · haiku · 18.4k · 12 tool calls · 42s
 *   │ ├─ ⟳ review:perf      · Explore · 8 tool calls · 21s
 *   │ └─ ⟳ review:security
 *   ╰─ Verify
 *     └─ ⟳ verify:auth.ts   · Plan · 3 tool calls · 9s
 *   ⎿  scanned 41 changed files
 * ```
 *
 * Two things about this file are easy to get wrong.
 *
 * **The glyphs are not the dialog's glyphs.** The inline row keys off the *raw*
 * entry `state` (start | progress | done | error), not the derived display
 * state, so a skipped or blocked agent renders as a plain ✘ here while the
 * workflows dialog distinguishes them. `displayState` is deliberately not
 * consulted below.
 *
 * **The layout is pure.** `layoutWorkflowCard` returns coloured segments and
 * never touches a theme or a terminal, so the same layout drives the `Workflow`
 * tool's `renderResult` and a standalone session entry (a workflow launched from
 * a CLI flag has no tool call to attach to). Theme application is the thin
 * `styleWorkflowCardLines` wrapper on top.
 *
 * All state derivation lives in `src/workflow/progress.ts`; this file only
 * arranges what that module returns.
 */

import { stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowEntryData } from "../workflow/entry.js";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  type ArchivedRounds,
  buildPhaseTree,
  collapse,
  earlierRounds,
  flattenPhaseTree,
  formatCompactTokens,
  formatDuration,
  header,
  roundOf,
  roundSummaries,
  sizeWarning,
  stats,
  type WorkflowAgentEntry,
  type WorkflowEntry,
  type WorkflowRunStatus,
} from "../workflow/progress.js";
import type { Theme } from "./agent-widget.js";

/**
 * Header re-render cadence. Claude Code ticks the workflow clock once a second,
 * not at the 80ms spinner cadence — the running glyph is static, so there is
 * nothing to animate faster than the elapsed time changes.
 */
export const WORKFLOW_TICK_MS = 1000;

/** Widest label column before stats stop being aligned and just follow the label. */
const LABEL_COLUMN_MAX = 28;

/**
 * Agent rows the card draws before it folds the oldest settled ones away.
 *
 * A round is bounded by the phase tree's shape, not by the number of agents in
 * it: one `pipeline()` over 200 items is 200 rows, and the transcript card is
 * re-laid-out on every render, so it has to stop somewhere. Live rows are never
 * among the folded ones — hiding work in flight to save lines is worse than a
 * long card.
 */
export const CARD_AGENT_ROW_BUDGET = 24;

/**
 * Log lines kept below the tree.
 *
 * `log()` has no natural end in a loop — a script that reports each pass writes
 * one per round forever — so the card shows the tail and says how many it is
 * not showing. A single-round run is not capped: its log is as long as its
 * script, which the author already bounded.
 */
export const CARD_LOG_LINES = 6;

/** Fallback width when the caller does not know the terminal's. */
const DEFAULT_WIDTH = 80;

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowGlyphs {
  /** Tool-title pointer, matching the Agent tool's `▸`. */
  pointer: string;
  tick: string;
  cross: string;
  /** Running/queued. A static glyph, hence no spinner inline. */
  running: string;
  /**
   * History the card is not drawing: folded rounds, folded rows, older log
   * lines. One glyph for all three so they read as one kind of note.
   */
  folded: string;
  /** First and subsequent phase groups. */
  groupTop: string;
  /** A group that is neither the first nor the last. */
  groupMid: string;
  /** The last phase group. */
  groupBottom: string;
  /** Continuation rail under a non-final group. */
  vertical: string;
  branch: string;
  lastBranch: string;
  /** Log-line prefix, matching the Agent tool's result lines. */
  log: string;
  warning: string;
}

export const UNICODE_GLYPHS: WorkflowGlyphs = {
  pointer: "▸",
  tick: "✔",
  cross: "✘",
  running: "⟳",
  folded: "⋯",
  groupTop: "╭─",
  groupMid: "├─",
  groupBottom: "╰─",
  vertical: "│",
  branch: "├─",
  lastBranch: "└─",
  log: "⎿",
  warning: "⚠",
};

/**
 * The `figures` ASCII tier, for terminals that cannot draw the box set. Every
 * glyph keeps its unicode counterpart's column width so the tree stays aligned
 * either way.
 */
export const ASCII_GLYPHS: WorkflowGlyphs = {
  pointer: ">",
  tick: "√",
  cross: "×",
  running: "*",
  folded: "...",
  groupTop: ",-",
  groupMid: "|-",
  groupBottom: "`-",
  vertical: "|",
  branch: "|-",
  lastBranch: "`-",
  log: "\\",
  warning: "!",
};

/* ------------------------------------------------------------------------- *
 * Lines
 * ------------------------------------------------------------------------- */

/**
 * pi theme keys. Claude Code's palette maps as success→success, error→error,
 * subtle→dim, permission→warning for a blocked row and accent for selection;
 * an undefined colour means "leave it at the terminal default", which is what
 * the recovered inline mapping asks for on a running row.
 *
 * `accent` is unused by the card and exists for the workflows dialog, which
 * shares these segment types.
 */
export type WorkflowCardColor = "success" | "error" | "warning" | "dim" | "muted" | "toolTitle" | "accent";

export interface WorkflowCardSegment {
  text: string;
  color?: WorkflowCardColor;
  bold?: boolean;
}

export type WorkflowCardLine = WorkflowCardSegment[];

/** The subset of the task record the card reads. */
export interface WorkflowCardTask {
  status: WorkflowRunStatus;
  workflowName?: string;
  summary?: string;
  description?: string;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
}

export interface WorkflowCardInput {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that have reported. */
  agentCount?: number;
  /**
   * The task's `progressVersion`.
   *
   * Enables the derived-view cache in `progress.ts`: the card is laid out again
   * on every render, and re-walking a loop's whole log per render is the cost
   * that turns a weeks-long run into a permanent tax on the transcript.
   */
  version?: number;
  /** Rounds pruned from memory by the task, which the fold has to include. */
  archived?: ArchivedRounds;
  /** Total tokens for the size warning; summed from the entries when omitted. */
  totalTokens?: number;
  agentCap?: number;
  tokenCap?: number;
  now?: number;
  width?: number;
  /** Swap in the ASCII glyph tier for terminals without unicode. */
  ascii?: boolean;
  /**
   * Lead with `▸ SubagentWorkflow`.
   *
   * True where the card stands alone — the session entry a flag-launched run
   * writes, which has no tool call above it to say what it is. False as a tool
   * result, where the call line directly above already does.
   */
  showToolTitle?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

// Re-exported for the inspector, which formats the same figures: the helper
// lives in progress.ts now that the header needs it too, and both renderers
// already depend on that module for derived data.
export { formatCompactTokens };

/**
 * One label for the model pair. A fallback that never differed from the primary
 * would just be noise, so it only shows when the run actually has two models in
 * play.
 */
export function formatModel(
  entry: WorkflowAgentEntry,
  opts?: { canonical?: boolean },
): string | undefined {
  const { fallbackModel, requestedModel } = entry;
  // `canonical` is for surfaces with the width for `provider/model-id`; the
  // tight rows take the short label. Chosen here rather than by the caller
  // swapping fields, which would leave `fallbackModel` in the other spelling.
  const model = opts?.canonical ? entry.modelId ?? entry.model : entry.model;
  const primary = model && fallbackModel && model !== fallbackModel ? `${model}→${fallbackModel}` : model ?? fallbackModel;
  if (primary === undefined) return undefined;
  // Disclosed rather than substituted: a model an agent file pinned over the
  // script's is still a model the script did not get (#182). Same rule as
  // `buildInvocationTags`' `asked()` — only when the two actually differ, so a
  // request that was honoured says nothing.
  return requestedModel !== undefined && requestedModel !== primary
    ? `${primary} (asked ${requestedModel})`
    : primary;
}

/**
 * The thinking level, and what was asked for when it was not honoured.
 *
 * Separate from {@link formatModel} because a row can have one without the
 * other: an `agent()` that named no model still runs at some level, and a level
 * pi clamped is worth saying so about even when the model is unremarkable.
 */
export function formatThinking(entry: WorkflowAgentEntry): string | undefined {
  const { thinking, requestedThinking } = entry;
  if (!thinking) return undefined;
  return requestedThinking !== undefined && requestedThinking !== thinking
    ? `thinking: ${thinking} (asked ${requestedThinking})`
    : `thinking: ${thinking}`;
}

/**
 * What a row replayed from a resume journal says instead of a duration.
 *
 * Shared with the dialog so both views name the same thing the same way — the
 * card shows it inline while the run happens, the dialog on the agent's row.
 */
export const REPLAYED_ANNOTATION = "from resume journal";

/**
 * The `·`-separated tail of an agent row, in the recovered order: agentType,
 * model, tokens, toolCalls, durationMs. Absent values drop out entirely rather
 * than rendering a placeholder.
 */
export function agentStatSegments(entry: WorkflowAgentEntry): string[] {
  const parts: string[] = [];
  if (entry.agentType) parts.push(entry.agentType);
  const model = formatModel(entry);
  if (model) parts.push(model);
  if (entry.tokens) parts.push(formatCompactTokens(entry.tokens));
  if (entry.toolCalls) parts.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
  if (entry.durationMs) parts.push(formatDuration(entry.durationMs));
  return parts;
}

/**
 * The recovered inline mapping — keyed on the raw entry state. `skipped` and
 * `blocked` are not distinguished here; that is the dialog's job.
 */
function rowGlyph(entry: WorkflowAgentEntry, glyphs: WorkflowGlyphs): WorkflowCardSegment {
  if (entry.state === "done") return { text: glyphs.tick, color: "success" };
  if (entry.state === "error") return { text: glyphs.cross, color: "error" };
  return { text: glyphs.running };
}

/* ------------------------------------------------------------------------- *
 * Layout
 * ------------------------------------------------------------------------- */

/** Trim a line to `width`, cutting inside whichever segment crosses the edge. */
export function clampLine(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped: WorkflowCardLine = [];
  let used = 0;
  for (const segment of line) {
    const segmentWidth = visibleWidth(segment.text);
    if (used + segmentWidth <= width) {
      clamped.push(segment);
      used += segmentWidth;
      continue;
    }
    const room = width - used;
    // truncateToWidth wraps its ellipsis in resets, which would leak escape
    // codes into a layout that is supposed to be plain text until it is themed.
    if (room > 0) {
      clamped.push({ ...segment, text: stripTerminalSequences(truncateToWidth(segment.text, room, "…")) });
    }
    return clamped;
  }
  return clamped;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/**
 * Build the card.
 *
 * Everything derived — the phase tree, the header counts, the logs, the size
 * warning — comes from `progress.ts`; what happens here is purely arrangement.
 */
export function layoutWorkflowCard(input: WorkflowCardInput): WorkflowCardLine[] {
  const glyphs = input.ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;
  const width = Math.max(1, input.width ?? DEFAULT_WIDTH);
  const now = input.now ?? Date.now();

  const summaries = roundSummaries(input.progress, input.version);
  // The round in flight, and the only one drawn in full. `undefined` for a run
  // that has not looped, which keeps every surface's single-round shape.
  const liveRound = summaries.length > 1 ? summaries[summaries.length - 1]?.index : undefined;
  const earlier = earlierRounds(summaries, input.archived);
  const tree = buildPhaseTree(input.progress, input.meta?.phases, {
    ...(liveRound !== undefined ? { round: liveRound } : {}),
    ...(input.version !== undefined ? { version: input.version } : {}),
  });
  const nodes = flattenPhaseTree(tree);
  const { agents, logs } = collapse(input.progress);
  const totals = stats(input.progress, input.agentCount ?? 0);
  const head = header(input.task, input.meta, tree, input.agentCount ?? 0, now, summaries, input.archived);

  // The live round can itself be a huge fan-out, so the rows are budgeted. The
  // oldest settled rows go first; live ones are never dropped.
  const drawnAgents = nodes.flatMap(node => node.agents);
  const hiddenAgents = new Set<number>();
  if (drawnAgents.length > CARD_AGENT_ROW_BUDGET) {
    const isLiveRow = (agent: WorkflowAgentEntry) => agent.state === "start" || agent.state === "progress";
    const liveRows = drawnAgents.filter(isLiveRow).length;
    const settledRows = drawnAgents.filter(agent => !isLiveRow(agent)).sort((a, b) => a.index - b.index);
    const room = Math.max(0, CARD_AGENT_ROW_BUDGET - liveRows);
    for (const agent of settledRows.slice(0, Math.max(0, settledRows.length - room))) hiddenAgents.add(agent.index);
  }

  const lines: WorkflowCardLine[] = [];

  // ---- Header: `<name>` with the stats flush right ----
  // The tool name appears only when nothing above the card already carries it.
  // As a tool result there is a `▸ SubagentWorkflow …` call line directly above,
  // and repeating it put two near-identical pointer lines back to back.
  const left: WorkflowCardLine = input.showToolTitle
    ? [
        { text: `${glyphs.pointer} `, color: "toolTitle" },
        { text: "SubagentWorkflow", color: "toolTitle", bold: true },
        { text: "  " },
        { text: head.name, color: "muted" },
      ]
    : [{ text: "  " }, { text: head.name, color: "toolTitle", bold: true }];
  const statsWidth = visibleWidth(head.stats);
  const clampedLeft = clampLine(left, Math.max(0, width - statsWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - statsWidth);
  lines.push([...clampedLeft, { text: " ".repeat(gap) }, { text: head.stats, color: "dim" }]);

  if (head.subtext) lines.push(clampLine([{ text: `  ${head.subtext}`, color: "dim" }], width));

  // ---- Every round before the live one, as one line ----
  // A loop's history has no end, so it can only be a summary. Drawn above the
  // tree because that is where it sits in time: the reader sees what has been
  // done, then what is happening.
  if (earlier !== undefined) {
    const span = earlier.from === earlier.to ? `round ${earlier.from}` : `rounds ${earlier.from}–${earlier.to}`;
    const parts = [span, `${formatCompactTokens(earlier.agents)} agent${earlier.agents === 1 ? "" : "s"}`];
    if (earlier.failed > 0) parts.push(`${earlier.failed} failed`);
    if (earlier.tokens > 0) parts.push(`${formatCompactTokens(earlier.tokens)} tok`);
    if (earlier.durationMs > 0) parts.push(formatDuration(earlier.durationMs));
    lines.push(clampLine([{ text: `  ${glyphs.folded} ${parts.join(" · ")}`, color: "dim" }], width));
  }

  // ---- Phase tree ----
  // Stats line up in one column across the whole card, not per group, so the
  // eye can scan them; a label past the cap just pushes its own stats along.
  const labelColumn = Math.min(
    LABEL_COLUMN_MAX,
    Math.max(0, ...nodes.flatMap(node => node.agents.map(a => visibleWidth(a.label)))),
  );

  nodes.forEach((node, nodeIndex) => {
    const lastGroup = nodeIndex === nodes.length - 1;
    // A nested run's phases sit one level in, and say so with two columns
    // rather than a second box: the gutter is already drawing the tree.
    const indent = "  ".repeat(node.depth);
    const counts: WorkflowCardLine = [];
    if (node.total > 0) {
      // Settled, not succeeded — a failed agent ran, and `2/3` next to a ✘
      // reads as an agent that never got a turn.
      counts.push({ text: `${node.settled}/${node.total}`, color: "dim" });
      if (node.failed > 0) counts.push({ text: ` ${glyphs.cross} ${node.failed}`, color: "error" });
    }
    const head_: WorkflowCardLine = [
      { text: "  " },
      // One box, not a stack of them: only the first row opens it and only the
      // last closes it. Everything between branches off the side, or three
      // phases read as three half-drawn boxes.
      {
        text: `${
          lastGroup ? glyphs.groupBottom
          : nodeIndex === 0 ? glyphs.groupTop
          : glyphs.groupMid
        } `,
        color: "dim",
      },
      { text: indent },
      { text: node.label },
    ];
    // Counts flush right, in one column down the card, so a nested row reads as
    // part of the same table rather than as a different kind of line.
    const countsWidth = counts.reduce((sum, s) => sum + visibleWidth(s.text), 0);
    const gap = countsWidth > 0 ? Math.max(1, width - lineWidth(head_) - countsWidth) : 0;
    lines.push(
      clampLine(
        countsWidth > 0 ? [...head_, { text: " ".repeat(gap) }, ...counts] : head_,
        width,
      ),
    );

    const rail = lastGroup ? "  " : `${glyphs.vertical} `;
    const visibleAgents = node.agents.filter(agent => !hiddenAgents.has(agent.index));
    visibleAgents.forEach((entry, agentIndex) => {
      const lastAgent = agentIndex === visibleAgents.length - 1;
      const segments: WorkflowCardLine = [
        { text: "  " },
        { text: rail, color: "dim" },
        { text: `${lastAgent ? glyphs.lastBranch : glyphs.branch} `, color: "dim" },
        rowGlyph(entry, glyphs),
        { text: " " },
      ];

      // Prepended rather than folded into `agentStatSegments`, which is the
      // ported stat tail in its recovered order. A replayed agent otherwise
      // renders as a tick with no tokens and no duration — indistinguishable
      // from one that somehow did the work for free.
      const statParts = entry.cached
        ? [REPLAYED_ANNOTATION, ...agentStatSegments(entry)]
        : agentStatSegments(entry);
      const pad = Math.max(0, labelColumn - visibleWidth(entry.label));
      segments.push({ text: statParts.length > 0 ? entry.label + " ".repeat(pad) : entry.label });
      for (const part of statParts) {
        segments.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
      }
      lines.push(clampLine(segments, width));
    });
  });

  // ---- Rows the budget folded away ----
  if (hiddenAgents.size > 0) {
    const noun = hiddenAgents.size === 1 ? "agent" : "agents";
    lines.push(
      clampLine(
        [
          { text: `  ${glyphs.folded} ${hiddenAgents.size} earlier ${noun} · `, color: "dim" },
          { text: "/agents → Workflows", color: "dim" },
        ],
        width,
      ),
    );
  }

  // ---- log() output, below the tree ----
  // A looping run's log is unbounded, so only its tail is drawn and the count of
  // the rest is named rather than the lines being silently cut.
  const logTail = earlier === undefined ? logs : logs.slice(-CARD_LOG_LINES);
  const droppedLogs = logs.length - logTail.length;
  if (droppedLogs > 0) {
    const noun = droppedLogs === 1 ? "message" : "messages";
    lines.push(clampLine([{ text: `  ${glyphs.folded} ${droppedLogs} earlier ${noun}`, color: "dim" }], width));
  }
  for (const message of logTail) {
    const [first, ...rest] = message.split("\n");
    lines.push(clampLine([{ text: `  ${glyphs.log}  ${first}`, color: "dim" }], width));
    for (const continuation of rest) {
      lines.push(clampLine([{ text: `     ${continuation}`, color: "dim" }], width));
    }
  }

  // ---- Size warning ----
  // Measured per round once a run loops: the run's own total is unbounded by
  // design, so a warning against it would fire from the first hour and stay on
  // forever, which is how a warning becomes wallpaper.
  const scopedAgents = liveRound === undefined ? agents : agents.filter(agent => roundOf(agent) === liveRound);
  const scopedTokens = scopedAgents.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0);
  const warning = sizeWarning({
    scheduledAgents:
      liveRound === undefined ? Math.max(input.agentCount ?? 0, totals.total) : Math.max(scopedAgents.length, 1),
    startedAgents: scopedAgents.filter(
      entry => entry.state === "done" || entry.state === "error" || entry.startedAt !== undefined,
    ).length,
    totalTokens: liveRound === undefined ? (input.totalTokens ?? scopedTokens) : scopedTokens,
    agentCap: input.agentCap,
    tokenCap: input.tokenCap,
  });
  if (warning) {
    const subject = liveRound === undefined ? "Large workflow" : "Large round";
    lines.push(
      clampLine([{ text: `  ${glyphs.warning} ${subject} · /agents → Workflows to stop`, color: "warning" }], width),
    );
  }

  return lines;
}

/* ------------------------------------------------------------------------- *
 * Rendering
 * ------------------------------------------------------------------------- */

/** The card as plain text — what the layout tests assert against. */
export function plainWorkflowCardLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

/** Apply the theme. Nothing here changes the layout, only its colours. */
export function styleWorkflowCardLines(lines: readonly WorkflowCardLine[], theme: Theme): string[] {
  return lines.map(line =>
    line
      .map(segment => {
        const text = segment.bold ? theme.bold(segment.text) : segment.text;
        return segment.color ? theme.fg(segment.color, text) : text;
      })
      .join(""),
  );
}

/** The card as a component, for a tool result or a session entry renderer. */
export function renderWorkflowCard(input: WorkflowCardInput, theme: Theme): Text {
  return new Text(styleWorkflowCardLines(layoutWorkflowCard(input), theme).join("\n"), 0, 0);
}

/**
 * The card for a session entry, from the JSON a flag-launched run persisted.
 *
 * The same layout the tool result uses, not a second one — the only difference
 * is `showToolTitle`, because a session entry stands alone and nothing above it
 * says what it is. Returns undefined for an entry with no data, which is what
 * pi's renderer contract wants for "nothing to draw".
 */
export function renderWorkflowEntryCard(data: WorkflowEntryData | undefined, theme: Theme): Text | undefined {
  if (!data) return undefined;
  return renderWorkflowCard(
    {
      progress: data.progress,
      task: {
        status: data.status,
        workflowName: data.name,
        startTime: data.startTime,
        endTime: data.endTime,
      },
      meta: data.meta,
      agentCount: data.agentCount,
      totalTokens: data.totalTokens,
      version: data.version,
      ...(data.archived !== undefined ? { archived: data.archived } : {}),
      showToolTitle: true,
    },
    theme,
  );
}
