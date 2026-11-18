/**
 * agent-runner.test.ts — the turn budget a *resumed* run enforces.
 *
 * A spawn has always been capped: at `max_turns` the agent is steered to wrap up,
 * and `graceTurns` later it is aborted. Resume did not go through that path at
 * all, so a resumed agent — the natural way to push a run that ran out of budget
 * further — had no cap whatsoever (#368). These cases pin the cap onto the resume
 * path and check the outcome it reports back to the record.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock's factory is lifted above the imports, so it cannot close
// over ordinary top-level consts. Only the pieces `runAgent` builds a child
// from are replaced; everything else is pi's own.
const { createAgentSession, settingsManagerCreate, loaders, loaderExtensions } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  settingsManagerCreate: vi.fn(),
  loaders: [] as any[],
  /** What every mocked child loader reports as loaded. */
  loaderExtensions: [] as any[],
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    createAgentSession,
    // Records its options; a real one would read the user's agent dir.
    DefaultResourceLoader: class {
      reload = vi.fn(async () => {});
      getExtensions = () => ({ extensions: loaderExtensions, errors: [] });
      constructor(public options: any) {
        loaders.push(this);
      }
    },
    SettingsManager: { ...actual.SettingsManager, create: settingsManagerCreate },
  };
});

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  extensionCanonicalNames,
  installExtensionToolScope,
  type NestedCallGate,
  resolveThinkingLevel,
  resumeAgent,
  runAgent,
  SCOPE_GATE_NAME,
  scopeGateExtension,
  setGraceTurns,
  setRememberAgents,
} from "./agent-runner.js";
import { registerAgents } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

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

// ─── Tool scope: what pi would declare, and nested calls ─────────────────────

type ScopeTool = { name: string; exposure?: string; defaultActive?: boolean };

/** A pi session stand-in for the scope installer: a live registry and active set. */
function scopeSession(tools: ScopeTool[]) {
  let active: string[] = [];
  const listeners: Listener[] = [];
  const session = {
    getAllTools: () => tools.map(({ name, exposure }) => ({ name, exposure })),
    getToolDefinition: (name: string) => {
      const tool = tools.find((t) => t.name === name);
      return tool ? { defaultActive: tool.defaultActive } : undefined;
    },
    getActiveToolNames: () => active,
    setActiveToolsByName: (names: string[]) => {
      active = [...names];
    },
    subscribe: (listener: Listener) => {
      listeners.push(listener);
      return () => {};
    },
    agent: { beforeToolCall: undefined as unknown },
  };
  return {
    session: session as unknown as AgentSession,
    active: () => active,
    activate: (name: string) => {
      active = [...active, name];
    },
    turnEnd: () => {
      for (const listener of listeners) listener(turnEnd);
    },
  };
}

/** A loader whose extensions own the given tools, keyed by extension path. */
function scopeLoader(byPath: Record<string, string[]>) {
  return {
    getExtensions: () => ({
      extensions: Object.entries(byPath).map(([path, names]) => ({
        path,
        tools: new Map(names.map((n) => [n, {}])),
      })),
    }),
  } as never;
}

function installScope(
  session: AgentSession,
  loader: never,
  overrides: Partial<Parameters<typeof installExtensionToolScope>[1]> = {},
) {
  const nestedCallGate: NestedCallGate = {};
  installExtensionToolScope(session, {
    loader,
    toolNames: ["read"],
    disallowedSet: undefined,
    extNames: new Set(),
    narrowing: new Map(),
    mcpToolPatterns: undefined,
    readmitToolNames: new Set(),
    nestedCallGate,
    ...overrides,
  });
  return nestedCallGate;
}

