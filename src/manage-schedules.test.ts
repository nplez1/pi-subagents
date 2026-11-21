/**
 * manage-schedules.test.ts — the model's one scheduled-work door.
 *
 * What is pinned here is the *policy*, not the internals:
 *   - it is the only door: the Agent tool declares no `schedule` param, and a
 *     stale caller that still sends one is told where the door moved instead of
 *     silently spawning an agent now.
 *   - every verb works on both homes (cold scheduler row, live `/loop` entry),
 *     because a door that can arm a job but not change, fire, pause or cancel it
 *     is what makes a model narrate commands at the user instead of acting.
 *   - an id that names nothing is reported with the way to find a real one.
 *
 * The live half is exercised against a stand-in for `/loop` speaking the same
 * wire (`loop:rpc:schedules:*`); `tests/loop.test.mjs` covers the real side.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "./index.js";
import { LIVE_CREATE, LIVE_LIST, LIVE_REMOVE, LIVE_RUN, LIVE_UPDATE } from "./schedule-live-rpc.js";

type LiveJob = {
  id: string;
  prompt: string;
  mode: "fixed" | "dynamic";
  intervalMs?: number;
  nextAt?: number;
  runs: number;
  paused: boolean;
};

type ToolResult = { content: Array<{ type: string; text: string }> };

type Harness = {
  tools: Map<string, { name: string; parameters: any; execute: (id: string, params: any) => Promise<ToolResult> }>;
  call: (action: string, params?: Record<string, unknown>) => Promise<string>;
  live: Map<string, LiveJob>;
  cwd: string;
  stop: () => void;
};

/** `25m` → 1_500_000. The stand-in only needs the forms these tests use. */
function intervalMs(text: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(text.trim());
  if (!match) return undefined;
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * unit[match[2]];
}

