/**
 * agent-widget.ts — Rendering primitives and pure row builders for subagent surfaces.
 *
 * The live agent tree is composed by FleetList (fleet-list.ts), which owns the
 * below-editor widget, the spinner frame, and the overflow cap. The builders here
 * emit row *content* — no tree connectors, cursor column, or truncation — so the
 * same typography feeds the live view and the conversation viewer.
 */

import { renderAgentName } from "../agent-color.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, EffectiveThinkingLevel, SubagentType } from "../types.js";
import { getLifetimeCost, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

// ---- Constants ----

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  /** Context-window utilization percentage, or null when unavailable. */
  contextPercent?: number | null;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show.
 *
 * The tilde is load-bearing: this is pi's own estimate from the model's listed
 * rates, not a billed figure, and the surfaces that print it sit next to token
 * counts that ARE exact.
 *
 * Nothing is printed for zero, which is also what a model with no pricing data
 * reports: `$0.00` beside a local model's tokens would claim its cost was
 * measured and found to be nothing, rather than never measured at all. For the
 * same reason a real cost too small for four decimals reads `<$0.0001` — it was
 * measured, and rounding it to `~$0.0000` would say the opposite.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";                     // also catches NaN
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  // Under a dollar: cents at minimum, four decimals at most, nothing trailing.
  // Most single runs land between a tenth of a cent and a dime, where rounding
  // to cents would collapse a 4x difference in spend into the same figure.
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
/**
 * Context-window utilization with the shared color thresholds, e.g. `45%`.
 * Extracted so the viewer's footer and the token annotation cannot drift apart.
 */
export function formatContextAnnotation(percent: number, theme: Theme): string {
  const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
  return theme.fg(color, `${Math.round(percent)}%`);
}

/** Add the shared context-fill annotation to a preformatted token count. */
export function formatTokensWithContext(
  tokens: string,
  percent: number | null | undefined,
  theme: Theme,
): string {
  if (percent == null) return tokens;
  const context = formatContextAnnotation(percent, theme);
  return tokens ? `${tokens} (${context})` : context;
}

export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    annot.push(formatContextAnnotation(percent, theme));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/**
 * Mode label is not included — callers add it where they want it.
 *
 * Both model forms come back so each surface can pick by width; the
 * "(asked X)" annotation is applied here rather than by callers, so a value the
 * spawn did not honor cannot be rendered as though it had been (#182).
 */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined): string | undefined =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (thinking) tags.push(`thinking: ${thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground) tags.push("background");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  return {
    modelName: asked(invocation.modelName, invocation.requestedModel),
    modelId: asked(invocation.modelId, invocation.requestedModel),
    tags,
  };
}

/** Thinking level → the one-or-two character label the widget prints. */
const EFFORT_ABBREVIATIONS: Record<EffectiveThinkingLevel, string> = {
  off: "off",
  // Folded into `L`: pi resolves `minimal` to each model's own floor, so two
  // rows reading `L` is truer than implying a distinction the row cannot carry.
  minimal: "L",
  low: "L",
  medium: "M",
  high: "H",
  xhigh: "XH",
  max: "MX",
};

/** The widget's name-tag payload, e.g. `DSv4Pro/H`; undefined when the model is unknown. */
export function formatModelEffortTag(invocation: AgentInvocation | undefined): string | undefined {
  const model = invocation?.modelShort;
  if (!model) return undefined;
  const effort = invocation?.thinking ? EFFORT_ABBREVIATIONS[invocation.thinking] : undefined;
  return effort ? `${model}/${effort}` : model;
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Live row builders ----
//
// These return row *content* only: no tree connectors, no cursor column, no
// truncation. The below-editor surface (fleet-list.ts) composes them into a tree
// and owns the decorations, so the two cannot drift apart. This module stays a
// pure rendering/helper library — the widget class that once lived here (with its
// own timers and pi-widget registration) was retired when the live fleet view
// moved below the editor into FleetList.

/** Structural subset of `AgentRecord` the row builders read. */
export interface LiveAgent {
  id: string;
  type: SubagentType;
  status: string;
  description: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  lifetimeUsage?: LifetimeUsage;
  invocation?: AgentInvocation;
}

/** Settings read at render time by the row builders. */
export interface LiveRowOptions {
  theme: Theme;
  /** Current spinner frame index. */
  frame: number;
  showCost: boolean;
  showModel: boolean;
}

/**
 * The parenthetical after an agent's name: the model/effort pair when
 * `showModel` is on and the model is known, else the prompt-mode label — so the
 * tag keeps meaning something while the setting is off.
 */
function liveNameTag(type: SubagentType, invocation: AgentInvocation | undefined, opts: LiveRowOptions): string {
  const label = (opts.showModel ? formatModelEffortTag(invocation) : undefined) ?? getPromptModeLabel(type);
  return label ? ` ${opts.theme.fg("dim", `(${label})`)}` : "";
}

/** A running agent's two content lines: the header line and its `⎿ activity` line. */
export function buildRunningAgentRow(
  a: LiveAgent,
  activity: AgentActivity | undefined,
  opts: LiveRowOptions,
): [string, string] {
  const theme = opts.theme;
  const elapsed = formatMs(Date.now() - a.startedAt);
  // Context comes from the live session — only a running agent has one — while
  // spend comes from the record, which is the one that survives the agent
  // finishing and the one nested-tools folds a hidden child's spend into.
  const contextPercent = getSessionContextPercent(activity?.session);
  const costText = opts.showCost ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

  const parts: string[] = [];
  if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
  if (contextPercent !== null) parts.push(formatContextAnnotation(contextPercent, theme));
  if (costText) parts.push(costText);
  parts.push(elapsed);
  const statsText = parts.join(" · ");

  const described = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
  return [
    `${theme.fg("accent", SPINNER[opts.frame % SPINNER.length])} ${renderAgentName(a.type, theme, { bold: true })}${liveNameTag(a.type, a.invocation, opts)}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`,
    theme.fg("dim", `  ⎿  ${described}`),
  ];
}

/** A settled agent's single content line (completed / steered / stopped / error / aborted). */
export function buildSettledAgentRow(
  a: LiveAgent,
  activity: AgentActivity | undefined,
  opts: LiveRowOptions,
): string {
  const theme = opts.theme;
  const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

  let icon: string;
  let statusText: string;
  if (a.status === "completed") {
    icon = theme.fg("success", "✓");
    statusText = "";
  } else if (a.status === "steered") {
    icon = theme.fg("warning", "✓");
    statusText = theme.fg("warning", " (turn limit)");
  } else if (a.status === "stopped") {
    icon = theme.fg("dim", "■");
    statusText = theme.fg("dim", " stopped");
  } else if (a.status === "error") {
    icon = theme.fg("error", "✗");
    const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
    statusText = theme.fg("error", ` error${errMsg}`);
  } else {
    // aborted
    icon = theme.fg("error", "✗");
    statusText = theme.fg("warning", " aborted");
  }

  const parts: string[] = [];
  if (activity) parts.push(formatTurns(activity.turnCount, activity.maxTurns));
  // From the record, not the activity tracker: that entry is deleted the
  // moment an agent finishes, and "what did it cost" is a question asked
  // about finished agents.
  const costText = opts.showCost ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
  if (costText) parts.push(costText);
  parts.push(duration);

  return `${icon} ${renderAgentName(a.type, theme, { fallbackColor: "dim" })}${liveNameTag(a.type, a.invocation, opts)}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
}

/** The queued-agents summary content, e.g. `◦ 2 queued`. */
export function buildQueuedRow(count: number, theme: Theme): string {
  return `${theme.fg("muted", "◦")} ${theme.fg("dim", `${count} queued`)}`;
}
