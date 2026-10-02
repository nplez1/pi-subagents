/**
 * fleet-list.ts — The single below-editor live surface for subagents.
 *
 * Idle, it draws the live agent tree the above-editor widget used to: heading,
 * per-running-agent header + `⎿ activity` lines, settled rows, and a queued
 * summary. Pressing ↓ (or ←) at an empty prompt turns that *same* view into
 * selection mode in place — same heading, same rows, same indentation; it only
 * appends a hint to the heading and swaps a row's 2-space indent for a ❯ cursor
 * — so navigation feels like moving through the data already on screen. Enter
 * opens the selected agent's conversation overlay (`Ui.custom`); Esc (or ↑ past
 * the top) returns to the idle live view.
 *
 * Mechanics: one `belowEditor` widget (render-only) plus ALL key handling through
 * `onTerminalInput`, which fires before the focused editor and can `consume` keys,
 * gated on `getEditorText() === ""` so normal typing is untouched. Selection is
 * anchored by row *id* and re-resolved every render, because rows appear, settle
 * and drop out under the cursor while agents run.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, WidgetMode } from "../types.js";
import {
  type AgentActivity,
  buildQueuedRow,
  buildRunningAgentRow,
  buildSettledAgentRow,
  type LiveRowOptions,
  type Theme,
} from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Widget key for the below-editor fleet view. */
const FLEET_KEY = "fleet";
/** Re-render cadence so elapsed/token stats and the spinner tick while agents run. */
const TICK_MS = 120;
/** How long a settled agent lingers before its row drops out. */
const FINISHED_LINGER_MS = 4000;
/**
 * Total rendered lines before the rows are windowed. pi caps only the string-array
 * form of `setWidget`, not this component form, so without our own cap a large
 * fan-out would eat the terminal.
 */
const MAX_WIDGET_LINES = 12;
/** Hint appended to the heading row while the cursor is in the list. */
const HINT = "↑↓ select · enter view · esc back";
/** Sentinel id for the non-selectable queued-summary row. */
const QUEUED_ROW_ID = "queued-summary";

/** Minimal UI surface the fleet view needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setStatus(key: string, text: string | undefined): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet view needs to see it.
 *
 * Narrow on purpose: the view knows nothing about `WorkflowTask`, the runtime or
 * the dialog, so it stays as testable as it was when it only held agents. The
 * extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/** One rendered row: content lines the composer decorates with connectors and a cursor. */
export interface RenderRow {
  /** Row id the selection anchors on (a workflow or agent id; never a heading). */
  id: string;
  lines: string[];
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Spinner frame, advanced on every tick. */
  private frame = 0;

