import { describe, expect, it } from "vitest";
import {
	completeWorkflowTask,
	createWorkflowTask,
	failWorkflowTask,
	formatWorkflowNotification,
	updateWorkflowProgressBatch,
	workflowSettledEvent,
	workflowStartedEvent,
} from "./task.js";

const meta = { name: "review-tc", description: "Review the tc harness" };

function task(
	status: "running" | "paused" | "completed" | "failed" | "killed" = "running",
) {
	const t = createWorkflowTask({
		id: "wf_abc123def456",
		script: "",
		meta,
		startTime: 1_000,
	});
	t.status = status;
	return t;
}

describe("workflowStartedEvent", () => {
	it("names the run on the agent channel's payload, marked as a workflow", () => {
		expect(workflowStartedEvent(task())).toEqual({
			id: "wf_abc123def456",
			runId: "wf_abc123def456",
			type: "workflow",
			mode: "workflow",
			description: "review-tc",
		});
	});

	it("falls back to the run id when the script has no name", () => {
		const t = createWorkflowTask({ id: "wf_noname000001", script: "" });
		expect(workflowStartedEvent(t).description).toBe("wf_noname000001");
	});
});

describe("workflowSettledEvent", () => {
	it("is undefined while the run is live, including when paused", () => {
		expect(workflowSettledEvent(task("running"))).toBeUndefined();
		expect(workflowSettledEvent(task("paused"))).toBeUndefined();
	});

	it("settles a completed run as subagents:completed", () => {
		const t = task("running");
		t.totalTokens = 1234;
		t.totalToolCalls = 7;
		completeWorkflowTask(t, {
			status: "completed",
			meta,
			agentCount: 3,
			replayedCount: 0,
			value: "done",
		} as never);
		const settled = workflowSettledEvent(t, 1_000 + 5_000);
		expect(settled?.channel).toBe("subagents:completed");
		expect(settled?.data).toMatchObject({
			id: "wf_abc123def456",
			mode: "workflow",
			status: "completed",
			durationMs: expect.any(Number),
			tokens: 1234,
			toolUses: 7,
		});
		expect(settled?.data).not.toHaveProperty("error");
	});

	it("settles a failed run as subagents:failed, carrying the error", () => {
		const t = task("running");
		failWorkflowTask(t, "Workflow worker exited before completing.");
		const settled = workflowSettledEvent(t);
		expect(settled?.channel).toBe("subagents:failed");
		expect(settled?.data).toMatchObject({
			status: "failed",
			error: "Workflow worker exited before completing.",
		});
	});

	it("settles a killed run as subagents:failed, the way a stopped agent does", () => {
		const t = task("killed");
		expect(workflowSettledEvent(t)?.channel).toBe("subagents:failed");
		expect(workflowSettledEvent(t)?.data).toMatchObject({ status: "killed" });
	});
});

describe("formatWorkflowNotification", () => {
	// The runtime writes several rows per agent (queued, started, settled), so
	// counting rows reported `37/198 agents` for a run whose script spawned about
	// forty — the number the reader saw in the transcript was simply wrong.
	it("reports one agent per agent, not one per progress row", () => {
		const t = task("running");
		const rows = [0, 1, 2].flatMap(index => [
			{ type: "workflow_agent" as const, index, label: `a${index}`, state: "start" as const, queuedAt: 1 },
			{ type: "workflow_agent" as const, index, label: `a${index}`, state: "start" as const, queuedAt: 1, startedAt: 2 },
			{ type: "workflow_agent" as const, index, label: `a${index}`, state: "done" as const, queuedAt: 1, startedAt: 2 },
		]);
		updateWorkflowProgressBatch(t, rows);
		completeWorkflowTask(t, { status: "completed", meta, progress: [], agentCount: 3, replayedCount: 0, value: "ok" });

		expect(formatWorkflowNotification(t)).toContain("completed — 3/3 agents");
	});
});