describe("installExtensionToolScope activation", () => {
  it("activates only what pi would declare to the model", () => {
    // pi's MCP registers server tools `deferred` by default, and codemode /
    // tool_search with `defaultActive: false`. Activating every in-scope name
    // put all of them in front of the model at once.
    const { session, active } = scopeSession([
      { name: "read" },
      { name: "ext_tool" },
      { name: "mcp__srv__lookup", exposure: "deferred" },
      { name: "codemode", exposure: "direct", defaultActive: false },
    ]);
    installScope(session, scopeLoader({ "/ext/mcp.ts": ["ext_tool", "mcp__srv__lookup", "codemode"] }));

    expect(active()).toEqual(["read", "ext_tool"]);
  });

  it("keeps a deferred tool once something activated it, across turn_end", () => {
    const tools = [{ name: "read" }, { name: "mcp__srv__lookup", exposure: "deferred" }];
    const { session, active, activate, turnEnd: endTurn } = scopeSession(tools);
    installScope(session, scopeLoader({ "/ext/mcp.ts": ["mcp__srv__lookup"] }));
    expect(active()).not.toContain("mcp__srv__lookup");

    // tool_search loads it mid-run; the next renarrow must not take it back.
    activate("mcp__srv__lookup");
    endTurn();

    expect(active()).toContain("mcp__srv__lookup");
  });

  it("activates a `defaultActive: false` tool the agent names", () => {
    const { session, active } = scopeSession([
      { name: "read" },
      { name: "tool_search", defaultActive: false },
    ]);
    installScope(session, scopeLoader({ "/ext/mcp.ts": ["tool_search"] }), {
      extNames: new Set(["mcp"]),
      narrowing: new Map([["mcp", new Set(["tool_search"])]]),
    });

    expect(active()).toEqual(["read", "tool_search"]);
  });

  it("still keeps injected tools active", () => {
    // `readmitToolNames` is fork behaviour: nested-delegation tools and
    // StructuredOutput are not built-ins, so nothing else would admit them.
    const { session, active } = scopeSession([{ name: "read" }, { name: "StructuredOutput" }]);
    installScope(session, scopeLoader({}), { readmitToolNames: new Set(["StructuredOutput"]) });

    expect(active()).toEqual(["read", "StructuredOutput"]);
  });
});

describe("nested-call scope gate", () => {
  /** The gate extension's `tool_call` handler, as pi would bind it. */
  function gateHandler(gate: NestedCallGate) {
    const inline = scopeGateExtension(gate) as { name: string; hidden?: boolean; factory: (ext: unknown) => void };
    let handler: ((event: { toolName: string }) => unknown) | undefined;
    inline.factory({ on: (name: string, fn: typeof handler) => name === "tool_call" && (handler = fn) });
    if (!handler) throw new Error("gate registered no tool_call handler");
    return { inline, handler };
  }

  it("blocks a codemode-nested call to a tool outside the agent's scope", () => {
    // Calls made through ctx.executeTool never reach agent.beforeToolCall, so
    // without this an ext:-narrowed agent could still reach every MCP tool.
    const { session } = scopeSession([{ name: "read" }, { name: "allowed" }, { name: "other" }]);
    const gate = installScope(
      session,
      scopeLoader({ "/ext/mcp.ts": ["allowed", "other"] }),
      { extNames: new Set(["mcp"]), narrowing: new Map([["mcp", new Set(["allowed"])]]) },
    );
    const { inline, handler } = gateHandler(gate);

    expect(inline).toMatchObject({ name: SCOPE_GATE_NAME, hidden: true });
    expect(handler({ toolName: "allowed" })).toBeUndefined();
    expect(handler({ toolName: "other" })).toEqual({
      block: true,
      reason: 'Tool "other" is not available to this subagent.',
    });
  });

  it("admits everything until the scope is installed", () => {
    const { handler } = gateHandler({});
    expect(handler({ toolName: "anything" })).toBeUndefined();
  });
});

describe("extensionCanonicalNames for pi's built-ins", () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it("never reads a manifest for a `builtin:` path", () => {
    // `dirname("builtin:mcp")` is ".", so the climb used to start in the process
    // cwd — whose package.json could then rename pi's MCP for allowlist matching.
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-builtin-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@x/impostor", pi: { extensions: ["builtin:mcp"] } }),
    );
    process.chdir(dir);

    expect(extensionCanonicalNames("builtin:mcp")).toEqual(["builtin:mcp"]);
  });
});

// ─── runAgent: the child's loader, settings and trust ────────────────────────

