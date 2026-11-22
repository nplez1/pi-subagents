/**
 * schedule-preview.ts — what a schedule string means, before anything is armed.
 *
 * A cron typo is the cheapest scheduling mistake to make and the most expensive
 * to notice: "0 9 * * 1" (5 fields) is refused, but "0 0 9 * * 0" instead of
 * "… 1" arms happily and fires on Sunday. Previewing the next few fire instants,
 * in the job's own zone and the user's local clock, makes the reading visible
 * while it is still free to change.
 *
 * Both homes are previewed with their own rules, because they differ where it
 * matters: a cold interval's first fire is one interval after create (it is a
 * `setInterval`), a live interval's first fire is as soon as the creating turn
 * ends; live floors intervals at one minute and refuses cron; an unbounded live
 * loop stops at its 7-day TTL.
 */

import { Cron } from "croner";
import { formatSpan } from "./duration.js";
import { SubagentScheduler } from "./schedule.js";

/**
 * `/loop`'s own limits, duplicated: the live backend lives in pi-config's
 * `loop.ts` (`MIN_INTERVAL_MS`, `LOOP_TTL_MS`), and a preview has to answer
 * without a round trip. Change one, change both.
 */
export const LIVE_MIN_INTERVAL_MS = 60_000;
export const LIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const PREVIEW_COUNT = 5;

export interface SchedulePreview {
	backend: "cold" | "live";
	kind: "interval" | "once" | "cron";
	/** The zone a cron expression is read in. */
	timezone?: string;
	/** Fire instants, epoch ms, ascending. */
	times: number[];
	/** Facts about this schedule a caller would otherwise learn the hard way. */
	notes: string[];
}

/**
 * `14:05 PST` today, `Sat, Nov 22, 09:00 PST` otherwise — the user's clock.
 *
 * Machine-local by design: the listing is read by the person at this machine,
 * and an ISO instant in UTC is the form they are least able to check at a glance.
 */
export function clockLabel(epochMs: number, now = Date.now()): string {
	const date = new Date(epochMs);
	const sameDay = date.toDateString() === new Date(now).toDateString();
	return new Intl.DateTimeFormat("en-US", {
		...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).format(date);
}

/** Next fire instants for `schedule` in `backend`, honouring the bounds. Throws what create would throw. */
export function previewSchedule(input: {
	schedule: string;
	backend?: "cold" | "live";
	timezone?: string;
	until?: string;
	maxRuns?: number;
	now?: number;
	count?: number;
}): SchedulePreview {
	const now = input.now ?? Date.now();
	const backend = input.backend ?? "cold";
	const count = Math.max(1, Math.min(input.count ?? PREVIEW_COUNT, 20));
	const schedule = input.schedule.trim();
	const notes: string[] = [];
	const maxRuns = SubagentScheduler.validateMaxRuns(
		input.maxRuns === 0 ? undefined : input.maxRuns,
	);
	const until =
		typeof input.until === "string" && input.until.trim()
			? new Date(
					SubagentScheduler.validateUntil(input.until) as string,
				).getTime()
			: undefined;

	let kind: SchedulePreview["kind"];
	let timezone: string | undefined;
	let times: number[];

	if (backend === "live") {
		if (input.timezone) {
			throw new Error(
				"A live loop takes no `timezone`: it has no cron, and its intervals and one-shots are instants, not wall-clock times.",
			);
		}
		const interval = SubagentScheduler.parseInterval(schedule);
		const relative = /^\+(\d+)([smhd])$/.test(schedule)
			? SubagentScheduler.parseRelativeTime(schedule)
			: null;
		if (interval !== null && interval > 0) {
			kind = "interval";
			const ms = Math.max(interval, LIVE_MIN_INTERVAL_MS);
			if (ms !== interval)
				notes.push(
					`Raised to the live floor of ${formatSpan(LIVE_MIN_INTERVAL_MS, "seconds")}.`,
				);
			times = Array.from({ length: count }, (_, k) => now + k * ms);
			notes.push(
				"The first fire lands as soon as the creating turn ends, then every interval on that phase; a fire due mid-turn waits for the session to go idle.",
			);
		} else if (relative !== null || /^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
			kind = "once";
			const at = new Date(relative ?? schedule).getTime();
			if (Number.isNaN(at) || at <= now)
				throw new Error(`"${schedule}" is not a future instant.`);
			times = [at];
		} else {
			throw new Error(
				`"${schedule}" is not a live-loop schedule. Use an interval (5m / 30m / 1h / 2d) or a one-shot (+10m or an ISO timestamp); 6-field cron exists on the cold backend only.`,
			);
		}
		if (maxRuns === undefined && until === undefined && kind === "interval") {
			const ttl = now + LIVE_TTL_MS;
			if (times.some((at) => at >= ttl))
				notes.push(
					"An unbounded live loop expires 7 days after create; give it `until` or `maxRuns` to run longer.",
				);
			times = times.filter((at) => at < ttl);
		}
	} else {
		const detected = SubagentScheduler.detectSchedule(schedule);
		kind = detected.type;
		timezone = SubagentScheduler.resolveTimezone(detected.type, input.timezone);
		if (detected.type === "interval" && detected.intervalMs) {
			const ms = detected.intervalMs;
			times = Array.from({ length: count }, (_, k) => now + (k + 1) * ms);
			notes.push(
				"The first fire is one interval after create, not at create. If the machine sleeps through slots they are skipped (counted, not replayed) and the interval runs on from the late fire.",
			);
		} else if (detected.type === "once") {
			times = [new Date(detected.normalized).getTime()];
		} else {
			times = new Cron(detected.normalized, { timezone })
				.nextRuns(count, new Date(now))
				.map((date) => date.getTime());
		}
	}

	if (until !== undefined) times = times.filter((at) => at < until);
	if (maxRuns !== undefined) times = times.slice(0, maxRuns);
	if (times.length === 0)
		notes.push(
			"No fire falls inside its bounds, so this job would never fire.",
		);
	return { backend, kind, timezone, times, notes };
}

/** The preview as the tool reports it. */
export function describePreview(
	schedule: string,
	preview: SchedulePreview,
	now = Date.now(),
): string {
	const reading =
		preview.kind === "cron"
			? `cron, read in ${preview.timezone}`
			: preview.kind === "once"
				? "one-shot"
				: "interval";
	const lines = [
		`Preview of "${schedule}" on the ${preview.backend} backend (${reading}) — nothing was armed:`,
		...preview.times.map(
			(at, k) =>
				`  ${k + 1}. ${clockLabel(at, now)} · ${new Date(at).toISOString()} (in ${formatSpan(Math.max(0, at - now), "seconds")})`,
		),
		...preview.notes,
	];
	return lines.join("\n");
}
