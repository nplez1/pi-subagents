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

describe("workflow agent navigation", () => {
	it("descends into agent details, then opens the selected conversation", () => {
		const phases = initialWorkflowDialogState();
		const details = key("\r", phases)?.state;
		expect(details?.level).toBe("agent");
		if (!details) throw new Error("agent details did not open");
		const second = key("\x1b[B", details)?.state;
		expect(second?.selectedAgent).toBe(1);
		if (!second) throw new Error("second agent was not selected");
		expect(key("\r", second)).toEqual({
			state: second,
			action: { kind: "open", recordId: "record-2" },
		});
		expect(key("\x1b[C", second)).toEqual({
			state: second,
			action: { kind: "open", recordId: "record-2" },
		});
		expect(key("c", second)?.action).toEqual({
			kind: "open",
			recordId: "record-2",
		});
		expect(key("\x1b", second)?.state.level).toBe("phases");
	});

	it("keeps c available in the phase view and e for the prompt", () => {
		const phases = initialWorkflowDialogState();
		expect(key("c", phases)?.action).toEqual({
			kind: "open",
			recordId: "record-1",
		});
		const details: WorkflowDialogState = {
			...phases,
			level: "agent",
			selectedAgent: 1,
		};
		const expanded = key("e", details)?.state;
		expect(expanded?.promptExpanded).toBe(true);
		expect(expanded && key("e", expanded)?.state.promptExpanded).toBe(false);
		const text = plainWorkflowDialogLines(
			layoutWorkflowDialog({ ...source, state: details, width: 120 }),
		).join("\n");
		expect(text).toContain("⏎ convo");
		expect(text).toContain("e prompt");
		expect(text).toContain("e expand");
	});

	it("does not open conversations for empty, filtered-out, or not-yet-started entries", () => {
		const phases = initialWorkflowDialogState();
		const empty = { ...source, progress: [] };
		expect(key("\r", phases, empty)).toEqual({ state: phases });
		const queued: WorkflowDialogState = {
			...phases,
			level: "agent",
			selectedAgent: 2,
		};
		expect(key("\r", queued)).toBeUndefined();
		expect(key("c", queued)).toBeUndefined();
		const text = plainWorkflowDialogLines(
			layoutWorkflowDialog({ ...source, state: queued, width: 120 }),
		).join("\n");
		expect(text).not.toContain("⏎ convo");
		const filtered: WorkflowDialogState = {
			...phases,
			level: "agent",
			filter: "failed",
		};
		expect(key("\r", filtered)).toBeUndefined();
	});

	it("dispatches Enter to the injected conversation action with the selected record", () => {
		const onOpenAgent = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
		const dialog = new WorkflowDialog(tui, () => source, theme, vi.fn(), {
			onOpenAgent,
		});
		try {
			dialog.handleInput("\r");
			dialog.handleInput("\x1b[B");
			dialog.handleInput("\r");
			expect(onOpenAgent).toHaveBeenCalledOnce();
			expect(onOpenAgent).toHaveBeenCalledWith("record-2");
		} finally {
			dialog.dispose();
		}
	});
});
