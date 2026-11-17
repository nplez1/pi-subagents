import { describe, expect, it } from "vitest";
import {
	CARD_AGENT_ROW_BUDGET,
	CARD_LOG_LINES,
	layoutWorkflowCard,
	plainWorkflowCardLines,
	type WorkflowCardInput,
} from "./workflow-card.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../workflow/progress.js";

/**
 * The transcript card for a looping run.
 *
 * The card is the surface that grows unboundedly if nothing folds — it is laid
 * out again on every render and prints one line per agent — so what these cases
 * pin is that its height is a function of the round, not of the run.
 */

const task = { status: "running" as const, startTime: 0 };

function done(index: number, roundIndex: number, overrides: Partial<WorkflowAgentEntry> = {}): WorkflowEntry {
	return {
		type: "workflow_agent",
		index,
		phaseIndex: 0,
		roundIndex,
		label: `agent-${index}`,
		state: "done",
		queuedAt: 1_000,
		startedAt: 1_010,
		durationMs: 1_000,
		tokens: 10,
		...overrides,
	};
}

const phase: WorkflowEntry = { type: "workflow_phase", index: 0, title: "Wait" };

function card(progress: WorkflowEntry[], over: Partial<WorkflowCardInput> = {}) {
	return plainWorkflowCardLines(
		layoutWorkflowCard({ progress, task, now: 60_000, width: 100, ...over }),
	);
}

describe("workflow card rounds", () => {
	it("draws the live round and folds every round behind it into one line", () => {
		const progress: WorkflowEntry[] = [
			phase,
			done(0, 1),
			done(1, 1),
			// The live round: three agents, so they are drawn as rows.
			done(2, 2),
			done(3, 2),
		];
		const lines = card(progress);
		expect(lines[0]).toContain("round 2");
		const fold = lines.find(line => line.includes("⋯"));
		expect(fold).toContain("round 1 ·");
		expect(fold).toContain("2 agents");
		// Only the live round's agents are rows: the two from round 1 are not.
		expect(lines.some(line => line.includes("agent-0"))).toBe(false);
		expect(lines.some(line => line.includes("agent-2"))).toBe(true);
	});

	it("draws every agent of a run that has not looped", () => {
		const lines = card([phase, done(0, 1), done(1, 1)]);
		expect(lines[0]).toContain("2/2 agents");
		expect(lines.some(line => line.includes("agent-0"))).toBe(true);
		expect(lines.some(line => line.includes("agent-1"))).toBe(true);
	});

	it("folds the oldest settled rows past the budget and never a live one", () => {
		const budget = CARD_AGENT_ROW_BUDGET;
		const progress: WorkflowEntry[] = [phase];
		for (let i = 0; i < budget + 6; i++) progress.push(done(i, 1));
		// The newest agent is still running: it must survive the fold even though
		// it would be the last row dropped on the settled side.
		progress.push({ ...(done(budget + 6, 1) as WorkflowAgentEntry), state: "progress" });

		const lines = card(progress);
		const fold = lines.find(line => line.includes("earlier agent"));
		expect(fold).toBeDefined();
		expect(fold).toContain("7 earlier agents");
		expect(lines.some(line => line.includes(`agent-${budget + 6}`))).toBe(true);
		// The oldest settled rows are the ones that went.
		expect(lines.some(line => line.includes("agent-0 "))).toBe(false);
	});

	it("keeps only the tail of a looping run's log and counts the rest", () => {
		const progress: WorkflowEntry[] = [phase, done(0, 1), done(1, 2)];
		for (let i = 0; i < 20; i++) progress.push({ type: "workflow_log", message: `round ${i}` });
		const lines = card(progress);
		expect(lines.some(line => line.includes("14 earlier messages"))).toBe(true);
		// The tail is kept, oldest messages are not.
		const kept = lines.filter(line => line.includes("⎿"));
		expect(kept).toHaveLength(CARD_LOG_LINES);
		expect(kept[0]).toContain("round 14");
		expect(lines.some(line => line.includes("round 0"))).toBe(false);
	});

	it("does not cap the log of a single-round run", () => {
		const progress: WorkflowEntry[] = [phase, done(0, 1)];
		for (let i = 0; i < 20; i++) progress.push({ type: "workflow_log", message: `step ${i}` });
		const lines = card(progress);
		expect(lines.some(line => line.includes("earlier messages"))).toBe(false);
		expect(lines.some(line => line.includes("step 0"))).toBe(true);
	});

	it("counts pruned rounds in the fold", () => {
		const lines = card([phase, done(0, 5), done(1, 6)], {
			archived: { rounds: 4, through: 4, agents: 100, settled: 100, failed: 2, tokens: 900_000, durationMs: 5 },
		});
		const fold = lines.find(line => line.includes("⋯"));
		expect(fold).toContain("rounds 1–5");
		expect(fold).toContain("2 failed");
		expect(fold).toContain("101 agents");
	});
});