async function harness(options: { live?: boolean } = {}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "pi-manage-schedules-"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const live = new Map<string, LiveJob>();
  const liveLoaded = options.live !== false;

  const bus = {
    on(event: string, fn: (data: unknown) => void) {
      const set = busHandlers.get(event) ?? new Set();
      set.add(fn);
      busHandlers.set(event, set);
      return () => set.delete(fn);
    },
    emit(event: string, data: any) {
      if (!event.startsWith("loop:rpc:schedules:")) {
        for (const fn of busHandlers.get(event) ?? []) fn(data);
        return;
      }
      // No live extension in this session: the request goes unanswered, which
      // is what the client's timeout reports as "/loop is not loaded".
      if (!liveLoaded) return;
      const reply = (payload: unknown) => {
        for (const fn of busHandlers.get(`${event}:reply:${data.requestId}`) ?? []) fn(payload);
      };
      const job = data.jobId ? live.get(data.jobId) : undefined;
      if (event === LIVE_LIST) return reply({ success: true, data: { jobs: [...live.values()] } });
      if (event === LIVE_CREATE) {
        const ms = intervalMs(data.schedule);
        if (ms === undefined) return reply({ success: false, error: `"${data.schedule}" is not an interval.` });
        const id = `live${live.size + 1}`;
        live.set(id, { id, prompt: data.prompt, mode: "fixed", intervalMs: ms, nextAt: Date.now(), runs: 0, paused: false });
        return reply({ success: true, data: { id, intervalMs: ms, nextAt: Date.now() } });
      }
      if (!job) return reply({ success: false, error: `No live loop with id "${String(data.jobId)}".` });
      if (event === LIVE_UPDATE) {
        const changed: string[] = [];
        if (typeof data.schedule === "string") {
          const ms = intervalMs(data.schedule);
          if (ms === undefined) return reply({ success: false, error: `"${data.schedule}" is not an interval.` });
          if (ms !== job.intervalMs) {
            job.intervalMs = ms;
            changed.push("schedule");
          }
        }
        if (typeof data.prompt === "string" && data.prompt !== job.prompt) {
          job.prompt = data.prompt;
          changed.push("prompt");
        }
        if (typeof data.paused === "boolean" && data.paused !== job.paused) {
          job.paused = data.paused;
          changed.push(data.paused ? "paused" : "resumed");
        }
        if (changed.length === 0) return reply({ success: false, error: "Nothing changed." });
        return reply({ success: true, data: { job, changed } });
      }
      if (event === LIVE_RUN) {
        if (job.paused) return reply({ success: false, error: `Loop ${job.id} is paused. Resume it first, then run it.` });
        return reply({ success: true, data: { job, queuedForNextIdle: true } });
      }
      live.delete(job.id);
      return reply({ success: true, data: { removed: job.id } });
    },
  };

  const ctx: any = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "session-test" },
    ui: { notify: () => {}, setStatus: () => {} },
  };

  const base: any = {
    events: bus,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: any) => handlers.set(event, handler),
  };
  // Absorb every other pi surface the extension touches at load; the cases here
  // are about scheduling, not about the UI.
  const pi: any = new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => {};
    },
    set: () => true,
  });

  extension(pi);
  await handlers.get("session_start")?.({}, ctx);

  const tool = tools.get("manage_schedules");
  if (!tool) throw new Error("manage_schedules was not registered");

  return {
    tools,
    live,
    cwd,
    call: async (action, params = {}) => {
      const result = await tool.execute("call-1", { action, ...params });
      return result.content[0].text;
    },
    stop: () => {
      handlers.get("session_shutdown")?.({}, ctx);
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

let open: Harness | undefined;
afterEach(() => {
  open?.stop();
  open = undefined;
});

describe("the one door", () => {
  it("registers manage_schedules and leaves no `schedule` param on Agent", async () => {
    open = await harness();
    const agent = open.tools.get("Agent");
    expect(agent).toBeTruthy();
    const properties = (agent!.parameters as { properties: Record<string, unknown> }).properties;
    expect(properties.schedule).toBeUndefined();
    const schedules = open.tools.get("manage_schedules");
    const action = (schedules!.parameters as { properties: { action: any } }).properties.action;
    expect(action).toBeTruthy();
  });

  it("advertises every verb it accepts, so a caller never has to guess one", async () => {
    open = await harness();
    const schema = open.tools.get("manage_schedules")!.parameters as {
      properties: { action: { description?: string }; backend: { description?: string } };
    };
    // The action list lives in the description because Type.Union renders as an
    // enum: a model reads the enum, but the descriptions are what say what each
    // verb means and which home it acts on.
    expect(JSON.stringify(schema.properties.action)).toMatch(/create/);
    expect(JSON.stringify(schema.properties.action)).toMatch(/cancel/);
    expect(schema.properties.backend.description).toMatch(/cold/);
    expect(schema.properties.backend.description).toMatch(/live/);
  });
});

describe("cold jobs", () => {
  it("creates, lists and cancels a job in the scheduler", async () => {
    open = await harness();
    const created = await open.call("create", { schedule: "25m", prompt: "Still alive." });
    expect(created).toMatch(/^Scheduled cold job \S+: "Still alive\." every 25m/);

    const id = /Scheduled cold job (\S+):/.exec(created)?.[1] as string;
    expect(id).toBeTruthy();

    const listed = await open.call("list");
    expect(listed).toMatch(/\[cold\] every 25m/);
    expect(listed).toMatch(/Still alive\./);

    expect(await open.call("cancel", { id })).toMatch(new RegExp(`Cancelled cold job ${id}`));
    expect(await open.call("list")).toMatch(/Nothing is scheduled in this session\./);
  });

  it("pauses, resumes and re-times a job instead of only being able to delete it", async () => {
    open = await harness();
    const id = /Scheduled cold job (\S+):/.exec(await open.call("create", { schedule: "25m", prompt: "tick" }))?.[1] as string;

    expect(await open.call("pause", { id })).toMatch(/Updated cold job .*paused/);
    expect(await open.call("list")).toMatch(/paused/);

    expect(await open.call("resume", { id })).toMatch(/armed/);
    expect(await open.call("update", { id, schedule: "45m" })).toMatch(/schedule 45m/);
    expect(await open.call("list")).toMatch(/every 45m/);
  });

  it("refuses an update that changes nothing, instead of reporting a change", async () => {
    open = await harness();
    const id = /Scheduled cold job (\S+):/.exec(await open.call("create", { schedule: "25m", prompt: "tick" }))?.[1] as string;
    expect(await open.call("update", { id, prompt: "tick" })).toMatch(/Nothing changed/);
  });

  it("fires one now without disarming its schedule", async () => {
    open = await harness();
    const id = /Scheduled cold job (\S+):/.exec(await open.call("create", { schedule: "25m", prompt: "tick" }))?.[1] as string;

    const fired = await open.call("run", { id });

    expect(fired).toMatch(/^Fired cold job /);
    expect(fired).toMatch(/stays armed/);
    // A fire that fails synchronously is reported as one (schedule-run-now.test.ts
    // owns that case, where a manager can be made to throw).
  });

  it("refuses a thinking level a fire could not run, before it is stored", async () => {
    open = await harness();
    const bad = await open.call("create", { schedule: "25m", prompt: "tick", thinking: "turbo" });
    expect(bad).toMatch(/Nothing was scheduled/);
    expect(bad).toMatch(/thinking/);
    expect(await open.call("list")).toMatch(/Nothing is scheduled/);
  });
});

describe("live loops", () => {
  it("creates, lists, re-times and cancels a loop in this session", async () => {
    open = await harness();
    const created = await open.call("create", { backend: "live", schedule: "25m", prompt: "Still alive." });
    expect(created).toMatch(/^Armed live loop live1/);
    expect(created).toMatch(/spends the main context/);

    const listed = await open.call("list");
    expect(listed).toMatch(/\[live\] every 25m/);

    expect(await open.call("update", { id: "live1", schedule: "45m" })).toMatch(/Updated live loop live1/);
    expect(await open.call("cancel", { id: "live1" })).toMatch(/Cancelled live loop live1/);
    expect(open.live.size).toBe(0);
  });

  it("pauses a loop and refuses to run it until it is resumed", async () => {
    open = await harness();
    await open.call("create", { backend: "live", schedule: "25m", prompt: "tick" });

    expect(await open.call("pause", { id: "live1" })).toMatch(/paused/);
    expect(await open.call("run", { id: "live1" })).toMatch(/is paused\. Resume it first/);
    expect(await open.call("resume", { id: "live1" })).toMatch(/resumed/);
    expect(await open.call("run", { id: "live1" })).toMatch(/Queued live loop live1/);
  });

  it("names the id gap instead of guessing when the id belongs to neither home", async () => {
    open = await harness();
    const text = await open.call("cancel", { id: "nope" });
    expect(text).toMatch(/No scheduled job with id "nope"/);
    expect(text).toMatch(/action: "list"/);
  });
});

describe("arguments", () => {
  it("asks for a prompt and a schedule rather than arming half a job", async () => {
    open = await harness();
    expect(await open.call("create", { schedule: "25m" })).toMatch(/`prompt` is required/);
    expect(await open.call("create", { prompt: "Still alive." })).toMatch(/`schedule` is required/);
  });

  it("asks for an id on every verb that needs one", async () => {
    open = await harness();
    for (const action of ["update", "run", "pause", "resume", "cancel"]) {
      expect(await open.call(action, {})).toMatch(/`id` is required/);
    }
  });
});
