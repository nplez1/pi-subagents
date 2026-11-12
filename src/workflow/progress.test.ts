import { describe, expect, it } from "vitest";
import {
	buildPhaseTree,
	flattenPhaseTree,
	stats,
	type WorkflowAgentEntry,
	type WorkflowEntry,
} from "./progress.js";

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

/** A settled agent row, stamped so ordering has something to read. */
function done(index: number, phaseIndex: number, at: number, overrides: Partial<WorkflowAgentEntry> = {}): WorkflowEntry {
	return {
		type: "workflow_agent",
		index,
		phaseIndex,
		label: `agent-${index}`,
		state: "done",
		queuedAt: at,
		startedAt: at,
		durationMs: 1_000,
		...overrides,
	};
}

describe("buildPhaseTree", () => {
	it("hangs a nested run's phases under the phase that awaited it", () => {
		const progress: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "E2E" },
			done(0, 0, 10),
			{ type: "workflow_phase", index: 1, title: "Run" },
			// The child run's own entry, then the phases it defines.
			{ type: "workflow_phase", index: 2, title: "▸ tc", parentIndex: 1 },
			{ type: "workflow_phase", index: 3, title: "▸ tc › Run", parentIndex: 2 },
			{ type: "workflow_phase", index: 4, title: "▸ tc › Triage", parentIndex: 2 },
			done(1, 3, 20),
			done(2, 3, 21),
			done(3, 4, 30),
		];
		const tree = buildPhaseTree(progress);

		// Two top-level rows, in the order their work started: the delegating
		// phase is one row that names the run, and the child's phases are its
		// children — not siblings with a `▸ tc › ` prefix in the title.
		expect(tree.nodes.map(node => node.label)).toEqual(["E2E", "Run ▸ tc"]);
		expect(tree.nodes[1].children.map(node => node.title)).toEqual(["Run", "Triage"]);

		// Rolled up, so the delegating row accounts for the run it started.
		expect(tree.nodes[1].settled).toBe(3);
		expect(tree.nodes[1].total).toBe(3);
		expect(tree.nodes[1].agents).toHaveLength(0);
		expect(tree.totals).toMatchObject({ settled: 4, failed: 0, live: 0, total: 4 });
	});

	it("draws no row for a phase that has produced nothing", () => {
		const tree = buildPhaseTree(
			[{ type: "workflow_phase", index: 0, title: "Scan" }, done(0, 0, 10)],
			[{ title: "Scan" }, { title: "Fix", detail: "not yet" }, { title: "Report" }],
		);
		expect(tree.nodes.map(node => node.title)).toEqual(["Scan"]);
		expect(tree.remaining).toEqual(["Fix", "Report"]);
	});

	it("orders rows by when their work started, not by declaration", () => {
		// Declared Scan, Fix, Verify; Fix started first because the script
		// pipelined its items. Reading order must be the order things happened.
		const progress: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Scan" },
			{ type: "workflow_phase", index: 1, title: "Fix" },
			{ type: "workflow_phase", index: 2, title: "Verify" },
			done(0, 1, 10),
			done(1, 2, 20),
			done(2, 0, 30),
		];
		const tree = buildPhaseTree(progress);
		expect(tree.nodes.map(node => node.title)).toEqual(["Fix", "Verify", "Scan"]);
	});

	it("counts a failed agent as settled, and keeps the failure visible", () => {
		const progress: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Fix" },
			done(0, 0, 10),
			{ type: "workflow_agent", index: 1, phaseIndex: 0, label: "agent-1", state: "error", startedAt: 11, queuedAt: 11 },
		];
		const node = buildPhaseTree(progress).nodes[0];
		// Two agents ran: `0/2` would say neither did.
		expect(node).toMatchObject({ done: 1, failed: 1, settled: 2, total: 2, status: "failed" });
	});

	it("counts a live agent as work still in flight, not as settled", () => {
		const progress: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Run" },
			done(0, 0, 10),
			{ type: "workflow_agent", index: 1, phaseIndex: 0, label: "agent-1", state: "progress", startedAt: 11 },
		];
		const tree = buildPhaseTree(progress);
		expect(tree.nodes[0]).toMatchObject({ settled: 1, live: 1, total: 2, status: "running" });
		expect(flattenPhaseTree(tree)).toHaveLength(1);
	});

	it("keeps a script that names no phase as one group", () => {
		const tree = buildPhaseTree([done(0, 0, 10), done(1, 0, 11)]);
		expect(tree.nodes).toHaveLength(1);
		expect(tree.nodes[0].title).toBe("Agents");
		expect(tree.nodes[0].total).toBe(2);
	});
});