describe("runAgent child loader", () => {
  /** createAgentSession is the last stop these cases care about. */
  const STOP = new Error("stop after session options");
  const pi = { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) } as never;

  function parentCtx(trusted = true) {
    return {
      cwd: "/project",
      model: undefined,
      modelRegistry: {},
      getSystemPrompt: () => "parent prompt",
      isProjectTrusted: vi.fn(() => trusted),
      sessionManager: { getSessionFile: () => undefined },
    } as never;
  }

  async function spawn(type: string, ctx = parentCtx(), extra: Record<string, unknown> = {}) {
    await expect(runAgent(ctx, type, "go", { pi, ...extra })).rejects.toBe(STOP);
    return { loader: loaders.at(-1).options, session: createAgentSession.mock.calls.at(-1)?.[0] };
  }

  beforeEach(() => {
    loaders.length = 0;
    loaderExtensions.length = 0;
    createAgentSession.mockReset();
    createAgentSession.mockImplementation(async () => {
      throw STOP;
    });
    settingsManagerCreate.mockReset();
    settingsManagerCreate.mockImplementation((cwd: string, _dir: string, opts?: { projectTrusted?: boolean }) => ({
      cwd,
      isProjectTrusted: () => opts?.projectTrusted ?? true,
      getSessionDir: () => undefined,
    }));
    // In-memory session manager: nothing these cases do should touch disk.
    setRememberAgents(false);
    registerAgents(new Map());
  });

  afterEach(() => {
    setRememberAgents(true);
    registerAgents(new Map());
  });

  it("carries the parent's project-trust decision into the child's settings and loader", async () => {
    // The bug: settings were built trusted-by-default, so a subagent in a project
    // the user declined to trust still loaded its `.pi` extensions, and pi's MCP
    // started the servers in its `.pi/mcp.json`.
    const { loader, session } = await spawn("Explore", parentCtx(false));

    expect(settingsManagerCreate).toHaveBeenCalledTimes(1);
    expect(settingsManagerCreate).toHaveBeenCalledWith("/project", expect.any(String), { projectTrusted: false });
    // One manager for both, so the loader and the session agree on what loads.
    const manager = settingsManagerCreate.mock.results[0].value;
    expect(loader.settingsManager).toBe(manager);
    expect(session.settingsManager).toBe(manager);
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
  });

  it("a cross-directory spawn keeps the parent project's settings but reports its cwd untrusted", async () => {
    const { loader, session } = await spawn("Explore", parentCtx(true), { cwd: "/target", configCwd: "/project" });

    for (const call of settingsManagerCreate.mock.calls) {
      expect(call).toEqual(["/project", expect.any(String), { projectTrusted: true }]);
    }
    // The loader still loads the parent project's extensions, while the
    // session tells extensions (pi's MCP reading `<cwd>/.pi/mcp.json`) that its
    // cwd is not a trusted project.
    expect(session.settingsManager).not.toBe(loader.settingsManager);
    expect(loader.settingsManager.isProjectTrusted()).toBe(true);
    expect(session.settingsManager.isProjectTrusted()).toBe(false);
  });

  it("forwards pi's built-in extensions, plus the scope gate, to the child loader", async () => {
    // The child loader is built here, not by pi's CLI, so without these a
    // `builtin:<name>` path resolves to nothing and MCP/codemode never load.
    const { loader } = await spawn("Explore");

    const factories = loader.extensionFactories as Array<{ name: string; factory: unknown; builtin?: boolean }>;
    expect(factories.map((f) => f.name)).toEqual(["codemode", "tool-search", "mcp", SCOPE_GATE_NAME]);
    for (const f of factories.slice(0, 3)) {
      expect(f).toMatchObject({ builtin: true, replaceable: true });
      expect(typeof f.factory).toBe("function");
    }
    expect(factories[3].builtin).toBeUndefined();
    expect(loader.disabledBuiltinExtensions).toBeUndefined();
  });

  it("adds no scope gate when the agent loads no extensions", async () => {
    registerAgents(
      new Map<string, AgentConfig>([
        ["bare", { name: "bare", description: "d", extensions: false, skills: false, systemPrompt: "", promptMode: "replace" }],
      ]),
    );
    const { loader } = await spawn("bare");

    expect(loader.noExtensions).toBe(true);
    expect(loader.extensionFactories.map((f: { name: string }) => f.name)).toEqual(["codemode", "tool-search", "mcp"]);
  });

  it("honours --no-mcp and --no-extensions for pi's built-ins", async () => {
    const argv = process.argv;
    try {
      process.argv = [...argv, "--no-mcp"];
      expect((await spawn("Explore")).loader.disabledBuiltinExtensions).toEqual(["mcp"]);
      process.argv = [...argv, "-ne"];
      expect((await spawn("Explore")).loader.disabledBuiltinExtensions).toEqual(["codemode", "tool-search", "mcp"]);
    } finally {
      process.argv = argv;
    }
  });

  it("an `extensions:` allowlist keeps the scope gate and filters `builtin:` like any extension", async () => {
    registerAgents(
      new Map<string, AgentConfig>([
        ["scoped", { name: "scoped", description: "d", extensions: ["builtin:mcp"], skills: false, systemPrompt: "", promptMode: "replace" }],
      ]),
    );
    const { loader } = await spawn("scoped");

    const ext = (path: string) => ({ path, tools: new Map() });
    const kept = loader.extensionsOverride({
      extensions: [ext("builtin:mcp"), ext("builtin:codemode"), ext("/ext/other.ts"), ext(`<inline:${SCOPE_GATE_NAME}>`)],
      errors: [],
    });
    expect(kept.extensions.map((e: { path: string }) => e.path)).toEqual(["builtin:mcp", `<inline:${SCOPE_GATE_NAME}>`]);
  });
});

