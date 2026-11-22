/**
 * schedule.ts — `SubagentScheduler`: timer-driven dispatcher of scheduled subagents.
 *
 * Mirrors the engine shape of pi-cron-schedule/src/scheduler.ts:
 *   - two-Map split (jobs = croner Cron, intervals = setInterval/setTimeout)
 *   - addJob/removeJob/updateJob/scheduleJob/unscheduleJob/executeJob
 *   - static parsers for cron / "+10m" / "5m" / ISO formats
 *
 * Differences vs pi-cron-schedule:
 *   - Persistence is via ScheduleStore (PID-locked, session-scoped, atomic).
 *   - `executeJob` calls `manager.spawn(..., { bypassQueue: true })` instead
 *     of dispatching a user message — schedule fires bypass maxConcurrent so
 *     a 5-minute interval can't be deferred behind 4 long-running agents.
 *   - Result delivery is implicit: spawn → background completion → existing
 *     immediate `subagent-notification` path. No new delivery code.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cron } from "croner";
import { nanoid } from "nanoid";
import type { AgentManager } from "./agent-manager.js";
import { normalizeMaxTurns } from "./agent-runner.js";
import { resolveSpawnType } from "./agent-types.js";
import { applyAgentDefaults } from "./agent-defaults.js";
import { resolvePinnedModel } from "./model-resolver.js";
import type { ScheduleStore } from "./schedule-store.js";
import type {
  IsolationMode,
  JobOrigin,
  ScheduledFireRecord,
  ScheduledSubagent,
  SubagentType,
  ThinkingLevel,
} from "./types.js";

/** Fires kept per job: enough to answer "what did it find lately", small enough to rewrite every fire. */
export const SCHEDULE_HISTORY_MAX = 10;
/**
 * Failed fires in a row that pause a job when the caller set no policy; `0`
 * disables it. Pause, not cancel: the id, prompt and history survive for the
 * caller to read, and `resume` re-arms it once the cause is fixed.
 */
export const DEFAULT_PAUSE_AFTER_FAILURES = 3;
/** Timer jitter below this is not lateness worth reporting. */
const LATE_THRESHOLD_MS = 60_000;
/** A fire's summary is the head of its answer — a pointer to the result, not a copy of it. */
const SUMMARY_MAX = 280;

/** Event emitted on `pi.events` for cross-extension consumers. */
export type ScheduleChangeEvent =
  | { type: "added"; job: ScheduledSubagent }
  /**
   * A job read back from the store when the scheduler started — `/resume`
   * restoring a session's schedules. Emitted per job, before
   * `subagents:scheduler_ready`, so a consumer that mirrors this state (the
   * `/loop` footer does) learns about restored jobs it never saw created.
   * `added` is not reused: a restored job is not new, and a listener that
   * announces "scheduled X" on `added` must not announce it again on resume.
   */
  | { type: "restored"; job: ScheduledSubagent }
  | { type: "removed"; jobId: string }
  | { type: "updated"; job: ScheduledSubagent }
  | { type: "fired"; jobId: string; agentId: string; name: string }
  | { type: "error"; jobId: string; error: string };

/** Params accepted at job creation — ID, timestamps, and state are derived. */
export interface NewJobInput {
  name: string;
  description: string;
  schedule: string;
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;
  /** Disable after this many fires. */
  maxRuns?: number;
  /** ISO timestamp the job must not fire at or after. */
  until?: string;
  /** IANA zone for a cron expression; refused for other schedule types. */
  timezone?: string;
  /** Who armed it, so a listing and a bulk operation can attribute it. */
  origin?: JobOrigin;
  /** Failed fires in a row before it pauses itself; absent = the default, `0` = never. */
  pauseAfterFailures?: number;
}

