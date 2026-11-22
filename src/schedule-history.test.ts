/**
 * schedule-history.test.ts — what a job remembers about its fires, and when it
 * stops itself.
 *
 *   - each fire leaves a bounded log entry (status, agent, what it answered), so
 *     "what did the every-2h job find?" survives a scrolled-away notification;
 *   - a job that keeps failing pauses itself rather than billing every fire, and
 *     a resume gives it a fresh count;
 *   - an interval timer that fires late — Node's timers stop while the machine
 *     sleeps — records how late it was and how many slots it stood in for.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEDULE_HISTORY_MAX, SubagentScheduler } from "./schedule.js";
import { ScheduleStore } from "./schedule-store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(outcome: { status: string; result?: string; error?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-schedule-history-"));
  dirs.push(dir);
  const store = new ScheduleStore(join(dir, "schedules.json"));
  const scheduler = new SubagentScheduler();
  let spawned = 0;
  const events: Array<{ type: string; error?: string }> = [];
  const manager = {
    spawn: () => `agent-${++spawned}`,
    awaitStartup: async () => {},
    getRecord: () => ({ ...outcome, promise: Promise.resolve() }),
  };
  const pi = { events: { emit: (_: string, event: any) => events.push(event), on: () => () => {} } } as any;
  const ctx = { cwd: dir, modelRegistry: { getAvailable: () => [], getAll: () => [] } } as any;
  scheduler.start(pi, ctx, manager as any, store);
  const add = (overrides: Record<string, unknown> = {}) =>
    scheduler.addJob({
      name: `job-${Math.random()}`,
      description: "job",
      schedule: "5m",
      prompt: "do it",
      subagent_type: "general-purpose" as any,
      ...overrides,
    } as any);
  // Two turns for the completion chain (`awaitStartup` → `promise` → finalize).
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { scheduler, store, events, add, settle, spawned: () => spawned };
}

describe("the fire log", () => {
  it("records each fire with its agent and the head of its answer", async () => {
    const h = harness({ status: "completed", result: "Deploy is green.\n\n2 new warnings in the build log." });
    const job = h.add();
    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    await h.settle();

    const history = h.store.get(job.id)?.history ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "success",
      agentId: "agent-1",
      manual: true,
      summary: "Deploy is green. 2 new warnings in the build log.",
    });
    h.scheduler.stop();
  });

  it("keeps only the newest entries, so the store does not grow with the job's age", async () => {
    const h = harness({ status: "completed", result: "ok" });
    const job = h.add({ pauseAfterFailures: 0 });
    for (let i = 0; i < SCHEDULE_HISTORY_MAX + 3; i++) {
      expect(h.scheduler.runNow(job.id).ok).toBe(true);
      await h.settle();
    }
    const history = h.store.get(job.id)?.history ?? [];
    expect(history).toHaveLength(SCHEDULE_HISTORY_MAX);
    expect(history.at(-1)?.agentId).toBe(`agent-${SCHEDULE_HISTORY_MAX + 3}`);
    h.scheduler.stop();
  });
});

describe("the failure policy", () => {
  it("pauses a job after its failed fires in a row, and a resume gives it a fresh count", async () => {
    const h = harness({ status: "error", error: "model refused" });
    const job = h.add({ pauseAfterFailures: 2 });

    h.scheduler.runNow(job.id);
    await h.settle();
    expect(h.store.get(job.id)?.enabled).toBe(true);

    h.scheduler.runNow(job.id);
    await h.settle();
    const paused = h.store.get(job.id);
    expect(paused?.enabled).toBe(false);
    expect(paused?.pausedReason).toBe("paused after 2 failed fires in a row");
    expect(paused?.history?.at(-1)).toMatchObject({ status: "error", error: "model refused" });
    expect(h.events.some((event) => event.type === "error" && /paused after 2 failed fires/.test(event.error ?? ""))).toBe(true);

    const resumed = h.scheduler.updateJob(job.id, { enabled: true });
    expect(resumed?.pausedReason).toBeUndefined();
    expect(resumed?.failureStreak).toBe(0);
    h.scheduler.stop();
  });

  it("never pauses when the policy is 0", async () => {
    const h = harness({ status: "error" });
    const job = h.add({ pauseAfterFailures: 0 });
    for (let i = 0; i < 5; i++) {
      h.scheduler.runNow(job.id);
      await h.settle();
    }
    expect(h.store.get(job.id)?.enabled).toBe(true);
    expect(h.store.get(job.id)?.failureStreak).toBe(5);
    h.scheduler.stop();
  });

  it("refuses a policy that is not a whole number of fires", () => {
    const h = harness({ status: "completed" });
    expect(() => h.add({ pauseAfterFailures: -1 })).toThrow(/pauseAfterFailures must be a whole number/);
    expect(() => h.add({ pauseAfterFailures: 1.5 })).toThrow(/pauseAfterFailures must be a whole number/);
    h.scheduler.stop();
  });
});

describe("a late interval fire", () => {
  it("records how late it was and how many slots it stood in for", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00Z"));
    const h = harness({ status: "completed" });
    const job = h.add({ schedule: "1h" });

    // The machine sleeps for 3.5h: the wall clock jumps, the monotonic timer does
    // not, so the timer still fires one hour of *its* time after it was armed.
    vi.setSystemTime(Date.parse("2030-01-01T03:30:00Z"));
    vi.advanceTimersByTime(3_600_000);
    vi.useRealTimers();
    await h.settle();

    const stored = h.store.get(job.id);
    const entry = stored?.history?.at(-1);
    expect(entry?.lateMs).toBe(3.5 * 3_600_000);
    expect(entry?.skipped).toBe(3);
    expect(stored?.skipped).toBe(3);
    h.scheduler.stop();
  });

  it("records nothing for a fire that was on time", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const h = harness({ status: "completed" });
    const job = h.add({ schedule: "1h" });
    vi.advanceTimersByTime(3_600_000);
    vi.useRealTimers();
    await h.settle();
    const entry = h.store.get(job.id)?.history?.at(-1);
    expect(entry?.lateMs).toBeUndefined();
    expect(entry?.skipped).toBeUndefined();
    h.scheduler.stop();
  });
});
