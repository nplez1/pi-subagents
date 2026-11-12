import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowEntry } from "../workflow/progress.js";
import type { Theme } from "./agent-widget.js";
import {
	handleWorkflowDialogKey,
	initialWorkflowDialogState,
	layoutWorkflowDialog,
	plainWorkflowDialogLines,
	resolveWorkflowDialog,
	WorkflowDialog,
	type WorkflowDialogSource,
	type WorkflowDialogState,
} from "./workflow-dialog.js";

const progress: WorkflowEntry[] = [
	{ type: "workflow_phase", index: 0, title: "Review" },
	{
		type: "workflow_agent",
		index: 0,
		phaseIndex: 0,
		label: "first",
		state: "done",
		recordId: "record-1",
	},
	{
		type: "workflow_agent",
		index: 1,
		phaseIndex: 0,
		label: "second",
		state: "progress",
		recordId: "record-2",
		promptPreview: "one\ntwo\nthree\nfour\nfive",
	},
	{
		type: "workflow_agent",
		index: 2,
		phaseIndex: 0,
		label: "queued",
		state: "start",
	},
];

const source: WorkflowDialogSource = {
	progress,
	task: { status: "running", workflowName: "review", startTime: 0 },
};

function key(data: string, state: WorkflowDialogState, input = source) {
	return handleWorkflowDialogKey(
		data,
		state,
		resolveWorkflowDialog({ ...input, state }),
	);
}

const text = (state: WorkflowDialogState, input = source) =>
	plainWorkflowDialogLines(
		layoutWorkflowDialog({ ...input, state, width: 120 }),
	).join("\n");