export class SubagentScheduler {
  private jobs = new Map<string, Cron>();
  /** Ids with a fire that has not returned yet — `runNow`'s re-entrancy guard. */
  private inFlight = new Set<string>();
  /**
   * Ids whose fire is still *running*, as opposed to still being started.
   *
   * `inFlight` only covers the synchronous start (`executeJob` returns as soon as
   * the child is spawned), so it cannot answer "is this job busy" for the next
   * tick. Without this set an interval shorter than a run stacks concurrent
   * subagents on one prompt, and scheduled fires bypass the concurrency queue, so
   * nothing downstream would throttle them either.
   */
  private running = new Set<string>();
  private intervals = new Map<string, NodeJS.Timeout>();
  /**
   * Wall-clock instant an interval timer last fired or was armed.
   *
   * Node timers run on a monotonic clock that stops while the machine sleeps, so
   * after a night asleep a 2h `setInterval` fires once, hours late, and carries on
   * from there — the slots it slept through vanish. Comparing the wall clock
   * against this phase is how a late fire is noticed and its skipped slots
   * counted, instead of nobody ever knowing.
   */
  private intervalPhase = new Map<string, number>();
  private store: ScheduleStore | undefined;
  private pi: ExtensionAPI | undefined;
  private ctx: ExtensionContext | undefined;
  private manager: AgentManager | undefined;

  /** Start the scheduler: bind to a session's store and arm enabled jobs. */
  start(pi: ExtensionAPI, ctx: ExtensionContext, manager: AgentManager, store: ScheduleStore): void {
    this.pi = pi;
    this.ctx = ctx;
    this.manager = manager;
    this.store = store;

    for (const job of store.list()) {
      if (job.enabled) this.scheduleJob(job);
      // Announced even when disabled: a consumer mirroring the store needs the
      // whole set, not just the armed part of it. `enabled: false` is a fact
      // about the job, and dropping it here would make a paused job look gone.
      this.emit({ type: "restored", job });
    }
  }

  /** Stop all timers; drop refs. Safe to call repeatedly. */
  stop(): void {
    for (const cron of this.jobs.values()) cron.stop();
    this.jobs.clear();
    for (const t of this.intervals.values()) clearTimeout(t);
    this.intervals.clear();
    this.intervalPhase.clear();
    this.store = undefined;
    this.pi = undefined;
    this.ctx = undefined;
    this.manager = undefined;
  }

  /** True if start() has bound a store and the scheduler is active. */
  isActive(): boolean {
    return this.store !== undefined;
  }

  list(): ScheduledSubagent[] {
    return this.store?.list() ?? [];
  }

  /** Whether a job name is taken, excluding one id — `addJob`'s own rule, exposed. */
  hasName(name: string, exceptId?: string): boolean {
    return this.store?.hasName(name, exceptId) ?? false;
  }

