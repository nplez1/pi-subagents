import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowTask } from "../workflow/task.js";
import { showWorkflowsMenu, summarizeRuns, type WorkflowMenuDeps } from "./workflow-menu.js";

/**
 * A run of `name`, started at `startedAt`, settled unless a status says otherwise.
 * One loop round per call is the case the fold exists for.
 */
function run(
	name: string,
	startedAt: number,
	status: "running" | "completed" | "failed" = "completed",
) {
	const task = createWorkflowTask({
		id: `wf_${name.replace(/[^a-z0-9]/g, "")}${startedAt}`,
		script: "",
		meta: { name, description: name },
		startTime: startedAt,
	});
	task.status = status;
	return task;
}

function depsOf(tasks: ReturnType<typeof run>[]): WorkflowMenuDeps {
	return {
		tasks: new Map(tasks.map(task => [task.id, task])),
		getCtx: () => undefined,
		getRecord: () => undefined,
		viewAgentConversation: async () => {},
	};
}

describe("summarizeRuns", () => {
	it("keeps the newest settled run of a repeated workflow and folds the rest", () => {
		const rounds = [run("ps-drive-loop", 4_000), run("ps-drive-loop", 3_000), run("ps-drive-loop", 2_000)];
		const { shown, older } = summarizeRuns(rounds);
		expect(shown.map(task => task.startTime)).toEqual([4_000]);
		expect(older.map(task => task.startTime)).toEqual([3_000, 2_000]);
	});

	it("keeps every live run, alongside the last finished one", () => {
		const live = run("ps-drive-loop", 5_000, "running");
		const lastSettled = run("ps-drive-loop", 4_000);
		const { shown, older } = summarizeRuns([live, lastSettled, run("ps-drive-loop", 1_000)]);
		expect(shown.map(task => task.id)).toEqual([live.id, lastSettled.id]);
		expect(older).toHaveLength(1);
	});

	it("keeps one row per distinct workflow name", () => {
		const audit = run("audit", 3_000);
		const fix = run("fix", 2_000);
		const { shown, older } = summarizeRuns([audit, fix]);
		expect(shown.map(task => task.id)).toEqual([audit.id, fix.id]);
		expect(older).toHaveLength(0);
	});
});

describe("showWorkflowsMenu", () => {
	it("folds earlier rounds behind one row instead of listing them", async () => {
		const rounds = [run("ps-drive-loop", 3_000), run("ps-drive-loop", 2_000), run("ps-drive-loop", 1_000)];
		const offered: string[][] = [];
		// Backing out of each pick keeps the dialog out of it: what is under test is
		// which rows the reader is asked to scroll through.
		const ctx = {
			ui: {
				select: (_title: string, labels: string[]) => {
					offered.push(labels);
					return Promise.resolve(undefined);
				},
				notify: vi.fn(),
			},
		} as unknown as ExtensionCommandContext;

		await showWorkflowsMenu(ctx, depsOf(rounds));

		expect(offered).toHaveLength(1);
		expect(offered[0]).toHaveLength(2);
		expect(offered[0][0]).toContain("ps-drive-loop");
		expect(offered[0][1]).toContain("Older runs (2)");
	});

	it("keeps the whole history one select away", async () => {
		const rounds = [run("ps-drive-loop", 3_000), run("ps-drive-loop", 2_000), run("ps-drive-loop", 1_000)];
		const offered: string[][] = [];
		const ctx = {
			ui: {
				select: (_title: string, labels: string[]) => {
					offered.push(labels);
					// First pick chooses the fold; the second backs out of the history.
					return Promise.resolve(offered.length === 1 ? labels[labels.length - 1] : undefined);
				},
				notify: vi.fn(),
			},
		} as unknown as ExtensionCommandContext;

		await showWorkflowsMenu(ctx, depsOf(rounds));

		expect(offered).toHaveLength(2);
		expect(offered[1].map(label => label)).toEqual([
			expect.stringContaining(`wf_psdriveloop2000`),
			expect.stringContaining(`wf_psdriveloop1000`),
		]);
	});
});