// ─── `tools:` mcp__ entries and Claude Code names ────────────────────────────

describe("bare mcp__ entries in tools:", () => {
  const mcpLoader = () =>
    scopeLoader({
      "builtin:mcp": ["mcp__github__issue", "mcp__github__pr", "mcp__slack__post", "read_mcp_resource"],
      "builtin:codemode": ["codemode"],
      "builtin:tool-search": ["tool_search"],
    });

  it("without them, every MCP tool is in scope (the old reading of `tools: mcp__…`)", () => {
    // The entry used to be taken for a mistyped built-in and dropped, which left
    // the agent with every MCP tool rather than the one it asked for.
    const { session } = scopeSession([{ name: "read" }]);
    const gate = installScope(session, mcpLoader(), { toolNames: ["mcp__github__issue"] });

    expect(gate.allows?.("mcp__slack__post")).toBe(true);
  });

  it("narrows MCP tools to the matching ones, keeping the bridges that reach them", () => {
    const { session } = scopeSession([{ name: "read" }]);
    const gate = installScope(session, mcpLoader(), { mcpToolPatterns: ["mcp__github__*"] });

    expect(gate.allows?.("mcp__github__issue")).toBe(true);
    expect(gate.allows?.("mcp__github__pr")).toBe(true);
    expect(gate.allows?.("mcp__slack__post")).toBe(false);
    // pi counts its resource tools as MCP tools, so a narrowed agent loses them too.
    expect(gate.allows?.("read_mcp_resource")).toBe(false);
    expect(gate.allows?.("codemode")).toBe(true);
    expect(gate.allows?.("tool_search")).toBe(true);
    expect(gate.allows?.("read")).toBe(true);
  });

  it("reaches a matching tool even from an extension the ext: opt-in left out", () => {
    const { session } = scopeSession([{ name: "read" }]);
    const gate = installScope(
      session,
      scopeLoader({ "/ext/other.ts": ["other_tool"], "builtin:mcp": ["mcp__github__issue", "mcp__slack__post"] }),
      { extNames: new Set(["other"]), mcpToolPatterns: ["mcp__github__issue"] },
    );

    expect(gate.allows?.("other_tool")).toBe(true);
    expect(gate.allows?.("mcp__github__issue")).toBe(true);
    expect(gate.allows?.("mcp__slack__post")).toBe(false);
  });

  it("still lets disallowed_tools win over a matching entry", () => {
    const { session } = scopeSession([{ name: "read" }]);
    const gate = installScope(session, mcpLoader(), {
      mcpToolPatterns: ["mcp__github__*"],
      disallowedSet: new Set(["mcp__github__pr", "tool_search"]),
    });

    expect(gate.allows?.("mcp__github__issue")).toBe(true);
    expect(gate.allows?.("mcp__github__pr")).toBe(false);
    expect(gate.allows?.("tool_search")).toBe(false);
  });

  it("activates an exactly named MCP tool that opts out of default activation", () => {
    const { session, active } = scopeSession([
      { name: "read" },
      { name: "mcp__github__issue", defaultActive: false },
      { name: "mcp__github__pr", defaultActive: false },
    ]);
    installScope(session, mcpLoader(), { mcpToolPatterns: ["mcp__github__issue", "mcp__github__p*"] });

    // Named exactly → activated; matched only by a pattern → left as pi would.
    expect(active()).toEqual(["read", "mcp__github__issue"]);
  });
});

