/**
 * schedule-bounds-fire.test.ts — what actually stops a repeating job.
 *
 * The bounds are validated in `schedule-bounds.test.ts`; this file is about the
 * fire path, where the decisions have consequences:
 *   - a fire that is still running must skip the next one rather than stack,
 *     because scheduled fires bypass the concurrency queue by design;
 *   - a job that has used up its `maxRuns` or passed its `until` must not get one
 *     more spawn out of a timer that is still armed;
 *   - the fire that reaches the bound is the one that applies it, so the row is
 *     already disabled when the caller looks rather than one fire later.
 *
 * Each case runs against a real store and a controllable child, because the bug
 * being guarded against is a *timing* one: `executeJob` cleared its guard in a
 * `finally` as soon as the child was spawned, so it only ever covered
 * overlapping start attempts and never a run.
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

type Gate = { resolve: () => void; promise: Promise<void> };

/** A promise the test closes when it decides the child's run is over. */
function gate(): Gate {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { resolve, promise };
}

type Harness = {
  scheduler: SubagentScheduler;
  store: ScheduleStore;
  spawnCount: () => number;
  /** Close the child's run and let the fire's completion chain finish. */
  finishRun: () => Promise<void>;
  stop: () => void;
};

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pi-bounds-fire-"));
  dirs.push(dir);
  const store = new ScheduleStore(join(dir, "schedules.json"));
  const scheduler = new SubagentScheduler();

  let spawned = 0;
  let current: Gate = gate();
  const manager = {
    spawn: () => {
      spawned += 1;
      // Each spawn gets its own run gate, so "the fire that is in flight" is a
      // thing the test holds rather than a guess about ordering.
      current = gate();
      return `agent-${spawned}`;
    },
    awaitStartup: async () => {},
    getRecord: () => ({ status: "completed", promise: current.promise }),
  };

  const pi = { events: { emit: () => {}, on: () => () => {} } } as any;
  const ctx = { cwd: dir, modelRegistry: { getAvailable: () => [], getAll: () => [] } } as any;
  scheduler.start(pi, ctx, manager as any, store);

  return {
    scheduler,
    store,
    spawnCount: () => spawned,
    finishRun: async () => {
      current.resolve();
      // One turn for `getRecord().promise`, one for the `.then` that finalizes.
      await Promise.resolve();
      await new Promise((done) => setTimeout(done, 5));
    },
    stop: () => scheduler.stop(),
  };
}

function addJob(h: Harness, overrides: Record<string, unknown> = {}) {
  return h.scheduler.addJob({
    name: "job",
    description: "job",
    schedule: "5m",
    prompt: "do it",
    subagent_type: "general-purpose" as any,
    ...overrides,
  } as any);
}

describe("a fire that is still running", () => {
  it("skips the next fire instead of stacking a second subagent on one prompt", () => {
    const h = harness();
    const job = addJob(h, { name: "slow" });

    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    const second = h.scheduler.runNow(job.id);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/still running from its last fire/);
    expect(h.spawnCount()).toBe(1);
    h.stop();
  });

  it("lets the next fire through once the previous one has finished", async () => {
    const h = harness();
    const job = addJob(h, { name: "slow" });

    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    expect(h.scheduler.runNow(job.id).ok).toBe(false);

    await h.finishRun();

    // The guard has to release with the child, or the job is stuck un-runnable
    // for the rest of the session — which is the failure the persisted
    // `lastStatus` guard used to cause after a crash.
    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    expect(h.spawnCount()).toBe(2);
    h.stop();
  });
});

describe("maxRuns", () => {
  it("refuses another fire once the allowance is used, and disables the row", async () => {
    const h = harness();
    const job = addJob(h, { name: "once-only", maxRuns: 1 });

    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    await h.finishRun();

    // Applied by the fire that reached the bound, not by a later tick.
    expect(h.store.get(job.id)?.enabled).toBe(false);
    expect(h.store.get(job.id)?.runCount).toBe(1);

    const again = h.scheduler.runNow(job.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/is done|is paused/);
    expect(h.spawnCount()).toBe(1);
    h.stop();
  });

  it("keeps firing while the allowance is not used up", async () => {
    const h = harness();
    const job = addJob(h, { name: "twice", maxRuns: 2 });

    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    await h.finishRun();
    expect(h.store.get(job.id)?.enabled).toBe(true);

    expect(h.scheduler.runNow(job.id).ok).toBe(true);
    await h.finishRun();
    expect(h.store.get(job.id)?.enabled).toBe(false);
    expect(h.spawnCount()).toBe(2);
    h.stop();
  });
});

describe("until", () => {
  it("refuses a fire past its stop time and disables the row", async () => {
    const h = harness();
    // Validated as future at create time, so it has to pass naturally.
    const job = addJob(h, { name: "brief", until: new Date(Date.now() + 40).toISOString() });

    await new Promise((done) => setTimeout(done, 60));
    const result = h.scheduler.runNow(job.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/stop time|is paused/);
    expect(h.spawnCount()).toBe(0);
    expect(h.store.get(job.id)?.enabled).toBe(false);
    h.stop();
  });
});
