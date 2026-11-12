/**
 * workflow-menu.ts — `/agents → Workflows`, and the run inspector behind it.
 *
 * The same shape `schedule-menu.ts` has for `/agents → Scheduled jobs`: the
 * submenu and the overlay it opens live here, and everything they need arrives
 * as {@link WorkflowMenuDeps} rather than through a closure. The inspector is
 * reached from two places — this menu and a `workflow` row in the fleet list —
 * and both go through `showWorkflowDialog`, so the two entry points cannot
 * drift apart on what the keys do.
 *
 * Lives in the agents menu rather than as a top-level `/workflows` command: it
 * is one more view of the same fleet, and a second command name would only add
 * a collision surface (pi renames duplicate commands to `/workflows:1` and
 * `/workflows:2`, which breaks the bare name for both).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../types.js";
import { pauseWorkflowTask, resumeWorkflowTask, type WorkflowTask } from "../workflow/task.js";
import { WorkflowDialog } from "./workflow-dialog.js";

/** Everything the menu and the inspector need from the extension around them. */
export interface WorkflowMenuDeps {
  /**
   * Live runs by id, read on every use rather than snapshotted: a run that
   * settled and was swept between render and keypress must be a no-op, not a
   * crash.
   */
  tasks: ReadonlyMap<string, WorkflowTask>;
  /** The record behind an agent id, or undefined once it has been swept. */
  getRecord(id: string): AgentRecord | undefined;
  /** The conversation overlay opened from an agent row. */
  viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord): Promise<void>;
  /**
   * The session context, for the fleet-list entry point — that one is a
   * keypress in a list that holds no `ctx` of its own. Undefined between
   * sessions, which is a no-op rather than an error.
   */
  getCtx(): ExtensionCommandContext | undefined;
}

/**
 * Open the inspector for a workflow run.
 *
 * All six controls are wired: `onKill` aborts the run's controller, while
 * pause/resume and per-agent skip/retry go through `task.control`, the handle
 * `runWorkflow` hands back. `onOpenAgent` is the odd one out — it opens the
 * child's conversation rather than changing the run. The dialog derives its key
 * hints from the actions it is handed, so the footer advertises exactly what
 * works — see `WorkflowDialogActions`.
 */
export async function showWorkflowDialog(
  ctx: ExtensionCommandContext,
  task: WorkflowTask,
  deps: WorkflowMenuDeps,
): Promise<void> {
  // Overlaid on the same terms as the conversation viewer, because they are
  // reached the same way: both are rows of the fleet list, and opening one
  // must not behave unlike opening the other. Inline, the frame would render
  // into the conversation and stay in the scrollback after it closed.
  const { VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
  /**
   * This dialog's own overlay, so opening a conversation can hide it while it is
   * up. Overlays stack, so the viewer would render *over* it either way —
   * but the two frames size themselves to different content, and the taller
   * one's edges show around the shorter. Hidden, there is nothing to peek
   * out, and un-hiding puts the focus back on the dialog when the viewer
   * closes.
   */
  let overlay: { setHidden(hidden: boolean): void } | undefined;
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) =>
      new WorkflowDialog(
        tui,
        // Re-read on every render: the run is in the background, so the
        // dialog has to follow it rather than snapshot it at open time.
        () => ({
          progress: task.workflowProgress,
          task: {
            status: task.status,
            workflowName: task.workflowName,
            startTime: task.startTime,
            endTime: task.endTime,
            totalPausedMs: task.totalPausedMs,
          },
          meta: task.meta,
          agentCount: task.agentCount,
        }),
        theme,
        done,
        {
          onKill: () => {
            if (task.abortController.signal.aborted) return;
            task.abortController.abort();
            ctx.ui.notify(`Stopped workflow "${task.meta?.name ?? task.id}".`, "info");
          },
          onPause: () => {
            if (pauseWorkflowTask(task)) {
              // Named rather than implied: "paused" on a run whose agents are
              // still finishing reads as a stronger promise than it is.
              ctx.ui.notify("Paused — running agents finish, no new ones start.", "info");
            }
          },
          onResume: () => {
            if (resumeWorkflowTask(task)) ctx.ui.notify("Resumed.", "info");
          },
          onSkipAgent: index => {
            if (task.control?.skip(index) !== true) {
              ctx.ui.notify("Nothing to skip — that agent has already finished.", "info");
            }
          },
          onRetryAgent: index => {
            if (task.control?.retry(index) !== true) {
              // The window is exactly "while it is running": before that
              // there is nothing to stop, after it the script has its answer.
              ctx.ui.notify("Only a running agent can be retried.", "info");
            }
          },
          onOpenAgent: recordId => {
            const record = deps.getRecord(recordId);
            // A run's children are records like any other, so they are swept
            // ten minutes after they finish — the row outlives the
            // conversation it points at, and saying why beats an overlay that
            // opens empty.
            if (record === undefined) {
              ctx.ui.notify("No conversation left — agent records are dropped ten minutes after they finish.", "info");
              return;
            }
            overlay?.setHidden(true);
            // Caught before the `finally`, so a viewer that fails to open
            // still un-hides the dialog and cannot surface as an unhandled
            // rejection out of a detached promise.
            void deps.viewAgentConversation(ctx, record)
              .catch(err => ctx.ui.notify(
                `Could not open the conversation: ${err instanceof Error ? err.message : String(err)}`,
                "warning",
              ))
              .finally(() => overlay?.setHidden(false));
          },
        },
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      onHandle: handle => { overlay = handle; },
    },
  );
}