describe("runAgent with mcp__ entries and unusable tools: lists", () => {
  const STOP = new Error("stop after scope install");
  const pi = { exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })) } as never;
  const ctx = {
    cwd: "/project",
    model: undefined,
    modelRegistry: {},
    getSystemPrompt: () => "parent prompt",
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined },
  } as never;

  function agent(name: string, fields: Partial<AgentConfig>) {
    registerAgents(
      new Map<string, AgentConfig>([
        [name, { name, description: "d", extensions: true, skills: false, systemPrompt: "", promptMode: "replace", ...fields }],
      ]),
    );
  }

  beforeEach(() => {
    loaders.length = 0;
    loaderExtensions.length = 0;
    createAgentSession.mockReset();
    settingsManagerCreate.mockReset();
    settingsManagerCreate.mockImplementation(() => ({ isProjectTrusted: () => true, getSessionDir: () => undefined }));
    setRememberAgents(false);
  });

  afterEach(() => {
    setRememberAgents(true);
    registerAgents(new Map());
  });

  it("scopes the child's MCP tools to the agent's mcp__ entries", async () => {
    agent("gh", { builtinToolNames: ["read"], mcpToolPatterns: ["mcp__github__*"] });
    loaderExtensions.push({
      path: "builtin:mcp",
      tools: new Map([["mcp__github__issue", {}], ["mcp__slack__post", {}]]),
    });
    const fake = scopeSession([{ name: "read" }]);
    const session = Object.assign(fake.session, { setSessionName: () => {}, bindExtensions: async () => {} });
    createAgentSession.mockResolvedValue({ session });

    await expect(
      runAgent(ctx, "gh", "go", {
        pi,
        onSessionCreated: () => {
          throw STOP;
        },
      }),
    ).rejects.toBe(STOP);

    const gate = (session as unknown as { agent: { beforeToolCall: (c: unknown) => Promise<unknown> } }).agent;
    await expect(gate.beforeToolCall({ toolCall: { name: "mcp__slack__post" } })).resolves.toMatchObject({ block: true });
    await expect(gate.beforeToolCall({ toolCall: { name: "mcp__github__issue" } })).resolves.toBeUndefined();
  });

  it("warns that mcp__ entries cannot match when the agent loads no extensions", async () => {
    agent("noext", { builtinToolNames: ["read"], mcpToolPatterns: ["mcp__github__*"], extensions: false });
    createAgentSession.mockRejectedValue(STOP);
    const onToolActivity = vi.fn();

    await expect(runAgent(ctx, "noext", "go", { pi, onToolActivity })).rejects.toBe(STOP);

    expect(onToolActivity.mock.calls.map((c) => c[0].toolName)).toContain(
      'tools-error:mcp__github__* requested by agent "noext" need extensions, but it loads none',
    );
  });

  it("refuses an agent whose tools: list resolved to nothing", async () => {
    agent("empty", { builtinToolNames: ["WebFetch"], extensions: false });

    await expect(runAgent(ctx, "empty", "go", { pi })).rejects.toThrow(
      /Agent 'empty' would be spawned with zero tools — refusing\. .*unrecognized \[WebFetch\]/,
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("does not refuse while an extension could still supply tools", async () => {
    agent("later", { builtinToolNames: ["WebFetch"] });
    loaderExtensions.push({ path: "builtin:mcp", tools: new Map() });
    createAgentSession.mockRejectedValue(STOP);

    await expect(runAgent(ctx, "later", "go", { pi })).rejects.toBe(STOP);
  });
});