  /**
   * Whether navigation (↓/←, cursor, Enter→viewer) is available. The live tree
   * itself is governed by `widgetMode` and stays on screen either way — this
   * setting only turns off the selectable overlay, so a user who does not want
   * to navigate still sees live agents below the editor.
   */
  private enabled = true;
  /** Whether the cursor is in the list (vs. the idle live tree). */
  private active = false;
  /**
   * The selected row's id, not an index: rows settle and drop out while agents
   * run, so an index would silently slide onto a different agent. `""` means no
   * selection — there is no `main` row, because Esc/↑ already return to the
   * prompt and a heading that changes into a row was the confusing part.
   */
  private selectedId = "";
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;
  /** Last status-bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time. Which agents appear, exactly as the old
     * above-editor widget defined it: `off` shows none, `background` drops only
     * agents *known* to be foreground (`isBackground === false`), `all` shows
     * every top-level agent.
     */
    private mode: () => WidgetMode = () => "all",
    /**
     * Read live at render time. Whether each row names the model driving the
     * agent and the thinking level it runs at.
     */
    private showModel: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.active = false;
      this.selectedId = "";
    }
    this.update();
  }

  /**
   * Capture the UI context and (re)register the global input handler.
   *
   * `onTerminalInput` exists only in interactive mode, and a headless `ctx.ui`
   * still reaches the Agent tool — so subscribe only when it is there and let the
   * view stay render-only (it never is, since nothing renders without a UI).
   */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
    this.inputUnsub = typeof ui.onTerminalInput === "function"
      ? ui.onTerminalInput(data => this.handleKey(data))
      : undefined;
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Wire workflow runs into the view.
   *
   * Injected rather than constructed here because the fleet view predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /**
   * Called when an agent finishes. The viewer (if open on it) stays open so the
   * final output remains readable, and the row lingers briefly — just refresh.
   */
  onAgentFinished(_id: string): void {
    this.update();
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    if (this.ui && this.lastStatusText !== undefined) this.ui.setStatus("subagents", undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    this.selectedId = "";
    this.lastStatusText = undefined;
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui || typeof this.ui.setWidget !== "function") return;

    if (!this.hasContent()) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      if (this.lastStatusText !== undefined) { this.ui.setStatus("subagents", undefined); this.lastStatusText = undefined; }
      this.active = false;
      this.selectedId = "";
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the view is shown (e.g. after a re-enable)

    // Status bar — only call setStatus when the text actually changes.
    const running = this.runningAgents().length;
    const queued = this.queuedCount();
    const total = running + queued;
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    const newStatus = total > 0 ? `${parts.join(", ")} agent${total === 1 ? "" : "s"}` : undefined;
    if (newStatus !== this.lastStatusText) {
      this.ui.setStatus("subagents", newStatus);
      this.lastStatusText = newStatus;
    }

    this.frame++;

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /** Whether the given agent passes the live-view's `widgetMode` filter. */
  private widgetVisible(a: AgentRecord): boolean {
    switch (this.mode()) {
      case "off": return false;
      case "background": return a.isBackground !== false;
      default: return true;
    }
  }

  /**
   * Settled (completed/steered/stopped/error/aborted) agents that still linger,
   * earliest-launched first. A settled agent is only shown while its linger has
   * not expired — plus the one being viewed, so closing its overlay finds it
   * where it was.
   */
  private settledAgents(): AgentRecord[] {
    const now = Date.now();
    return this.manager.listAgents()
      .filter(a =>
        isTopLevelAgent(a) && this.widgetVisible(a)
        && a.status !== "running" && a.status !== "queued"
        && a.completedAt != null
        && (now - a.completedAt < FINISHED_LINGER_MS || a.id === this.viewingAgentId),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Running top-level agents, earliest-launched first. */
  private runningAgents(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && this.widgetVisible(a) && a.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** How many top-level agents are waiting in the concurrency queue. */
  private queuedCount(): number {
    if (this.mode() === "off") return 0;
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a) && this.widgetVisible(a) && a.status === "queued")
      .length;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Whether there is anything at all for the below-editor view to draw. */
  private hasContent(): boolean {
    return this.workflows().length > 0
      || this.settledAgents().length > 0
      || this.runningAgents().length > 0
      || this.queuedCount() > 0;
  }

  /**
   * Whether the live view has any active work — drives the `●`/`○` heading and
   * the footer status. A running workflow counts even though its own agents stay
   * out of the list.
   */
  private hasActiveWork(): boolean {
    return this.runningAgents().length > 0 || this.queuedCount() > 0 || this.workflows().length > 0;
  }

  /**
   * Selectable row ids in display order: workflows, running agents, then
   * lingering settled agents. Running rows lead so the first ↓ lands on
   * something live; the queued summary is a tail line, not a row. There is no
   * `main` row — Esc/↑ already return to the prompt.
   */
  private selectableIds(): string[] {
    return [
      ...this.workflows().map(w => w.id),
      ...this.runningAgents().map(a => a.id),
      ...this.settledAgents().map(a => a.id),
    ];
  }

  private clampSelection(): void {
    const ids = this.selectableIds();
    if (!ids.includes(this.selectedId)) this.selectedId = ids[0] ?? "";
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    if (this.viewerClose || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list. The live
      // tree is already on screen — this only adds the hint and the cursor.
      const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
      const ids = this.selectableIds();
      if (isActivator && ids.length > 0 && this.ui.getEditorText() === "") {
        this.active = true;
        this.selectedId = ids[0] ?? "";
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows move the cursor, Enter opens, Esc returns to the live view.
    const ids = this.selectableIds();
    const index = Math.max(0, ids.indexOf(this.selectedId));
    if (matchesKey(data, "down")) {
      this.selectedId = ids[Math.min(ids.length - 1, index + 1)] ?? "";
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (index === 0) { this.deactivate(); return { consume: true }; }
      this.selectedId = ids[index - 1] ?? "";
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }

    // Any other key returns focus to the editor without moving the cursor away.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  private deactivate(): void {
    this.active = false;
    this.selectedId = "";
    this.update();
  }

  private openSelected(): void {
    const id = this.selectedId;
    if (this.workflows().some(w => w.id === id)) {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = id;
      void Promise.resolve(this.openWorkflow?.(id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    const record = this.manager.listAgents().find(a => a.id === id);
    if (!record || !this.ui) { this.update(); return; }
    if (!record.session) {
      this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
      return;
    }
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    this.viewingAgentId = record.id;

    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.clearViewer(), () => this.clearViewer());
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing. Selection is id-anchored, so
    // this only has to guard against the row being gone.
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.clampSelection();
    this.update();
  }

  // ---- Rendering ----

  /** One selectable row's content lines, in display order. */
  private buildRows(theme: Theme): RenderRow[] {
    const opts: LiveRowOptions = {
      theme,
      frame: this.frame,
      showCost: this.showCost(),
      showModel: this.showModel(),
    };
    const rows: RenderRow[] = [];
    for (const workflow of this.workflows()) rows.push({ id: workflow.id, lines: [this.renderWorkflowLine(workflow, theme)] });
    for (const a of this.runningAgents()) {
      rows.push({ id: a.id, lines: buildRunningAgentRow(a, this.agentActivity.get(a.id), opts) });
    }
    for (const a of this.settledAgents()) {
      rows.push({ id: a.id, lines: [buildSettledAgentRow(a, this.agentActivity.get(a.id), opts)] });
    }
    const queued = this.queuedCount();
    if (queued > 0) rows.push({ id: QUEUED_ROW_ID, lines: [buildQueuedRow(queued, theme)] });
    return rows;
  }

  /**
   * The below-editor view. Idle it is the live tree; active it is the *same* tree
   * plus a ❯ cursor on the selected row and a hint appended to the heading —
   * same rows, same line count, same indentation. The cursor occupies the
   * 2-space indent every row already has, so nothing shifts or re-indents when
   * selection starts. Rows are windowed to MAX_WIDGET_LINES with `↑/↓ N more`
   * indicators, keeping the selected row visible.
   */
  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.buildRows(theme);
    if (rows.length === 0) return [];

    const truncate = (line: string) => truncateToWidth(line, width);
    const lines: string[] = [];

    // The heading never changes: no `main` row appears during selection (Esc and
    // ↑ past the top already return to the prompt), and the hint rides on the
    // heading row so the tree does not move down by a line. `truncateToWidth`
    // drops the hint first on a narrow terminal.
    const active = this.hasActiveWork();
    const heading = "  " + theme.fg(active ? "accent" : "dim", active ? "● Agents" : "○ Agents");
    lines.push(truncate(this.active ? `${heading}   ${theme.fg("dim", HINT)}` : heading));

    // Window the rows to the remaining budget, keeping the selection visible.
    const budget = Math.max(1, MAX_WIDGET_LINES - lines.length);
    // Reserve room for the possible `↑ N more` / `↓ N more` indicators.
    const avail = Math.max(1, budget - 2);
    const counts = rows.map(r => r.lines.length);
    const focus = rows.findIndex(r => r.id === this.selectedId);
    let start = 0;
    let end = rows.length;
    let load = counts.reduce((sum, n) => sum + n, 0);
    while (load > avail && end > start) {
      const above = focus >= start && focus < end ? focus - start : 0;
      const below = focus >= start && focus < end ? end - 1 - focus : end - 1 - start;
      if (above > below && above > 0) load -= counts[start++];
      else if (below > 0) load -= counts[--end];
      else break;
    }

    if (start > 0) lines.push(truncate("  " + theme.fg("dim", `↑ ${start} more`)));
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const isLast = i === rows.length - 1;
      const branch = theme.fg("dim", isLast ? "└─" : "├─");
      const selected = this.active && row.id === this.selectedId;
      // The cursor replaces the row's own 2-space indent rather than adding a
      // column, so idle and selection are the same layout.
      const lead = selected ? `${theme.fg("accent", "❯")} ` : "  ";
      row.lines.forEach((line, j) => {
        const prefix = j === 0
          ? `${lead}${branch} `
          : `  ${isLast ? "   " : theme.fg("dim", "│  ")}`;
        lines.push(truncate(prefix + line));
      });
    }
    const hiddenBelow = rows.length - end;
    if (hiddenBelow > 0) lines.push(truncate("  " + theme.fg("dim", `↓ ${hiddenBelow} more`)));

    return lines;
  }

  /**
   * A run's row, shaped like an agent's — bullet, kind, name, stats — so the two
   * read as one tree, with the agent count where an agent has its description.
   */
  private renderWorkflowLine(workflow: FleetWorkflow, theme: Theme): string {
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return `${theme.fg("accent", "◆")} ${theme.fg("muted", "workflow")}  ${workflow.name} ${theme.fg("dim", "·")} ${theme.fg("dim", stats)}`;
  }
}
