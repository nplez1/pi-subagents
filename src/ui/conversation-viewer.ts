/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 *
 * Messages are rendered with pi's own transcript components — the same ones the
 * main chat uses — so the overlay reads like the primary UI: markdown for
 * assistant text, the built-in colored tool shells (read headers, edit diffs,
 * `$ command` blocks), collapsed tool-output previews, and proper user blocks.
 *
 * A raw text fallback is kept for the case where a component cannot be built
 * (e.g. this process never called `initTheme()`, which the components read
 * through pi's global theme).
 */

import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  getSelectListTheme,
  ToolExecutionComponent,
  type TruncationResult,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type EditorTheme, type MarkdownTheme, matchesKey, type SelectListTheme, Spacer, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatContextAnnotation, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

/** Base lines consumed by chrome: top border + header + header sep + footer sep + hints + status + bottom border. */
const CHROME_LINES_BASE = 7;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 90;

/**
 * Cap on a single tool result or bash output before the *raw fallback* elides
 * the rest. The component path handles truncation itself (each renderer or
 * `ToolExecutionComponent` previews and expands), so this only bounds the
 * degraded renderer.
 */
export const RESULT_MAX_CHARS = 16_000;

/** A message from the child session, as this overlay consumes it. */
type ViewerMessage = AgentSession["messages"][number];

/** Anything with pi's collapsed/expanded contract. */
interface Expandable {
  setExpanded(expanded: boolean): void;
}

/**
 * Structural subset of pi-tui's `TuiMouseEvent`. The pi-tui version this package
 * typechecks against (0.84) predates mouse support; at runtime the loader aliases
 * pi-tui to pi's own copy (0.87+), so these fields are present even though the
 * typings are not.
 */
export interface ViewerMouseEvent {
  type: string;
  button: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One transcript component's slice of the rendered content lines. */
export interface ViewerContentEntry {
  component: Component;
  /** First content line index this component produced. */
  start: number;
  /** How many lines it produced (its rendered height). */
  height: number;
}

/**
 * The content line under an overlay-local click row, resolved to the component
 * that produced it. Pure, so the geometry is testable without a TUI.
 *
 * `y` is relative to the overlay box (row 0 is the top border), `contentTop` is
 * the first content row, `visibleStart` the scroll offset, and rows outside the
 * viewport miss.
 */
export function hitTestContent(
  layout: readonly ViewerContentEntry[],
  y: number,
  contentTop: number,
  viewportHeight: number,
  visibleStart: number,
): { component: Component; localY: number; height: number } | undefined {
  const rel = y - contentTop;
  if (rel < 0 || rel >= viewportHeight) return undefined;
  const line = visibleStart + rel;
  for (const entry of layout) {
    if (line >= entry.start && line < entry.start + entry.height) {
      return { component: entry.component, localY: line - entry.start, height: entry.height };
    }
  }
  return undefined;
}

/** Column where a content component's own x=0 sits inside a bordered row (`│ `). */
const CONTENT_X = 2;

/** Cheap content weight for one message; only the last message needs re-checking as it streams. */
function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      n += (part as { text: string }).text.length;
    }
  }
  return n;
}

