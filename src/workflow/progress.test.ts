import { describe, expect, it } from "vitest";
import { stats, type WorkflowAgentEntry, type WorkflowEntry } from "./progress.js";

/** The three rows the runtime emits for one agent that ran to completion. */
function agentRows(index: number, overrides: Partial<WorkflowAgentEntry> = {}): WorkflowEntry[] {
	const base = { type: "workflow_agent" as const, index, label: `agent-${index}` };
	return [
		{ ...base, state: "start", queuedAt: 1_000 },
		{ ...base, state: "start", queuedAt: 1_000, startedAt: 1_010 },
		{ ...base, state: "done", queuedAt: 1_000, startedAt: 1_010, durationMs: 5, ...overrides },
	];
}

describe("stats", () => {
	// The log is append-only and last-write-wins, so a single agent is several
	// entries. Counting entries reported ~5 agents per real one — the header read
	// `16/85 agents` for a run whose script spawned eighteen.
	it("counts one agent once, however many rows it emitted", () => {
		expect(stats(agentRows(0), 1)).toMatchObject({ done: 1, total: 1, complete: true });
	});

	it("does not inflate the total as agents emit progress", () => {
		const log = [0, 1, 2].flatMap(index => agentRows(index));
		expect(log).toHaveLength(9);
		expect(stats(log, 3)).toMatchObject({ done: 3, total: 3, complete: true });
	});

	// A fan-out reports its size before the agents start; the scheduled count is
	// the floor, so the header does not read `0/0` while work is being handed out.
	it("keeps the scheduled count when it leads the log", () => {
		expect(stats(agentRows(0), 6)).toMatchObject({ done: 1, total: 6, complete: false });
	});

	it("reports a run with a live agent as running, not complete", () => {
		const live: WorkflowEntry = {
			type: "workflow_agent",
			index: 1,
			label: "agent-1",
			state: "progress",
			queuedAt: 1_000,
			startedAt: 1_010,
		};
		const result = stats([...agentRows(0), live], 2);
		expect(result).toMatchObject({ done: 1, total: 2, running: true, complete: false });
	});

	it("counts a failed agent as settled and done", () => {
		const failed: WorkflowEntry[] = [
			{
				type: "workflow_agent",
				index: 0,
				label: "agent-0",
				state: "error",
				queuedAt: 1_000,
			},
		];
		expect(stats(failed, 1)).toMatchObject({
			done: 0,
			failedCount: 1,
			total: 1,
			started: 1,
			complete: true,
		});
	});
});
