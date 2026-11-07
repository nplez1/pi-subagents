/**
 * schedule-rpc.ts — cross-extension RPC for the subagent scheduler.
 *
 * Why this exists: the scheduler was reachable only through the `Agent` tool's
 * `schedule` param and the `/agents → Scheduled jobs` menu. A job could be
 * created but never listed or cancelled by anything else — the menu is the only
 * cancel path, and it is interactive. `/loop` needs both, because it presents
 * scheduled work as one surface with two backends (live-session ticks and these
 * cold subagent jobs) and has to be able to stop either one.
 *
 * Channels, all under the shared `subagents:rpc:` namespace and replying through
 * the same per-request envelope as the rest of the RPC layer:
 *
 *   subagents:rpc:schedules:list    → { jobs: ScheduledJobView[] }
 *   subagents:rpc:schedules:create  → { id, name, nextRun? }
 *   subagents:rpc:schedules:remove  → {}
 *
 * Session-scoped, like everything the scheduler owns: a caller reads and writes
 * the current session's store, and nothing here can reach another session's.
 */

import type { ScheduleChangeEvent } from "./schedule.js";
import type { ScheduledSubagent } from "./types.js";

/** The slice of `SubagentScheduler` these handlers use. */
export interface ScheduleCapable {
	isActive(): boolean;
	list(): ScheduledSubagent[];
	addJob(input: ScheduleCreateInput): ScheduledSubagent;
	removeJob(id: string): boolean;
	getNextRun(jobId: string): string | undefined;
}

/**
 * Params for `create`. Mirrors `NewJobInput` with the fields a non-model caller
 * (a slash command) can reasonably leave out: `name`/`description` fall back to
 * the prompt, and `subagent_type` to the general-purpose default.
 */
export interface ScheduleCreateInput {
	name?: string;
	description?: string;
	schedule: string;
	prompt: string;
	subagent_type?: string;
	model?: string;
	thinking?: ScheduledSubagent["thinking"];
	max_turns?: number;
	isolated?: boolean;
	isolation?: ScheduledSubagent["isolation"];
}

/** One job as a caller sees it: the stored row plus its live next run. */
export interface ScheduledJobView {
	id: string;
	name: string;
	description: string;
	schedule: string;
	scheduleType: ScheduledSubagent["scheduleType"];
	/** Interval cadence for `scheduleType: "interval"`; absent for cron/once. */
	intervalMs?: number;
	enabled: boolean;
	prompt: string;
	subagent_type: string;
	runCount: number;
	lastRun?: string;
	lastStatus?: ScheduledSubagent["lastStatus"];
	/** From `getNextRun` — the armed timer's answer, not the stored snapshot. */
	nextRun?: string;
}

/** Default agent type for a scheduled job created without one. */
const DEFAULT_SUBAGENT_TYPE = "general-purpose";
/** A derived name is a label in a list, not a transcript. */
const DERIVED_NAME_MAX = 60;

/**
 * The name a job gets when the caller supplied none. First line, collapsed and
 * capped, so `/loop 1m --cold say hello` lists as "say hello" rather than as an
 * empty row or a 400-character prompt.
 */
export function deriveJobName(prompt: string): string {
	const single = prompt.replace(/\s+/g, " ").trim();
	if (!single) return "scheduled job";
	return single.length > DERIVED_NAME_MAX
		? `${single.slice(0, DERIVED_NAME_MAX - 1)}…`
		: single;
}

/** Project a stored job into the caller-facing view, resolving its next run. */
export function toJobView(
	job: ScheduledSubagent,
	nextRun: string | undefined,
): ScheduledJobView {
	return {
		id: job.id,
		name: job.name,
		description: job.description,
		schedule: job.schedule,
		scheduleType: job.scheduleType,
		intervalMs: job.intervalMs,
		enabled: job.enabled,
		prompt: job.prompt,
		subagent_type: job.subagent_type,
		runCount: job.runCount,
		lastRun: job.lastRun,
		lastStatus: job.lastStatus,
		nextRun: nextRun ?? job.nextRun,
	};
}

function requireActive(scheduler: ScheduleCapable): void {
	if (!scheduler.isActive()) {
		throw new Error(
			"Scheduler is not active in this session yet. Try again after the session has fully started.",
		);
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`\`${field}\` is required.`);
	return value.trim();
}

/** List every scheduled job in this session, newest state first. */
export function listSchedules(scheduler: ScheduleCapable): {
	jobs: ScheduledJobView[];
} {
	requireActive(scheduler);
	const jobs = scheduler
		.list()
		.map((job) => toJobView(job, scheduler.getNextRun(job.id)));
	return { jobs };
}

/** Create a scheduled job. Returns its id and first run so a caller can report both. */
export function createSchedule(
	scheduler: ScheduleCapable,
	input: ScheduleCreateInput,
): { id: string; name: string; nextRun?: string } {
	requireActive(scheduler);
	const schedule = requireString(input.schedule, "schedule");
	const prompt = requireString(input.prompt, "prompt");
	const name = input.name?.trim() || deriveJobName(prompt);

	const job = scheduler.addJob({
		name,
		description: input.description?.trim() || name,
		schedule,
		subagent_type: (input.subagent_type ??
			DEFAULT_SUBAGENT_TYPE) as ScheduledSubagent["subagent_type"],
		prompt,
		model: input.model,
		thinking: input.thinking,
		max_turns: input.max_turns,
		isolated: input.isolated,
		isolation: input.isolation,
	});

	return { id: job.id, name: job.name, nextRun: scheduler.getNextRun(job.id) };
}

/**
 * Remove a job. `removeJob` disarms the timer and drops the stored row, so this
 * is a real cancel — not a store edit that leaves the interval running.
 */
export function removeSchedule(
	scheduler: ScheduleCapable,
	jobId: unknown,
): { removed: string } {
	requireActive(scheduler);
	const id = requireString(jobId, "jobId");
	if (!scheduler.removeJob(id))
		throw new Error(`No scheduled job with id "${id}".`);
	return { removed: id };
}

/** Re-exported so a consumer can type the event stream it mirrors. */
export type { ScheduleChangeEvent };