/** Serialized size of tool-call args, or 0 when they cannot be serialized. */
function argsLength(args: unknown): number {
  try {
    return JSON.stringify(args)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The user-facing theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what makes the components match the main UI. It has to be
 * *probed* rather than try/caught around the call: `getMarkdownTheme()` returns
 * arrow functions that read pi's global theme lazily, so an uninitialized theme
 * throws inside `render()` — long after this returns. That is the case in tests
 * and any embedded session that never called `initTheme()`, where the whole
 * component path is abandoned for the raw fallback.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * pi's select-list theme when this process initialized one, else `undefined`.
 *
 * Probed the same way as the markdown theme, and for the same reason: the
 * functions read pi's global theme lazily, so an uninitialized theme throws at
 * render time rather than at this call.
 */
function probeSelectListTheme(): SelectListTheme | undefined {
  try {
    const theme = getSelectListTheme();
    theme.selectedText("probe");
    return theme;
  } catch {
    return undefined;
  }
}

/**
 * The editor's select list is only reached by autocomplete, which the viewer
 * never wires — so this fallback costs no feature, only a colour choice.
 */
function fallbackSelectListTheme(th: Theme): SelectListTheme {
  return {
    selectedPrefix: text => th.fg("accent", text),
    selectedText: text => th.bold(text),
    description: text => th.fg("muted", text),
    scrollInfo: text => th.fg("dim", text),
    noMatch: text => th.fg("dim", text),
  };
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it — the notice is the viewer's chrome, not the tool's output.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  private keys: ViewerKeys;
  /** The steering editor — pi's own, built on first render for a steerable agent. */
  private editor: Editor | undefined;
  /** Its height last frame, so the viewport can reserve the rows before it renders. */
  private editorRows = 0;
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** The child session's working directory, for path renderers. */
  private readonly cwd: string;
  /** Whether every tool/bash block is expanded (`t`). */
  private toolsExpanded = false;

  // ---- Transcript components (the main-UI path) ----
  /** Flat list of components currently making up the transcript (with spacers). */
  private transcript: Component[] = [];
  private messageComponents = new WeakMap<object, Component[]>();
  private messageSignatures = new WeakMap<object, string>();
  private toolComponents = new Map<string, ToolExecutionComponent>();
  private toolArgSigs = new Map<string, number>();
  private expandables = new Set<Expandable>();
  /** Set when the component path fails, so `render()` stops retrying it every frame. */
  private componentsFailed = false;

  // ---- Rendered-line cache ----
  private contentSig = "";
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private dirty = true;
  /** Per-component content-line ranges, for routing mouse clicks to a tool block. */
  private contentLayout: ViewerContentEntry[] = [];
  /** First content row in the overlay box, captured each render for the same routing. */
  private lastContentTop = 0;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
  ) {
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.cwd = session.sessionManager?.getCwd?.() ?? process.cwd();
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) return;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    // The wheel is read first: it is the one input that arrives as a raw escape
    // sequence, and the editor would otherwise take it as typing.
    const wheelLines = this.keys.wheelLines(data);
    if (wheelLines !== undefined) {
      const { maxScroll } = this.scrollBounds();
      this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + wheelLines));
      this.autoScroll = this.scrollOffset >= maxScroll;
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Actions keep their wording but leave the printable keys alone: with the
    // editor always focused, "x" and "t" are characters now.
    if (matchesKey(data, "ctrl+t")) {
      this.toggleTools();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first Ctrl+X arms, second confirms — any other key disarms.
    if (matchesKey(data, "ctrl+x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    // Paging outlives the editor because the arrows do not: they belong to the
    // message being typed, exactly as they do in the main chat.
    const { maxScroll, viewportHeight } = this.scrollBounds();
    if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
      return;
    }
    if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
      return;
    }

    // Everything else is the message, for as long as the agent can take one.
    if (this.canSteer()) {
      this.ensureEditor().handleInput(data);
      this.tui.requestRender();
      return;
    }

    // A finished agent has no editor, so the transcript takes the arrows back.
    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  /**
   * Route a left click inside the overlay to the transcript component under the
   * pointer, so tool/bash blocks expand and collapse exactly as they do in the
   * main chat. pi's `ToolExecutionComponent` exposes its toggle through a
   * `MouseRegion`; the main chat reaches it by hit-testing its chat `Container`,
   * and this overlay — which is not a container — does the same hit-test here.
   *
   * Only clicks are routed. Everything else returns `undefined` so pi's own
   * text-selection and wheel handling stay in charge (the wheel still arrives as
   * raw bytes through `handleInput`).
   */
  handleMouse(event: ViewerMouseEvent): { handled: true } | undefined {
    if (event.type !== "click" || (event.button & 3) !== 0) return undefined;
    const innerW = this.lastInnerW;
    if (innerW <= 0) return undefined;

    const { maxScroll, viewportHeight } = this.scrollBounds();
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const target = hitTestContent(this.contentLayout, event.y, this.lastContentTop, viewportHeight, visibleStart);
    if (!target) return undefined;

    const child = target.component as Component & { handleMouse?: (e: ViewerMouseEvent) => unknown };
    if (typeof child.handleMouse !== "function") return undefined;
    const hit = child.handleMouse({
      ...event,
      x: event.x - CONTENT_X,
      y: target.localY,
      width: innerW,
      height: target.height,
    });
    if (!hit) return undefined;

    // Expanding a tool changes its rendered height, which the cached-line
    // signature does not track (it only knows the global Ctrl+T state), so the
    // cache has to be invalidated explicitly or the toggle would not show.
    this.dirty = true;
    this.tui.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    if (width < 6) return []; // too narrow for any meaningful rendering
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    // Header
    lines.push(hrTop);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const duration = formatDuration(this.record.startedAt, this.record.completedAt);

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend. Context and cost sit in the footer instead.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      headerParts.push(formatSessionTokens(tokens, null, th, this.record.compactionCount));
    }

    lines.push(row(
      `${statusIcon} ${renderAgentName(this.record.type, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    ));
    const invocationLine = this.invocationLine();
    if (invocationLine) lines.push(row(invocationLine));
    lines.push(hrMid);
    // Content starts on the next row; recorded so a mouse click can be mapped
    // back to the transcript line and component it landed on.
    this.lastContentTop = lines.length;

    // The editor's rows are reserved before the viewport is computed, so a
    // growing message shrinks the transcript rather than pushing the frame past
    // the overlay's maxHeight.
    const editorLines = this.editorLines(innerW);

    // Content area — rendered from the cached line list; rebuilt only when the
    // transcript actually changes (not on every scroll key).
    const contentLines = this.renderContent(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

    for (let i = 0; i < viewportHeight; i++) {
      lines.push(row(visible[i] ?? ""));
    }

    // Footer — the editor, its hints, then the stats line the main chat keeps
    // at the bottom. `row()` frames each so the box sits inside the overlay.
    lines.push(hrMid);
    for (const editorLine of editorLines) lines.push(row(editorLine));
    lines.push(row(this.hintRow(innerW)));
    lines.push(row(this.statusRow(innerW, contentLines.length, visibleStart, viewportHeight)));
    lines.push(hrBot);

    return lines;
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /**
   * The steering editor, built on first use. It is pi's own `Editor` — the main
   * chat's input — so steering looks and edits like typing there.
   */
  private ensureEditor(): Editor {
    if (this.editor) return this.editor;
    const editor = new Editor(
      this.tui,
      {
        borderColor: text => this.theme.fg("border", text),
        selectList: probeSelectListTheme() ?? fallbackSelectListTheme(this.theme),
      },
      { paddingX: 1 },
    );
    editor.focused = true;
    editor.onSubmit = (text: string) => this.submitSteer(text);
    this.editor = editor;
    return editor;
  }

  /** Send the editor's text as a steer message and clear the box. */
  private submitSteer(text: string): void {
    const message = text.trim();
    this.editor?.setText("");
    if (message) this.onSteer?.(message);
    this.tui.requestRender();
  }

  /** Expand/collapse every tool and bash block (`Ctrl+T`). */
  private toggleTools(): void {
    this.stopArmed = false;
    this.toolsExpanded = !this.toolsExpanded;
    for (const c of this.expandables) c.setExpanded(this.toolsExpanded);
    this.dirty = true;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.editor?.invalidate();
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    for (const c of this.transcript) (c as { dispose?: () => void }).dispose?.();
    this.transcript = [];
    this.contentLayout = [];
    this.toolComponents.clear();
    this.toolArgSigs.clear();
    this.expandables.clear();
  }

  // ---- Private ----

  private viewportHeight(): number {
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer.
    const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  private chromeLines(): number {
    // The hint and status rows are in the base; only the editor's box grows.
    return CHROME_LINES_BASE + (this.invocationLine() ? 1 : 0) + (this.canSteer() ? this.editorRows : 0);
  }

  /** Bounds every scroll path needs; the editor can change the viewport mid-frame. */
  private scrollBounds(): { totalLines: number; viewportHeight: number; maxScroll: number } {
    const totalLines = this.renderContent(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    return { totalLines, viewportHeight, maxScroll: Math.max(0, totalLines - viewportHeight) };
  }

  /** The steering editor's box, or `[]` when the agent can no longer be steered. */
  private editorLines(width: number): string[] {
    if (!this.canSteer()) {
      this.editorRows = 0;
      return [];
    }
    const lines = this.ensureEditor().render(width);
    this.editorRows = lines.length;
    return lines;
  }

  /** Spawn parameters other than the model, which the footer carries. */
  private invocationLine(): string | undefined {
    const { tags } = buildInvocationTags(this.record.invocation);
    if (tags.length === 0) return undefined;
    return this.theme.fg("dim", `  ↳ ${tags.join(" · ")}`);
  }

  /** Actions on the left, navigation on the right — the keys the editor leaves free. */
  private hintRow(innerW: number): string {
    const th = this.theme;
    const actions: string[] = [];
    if (this.canSteer()) actions.push(th.fg("accent", "✎ Enter send"));
    if (this.isStoppable()) {
      actions.push(this.stopArmed ? th.fg("error", "⌃x again to STOP") : th.fg("dim", "⌃x stop"));
    }
    actions.push(th.fg("dim", this.toolsExpanded ? "⌃t collapse" : "⌃t tools"));
    const nav = this.canSteer()
      ? "PgUp/PgDn scroll · Esc close"
      : "↑↓ or j/k scroll · PgUp/PgDn · Esc close";
    const left = actions.join(th.fg("dim", " · "));
    const right = th.fg("dim", nav);
    const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }

  /** Model, cost and context under the editor, where the main chat keeps its stats. */
  private statusRow(innerW: number, totalLines: number, visibleStart: number, viewportHeight: number): string {
    const th = this.theme;
    const parts: string[] = [];
    const model = this.modelLabel();
    if (model) parts.push(th.fg("accent", model));
    if (this.showCost) {
      const cost = formatCost(getLifetimeCost(this.record.lifetimeUsage));
      if (cost) parts.push(th.fg("dim", cost));
    }
    const percent = getSessionContextPercent(this.activity?.session);
    if (percent !== null) parts.push(formatContextAnnotation(percent, th));

    const scrollPct = totalLines <= viewportHeight
      ? "100%"
      : `${Math.round(((visibleStart + viewportHeight) / totalLines) * 100)}%`;
    const left = parts.join(th.fg("dim", " · "));
    const right = th.fg("dim", `${totalLines} lines · ${scrollPct}`);
    const gap = Math.max(1, innerW - visibleWidth(left) - visibleWidth(right));
    return left + " ".repeat(gap) + right;
  }

  /** The session's live model, falling back to the one the spawn asked for. */
  private modelLabel(): string | undefined {
    const live = this.session.model;
    if (live) return live.name || live.id;
    const { modelName, modelId } = buildInvocationTags(this.record.invocation);
    return modelName ?? modelId;
  }

  // ---- Content rendering ----

  /** Cached transcript lines for `width`; rebuilds only when the content changed. */
  private renderContent(width: number): string[] {
    if (width <= 0) return [];
    const sig = this.contentSignature();
    if (!this.dirty && sig === this.contentSig && width === this.cachedWidth) {
      return this.cachedLines;
    }
    this.contentSig = sig;
    this.cachedWidth = width;
    this.dirty = false;

    if (!this.componentsFailed) {
      const lines = this.tryBuildComponentLines(width);
      if (lines) {
        this.cachedLines = lines;
        return lines;
      }
      this.componentsFailed = true;
    }
    this.cachedLines = this.buildRawLines(width);
    return this.cachedLines;
  }

  /** Cheap key over everything that can change the rendered transcript. */
  private contentSignature(): string {
    const messages = this.session.messages;
    const last = messages[messages.length - 1];
    const lastSig = last ? this.messageSignature(last) : "";
    const act = this.activity
      ? `${this.activity.activeTools.size}:${this.activity.responseText.length}:${this.activity.turnCount}`
      : "";
    return `${messages.length}|${lastSig}|${this.toolsExpanded ? 1 : 0}|${this.record.status}|${this.record.toolUses}|${act}`;
  }

  /** Per-message weight; only the streaming tail changes between syncs. */
  private messageSignature(msg: ViewerMessage): string {
    const m = msg as any;
    switch (m.role) {
      case "user":
        return `u:${textLength(m.content)}`;
      case "assistant": {
        let n = 0;
        for (const c of m.content ?? []) {
          if (c?.type === "text") n += c.text?.length ?? 0;
          else if (c?.type === "thinking") n += c.thinking?.length ?? 0;
          else if (c?.type === "toolCall") n += (c.id?.length ?? 0) + (c.name?.length ?? 0) + argsLength(c.arguments);
        }
        // The streaming flag is part of the signature so that when the agent
        // settles, the tail message is re-rendered as finished even though its
        // text did not change.
        const streaming = msg === this.session.messages[this.session.messages.length - 1] && this.record.status === "running";
        return `a:${n}:${m.stopReason ?? ""}:${m.errorMessage ?? ""}:${streaming ? 1 : 0}`;
      }
      case "toolResult":
        return `r:${textLength(m.content)}:${m.isError ? 1 : 0}`;
      case "bashExecution":
        return `b:${m.command ?? ""}:${m.output?.length ?? 0}:${m.exitCode ?? ""}:${m.cancelled ? 1 : 0}`;
      case "compactionSummary":
        return `cs:${m.summary?.length ?? 0}`;
      case "branchSummary":
        return `bs:${m.summary?.length ?? 0}`;
      default:
        return `${m.role ?? "?"}`;
    }
  }

  /** Build the component transcript and render it; `undefined` on any failure (→ raw fallback). */
  private tryBuildComponentLines(width: number): string[] | undefined {
    try {
      this.rebuildTranscript();
      const out: string[] = [];
      const layout: ViewerContentEntry[] = [];
      for (const component of this.transcript) {
        const childLines = component.render(width);
        layout.push({ component, start: out.length, height: childLines.length });
        out.push(...childLines);
      }
      this.contentLayout = layout;

      if (this.record.status === "running" && this.activity) {
        const act = describeActivity(this.activity.activeTools, this.activity.responseText);
        out.push("");
        out.push(this.theme.fg("accent", "▍ ") + this.theme.fg("dim", act));
      }
      if (out.length === 0) out.push(this.theme.fg("dim", "(waiting for first message...)"));
      return out.map(l => truncateToWidth(l, width));
    } catch {
      // A component render is on the TUI's critical path; degrade to the raw
      // text renderer rather than taking the overlay down. The component path is
      // not retried, since the throw would otherwise repeat every frame.
      this.transcript = [];
      this.contentLayout = [];
      this.toolComponents.clear();
      this.toolArgSigs.clear();
      this.expandables.clear();
      return undefined;
    }
  }

  /** Refresh the flat component list from the session's messages. */
  private rebuildTranscript(): void {
    const messages = this.session.messages;
    const lastIndex = messages.length - 1;
    const next: Component[] = [];
    let first = true;
    for (let i = 0; i < messages.length; i++) {
      const comps = this.componentsForMessage(messages[i], i === lastIndex);
      if (comps.length === 0) continue;
      if (!first) next.push(new Spacer(1));
      next.push(...comps);
      first = false;
    }
    this.transcript = next;
  }

  /**
   * Get-or-create the components for one message, updating cached ones in place.
   * Only the tail message is re-examined: everything before it is final, so its
   * signature cannot change and recomputing it would make every streaming tick
   * walk the whole transcript.
   */
  private componentsForMessage(msg: ViewerMessage, isTail: boolean): Component[] {
    const key = msg as unknown as object;
    const cached = this.messageComponents.get(key);
    if (cached && !isTail) return cached;

    const sig = this.messageSignature(msg);
    if (cached && this.messageSignatures.get(key) === sig) return cached;

    const comps = cached ?? [];
    this.updateMessageComponents(msg, comps, cached === undefined);
    this.messageComponents.set(key, comps);
    this.messageSignatures.set(key, sig);
    return comps;
  }

  private updateMessageComponents(msg: ViewerMessage, comps: Component[], created: boolean): void {
    const m = msg as any;
    switch (m.role) {
      case "user": {
        if (!created) return;
        const text = typeof m.content === "string" ? m.content : extractText(m.content);
        if (!text.trim()) return;
        comps.push(new UserMessageComponent(text.trim(), this.markdownTheme, 0));
        return;
      }
      case "assistant": {
        let assistant = comps[0] as AssistantMessageComponent | undefined;
        if (!assistant) {
          assistant = new AssistantMessageComponent(undefined, false, this.markdownTheme, undefined, 0);
          comps.push(assistant);
        }
        const streaming = msg === this.session.messages[this.session.messages.length - 1] && this.record.status === "running";
        assistant.updateContent(m, streaming);

        for (const call of m.content ?? []) {
          if (call?.type !== "toolCall" || !call.id) continue;
          let tool = this.toolComponents.get(call.id);
          if (!tool) {
            tool = new ToolExecutionComponent(
              call.name ?? "unknown",
              call.id,
              call.arguments,
              { showImages: false },
              this.toolDefinitionFor(call.name),
              this.tui,
              this.cwd,
            );
            tool.setExpanded(this.toolsExpanded);
            this.toolComponents.set(call.id, tool);
            this.toolArgSigs.set(call.id, argsLength(call.arguments));
            this.expandables.add(tool);
          } else {
            const argSig = argsLength(call.arguments);
            if (this.toolArgSigs.get(call.id) !== argSig) {
              this.toolArgSigs.set(call.id, argSig);
              tool.updateArgs(call.arguments);
            }
          }
          // The component is owned by the tool-call id, not by this message
          // object: if the session ever swaps the assistant message for a new
          // object, the tool block still has to reappear in the new list.
          if (!comps.includes(tool)) comps.push(tool);
          if (!streaming) tool.setArgsComplete();
        }
        return;
      }
      case "toolResult": {
        const tool = this.toolComponents.get(m.toolCallId);
        if (tool) {
          tool.setArgsComplete();
          tool.updateResult(m);
        }
        return;
      }
      case "bashExecution": {
        if (!created) return;
        const comp = new BashExecutionComponent(m.command, this.tui, m.excludeFromContext);
        if (m.output) comp.appendOutput(m.output);
        comp.setComplete(m.exitCode, m.cancelled, m.truncated ? ({ truncated: true } as unknown as TruncationResult) : undefined, m.fullOutputPath);
        comp.setExpanded(this.toolsExpanded);
        this.expandables.add(comp);
        comps.push(comp);
        return;
      }
      case "compactionSummary": {
        if (!created) return;
        const comp = new CompactionSummaryMessageComponent(m, this.markdownTheme);
        comp.setExpanded(this.toolsExpanded);
        this.expandables.add(comp);
        comps.push(comp);
        return;
      }
      case "branchSummary": {
        if (!created) return;
        const comp = new BranchSummaryMessageComponent(m, this.markdownTheme);
        comp.setExpanded(this.toolsExpanded);
        this.expandables.add(comp);
        comps.push(comp);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Renderer source for a tool: the child session's own definition when it
   * carries renderers, else the matching built-in definition (whose factory
   * spreads in the read/edit/bash/… renderers).
   */
  private toolDefinitionFor(name: string): any {
    let def: any;
    try {
      def = this.session.getToolDefinition(name);
    } catch {
      def = undefined;
    }
    const needsFallback = !def?.renderCall && !def?.renderResult;
    const builtIn = needsFallback ? this.builtInDefinition(name) : undefined;
    if (!def) return builtIn;
    if (!builtIn) return def;
    return {
      ...def,
      renderCall: def.renderCall ?? builtIn.renderCall,
      renderResult: def.renderResult ?? builtIn.renderResult,
      renderShell: def.renderShell ?? builtIn.renderShell,
    };
  }

  private builtInDefinition(name: string): any {
    try {
      switch (name) {
        case "read": return createReadToolDefinition(this.cwd);
        case "edit": return createEditToolDefinition(this.cwd);
        case "write": return createWriteToolDefinition(this.cwd);
        case "grep": return createGrepToolDefinition(this.cwd);
        case "find": return createFindToolDefinition(this.cwd);
        case "ls": return createLsToolDefinition(this.cwd);
        case "bash": return createBashToolDefinition(this.cwd);
        default: return undefined;
      }
    } catch {
      return undefined;
    }
  }

  /** Wrap `text` literally — the fallback renderer's line primitive. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /**
   * Verbatim renderer used only when the component path is unavailable. It keeps
   * the viewer legible rather than taking it down, at the cost of the main-UI
   * formatting.
   */
  private buildRawLines(width: number): string[] {
    if (width <= 0) return [];
    // Verbatim text has no components, so nothing is clickable in this path.
    this.contentLayout = [];
    const th = this.theme;
    const messages = this.session.messages;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    let needsSeparator = false;
    for (const msg of messages as any[]) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
        if (!text.trim()) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("accent", "[User]"));
        lines.push(...this.rawLines(text.trim(), width, false));
      } else if (msg.role === "assistant") {
        const textParts: string[] = [];
        const toolCalls: string[] = [];
        for (const c of msg.content ?? []) {
          if (c.type === "text" && c.text) textParts.push(c.text);
          else if (c.type === "toolCall") toolCalls.push(c.name ?? "unknown");
        }
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.bold("[Assistant]"));
        if (textParts.length > 0) {
          lines.push(...this.rawLines(textParts.join("\n").trim(), width, false));
        }
        for (const name of toolCalls) {
          lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
        }
      } else if (msg.role === "toolResult") {
        const { text, elided } = capResult(extractText(msg.content).trim());
        if (!text) continue;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(th.fg("dim", "[Result]"));
        lines.push(...this.rawLines(text, width, true));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      } else if (msg.role === "bashExecution") {
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${msg.command}`), width));
        if (msg.output?.trim()) {
          const { text, elided } = capResult(msg.output.trim());
          lines.push(...this.rawLines(text, width, true));
          if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    return lines.map(l => truncateToWidth(l, width));
  }
}
