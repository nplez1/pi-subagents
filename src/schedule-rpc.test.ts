/**
 * schedule-rpc.test.ts — the cross-extension surface over the scheduler.
 *
 * Two contracts are pinned here, because both are load-bearing for `/loop`:
 *   - `restored` fires once per job read back from the store, so a consumer
 *     mirroring the scheduler learns about jobs it never saw created (a
 *     `/resume`). Without it, the footer would show an empty session that has
 *     live timers running in it.
 *   - `remove` really disarms. The whole reason this RPC exists is that the
 *     only previous cancel path was the interactive menu; a remove that left a
 *     timer running would be worse than no remove at all.
 */

import { describe, expect, it } from "vitest";
import { SubagentScheduler } from "./schedule.js";
import {
	createSchedule,
	deriveJobName,
	listSchedules,
	removeSchedule,
	type ScheduleCapable,
	type ScheduleCreateInput,
	toJobView,
} from "./schedule-rpc.js";
import type { ScheduledSubagent } from "./types.js";

/** A stored job with the fields the RPC layer reads; overridable per test. */
function job(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
	return {
		id: "job1",
		name: "say hello",
		description: "say hello",
		schedule: "1m",
		scheduleType: "interval",
		intervalMs: 60_000,
		subagent_type: "general-purpose",
		prompt: "say hello",
		enabled: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		runCount: 0,
		...overrides,
	};
}

function fakeScheduler(
	seed: ScheduledSubagent[] = [],
): ScheduleCapable & { jobs: Map<string, ScheduledSubagent> } {
	const jobs = new Map(seed.map((j) => [j.id, j]));
	return {
		jobs,
		isActive: () => true,
		list: () => [...jobs.values()],
		addJob: (input: ScheduleCreateInput) => {
			const created = job({
				id: `job${jobs.size + 1}`,
				name: input.name ?? "unnamed",
				description: input.description ?? "unnamed",
				schedule: input.schedule,
				prompt: input.prompt,
				subagent_type: (input.subagent_type ??
					"general-purpose") as ScheduledSubagent["subagent_type"],
			});
			jobs.set(created.id, created);
			return created;
		},
		removeJob: (id: string) => jobs.delete(id),
		getNextRun: (id: string) =>
			jobs.has(id) ? "2026-01-01T00:01:00.000Z" : undefined,
	};
}

// ── restored events ─────────────────────────────────────────────────────────

describe("scheduler restore", () => {
	it("announces every stored job on start, so a consumer can mirror them", () => {
		const events: Array<{ type: string; id?: string }> = [];
		const scheduler = new SubagentScheduler();
		// A future one-shot arms a real setTimeout, which `stop()` clears below.
		// It must stay under Node's ~24.8-day timer ceiling, or the timer would
		// overflow and fire immediately instead of being a quiet arm.
		const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
		const store = {
			list: () => [
				job({ id: "a", scheduleType: "once", schedule: soon }),
				job({ id: "b", scheduleType: "once", schedule: soon, enabled: false }),
			],
		} as any;

		scheduler.start(
			{
				events: {
					emit: (_name: string, event: any) =>
						events.push({ type: event.type, id: event.job?.id }),
				},
			} as any,
			{} as any,
			{} as any,
			store,
		);

		expect(events).toEqual([
			{ type: "restored", id: "a" },
			{ type: "restored", id: "b" },
		]);
		scheduler.stop();
	});

	it("says nothing when the session has no stored jobs", () => {
		const events: string[] = [];
		const scheduler = new SubagentScheduler();
		scheduler.start(
			{
				events: {
					emit: (_name: string, event: any) => events.push(event.type),
				},
			} as any,
			{} as any,
			{} as any,
			{ list: () => [] } as any,
		);
		expect(events).toEqual([]);
		scheduler.stop();
	});
});

// ── list / create / remove ──────────────────────────────────────────────────

describe("schedules RPC", () => {
	it("lists each job with its live next run", () => {
		const scheduler = fakeScheduler([job({ id: "a" })]);
		const { jobs } = listSchedules(scheduler);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			id: "a",
			schedule: "1m",
			nextRun: "2026-01-01T00:01:00.000Z",
		});
	});

	it("refuses to list before the scheduler has bound a session", () => {
		const inactive = { ...fakeScheduler(), isActive: () => false };
		expect(() => listSchedules(inactive)).toThrow(/not active/i);
	});

	it("derives a name from the prompt when the caller supplies none", () => {
		const scheduler = fakeScheduler();
		const created = createSchedule(scheduler, {
			schedule: "1m",
			prompt: "  say\n hello  ",
		});
		expect(created.name).toBe("say hello");
		expect(scheduler.jobs.get(created.id)?.prompt).toBe("say\n hello");
	});

	it("defaults the agent type and reports the first run", () => {
		const scheduler = fakeScheduler();
		const created = createSchedule(scheduler, {
			schedule: "5m",
			prompt: "check the deploy",
		});
		expect(created.nextRun).toBe("2026-01-01T00:01:00.000Z");
		expect(scheduler.jobs.get(created.id)?.subagent_type).toBe(
			"general-purpose",
		);
	});

	it("requires a schedule and a prompt", () => {
		const scheduler = fakeScheduler();
		expect(() =>
			createSchedule(scheduler, { schedule: "", prompt: "x" }),
		).toThrow(/schedule/);
		expect(() =>
			createSchedule(scheduler, { schedule: "1m", prompt: "  " }),
		).toThrow(/prompt/);
	});

	it("removes a job, and says so when the id is unknown", () => {
		const scheduler = fakeScheduler([job({ id: "a" })]);
		expect(removeSchedule(scheduler, "a")).toEqual({ removed: "a" });
		expect(scheduler.jobs.size).toBe(0);
		expect(() => removeSchedule(scheduler, "a")).toThrow(/No scheduled job/);
	});

	it("prefers the armed timer's next run over the stored snapshot", () => {
		const view = toJobView(
			job({ nextRun: "1999-01-01T00:00:00.000Z" }),
			"2026-01-01T00:01:00.000Z",
		);
		expect(view.nextRun).toBe("2026-01-01T00:01:00.000Z");
	});

	it("caps a derived name so a long prompt stays a label", () => {
		expect(deriveJobName("x".repeat(200))).toHaveLength(60);
		expect(deriveJobName("   ")).toBe("scheduled job");
	});
});
