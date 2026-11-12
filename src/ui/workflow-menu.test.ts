import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../types.js";
import { createWorkflowTask } from "../workflow/task.js";
import type { Theme } from "./agent-widget.js";
import type { WorkflowDialog } from "./workflow-dialog.js";
import { showWorkflowDialog, type WorkflowMenuDeps } from "./workflow-menu.js";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

describe("workflow conversation overlay", () => {
	it("opens the selected viewer on Enter and restores the workflow when it closes", async () => {
		const task = createWorkflowTask({
			id: "wf_test",
			script: "",
			startTime: 0,
		});
		task.workflowProgress.push({
			type: "workflow_agent",
			index: 0,
			label: "child",
			state: "done",
			recordId: "record-1",
		});
		const record = { id: "record-1" } as AgentRecord;
		const setHidden = vi.fn();
		const notify = vi.fn();
		let closeViewer = () => {};
		const viewAgentConversation = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					closeViewer = resolve;
				}),
		);
		let dialog: WorkflowDialog | undefined;
		let recordAvailable = true;
		const ctx = {
			ui: {
				notify,
				custom: (
					factory: (
						tui: TUI,
						theme: Theme,
						keys: object,
						done: () => void,
					) => WorkflowDialog,
					options: { onHandle: (handle: unknown) => void },
				) =>
					new Promise<void>((resolve) => {
						options.onHandle({ setHidden });
						dialog = factory(
							{ requestRender: vi.fn() } as unknown as TUI,
							theme,
							{},
							resolve,
						);
					}),
			},
		} as unknown as ExtensionCommandContext;
		const deps: WorkflowMenuDeps = {
			tasks: new Map([[task.id, task]]),
			getCtx: () => ctx,
			getRecord: (id) =>
				recordAvailable && id === record.id ? record : undefined,
			viewAgentConversation,
		};
		const pending = showWorkflowDialog(ctx, task, deps);
		await vi.waitFor(() => expect(dialog).toBeDefined());
		if (!dialog) throw new Error("workflow dialog did not open");
		try {
			// The tree opens on the run's row with its agents listed under it, so
			// the agent is one row down; Enter there opens the detail, Enter again
			// the conversation.
			dialog.handleInput("\x1b[B");
			dialog.handleInput("\r");
			dialog.handleInput("\r");
			expect(viewAgentConversation).toHaveBeenCalledWith(ctx, record);
			expect(setHidden).toHaveBeenCalledWith(true);
			closeViewer();
			await vi.waitFor(() => expect(setHidden).toHaveBeenLastCalledWith(false));
			// Closing the child viewer restores the same agent detail, where Enter
			// can open it again instead of sending the user back to phase selection.
			dialog.handleInput("\r");
			expect(viewAgentConversation).toHaveBeenCalledTimes(2);
			closeViewer();
			await vi.waitFor(() => expect(setHidden).toHaveBeenLastCalledWith(false));
			// A swept record reports why it cannot open rather than hiding the dialog.
			recordAvailable = false;
			dialog.handleInput("\r");
			expect(viewAgentConversation).toHaveBeenCalledTimes(2);
			expect(notify).toHaveBeenCalledWith(
				expect.stringContaining("No conversation left"),
				"info",
			);
			expect(setHidden).toHaveBeenLastCalledWith(false);
			dialog.handleInput("\x1b");
			dialog.handleInput("\x1b");
			await pending;
		} finally {
			dialog.dispose();
		}
	});
});
