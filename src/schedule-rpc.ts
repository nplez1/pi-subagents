/**
 * schedule-rpc.ts — cross-extension RPC for the subagent scheduler.
 *
 * Why this exists: the scheduler used to be reachable only through the `Agent`
 * tool's `schedule` param and the interactive `/agents → Scheduled jobs` menu, so
 * a job could be created but never listed or cancelled by anything but a human.
 * Two callers need the programmatic surface: `manage_schedules`, which is the
 * model's one door to created *and* managed jobs, and `/loop`, which presents
 * scheduled work as one surface with two homes (live-session ticks and these cold
 * subagent jobs) and has to be able to stop either one.
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

import { normalizeMaxTurns } from "./agent-runner.js";
import { resolveSpawnType } from "./agent-types.js";
import type { ScheduleChangeEvent } from "./schedule.js";
import type { ScheduledSubagent, ThinkingLevel } from "./types.js";

/**
 * The thinking levels a job may pin — the storable set, which is pi's thinking
 * ladder without `"off"` (`ScheduledSubagent.thinking` cannot hold it, and a
 * job that wants no extended thinking simply omits the field). Duplicated here
 * on purpose: a scheduled fire resolves the level through `applyAgentDefaults`,
 * which refuses anything outside this set, and refusing at arming time beats a
 * job that errors on every fire because of a typo.
 */
const THINKING: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Validate the fields a create or update carries before they are stored.
 *
 * The retired `Agent`+`schedule` path inherited these checks from the Agent tool's
 * shared argument handling. Without them a typo in `subagent_type` was accepted
 * at arming time and then failed every single fire, which reads to the caller as
 * "scheduled" right up until nothing happens.
 */