  /**
   * Build a `ScheduledSubagent` from user input. Validates the schedule
   * format and tags `scheduleType`. Throws on invalid input.
   */
  buildJob(input: NewJobInput): ScheduledSubagent {
    const detected = SubagentScheduler.detectSchedule(input.schedule);
    return {
      id: nanoid(10),
      name: input.name,
      description: input.description,
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
      // `0` and `""` mean "no bound" at create too, so create, update and preview agree.
      maxRuns: SubagentScheduler.validateMaxRuns(input.maxRuns === 0 ? undefined : input.maxRuns),
      until: SubagentScheduler.validateUntil(input.until?.trim() ? input.until : undefined),
      timezone: SubagentScheduler.resolveTimezone(detected.type, input.timezone),
      pauseAfterFailures: SubagentScheduler.validatePauseAfterFailures(input.pauseAfterFailures),
      origin: input.origin,
      subagent_type: input.subagent_type,
      prompt: input.prompt,
      model: input.model,
      thinking: input.thinking,
      max_turns: input.max_turns,
      isolated: input.isolated,
      isolation: input.isolation,
      enabled: true,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
  }

  /**
   * Validate and normalize a schedule string without creating anything.
   *
   * The same parser `addJob` uses, exposed so an update cannot accept something
   * a create would refuse, or normalize it differently.
   */
  normalizeSchedule(schedule: string): {
    schedule: string;
    scheduleType: ScheduledSubagent["scheduleType"];
    intervalMs?: number;
  } {
    const detected = SubagentScheduler.detectSchedule(schedule);
    return {
      schedule: detected.normalized,
      scheduleType: detected.type,
      intervalMs: detected.intervalMs,
    };
  }

  /** Add a job, persist, and arm if enabled. Returns the stored job. */
  addJob(input: NewJobInput): ScheduledSubagent {
    const store = this.requireStore();
    if (store.hasName(input.name)) {
      throw new Error(`A scheduled job named "${input.name}" already exists.`);
    }
    const job = this.buildJob(input);
    store.add(job);
    if (job.enabled) this.scheduleJob(job);
    this.emit({ type: "added", job });
    return job;
  }

  removeJob(id: string): boolean {
    const store = this.requireStore();
    if (!store.get(id)) return false;
    this.unscheduleJob(id);
    const ok = store.remove(id);
    if (ok) this.emit({ type: "removed", jobId: id });
    return ok;
  }

  /**
   * Toggle / mutate a job.
   *
   * Re-arming is opt-out rather than always-on: unscheduling and rescheduling a
   * 25-minute job to fix a typo in its prompt would restart the interval from
   * now, silently moving every later fire. `rearm: false` leaves the armed timer
   * untouched; an `enabled` or `schedule` change forces it regardless, since
   * those are exactly what a timer cannot absorb.
   */
  updateJob(
    id: string,
    patch: Partial<ScheduledSubagent>,
    options: { rearm?: boolean } = {},
  ): ScheduledSubagent | undefined {
    const store = this.requireStore();
    // A resume is the caller vouching for the job again, so a self-pause's
    // reason and streak go with it: otherwise the next single error re-trips it.
    const wasEnabled = store.get(id)?.enabled;
    if (patch.enabled === true && wasEnabled === false) {
      patch = { ...patch, failureStreak: 0, pausedReason: undefined };
    }
    const updated = store.update(id, patch);
    if (!updated) return undefined;
    const timingChanged = "enabled" in patch || "schedule" in patch || "scheduleType" in patch || "timezone" in patch;
    if (options.rearm === false && !timingChanged) {
      const settled = store.get(id) ?? updated;
      this.emit({ type: "updated", job: settled });
      return settled;
    }
    this.unscheduleJob(id);
    if (updated.enabled) this.scheduleJob(updated);
    // Read back: `scheduleJob` can persist a correction (a past one-shot is
    // disabled there), and returning the pre-arm row would describe a job the
    // store no longer holds.
    const settled = store.get(id) ?? updated;
    this.emit({ type: "updated", job: settled });
    return settled;
  }

  /** Next-run time as ISO, or undefined if not currently armed. */
  getNextRun(jobId: string): string | undefined {
    const cron = this.jobs.get(jobId);
    if (cron) return cron.nextRun()?.toISOString();
    const job = this.store?.get(jobId);
    if (!job?.enabled) return undefined;
    if (job.scheduleType === "once") return job.schedule;
    if (job.scheduleType === "interval" && job.intervalMs) {
      // Before the first fire there's no `lastRun`, so fall back to "now" —
      // accurate at create time (setInterval was just armed) and within
      // intervalMs of correct in any pre-first-fire view.
      const base = job.lastRun ? new Date(job.lastRun).getTime() : Date.now();
      return new Date(base + job.intervalMs).toISOString();
    }
    return undefined;
  }

  /** One job as stored, or undefined when the id is unknown. */
  getJob(id: string): ScheduledSubagent | undefined {
    return this.store?.get(id);
  }

  /**
   * Fire a job now, out of step with its own timer.
   *
   * The timer is left armed: this is "also run now", not "run instead of the
   * schedule", so a caller that fires a 25m job at 3:00 still gets the 3:25 fire.
   * A paused job refuses rather than firing — paused means paused, and a caller
   * that wanted it to run could have resumed it in the same call — and so does a
   * job still running from its last fire, which is the one case where "run now"
   * would start a second subagent on the same prompt.
   *
   * Returned as a result rather than a boolean because every refusal has a
   * different answer for the caller, and "did not fire" alone tells it nothing.
   */
  runNow(id: string): { ok: true; job: ScheduledSubagent } | { ok: false; error: string } {
    const store = this.requireStore();
    const job = store.get(id);
    if (!job) return { ok: false, error: `No scheduled job with id "${id}".` };
    if (!job.enabled) {
      return {
        ok: false,
        error: `Job "${id}" is paused. Use manage_schedules { action: "resume", id: "${id}" } if it should run again.`,
      };
    }
    // In-memory, not the persisted `lastStatus`: a job whose host crashed
    // mid-fire, or whose fire hung, would otherwise refuse `run` forever, since
    // nothing ever resets a persisted "running".
    if (this.inFlight.has(id)) {
      return {
        ok: false,
        error: `Job "${id}" is still running from its last fire; it will fire again on its own schedule.`,
      };
    }
    this.inFlight.add(id);
    try {
      // A synchronous fire failure (an unresolvable model, a refused agent type)
      // comes back here rather than being reported as a run that started.
      const fired = this.executeJob(id, { manual: true });
      if (!fired.ok) return fired;
      return { ok: true, job };
    } finally {
      this.inFlight.delete(id);
    }
  }

  // ── Scheduling primitives ────────────────────────────────────────────

  private scheduleJob(job: ScheduledSubagent): void {
    const store = this.store;
    if (!store) return;
    try {
      if (job.scheduleType === "interval" && job.intervalMs) {
        const t = setInterval(() => {
          this.executeJob(job.id, { timer: true });
        }, job.intervalMs);
        this.intervals.set(job.id, t);
        this.intervalPhase.set(job.id, Date.now());
      } else if (job.scheduleType === "once") {
        const target = new Date(job.schedule).getTime();
        const delay = target - Date.now();
        if (delay > 0) {
          const t = setTimeout(() => {
            this.executeJob(job.id, { timer: true });
            // Auto-disable one-shots after they fire (mirrors pi-cron-schedule)
            const updated = this.persist(job.id, { enabled: false });
            if (updated) this.emit({ type: "updated", job: updated });
          }, delay);
          this.intervals.set(job.id, t);
        } else {
          // Past timestamp — disable, mark error, never fire. The `updated` event
          // matters as much as the error one: a consumer mirroring the store
          // learns the job is now disabled, where an error event alone leaves it
          // rendering a job that is armed and will never fire.
          const disabled = this.persist(job.id, { enabled: false, lastStatus: "error" });
          this.emit({ type: "error", jobId: job.id, error: `Scheduled time ${job.schedule} is in the past` });
          if (disabled) this.emit({ type: "updated", job: disabled });
        }
      } else {
        // The tick ignores the outcome; `runNow` is the caller that reads it.
        // The zone is passed explicitly: a cron expression names a wall-clock
        // time, and omitting the option would let croner read it in whatever zone
        // the machine happens to be in.
        const cron = new Cron(job.schedule, job.timezone ? { timezone: job.timezone } : {}, () => {
          this.executeJob(job.id, { timer: true });
        });
        this.jobs.set(job.id, cron);
      }
    } catch (err) {
      this.emit({ type: "error", jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private unscheduleJob(id: string): void {
    const cron = this.jobs.get(id);
    if (cron) {
      cron.stop();
      this.jobs.delete(id);
    }
    const t = this.intervals.get(id);
    if (t) {
      clearTimeout(t);
      clearInterval(t);
      this.intervals.delete(id);
    }
    this.intervalPhase.delete(id);
  }

  /**
   * Fire a job: persist running state, spawn (bypassing the concurrency
   * queue), persist completion. Fire-and-forget: the timer tick returns
   * immediately so other jobs keep firing.
   */
  private executeJob(
    id: string,
    trigger: { timer?: boolean; manual?: boolean } = {},
  ): { ok: true; agentId: string } | { ok: false; error: string } {
    const store = this.store;
    const pi = this.pi;
    const ctx = this.ctx;
    const manager = this.manager;
    // A timer tick ignores the result; `runNow` reports it, because "started" and
    // "tried and failed synchronously" are the two things a caller must not have
    // to guess between.
    if (!store || !pi || !ctx || !manager) {
      return { ok: false, error: "Scheduler not started — no active session." };
    }
    const job = store.get(id);
    if (!job?.enabled) return { ok: false, error: `Job "${id}" is paused.` };

    // Measured before any early return: a timer tick that is skipped below still
    // advanced the phase, and still stood for a slot.
    const startedAt = Date.now();
    const late = trigger.timer ? this.lateness(job, startedAt) : undefined;

    // Bounds before anything else: a job that has used up its fires or passed its
    // stop time must not start another one, even with its timer still armed.
    if (job.maxRuns !== undefined && job.runCount >= job.maxRuns) {
      this.retire(id, `it has completed its ${job.maxRuns} run${job.maxRuns === 1 ? "" : "s"}`);
      return { ok: false, error: `Job "${id}" is done: it has completed its ${job.maxRuns} run(s).` };
    }
    if (job.until !== undefined && Date.now() >= new Date(job.until).getTime()) {
      this.retire(id, `it passed its stop time (${job.until})`);
      return { ok: false, error: `Job "${id}" passed its stop time ${job.until} and was disabled.` };
    }

    // A fire that is still running is skipped rather than stacked. Scheduled
    // fires bypass the concurrency queue by design, so an interval shorter than
    // a run would otherwise put several subagents on the same prompt at once.
    if (this.running.has(id)) {
      // Counted, not just refused: a slot that passed without a fire is the same
      // fact whether the machine slept through it or the last run overran it, and
      // nothing stood in for any of them — its own slot is skipped too.
      if (trigger.timer) this.persist(id, { skipped: (job.skipped ?? 0) + (late?.skipped ?? 0) + 1 });
      return {
        ok: false,
        error: `Job "${id}" is still running from its last fire, so this fire was skipped; it will fire again on its own schedule.`,
      };
    }

    this.persist(id, { lastStatus: "running" });

    // Resolve model at fire time — registry contents may have changed since the
    // job was created (auth added/removed). A stored explicit pin that no longer
    // resolves is a failed job, never a reason to silently change models.
    let resolvedModel: any | undefined;
    let agentId: string;
    try {
      if (job.model) {
        const resolved = resolvePinnedModel(job.model, ctx.modelRegistry);
        if (typeof resolved === "string") throw new Error(resolved);
        resolvedModel = resolved;
      }
      // Re-resolve at fire time against the registry as it stands. This does not
      // reload from disk (the scheduler has no reason to rebuild process-global
      // state from a timer), so it catches changes that went through /agents or
      // an Agent call — not a file deleted directly from a shell. The catch below turns
      // this into lastStatus: "error" plus an error event, like any other
      // fire-time failure.
      const dispatch = resolveSpawnType(job.subagent_type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      // The job's own model/thinking (whatever the create call pinned) win; where
      // it has neither, the agent's configured default applies — the same
      // precedence an on-demand spawn uses, so a scheduled run matches it.
      const defaults = applyAgentDefaults(
        dispatch.type,
        { model: resolvedModel, thinkingLevel: job.thinking },
        ctx,
      );
      if (defaults.error) throw new Error(defaults.error);
      resolvedModel = defaults.model;
      const effectiveThinking = defaults.thinkingLevel;
      agentId = manager.spawn(pi, ctx, dispatch.type, job.prompt, {
        description: job.description,
        isBackground: true,
        bypassQueue: true,
        model: resolvedModel,
        maxTurns: job.max_turns,
        isolated: job.isolated,
        thinkingLevel: effectiveThinking,
        isolation: job.isolation,
        // A scheduled run has no tool call to build this, so without it the
        // conversation viewer shows nothing about how the job was configured.
        // The model is left out on purpose: agent-manager fills in the effective
        // one when the session reports it, and naming the pre-session pick here
        // would only be right until then.
        invocation: {
          thinking: effectiveThinking,
          // Normalized like the Agent tool's own snapshot: `0` means unlimited,
          // and rendering it as "max turns: 0" would read as a limit of none.
          maxTurns: normalizeMaxTurns(job.max_turns),
          isolated: job.isolated,
          runInBackground: true,
          isolation: job.isolation,
        },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.settleFire(
        id,
        { at: new Date(startedAt).toISOString(), status: "error", error, ...(trigger.manual ? { manual: true } : {}), ...late },
        { lastRun: new Date().toISOString(), lastStatus: "error" },
      );
      this.emit({ type: "error", jobId: id, error });
      return { ok: false, error };
    }

    this.running.add(id);
    this.emit({ type: "fired", jobId: id, agentId, name: job.name });

    const finalize = (status: "success" | "error") => {
      this.running.delete(id);
      const next = this.getNextRun(id);
      const current = store.get(id);
      const runCount = (current?.runCount ?? 0) + 1;
      // A bound reached by *this* fire is applied now, not left for a tick to
      // notice: the fire that just finished is the one that decided there would
      // be no more, and waiting would let another spawn through first.
      const exhausted = current?.maxRuns !== undefined && runCount >= current.maxRuns;
      const until = current?.until;
      const pastUntil =
        until !== undefined && (next === undefined || new Date(next).getTime() >= new Date(until).getTime());
      const stopping = exhausted || pastUntil;
      const record = manager.getRecord(agentId);
      this.settleFire(
        id,
        {
          at: new Date(startedAt).toISOString(),
          status,
          agentId,
          ...(trigger.manual ? { manual: true } : {}),
          ...late,
          ...(status === "error" && record?.error ? { error: briefText(String(record.error)) } : {}),
          ...(typeof record?.result === "string" && record.result.trim() ? { summary: briefText(record.result) } : {}),
        },
        {
          lastRun: new Date().toISOString(),
          lastStatus: status,
          runCount,
          nextRun: next,
          ...(stopping ? { enabled: false } : {}),
        },
      );
      if (stopping) {
        const why = exhausted
          ? `completed its ${current?.maxRuns} run${current?.maxRuns === 1 ? "" : "s"}`
          : `reached its stop time (${until})`;
        const settled = store.get(id);
        this.emit({ type: "error", jobId: id, error: `Job "${id}" was disabled: it ${why}.` });
        if (settled) this.emit({ type: "updated", job: settled });
      }
    };

    // AgentManager's promise resolves either way (its .catch returns ""), so we
    // can't infer success/failure from the promise — read record.status instead.
    // Terminal states: completed/steered = success; error/aborted/stopped = error.
    // awaitStartup first: with isolation: "worktree" the run promise only exists
    // once the repo copy is made, and a failed copy rejects here.
    manager.awaitStartup(agentId)
      .then(() => manager.getRecord(agentId)?.promise)
      .then(() => {
        const r = manager.getRecord(agentId);
        const failed = r?.status === "error" || r?.status === "aborted" || r?.status === "stopped";
        finalize(failed ? "error" : "success");
      })
      .catch(() => finalize("error"));

    return { ok: true, agentId };
  }

  /**
   * Fire-time bookkeeping. A failed persist — the store lock is held by another
   * pi, or the file went unreadable — becomes an error event rather than a throw
   * out of a timer tick, where nothing would catch it. The run itself is
   * unaffected, so the job keeps its schedule either way.
   */
  /**
   * Disable a job that has no work left in it and say so on the bus, so a
   * consumer mirroring the store stops showing it as armed. The row itself
   * survives as the record of what ran; only `removeJob` forgets it.
   */
  private retire(id: string, reason: string): void {
    const updated = this.persist(id, { enabled: false });
    this.emit({ type: "error", jobId: id, error: `Job "${id}" was disabled: ${reason}.` });
    if (updated) this.emit({ type: "updated", job: updated });
  }

  /**
   * How late a timer fire is, and how many slots it stands in for.
   *
   * Interval: against the wall-clock phase the timer was armed or last fired at.
   * One-shot: against its own instant. Cron is left to croner, which schedules
   * against the wall clock itself, so a slept-through cron slot is simply the
   * next one — there is no phase of ours to compare against.
   */
  private lateness(job: ScheduledSubagent, now: number): { lateMs?: number; skipped?: number } | undefined {
    let expected: number | undefined;
    if (job.scheduleType === "interval" && job.intervalMs) {
      const phase = this.intervalPhase.get(job.id);
      this.intervalPhase.set(job.id, now);
      expected = phase === undefined ? undefined : phase + job.intervalMs;
    } else if (job.scheduleType === "once") {
      expected = new Date(job.schedule).getTime();
    }
    if (expected === undefined || !Number.isFinite(expected) || now - expected < LATE_THRESHOLD_MS) return undefined;
    const lateMs = now - expected;
    const skipped = job.scheduleType === "interval" && job.intervalMs ? Math.floor(lateMs / job.intervalMs) : 0;
    return skipped > 0 ? { lateMs, skipped } : { lateMs };
  }

  /**
   * Write a finished fire: its log entry, its bookkeeping, and the failure
   * policy's verdict, in one store write so a reader never sees half of it.
   */
  private settleFire(id: string, record: ScheduledFireRecord, extra: Partial<ScheduledSubagent>): void {
    const current = this.store?.get(id);
    if (!current) return;
    const failed = record.status === "error";
    const streak = failed ? (current.failureStreak ?? 0) + 1 : 0;
    const limit = current.pauseAfterFailures ?? DEFAULT_PAUSE_AFTER_FAILURES;
    const staysEnabled = extra.enabled ?? current.enabled;
    const tripped = failed && limit > 0 && streak >= limit && staysEnabled;
    const pausedReason = tripped ? `paused after ${streak} failed fires in a row` : undefined;
    const updated = this.persist(id, {
      ...extra,
      history: [...(current.history ?? []), record].slice(-SCHEDULE_HISTORY_MAX),
      failureStreak: streak,
      ...(record.skipped ? { skipped: (current.skipped ?? 0) + record.skipped } : {}),
      ...(tripped ? { enabled: false, pausedReason } : {}),
    });
    if (!tripped) return;
    // Disarm too: a paused cron job would otherwise keep reporting croner's next run.
    this.unscheduleJob(id);
    this.emit({
      type: "error",
      jobId: id,
      error: `Job "${id}" ${pausedReason}${record.error ? ` (last: ${record.error})` : ""}. Resume it with manage_schedules { action: "resume", id: "${id}" } once the cause is fixed.`,
    });
    if (updated) this.emit({ type: "updated", job: updated });
  }

  private persist(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    try {
      return this.store?.update(id, patch);
    } catch (err) {
      this.emit({ type: "error", jobId: id, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  private emit(event: ScheduleChangeEvent): void {
    if (this.pi) this.pi.events.emit("subagents:scheduled", event);
  }

  private requireStore(): ScheduleStore {
    if (!this.store) throw new Error("Scheduler not started — no active session.");
    return this.store;
  }

  // ── Format detection / parsers (statics — pure) ──────────────────────

  /**
   * Sniff a schedule string and tag its type. Throws on invalid input.
   * Order matters: relative ("+10m") and interval ("5m") both match digit+unit;
   * relative requires the leading "+" to disambiguate.
   */
  static detectSchedule(s: string): { type: "cron" | "once" | "interval"; intervalMs?: number; normalized: string } {
    const trimmed = s.trim();
    // "+10m" — relative one-shot
    const rel = SubagentScheduler.parseRelativeTime(trimmed);
    if (rel !== null) return { type: "once", normalized: rel };
    // "5m" — interval
    const ivl = SubagentScheduler.parseInterval(trimmed);
    if (ivl !== null) return { type: "interval", intervalMs: ivl, normalized: trimmed };
    // ISO timestamp — one-shot. Reject past timestamps upfront so we never
    // create a dead-on-arrival record (scheduleJob's safety net still catches
    // micro-races from `+0s`-style relatives).
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        if (d.getTime() <= Date.now()) {
          throw new Error(`Scheduled time ${d.toISOString()} is in the past.`);
        }
        return { type: "once", normalized: d.toISOString() };
      }
    }
    // Cron — 6-field
    const cronCheck = SubagentScheduler.validateCronExpression(trimmed);
    if (cronCheck.valid) return { type: "cron", normalized: trimmed };
    throw new Error(
      `Invalid schedule "${s}". Use 6-field cron (e.g. "0 0 9 * * 1" — 9am every Monday), interval ("5m"/"1h"), or one-shot ("+10m" / ISO).`
    );
  }

  /** 6-field cron — 'second minute hour dom month dow'. */
  static validateCronExpression(expr: string, timezone?: string): { valid: boolean; error?: string } {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) {
      return {
        valid: false,
        error: `Cron must have 6 fields (second minute hour dom month dow), got ${fields.length}. Example: "0 0 9 * * 1" for 9am every Monday.`,
      };
    }
    try {
      // Croner validates by construction.
      new Cron(expr, timezone ? { timezone } : {}, () => {});
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : "Invalid cron expression" };
    }
  }

  /**
   * The zone a cron expression is read in.
   *
   * A cron expression names a wall-clock time and carries no instant of its own —
   * "9am" is 9am *somewhere* — so the zone has to belong to the job, not to
   * whatever clock reads it later. Omitted, it defaults to this machine's
   * resolved zone **written down**: leaving the default implicit is what makes a
   * job silently fire at a different wall-clock time after a move, a travel day,
   * or a DST shift on another machine.
   *
   * Interval and one-shot schedules are durations from a known instant, so a zone
   * would be a field nothing reads. That is refused rather than dropped: a caller
   * that passed one believed it did something.
   */
  static resolveTimezone(
    scheduleType: ScheduledSubagent["scheduleType"],
    requested?: string,
  ): string | undefined {
    if (scheduleType !== "cron") {
      if (requested) {
        throw new Error(
          `A timezone only applies to a cron schedule, so "${requested}" would do nothing for a ${scheduleType} schedule. Drop it, or use a cron expression to name a wall-clock time.`,
        );
      }
      return undefined;
    }
    const zone = (requested ?? "").trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      // Throws RangeError for an unknown zone — validation without a table to go stale.
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      throw new Error(
        `Unknown timezone "${zone}". Use an IANA zone such as "America/Los_Angeles" or "Europe/London".`,
      );
    }
    return zone;
  }

  /** A fire count bound must be a positive whole number, or absent. */
  static validateMaxRuns(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`maxRuns must be a whole number of at least 1, got ${value}.`);
    }
    return value;
  }

  /** A failure policy is a whole number of fires; `0` turns it off. */
  static validatePauseAfterFailures(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `pauseAfterFailures must be a whole number — N pauses after N failed fires in a row, 0 never pauses — got ${value}.`,
      );
    }
    return value;
  }

  /** A stop time must be a real, future instant — a past one would never fire. */
  static validateUntil(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const at = new Date(value).getTime();
    if (Number.isNaN(at)) throw new Error(`until must be an ISO timestamp, got "${value}".`);
    if (at <= Date.now()) {
      throw new Error(`until ${new Date(at).toISOString()} is in the past, so the job would never fire.`);
    }
    return new Date(at).toISOString();
  }

  /** "+10s"/"+5m"/"+1h"/"+2d" → ISO timestamp. */
  static parseRelativeTime(s: string): string | null {
    const m = s.match(/^\+(\d+)(s|m|h|d)$/);
    if (!m) return null;
    const ms = parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return new Date(Date.now() + ms).toISOString();
  }

  /** "10s"/"5m"/"1h"/"2d" → milliseconds. */
  static parseInterval(s: string): number | null {
    const m = s.match(/^(\d+)(s|m|h|d)$/);
    if (!m) return null;
    return parseInt(m[1], 10) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  }
}

/** One line, capped: a fire log entry points at a result, it does not hold it. */
function briefText(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > SUMMARY_MAX ? `${single.slice(0, SUMMARY_MAX - 1)}…` : single;
}