describe("workflow tree navigation", () => {
	it("opens the phase that is running, with its agents already in place", () => {
		const state = initialWorkflowDialogState();
		const view = resolveWorkflowDialog({ ...source, state });
		// The phase owns three agents and one of them is live, so the row for it
		// is the one that opens: the inspector lands on what is happening now.
		expect(view.expandedIndex).toBe(0);
		expect(view.rows.map((row) => row.kind)).toEqual([
			"node",
			"agent",
			"agent",
			"agent",
		]);
		expect(view.rows[1].kind === "agent" && view.rows[1].entry.label).toBe(
			"first",
		);
		expect(text(state)).toContain("Review");
	});

	it("moves down agent rows and opens one's detail, then its conversation", () => {
		const state = initialWorkflowDialogState();
		const second = key("\x1b[B", state)?.state;
		if (!second) throw new Error("second row was not reached");
		expect(second.selectedRow).toBe(1);
		const third = key("j", second)?.state;
		if (!third) throw new Error("third row was not reached");
		expect(third.selectedRow).toBe(2);

		const details = key("\r", second)?.state;
		expect(details?.level).toBe("agent");
		if (!details) throw new Error("agent detail did not open");
		expect(key("\r", details)).toEqual({
			state: details,
			action: { kind: "open", recordId: "record-1" },
		});
		expect(key("c", details)?.action).toEqual({
			kind: "open",
			recordId: "record-1",
		});
		expect(key("\x1b", details)?.state.level).toBe("tree");
	});

	it("collapses and re-opens a phase from its own row", () => {
		const state = initialWorkflowDialogState();
		const collapsed = key("\r", state)?.state;
		expect(collapsed?.expanded).toBe(-1);
		if (!collapsed) throw new Error("row did not collapse");
		expect(
			resolveWorkflowDialog({ ...source, state: collapsed }).rows,
		).toHaveLength(1);
		const reopened = key("\r", collapsed)?.state;
		expect(reopened?.expanded).toBe(0);
		if (!reopened) throw new Error("row did not re-open");
		expect(
			resolveWorkflowDialog({ ...source, state: reopened }).rows,
		).toHaveLength(4);
	});

	it("keeps c on the phase rows and e for the prompt in detail", () => {
		const state = initialWorkflowDialogState();
		// Row 0 is the phase, so `c` has no agent under it.
		expect(key("c", state)).toBeUndefined();
		const after = key("\x1b[B", state)?.state;
		if (!after) throw new Error("agent row was not reached");
		expect(key("c", after)?.action).toEqual({
			kind: "open",
			recordId: "record-1",
		});
		// The second agent is the one with a prompt worth expanding.
		const details: WorkflowDialogState = {
			...state,
			selectedRow: 2,
			level: "agent",
		};
		const expanded = key("e", details)?.state;
		expect(expanded?.promptExpanded).toBe(true);
		expect(expanded && key("e", expanded)?.state.promptExpanded).toBe(false);
		const lines = text(details);
		expect(lines).toContain("⏎ convo");
		expect(lines).toContain("e prompt");
		expect(lines).toContain("e expand");
	});

	it("does not open conversations for empty, filtered-out, or not-yet-started entries", () => {
		const state = initialWorkflowDialogState();
		// Nothing has reported: no rows at all, so Enter has nothing to open.
		expect(key("\r", state, { ...source, progress: [] })).toEqual({ state });

		// The queued agent has no record behind it, in the tree or in detail.
		const queued = { ...state, selectedRow: 3 };
		const detail = key("\r", queued)?.state;
		expect(detail?.level).toBe("agent");
		if (!detail) throw new Error("queued detail did not open");
		expect(key("\r", detail)).toBeUndefined();
		expect(key("c", detail)).toBeUndefined();
		expect(text(detail)).not.toContain("⏎ convo");

		// A filter that hides every agent leaves nothing to select.
		const filtered: WorkflowDialogState = { ...state, filter: "failed" };
		const view = resolveWorkflowDialog({ ...source, state: filtered });
		expect(view.rows.every((row) => row.kind === "node")).toBe(true);
	});

	it("counts a failure as settled work and names it", () => {
		const withFailure: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Fix" },
			{
				type: "workflow_agent",
				index: 0,
				phaseIndex: 0,
				label: "item-a",
				state: "done",
			},
			{
				type: "workflow_agent",
				index: 1,
				phaseIndex: 0,
				label: "item-b",
				state: "error",
			},
		];
		const input = { ...source, progress: withFailure, task: { ...source.task, status: "completed" as const } };
		const lines = text(initialWorkflowDialogState(), input);
		// Two agents ran: one passed, one failed. Not `1/2 next to a ✘`, which
		// reads as an agent that never got a turn.
		expect(lines).toContain("2/2");
		expect(lines).toContain("1 failed");
		expect(lines).toContain("✘");
	});

	it("hangs a nested run under the phase that awaited it", () => {
		const nested: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "E2E" },
			{
				type: "workflow_agent",
				index: 0,
				phaseIndex: 0,
				label: "e2e-before",
				state: "done",
				// Ordering comes from activity timestamps, as the runtime stamps
				// them; a row with none sorts last.
				startedAt: 0,
				durationMs: 41_000,
			},
			{ type: "workflow_phase", index: 1, title: "Run" },
			// The nested run's own entry: it belongs to the "Run" phase above.
			{ type: "workflow_phase", index: 2, title: "▸ ps-drive-tc", parentIndex: 1 },
			{ type: "workflow_phase", index: 3, title: "▸ ps-drive-tc › Run", parentIndex: 2 },
			{ type: "workflow_phase", index: 4, title: "▸ ps-drive-tc › Triage", parentIndex: 2 },
			{
				type: "workflow_agent",
				index: 1,
				phaseIndex: 3,
				label: "case:ps-6110",
				state: "done",
				startedAt: 10,
			},
			{
				type: "workflow_agent",
				index: 2,
				phaseIndex: 4,
				label: "triage:ps-6110",
				state: "progress",
				startedAt: 20,
			},
		];
		const state = initialWorkflowDialogState();
		const lines = text(state, { ...source, progress: nested });
		// The delegating phase is one row that names the run, and the child's
		// phases sit under it — not beside the parent's phases, and not as an
		// empty row of their own.
		expect(lines).toContain("Run ▸ ps-drive-tc");
		// Compared by column, not by position in the dump: a nested row starts
		// two columns further in, which is the whole of how the hierarchy shows.
		const body = lines.split("\n").filter((line) => line.startsWith(" │"));
		const parent = body.find((line) => line.includes("Run ▸ ps-drive-tc"));
		const child = body.find((line) => line.includes(" Triage"));
		if (!parent || !child) throw new Error("nested rows are missing");
		expect(parent.indexOf("Run ▸")).toBeLessThan(child.indexOf("Triage"));
		const view = resolveWorkflowDialog({
			...source,
			progress: nested,
			state,
		});
		const rows = view.rows.filter((row) => row.kind === "node");
		expect(rows.map((row) => row.kind === "node" && row.node.label)).toEqual([
			"E2E",
			"Run ▸ ps-drive-tc",
			"Run",
			"Triage",
		]);
	});

	it("counts declared phases that have not started instead of drawing them", () => {
		const declared = {
			...source,
			progress,
			meta: {
				name: "review",
				description: "review the change",
				phases: [{ title: "Review" }, { title: "Native" }, { title: "E2E after" }],
			},
		};
		const lines = text(initialWorkflowDialogState(), declared);
		expect(lines).toContain("2 phases to go");
		// An empty phase is a plan, not work: no row, no zero count.
		expect(lines).not.toContain("Native");
	});

	it("dispatches Enter to the injected conversation action with the selected record", () => {
		const onOpenAgent = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
		const dialog = new WorkflowDialog(tui, () => source, theme, vi.fn(), {
			onOpenAgent,
		});
		try {
			dialog.handleInput("\x1b[B");
			dialog.handleInput("\r");
			dialog.handleInput("\r");
			expect(onOpenAgent).toHaveBeenCalledOnce();
			expect(onOpenAgent).toHaveBeenCalledWith("record-1");
		} finally {
			dialog.dispose();
		}
	});
});