function validateDispatchInput(input: {
  subagent_type?: string;
  thinking?: string;
  max_turns?: number;
}): { subagent_type?: string; thinking?: ThinkingLevel; max_turns?: number } {
  const out: { subagent_type?: string; thinking?: ThinkingLevel; max_turns?: number } = {};

  if (input.subagent_type !== undefined) {
    const dispatch = resolveSpawnType(input.subagent_type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // The caller's own name, not the substitute: the scheduler re-resolves at
    // fire time, so storing the substitute would silently freeze today's fallback.
    out.subagent_type = input.subagent_type;
  }

  if (input.thinking !== undefined) {
    if (!THINKING.includes(input.thinking as ThinkingLevel)) {
      throw new Error(`\`thinking\` must be one of ${THINKING.join(", ")}, got "${input.thinking}".`);
    }
    out.thinking = input.thinking as ThinkingLevel;
  }

  if (input.max_turns !== undefined) {
    if (!Number.isFinite(input.max_turns) || input.max_turns < 0) {
      throw new Error(`\`max_turns\` must be 0 (unlimited) or a positive number, got ${input.max_turns}.`);
    }
    out.max_turns = normalizeMaxTurns(input.max_turns);
  }

  return out;
}

/** The slice of `SubagentScheduler` these handlers use. */
export interface ScheduleCapable {
	isActive(): boolean;
	list(): ScheduledSubagent[];
	getJob(id: string): ScheduledSubagent | undefined;
	addJob(input: ScheduleCreateInput): ScheduledSubagent;
	updateJob(
		id: string,
		patch: Partial<ScheduledSubagent>,
		options?: { rearm?: boolean },
	): ScheduledSubagent | undefined;
	/** Names in use, so an update cannot collide with another job. */
	hasName(name: string, exceptId?: string): boolean;
	removeJob(id: string): boolean;
	getNextRun(jobId: string): string | undefined;
	normalizeSchedule(schedule: string): {
		schedule: string;
		scheduleType: ScheduledSubagent["scheduleType"];
		intervalMs?: number;
	};
	runNow(id: string): { ok: true; job: ScheduledSubagent } | { ok: false; error: string };
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
	/** Disable after this many fires. */
	maxRuns?: number;
	/** ISO timestamp the job must not fire at or after. */
	until?: string;
	/** IANA zone a cron expression is read in; refused for other types. */
	timezone?: string;
	/** Who armed it. Stamped by the tool layer, never by a model. */
	origin?: ScheduledSubagent["origin"];
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
	/** A pinned model for each fire, when the job names one. */
	model?: string;
	thinking?: ScheduledSubagent["thinking"];
	runCount: number;
	lastRun?: string;
	lastStatus?: ScheduledSubagent["lastStatus"];
	/** From `getNextRun` — the armed timer's answer, not the stored snapshot. */
	nextRun?: string;
	/** How many fires stop the job; absent when it repeats until cancelled. */
	maxRuns?: number;
	/** ISO stop time; absent when it has none. */
	until?: string;
	/** The zone a cron expression is read in. */
	timezone?: string;
	/** Who armed it, so a listing can attribute it. */
	origin?: ScheduledSubagent["origin"];
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
		model: job.model,
		thinking: job.thinking,
		runCount: job.runCount,
		lastRun: job.lastRun,
		lastStatus: job.lastStatus,
		// A disabled job arms nothing, so the stored `nextRun` of one that has
		// fired before is a stale countdown. Reporting it made a paused job read
		// as "next in 4m" in both `list` and the footer.
		nextRun: job.enabled ? (nextRun ?? job.nextRun) : undefined,
		maxRuns: job.maxRuns,
		until: job.until,
		timezone: job.timezone,
		origin: job.origin,
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
	const checked = validateDispatchInput({
		subagent_type: input.subagent_type ?? DEFAULT_SUBAGENT_TYPE,
		thinking: input.thinking,
		max_turns: input.max_turns,
	});

	const job = scheduler.addJob({
		name,
		description: input.description?.trim() || name,
		schedule,
		subagent_type: checked.subagent_type as ScheduledSubagent["subagent_type"],
		prompt,
		model: input.model,
		thinking: checked.thinking,
		max_turns: checked.max_turns,
		isolated: input.isolated,
		isolation: input.isolation,
		maxRuns: input.maxRuns,
		until: input.until,
		timezone: input.timezone,
		origin: input.origin,
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

/**
 * Change a job: its cadence, its prompt, its agent, or whether it is enabled.
 *
 * One entry point rather than four, because pausing and re-timing are the same
 * operation on the same row, and a caller that has to know which verb a change
 * belongs to is a caller that will pick wrong. Only fields that actually differ
 * are written, and `changed` names them: an update that silently re-sent the
 * same values would let a caller report a change that never happened.
 *
 * `enabled: false` pauses (the timer is disarmed, the row and its history stay);
 * `enabled: true` resumes and re-arms from now.
 */
export function updateSchedule(
	scheduler: ScheduleCapable,
	input: ScheduleUpdateInput,
): { id: string; changed: string[]; job: ScheduledJobView } {
	requireActive(scheduler);
	const id = requireString(input.jobId, "jobId");
	const current = scheduler.getJob(id);
	if (!current) throw new Error(`No scheduled job with id "${id}".`);

	const patch: Partial<ScheduledSubagent> = {};
	const changed: string[] = [];

	if (typeof input.schedule === "string" && input.schedule.trim()) {
		// Normalized through the scheduler's own parser, so an update accepts
		// exactly what a create accepts and stores it the same way.
		const next = scheduler.normalizeSchedule(input.schedule);
		if (next.schedule !== current.schedule) {
			patch.schedule = next.schedule;
			patch.scheduleType = next.scheduleType;
			patch.intervalMs = next.intervalMs;
			changed.push(`schedule ${next.schedule}`);
		}
	}

	if (typeof input.prompt === "string" && input.prompt.trim() && input.prompt.trim() !== current.prompt) {
		patch.prompt = input.prompt.trim();
		changed.push("prompt");
	}

	if (typeof input.name === "string" && input.name.trim() && input.name.trim() !== current.name) {
		const name = input.name.trim();
		// `addJob` refuses a duplicate name, so an update must too: otherwise the
		// store's uniqueness rule holds only on the create path, and two jobs the
		// user cannot tell apart appear under identical labels.
		if (scheduler.hasName(name, id)) {
			throw new Error(
				`Another scheduled job is already named "${name}". Pick a different \`name\`, or cancel that one first.`,
			);
		}
		patch.name = name;
		changed.push(`name ${name}`);
	}

	// Validated as a create would be: a stored typo fails every fire, and reads as
	// "scheduled" right up until nothing happens.
	const checked = validateDispatchInput({
		subagent_type:
			typeof input.subagent_type === "string" && input.subagent_type.trim()
				? input.subagent_type.trim()
				: undefined,
		thinking: input.thinking,
		max_turns: input.max_turns,
	});

	if (checked.subagent_type !== undefined && checked.subagent_type !== current.subagent_type) {
		patch.subagent_type = checked.subagent_type as ScheduledSubagent["subagent_type"];
		changed.push(`agent ${patch.subagent_type}`);
	}

	if (typeof input.model === "string" && input.model.trim() !== (current.model ?? "")) {
		patch.model = input.model.trim() || undefined;
		changed.push(`model ${patch.model ?? "inherit"}`);
	}

	if (checked.thinking !== undefined && checked.thinking !== current.thinking) {
		patch.thinking = checked.thinking;
		changed.push(`thinking ${patch.thinking}`);
	}

	if (checked.max_turns !== undefined && checked.max_turns !== current.max_turns) {
		patch.max_turns = checked.max_turns;
		changed.push(`max_turns ${patch.max_turns}`);
	}

	if (typeof input.enabled === "boolean" && input.enabled !== current.enabled) {
		patch.enabled = input.enabled;
		changed.push(input.enabled ? "resumed" : "paused");
	}

	// A bound is removable as well as settable: `maxRuns: 0` and an empty `until`
	// both mean "no bound", because a job armed with one and then told to keep
	// going is a real request, and leaving no way to say it would force a cancel
	// and a re-create that loses the job's id and history.
	if (input.maxRuns !== undefined && input.maxRuns !== current.maxRuns) {
		patch.maxRuns = input.maxRuns === 0 ? undefined : input.maxRuns;
		changed.push(input.maxRuns === 0 ? "maxRuns removed" : `maxRuns ${input.maxRuns}`);
	}

	if (typeof input.until === "string") {
		const until = input.until.trim() ? new Date(input.until).toISOString() : undefined;
		if (until !== current.until) {
			patch.until = until;
			changed.push(until === undefined ? "until removed" : `until ${until}`);
		}
	}

	if (typeof input.timezone === "string" && input.timezone.trim() && input.timezone.trim() !== current.timezone) {
		patch.timezone = input.timezone.trim();
		changed.push(`timezone ${patch.timezone}`);
	}

	if (changed.length === 0) {
		throw new Error(
			`Nothing changed for job "${id}". Pass at least one field that differs from what it already has.`,
		);
	}

	// Only a timing change disarms and re-arms the timer. Re-arming for a prompt
	// typo would restart the interval from now and move every later fire, which is
	// not what "fix the wording" means.
	const updated = scheduler.updateJob(id, patch, {
		rearm: "schedule" in patch || "enabled" in patch || "timezone" in patch,
	});
	if (!updated) throw new Error(`No scheduled job with id "${id}".`);
	return { id, changed, job: toJobView(updated, scheduler.getNextRun(id)) };
}

/**
 * Fire a job now, leaving its own schedule armed.
 *
 * The scheduler answers why not when it refuses (unknown id, paused, or still
 * running), because each of those needs a different next move from the caller.
 */
export function runSchedule(
	scheduler: ScheduleCapable,
	jobId: unknown,
): { id: string; job: ScheduledJobView } {
	requireActive(scheduler);
	const id = requireString(jobId, "jobId");
	const result = scheduler.runNow(id);
	if (!result.ok) throw new Error(result.error);
	return { id, job: toJobView(result.job, scheduler.getNextRun(id)) };
}

/** Params for `update`: every field optional except the id it names. */
export interface ScheduleUpdateInput {
	jobId: string;
	schedule?: string;
	prompt?: string;
	name?: string;
	subagent_type?: string;
	model?: string;
	thinking?: ScheduledSubagent["thinking"];
	max_turns?: number;
	enabled?: boolean;
	/** `0` clears the bound; a positive number disables after that many fires. */
	maxRuns?: number;
	/** ISO stop time; an empty string clears it. */
	until?: string;
	/** IANA zone a cron expression is read in. */
	timezone?: string;
}

/** Re-exported so a consumer can type the event stream it mirrors. */
export type { ScheduleChangeEvent };
