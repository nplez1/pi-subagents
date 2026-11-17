import { describe, expect, it } from "vitest";
import {
	buildPhaseTree,
	earlierRounds,
	flattenPhaseTree,
	header,
	roundSummaries,
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

describe("rounds", () => {
	it("folds agents into one summary per round", () => {
		const log: WorkflowEntry[] = [
			...agentRows(0, { roundIndex: 1, tokens: 100 }),
			...agentRows(1, { roundIndex: 1, tokens: 100 }),
			...agentRows(2, { roundIndex: 3, tokens: 7 }),
		];
		const rounds = roundSummaries(log);
		expect(rounds.map(r => r.index)).toEqual([1, 3]);
		expect(rounds[0]).toMatchObject({ agents: 2, settled: 2, failed: 0, tokens: 200 });
		expect(rounds[1]).toMatchObject({ agents: 1, settled: 1, tokens: 7 });
	});

	it("treats an agent logged before rounds existed as round one", () => {
		// A session entry written by an older build has no `roundIndex` at all, and
		// one round is what it was.
		expect(roundSummaries([done(0, 0, 10)]).map(r => r.index)).toEqual([1]);
	});

	it("marks a round with a failure as failed", () => {
		const log: WorkflowEntry[] = [
			{ type: "workflow_agent", index: 0, roundIndex: 2, label: "a", state: "error", startedAt: 5, durationMs: 1 },
		];
		expect(roundSummaries(log)[0]).toMatchObject({ failed: 1, settled: 1, status: "failed" });
	});

	it("draws one round's phases when asked for a round", () => {
		const log: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Wait" },
			{ type: "workflow_phase", index: 1, title: "Run" },
			done(0, 0, 10, { roundIndex: 1 }),
			done(1, 1, 11, { roundIndex: 2 }),
			done(2, 1, 12, { roundIndex: 2 }),
		];
		const whole = buildPhaseTree(log);
		expect(whole.totals.total).toBe(3);
		const second = buildPhaseTree(log, undefined, { round: 2 });
		expect(flattenPhaseTree(second).map(node => node.title)).toEqual(["Run"]);
		expect(second.totals.total).toBe(2);
	});

	it("drops `phases to go` for a round that has settled", () => {
		// A past round is behind, whatever `meta` declared: "2 phases to go" beside
		// it would read as work still owed.
		const log: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Wait" },
			done(0, 0, 10, { roundIndex: 1 }),
			done(1, 0, 11, { roundIndex: 2 }),
		];
		const declared = [{ title: "Wait" }, { title: "Run" }];
		expect(buildPhaseTree(log, declared).remaining).toEqual(["Run"]);
		expect(buildPhaseTree(log, declared, { round: 1 }).remaining).toEqual([]);
	});

	it("caches the derived tree until the version moves", () => {
		// The inspector redraws at 80 ms; a loop's log is the largest thing in the
		// session, so the walk has to be once per batch rather than once per frame.
		const log: WorkflowEntry[] = [done(0, 0, 10, { roundIndex: 1 })];
		const first = buildPhaseTree(log, undefined, { round: 1, version: 1 });
		log.push(done(1, 0, 11, { roundIndex: 1 }));
		expect(buildPhaseTree(log, undefined, { round: 1, version: 1 })).toBe(first);
		expect(buildPhaseTree(log, undefined, { round: 1, version: 2 })).not.toBe(first);
	});
});

describe("header", () => {
	const task = { status: "running" as const, startTime: 0 };
	const meta = { name: "ps-drive-tester", description: "triage" };

	it("leads with the round when a run has looped", () => {
		const log: WorkflowEntry[] = [
			{ type: "workflow_phase", index: 0, title: "Wait" },
			...agentRows(0, { roundIndex: 1 }),
			...agentRows(1, { roundIndex: 2 }),
		];
		const rounds = roundSummaries(log);
		const stats = header(task, meta, buildPhaseTree(log, undefined, { round: 2 }), 2, 60_000, rounds).stats;
		expect(stats).toContain("round 2");
		// The round's own fraction can finish; the run's total cannot.
		expect(stats).toContain("1/1");
		expect(stats).toContain("2 settled");
	});

	it("adds the pruned rounds back into the run's totals", () => {
		// The counters a prune leaves behind live in `archived`; without them the
		// header's settled count would fall every time memory was reclaimed.
		const log: WorkflowEntry[] = [...agentRows(0, { roundIndex: 5 }), ...agentRows(1, { roundIndex: 6 })];
		const rounds = roundSummaries(log);
		const archived = { rounds: 4, through: 4, agents: 100, settled: 100, failed: 2, tokens: 900_000, durationMs: 5 };
		const stats = header(task, meta, buildPhaseTree(log, undefined, { round: 6 }), 2, 60_000, rounds, archived)
			.stats;
		expect(stats).toContain("102 settled");
		expect(stats).toContain("2 failed");
		expect(stats).toContain("900.0k tok");
	});

	it("keeps the single-round header a run has always had", () => {
		const log = agentRows(0);
		const rounds = roundSummaries(log);
		const stats = header(task, meta, buildPhaseTree(log), 1, 60_000, rounds).stats;
		expect(stats).toMatch(/^1\/1 agent · 1m00s/);
	});
});

describe("earlierRounds", () => {
	it("folds the rounds behind the live one", () => {
		const log: WorkflowEntry[] = [
			...agentRows(0, { roundIndex: 1, tokens: 10 }),
			...agentRows(1, { roundIndex: 2, tokens: 20 }),
			...agentRows(2, { roundIndex: 3, tokens: 40 }),
		];
		const fold = earlierRounds(roundSummaries(log));
		expect(fold).toMatchObject({ from: 1, to: 2, rounds: 2, agents: 2, tokens: 30 });
	});

	it("includes rounds pruned from memory", () => {
		const log: WorkflowEntry[] = [...agentRows(0, { roundIndex: 5 }), ...agentRows(1, { roundIndex: 6 })];
		const archived = { rounds: 4, through: 4, agents: 100, settled: 100, failed: 3, tokens: 900, durationMs: 5 };
		expect(earlierRounds(roundSummaries(log), archived)).toMatchObject({
			from: 1,
			to: 5,
			rounds: 5,
			agents: 101,
			failed: 3,
			tokens: 900,
		});
	});

	it("has nothing to fold before a run has looped", () => {
		expect(earlierRounds(roundSummaries(agentRows(0)))).toBeUndefined();
	});
});
