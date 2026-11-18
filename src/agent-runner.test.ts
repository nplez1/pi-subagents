/**
 * agent-runner.test.ts — the turn budget a *resumed* run enforces.
 *
 * A spawn has always been capped: at `max_turns` the agent is steered to wrap up,
 * and `graceTurns` later it is aborted. Resume did not go through that path at
 * all, so a resumed agent — the natural way to push a run that ran out of budget
 * further — had no cap whatsoever (#368). These cases pin the cap onto the resume
 * path and check the outcome it reports back to the record.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveThinkingLevel, resumeAgent, setGraceTurns } from "./agent-runner.js";

type Listener = (event: unknown) => void;

/** A pi session stand-in: records every prompt/steer/abort the runner sends. */
function fakeSession(script: (emit: (event: unknown) => void) => void) {
  const listeners = new Set<Listener>();
  const steers: string[] = [];
  const calls = { prompts: 0, aborts: 0 };
  const session = {
    messages: [] as unknown[],
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      calls.prompts++;
      script((event) => {
        for (const listener of [...listeners]) listener(event);
      });
    },
    steer(message: string) {
      steers.push(message);
    },
    abort() {
      calls.aborts++;
    },
  };
  return { session: session as never, steers, calls };
}

/** One completed turn, as pi reports it. */
const turnEnd = { type: "turn_end" };

describe("resumeAgent turn budget", () => {
  beforeEach(() => {
    setGraceTurns(2);
  });

  it("steers to wrap up at max_turns and records the count", async () => {
    const counts: number[] = [];
    const { session, steers, calls } = fakeSession((emit) => {
      emit(turnEnd);
      emit(turnEnd);
      emit(turnEnd);
    });

    const outcome = await resumeAgent(session, "keep going", {
      type: "general-purpose",
      maxTurns: 2,
      onTurnEnd: (count) => counts.push(count),
    });

    expect(counts).toEqual([1, 2, 3]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatch(/turn limit/);
    // Steered, not killed: the grace turns are the agent's room to answer.
    expect(calls.aborts).toBe(0);
    expect(outcome).toMatchObject({ aborted: false, steered: true });
  });

  it("aborts once the grace turns are spent, and says so", async () => {
    const { session, calls } = fakeSession((emit) => {
      for (let i = 0; i < 4; i++) emit(turnEnd);
    });

    const outcome = await resumeAgent(session, "keep going", {
      type: "general-purpose",
      maxTurns: 2,
    });

    // 2 (limit) + 2 (grace) = the fourth turn end triggers the abort.
    expect(calls.aborts).toBe(1);
    expect(outcome.aborted).toBe(true);
  });

  it("leaves an uncapped run alone", async () => {
    const { session, steers, calls } = fakeSession((emit) => {
      for (let i = 0; i < 20; i++) emit(turnEnd);
    });

    const outcome = await resumeAgent(session, "all day", {
      type: "general-purpose",
      maxTurns: 0,
    });

    expect(steers).toEqual([]);
    expect(calls.aborts).toBe(0);
    expect(outcome).toMatchObject({ aborted: false, steered: false });
  });

  it("does not prompt a run whose signal is already aborted", async () => {
    const { session, calls } = fakeSession(() => {});
    const controller = new AbortController();
    controller.abort();

    await resumeAgent(session, "too late", {
      type: "general-purpose",
      signal: controller.signal,
    });

    expect(calls.prompts).toBe(0);
  });

  it("keeps counting even when the caller wants no per-turn callback", async () => {
    const { session, calls } = fakeSession((emit) => {
      emit(turnEnd);
      emit(turnEnd);
    });

    const outcome = await resumeAgent(session, "quiet", {
      type: "general-purpose",
      maxTurns: 2,
    });

    // The steering is the observable effect of a count nobody subscribed to.
    expect(calls.aborts).toBe(0);
    expect(outcome.steered).toBe(true);
  });
});

describe("resumeAgent event wiring", () => {
  it("still reports tool activity and usage deltas alongside the turn count", async () => {
    const tools: string[] = [];
    const usage: unknown[] = [];
    const { session } = fakeSession((emit) => {
      emit({ type: "tool_execution_start", toolName: "read" });
      emit({ type: "tool_execution_end", toolName: "read" });
      emit({ type: "message_end", message: { role: "assistant", usage: { input: 5, output: 7 } } });
    });

    await resumeAgent(session, "work", {
      type: "general-purpose",
      onToolActivity: (activity) => tools.push(`${activity.type}:${activity.toolName}`),
      onAssistantUsage: (u) => usage.push(u),
    });

    expect(tools).toEqual(["start:read", "end:read"]);
    expect(usage).toEqual([{ input: 5, output: 7, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
  });
});

describe("steerAgent", () => {
  it("forwards the message to the session", async () => {
    const steered: string[] = [];
    const session = { steer: (m: string) => steered.push(m) } as never;
    const { steerAgent } = await import("./agent-runner.js");
    await steerAgent(session, "change of plan");
    expect(steered).toEqual(["change of plan"]);
  });
});

describe("resolveThinkingLevel", () => {
  it("prefers the caller, then the agent file, then the parent session", () => {
    expect(
      resolveThinkingLevel({ thinkingLevel: "low" }, { thinking: "high" }, { thinkingLevel: "max" }),
    ).toBe("low");
    expect(resolveThinkingLevel({}, { thinking: "high" }, { thinkingLevel: "max" })).toBe("high");
  });

  it("inherits the parent session's level when nothing else asks for one", () => {
    // The bug (#306): an unset level used to fall through to pi's global
    // default, so a max-thinking session spawned agents at whatever the machine
    // defaults to.
    expect(resolveThinkingLevel({}, undefined, { thinkingLevel: "max" })).toBe("max");
    expect(resolveThinkingLevel({}, { thinking: undefined }, { thinkingLevel: "xhigh" })).toBe("xhigh");
  });

  it("keeps a parent that has thinking off, rather than guessing", () => {
    expect(resolveThinkingLevel({}, undefined, { thinkingLevel: "off" })).toBe("off");
  });

  it("stays undefined when the session reports no level of its own", () => {
    // Undefined still means "let pi resolve it from settings", which is right
    // for a session that has no level and no parent to inherit one from.
    expect(resolveThinkingLevel({}, undefined, {})).toBeUndefined();
  });
});
