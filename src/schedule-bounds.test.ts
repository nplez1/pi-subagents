/**
 * schedule-bounds.test.ts — how a repeating job stops, and where "9am" is.
 *
 * Both are quiet failure modes rather than loud ones, which is why they are
 * pinned here:
 *   - an unbounded job keeps spending tokens until someone remembers it, so a
 *     bound has to be stored, reported and validated rather than assumed;
 *   - a cron expression names a wall clock and nothing else, so the zone has to
 *     be recorded on the job. Left implicit, it silently follows the machine and
 *     fires at a different hour after a move or a DST shift.
 */

import { describe, expect, it } from "vitest";
import { SubagentScheduler } from "./schedule.js";
import { toJobView } from "./schedule-rpc.js";
import type { ScheduledSubagent } from "./types.js";

function job(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
	return {
		id: "job1",
		name: "nightly",
		description: "nightly",
		schedule: "0 0 9 * * 1",
		scheduleType: "cron",
		subagent_type: "general-purpose",
		prompt: "check the deploy",
		enabled: true,
		createdAt: new Date().toISOString(),
		runCount: 0,
		...overrides,
	};
}

describe("resolveTimezone", () => {
	it("records this machine's zone rather than leaving the default implicit", () => {
		const zone = SubagentScheduler.resolveTimezone("cron");
		expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		expect(zone).toBeTruthy();
	});

	it("keeps an explicit zone instead of overriding it with the local one", () => {
		expect(SubagentScheduler.resolveTimezone("cron", "America/Los_Angeles")).toBe(
			"America/Los_Angeles",
		);
	});

	it("refuses an unknown zone by name", () => {
		expect(() => SubagentScheduler.resolveTimezone("cron", "Mars/Olympus_Mons")).toThrow(
			/Unknown timezone/,
		);
	});

	it("refuses a zone on a schedule that has no wall clock to apply it to", () => {
		// Silently dropping it would read to the caller as "applied".
		expect(() => SubagentScheduler.resolveTimezone("interval", "Europe/London")).toThrow(
			/only applies to a cron schedule/,
		);
		expect(() => SubagentScheduler.resolveTimezone("once", "Europe/London")).toThrow(
			/only applies to a cron schedule/,
		);
	});

	it("accepts no zone for interval and one-shot schedules", () => {
		expect(SubagentScheduler.resolveTimezone("interval")).toBeUndefined();
		expect(SubagentScheduler.resolveTimezone("once")).toBeUndefined();
	});
});

describe("validateMaxRuns", () => {
	it("accepts a positive whole number", () => {
		expect(SubagentScheduler.validateMaxRuns(3)).toBe(3);
	});

	it("treats absent as unbounded", () => {
		expect(SubagentScheduler.validateMaxRuns(undefined)).toBeUndefined();
	});

	it("refuses a count that could never fire", () => {
		expect(() => SubagentScheduler.validateMaxRuns(0)).toThrow(/at least 1/);
		expect(() => SubagentScheduler.validateMaxRuns(-2)).toThrow(/at least 1/);
		expect(() => SubagentScheduler.validateMaxRuns(1.5)).toThrow(/whole number/);
	});
});

describe("validateUntil", () => {
	it("normalizes a future instant to ISO", () => {
		const at = new Date(Date.now() + 60_000);
		expect(SubagentScheduler.validateUntil(at.toISOString())).toBe(at.toISOString());
	});

	it("refuses a past instant, which would arm a job that never fires", () => {
		expect(() => SubagentScheduler.validateUntil("2020-01-01T00:00:00Z")).toThrow(/in the past/);
	});

	it("refuses a value that is not a timestamp", () => {
		expect(() => SubagentScheduler.validateUntil("next tuesday")).toThrow(/ISO timestamp/);
	});
});

describe("toJobView", () => {
	it("reports the bounds and the zone a job stops on", () => {
		const view = toJobView(
			job({ maxRuns: 4, until: "2026-12-01T00:00:00.000Z", timezone: "Europe/London" }),
			undefined,
		);

		expect(view.maxRuns).toBe(4);
		expect(view.until).toBe("2026-12-01T00:00:00.000Z");
		expect(view.timezone).toBe("Europe/London");
	});

	it("reports who armed the job, so a bulk verb can attribute it", () => {
		const origin = { sessionId: "sess-1", depth: 0 };
		expect(toJobView(job({ origin }), undefined).origin).toEqual(origin);
	});
});
