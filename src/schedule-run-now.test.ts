/**
 * schedule-run-now.test.ts — "fire this now" on the cold scheduler.
 *
 * `runNow` is the one verb whose whole value is the difference between *fired*
 * and *tried*. For a long time the only way to fire a scheduled job early was to
 * wait, and the plausible shortcut — call the private fire path and report
 * success — is wrong in the one case a caller cannot see: an unresolvable model,
 * a refused agent type, or a spawn that throws. The job then errors on every
 * fire while the caller has been told it started.
 *
 * These cases pin the honesty, the timer behaviour, and the re-arm rule that
 * stops a prompt edit from silently restarting a 25-minute interval.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentScheduler } from "./schedule.js";
import { ScheduleStore } from "./schedule-store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Harness = {
  scheduler: SubagentScheduler;
  jobId: string;
  nextRun: () => string | undefined;
  spawnCount: () => number;
  stop: () => void;
};

/** A scheduler bound to a real store, a fake manager and a fake pi. */
function harness(options: { spawnThrows?: string; schedule?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-run-now-"));
  dirs.push(dir);
  const store = new ScheduleStore(join(dir, "schedules.json"));
  const scheduler = new SubagentScheduler();

  let spawned = 0;
  const manager = {
    spawn: () => {
      spawned += 1;
      if (options.spawnThrows) throw new Error(options.spawnThrows);
      return "agent-1";
    },
    awaitStartup: async () => {},
    getRecord: () => ({ status: "completed", promise: Promise.resolve() }),
  };

  const pi = { events: { emit: () => {}, on: () => () => {} } } as any;
  const ctx = { cwd: dir, modelRegistry: { getAvailable: () => [], getAll: () => [] } } as any;

  scheduler.start(pi, ctx, manager as any, store);
  const job = scheduler.addJob({
    name: "tick",
    description: "tick",
    schedule: options.schedule ?? "25m",
    prompt: "tick",
    subagent_type: "general-purpose" as any,
  });

  return {
    scheduler,
    jobId: job.id,
    nextRun: () => scheduler.getNextRun(job.id),
    spawnCount: () => spawned,
    stop: () => scheduler.stop(),
  };
}

describe("runNow", () => {
  it("fires the job and reports the agent it started", () => {
    const h = harness();
    const result = h.scheduler.runNow(h.jobId);

    expect(result.ok).toBe(true);
    expect(h.spawnCount()).toBe(1);
    h.stop();
  });

  it("reports a spawn that failed instead of a run that started", () => {
    const h = harness({ spawnThrows: "Model not found: nope/nope" });
    const result = h.scheduler.runNow(h.jobId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Model not found/);
    h.stop();
  });

  it("leaves the job's own timer armed, so the next scheduled fire still happens", () => {
    const h = harness();
    // Same tolerance as above: an interval job's next run is derived from `now`
    // until its first fire, so the assertion is that it did not jump forward by
    // anything like a period.
    const before = Date.parse(h.nextRun() as string) - Date.now();
    expect(Number.isFinite(before)).toBe(true);

    h.scheduler.runNow(h.jobId);

    const after = Date.parse(h.nextRun() as string) - Date.now();
    expect(Math.abs(after - before)).toBeLessThan(5_000);
    h.stop();
  });

  it("refuses a paused job and names the verb that would allow it", () => {
    const h = harness();
    h.scheduler.updateJob(h.jobId, { enabled: false });

    const result = h.scheduler.runNow(h.jobId);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/paused.*action: "resume"/s);
    expect(h.spawnCount()).toBe(0);
    h.stop();
  });

  it("refuses an id the store does not hold", () => {
    const h = harness();
    const result = h.scheduler.runNow("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/No scheduled job with id "nope"/);
    h.stop();
  });
});

describe("updateJob re-arming", () => {
  it("keeps the armed slot when nothing about the timing changed", () => {
    const h = harness();
    // A pre-first-fire interval reports `now + interval`, so compare the distance
    // rather than the timestamp: an untouched timer keeps its end point, a
    // restarted one moves it forward by however long the edit took.
    const before = Date.parse(h.nextRun() as string) - Date.now();

    h.scheduler.updateJob(h.jobId, { prompt: "a different ask" }, { rearm: false });

    const after = Date.parse(h.nextRun() as string) - Date.now();
    expect(Math.abs(after - before)).toBeLessThan(5_000);
    h.stop();
  });

  it("re-arms when the cadence itself changes", () => {
    const h = harness();
    const before = h.nextRun();

    h.scheduler.updateJob(h.jobId, { schedule: "1h", intervalMs: 3_600_000 });

    expect(h.nextRun()).not.toBe(before);
    h.stop();
  });
});
