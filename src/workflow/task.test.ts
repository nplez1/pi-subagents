import { describe, expect, it } from "vitest";
import {
	completeWorkflowTask,
	createWorkflowTask,
	failWorkflowTask,
	formatWorkflowNotification,
	updateWorkflowProgressBatch,
	WORKFLOW_OVERFLOW_SLACK,
	WORKFLOW_ROW_RETENTION,
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

describe("progress batches at scale", () => {
	const agentEntry = (
		index: number,
		roundIndex: number,
		over: Partial<Extract<Parameters<typeof updateWorkflowProgressBatch>[1][number], { type: "workflow_agent" }>> = {},
	) =>
		({
			type: "workflow_agent" as const,
			index,
			label: `agent-${index}`,
			roundIndex,
			state: "start" as const,
			queuedAt: 1,
			...over,
		});

	const settled = (index: number, roundIndex: number) =>
		agentEntry(index, roundIndex, {
			state: "done",
			startedAt: 2,
			durationMs: 5,
			tokens: 10,
			toolCalls: 1,
			promptPreview: "a prompt that would otherwise be kept",
			resultPreview: "a result",
		});

	it("rewrites an agent's row in place instead of appending every write", () => {
		// Four writes per agent was four rows and a full re-fold per batch: the
		// two costs that grow with a run rather than with a step.
		const t = createWorkflowTask({ id: "wf_rewrite", script: "", meta });
		updateWorkflowProgressBatch(t, [agentEntry(0, 1)]);
		updateWorkflowProgressBatch(t, [agentEntry(0, 1, { state: "progress", startedAt: 2 })]);
		updateWorkflowProgressBatch(t, [settled(0, 1)]);
		expect(t.workflowProgress.filter(e => e.type === "workflow_agent")).toHaveLength(1);
		expect(t).toMatchObject({
			agentCount: 1,
			doneCount: 1,
			settledCount: 1,
			failedCount: 0,
			totalTokens: 10,
			totalToolCalls: 1,
		});
	});

	it("moves a row between states without double-counting its tokens", () => {
		const t = createWorkflowTask({ id: "wf_states", script: "", meta });
		updateWorkflowProgressBatch(t, [settled(0, 1)]);
		updateWorkflowProgressBatch(t, [settled(0, 1)]);
		expect(t.totalTokens).toBe(10);
		expect(t.doneCount).toBe(1);
	});

	it("counts a failure as settled, and never lets a replacement leave a stale total", () => {
		const t = createWorkflowTask({ id: "wf_failed", script: "", meta });
		updateWorkflowProgressBatch(t, [settled(0, 1)]);
		updateWorkflowProgressBatch(t, [agentEntry(0, 1, { state: "error", error: "boom", tokens: 4 })]);
		expect(t).toMatchObject({ doneCount: 0, failedCount: 1, settledCount: 1, totalTokens: 4 });
	});

	it("strips the previews of a round the loop has moved past", () => {
		const t = createWorkflowTask({ id: "wf_slim", script: "", meta });
		updateWorkflowProgressBatch(t, [settled(0, 1)]);
		updateWorkflowProgressBatch(t, [agentEntry(1, 2)]);
		const first = t.workflowProgress.find(e => e.type === "workflow_agent" && e.index === 0);
		expect(first).toBeDefined();
		expect(first && "promptPreview" in first ? first.promptPreview : undefined).toBeUndefined();
		expect(first && "resultPreview" in first ? first.resultPreview : undefined).toBeUndefined();
		// The row itself survives: it is still what the inspector lists.
		expect(first).toMatchObject({ label: "agent-0", tokens: 10 });
	});

	it("bounds a run that never forms a round at all", () => {
		// `while (…) { await agent(…) }` calls no `phase()`, so it stays in round one
		// and `retireRounds` has no boundary to retire on. Without this the rows grow
		// for the whole run — the exact shape of the loop this change exists for.
		const t = createWorkflowTask({ id: "wf_no_rounds", script: "", meta });
		const total = WORKFLOW_ROW_RETENTION + 600;
		for (let start = 0; start < total; start += 500) {
			const batch = Array.from({ length: Math.min(500, total - start) }, (_unused, i) => settled(start + i, 1));
			updateWorkflowProgressBatch(t, batch);
		}
		// The walk is amortised, so the bound holds within one slack interval.
		expect(t.agentSlots.size).toBeLessThanOrEqual(WORKFLOW_ROW_RETENTION + WORKFLOW_OVERFLOW_SLACK);
		// Counters are maintained per entry rather than derived from the rows, so
		// the run still reports every agent it ever scheduled.
		expect(t.agentCount).toBe(total);
		expect(t.doneCount).toBe(total);
	});

	it("bounds a chatty run's log lines the same way", () => {
		const t = createWorkflowTask({ id: "wf_chatty", script: "", meta });
		const lines = 900;
		for (let start = 0; start < lines; start += 100) {
			const batch = Array.from({ length: 100 }, (_unused, i) => ({
				type: "workflow_log" as const,
				message: `round ${start + i}`,
			}));
			updateWorkflowProgressBatch(t, batch);
		}
		expect(t.logLines).toBeLessThanOrEqual(200 + WORKFLOW_OVERFLOW_SLACK);
	});

	it("prunes the oldest rounds once the retained rows pass the budget", () => {
		// Retention is what makes the footprint independent of the run's length: a
		// loop left going for weeks never stops producing rounds.
		const t = createWorkflowTask({ id: "wf_prune", script: "", meta });
		const perRound = Math.ceil(WORKFLOW_ROW_RETENTION / 2);
		for (let round = 1; round <= 3; round++) {
			const batch = Array.from({ length: perRound }, (_unused, i) => settled((round - 1) * perRound + i, round));
			updateWorkflowProgressBatch(t, batch);
		}
		expect(t.archived.rounds).toBeGreaterThan(0);
		expect(t.archived.agents).toBeGreaterThan(0);
		expect(t.archived.through).toBe(1);
		// The rows went; the counts did not. `agentCount` is what the run scheduled.
		expect(t.agentSlots.size).toBeLessThanOrEqual(WORKFLOW_ROW_RETENTION);
		expect(t.agentCount).toBe(perRound * 3);
		expect(t.doneCount).toBe(perRound * 3);
		// What is left answers a lookup by index, so a re-emit still rewrites.
		const survivor = t.workflowProgress.find(e => e.type === "workflow_agent");
		expect(survivor?.type).toBe("workflow_agent");
	});
});