/**
 * Open a run from the fleet list.
 *
 * The list hands back an id rather than a task, so a run that settled and was
 * swept between render and keypress is a no-op instead of a crash. `esc` in the
 * dialog closes it and control returns to the list — which is why the promise
 * is handed back: the list puts the cursor back on the run rather than dropping
 * the reader at `main`.
 */
export function openWorkflowFromFleet(id: string, deps: WorkflowMenuDeps): Promise<void> | void {
  const task = deps.tasks.get(id);
  const ctx = deps.getCtx();
  if (task === undefined || ctx === undefined) return;
  return showWorkflowDialog(ctx, task, deps);
}

/**
 * A session's runs, folded down to the ones worth listing.
 *
 * Everything stays in the registry — `resumeFromRunId` resolves against it, so
 * dropping settled runs would break "re-run that again". Only the *listing* is
 * folded.
 */
export interface WorkflowRunSummary {
  /** Every live run, plus the newest settled run of each workflow name. */
  shown: WorkflowTask[];
  /** Settled runs folded out of the listing, newest first. */
  older: WorkflowTask[];
}

/**
 * Fold a session's runs into a list you can read.
 *
 * A loop that re-runs one workflow produces a run per round, and a session's
 * registry never drops them — which is right for resume and wrong for a picker:
 * thirty identical `ps-drive-loop` rows bury the one that is actually live.
 * So the listing keeps every live run and the newest settled run per workflow
 * name; older rounds move behind one "Older runs" row instead of vanishing.
 *
 * The newest settled run is kept even when a live run of the same name is
 * already listed, because "the run I just started" and "the last one that
 * finished" are two different questions and both get asked.
 */
export function summarizeRuns(tasks: Iterable<WorkflowTask>): WorkflowRunSummary {
  // Newest first, id as the tie-break so two runs started in the same
  // millisecond keep a stable order. `select` hands back the label string, so
  // an unstable order would map a pick onto the wrong run.
  const sorted = [...tasks].sort(
    (a, b) => b.startTime - a.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const shown: WorkflowTask[] = [];
  const older: WorkflowTask[] = [];
  const settledNames = new Set<string>();

  for (const task of sorted) {
    if (task.status === "running" || task.status === "paused") {
      shown.push(task);
      continue;
    }
    const name = task.meta?.name ?? task.workflowName ?? task.id;
    if (settledNames.has(name)) {
      older.push(task);
      continue;
    }
    settledNames.add(name);
    shown.push(task);
  }

  return { shown, older };
}

/** One run, as a line of the picker. */
function runLabel(task: WorkflowTask): string {
  return `${task.meta?.name ?? task.workflowName ?? task.id} — ${task.status}, ${task.agentCount} agent${
    task.agentCount === 1 ? "" : "s"
  } · ${task.id}`;
}

/**
 * `select` over runs, newest first.
 *
 * Returns the chosen task, or undefined when the reader backed out. The label
 * carries the run id so a pick cannot land on a same-named sibling, and the
 * index is taken from the parallel array rather than parsed back out.
 */
async function pickRun(
  ctx: ExtensionCommandContext,
  title: string,
  tasks: readonly WorkflowTask[],
): Promise<WorkflowTask | undefined> {
  const labels = tasks.map(runLabel);
  const picked = await ctx.ui.select(title, labels);
  const index = picked !== undefined ? labels.indexOf(picked) : -1;
  return index >= 0 ? tasks[index] : undefined;
}

/** `/agents → Workflows` — list this session's runs, open one. */
export async function showWorkflowsMenu(
  ctx: ExtensionCommandContext,
  deps: WorkflowMenuDeps,
): Promise<void> {
  const { shown, older } = summarizeRuns(deps.tasks.values());
  if (shown.length === 0 && older.length === 0) {
    ctx.ui.notify("No workflows in this session.", "info");
    return;
  }
  // One run and no history is the common case — opening it directly is the
  // whole menu, and an "Older runs" row would be a keystroke for nothing.
  if (shown.length === 1 && older.length === 0) {
    await showWorkflowDialog(ctx, shown[0], deps);
    return;
  }

  const labels = shown.map(runLabel);
  if (older.length > 0) labels.push(`Older runs (${older.length}) — settled earlier · every run is kept`);
  const picked = await ctx.ui.select("Workflows", labels);
  const index = picked !== undefined ? labels.indexOf(picked) : -1;
  if (index < 0) return;

  // The last row is the fold, not a run: one more level reaches the full
  // history instead of putting it in the way of the run being asked about.
  const task =
    index === shown.length ? await pickRun(ctx, "Older workflow runs", older) : shown[index];
  if (task !== undefined) await showWorkflowDialog(ctx, task, deps);
}
