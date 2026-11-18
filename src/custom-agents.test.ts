/**
 * custom-agents.test.ts — how an agent file's `tools:` and `disallowedTools`
 * frontmatter is read.
 *
 * Two spellings used to be silently unusable: a bare `mcp__<server>__<tool>`
 * entry was taken for a mistyped built-in and dropped, which left the agent
 * with EVERY MCP tool instead of the one it asked for; and Claude Code's tool
 * names (`Read`, `Glob`, `Bash`, `disallowedTools`) matched nothing in pi.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCustomAgents } from "./custom-agents.js";

let cwd: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-subagents-agents-"));
  mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
  // An empty global dir, so the user's own agents never leak into a case.
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-subagents-global-"));
});

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

/** Load one project agent file whose frontmatter is `frontmatter`. */
function load(frontmatter: string) {
  writeFileSync(join(cwd, ".pi", "agents", "probe.md"), `---\n${frontmatter}\n---\n\nPrompt.\n`);
  const agent = loadCustomAgents(cwd, true).get("probe");
  if (!agent) throw new Error("probe agent did not load");
  return agent;
}

describe("tools: mcp__ entries", () => {
  it("keeps a bare mcp__<server>__<tool> out of the built-ins and records it", () => {
    const agent = load("tools: read, mcp__github__create_issue");

    expect(agent.builtinToolNames).toEqual(["read"]);
    expect(agent.mcpToolPatterns).toEqual(["mcp__github__create_issue"]);
  });

  it("reads a server-level mcp__<server> as every tool of that server", () => {
    expect(load("tools: mcp__github").mcpToolPatterns).toEqual(["mcp__github__*"]);
  });

  it("keeps `*` patterns as written", () => {
    expect(load("tools: mcp__github__get_*").mcpToolPatterns).toEqual(["mcp__github__get_*"]);
  });

  it("leaves mcpToolPatterns unset when there are none", () => {
    expect(load("tools: read, ext:foo").mcpToolPatterns).toBeUndefined();
  });

  it("an mcp__-only list means zero built-ins, as an ext:-only list does", () => {
    expect(load("tools: mcp__github__create_issue").builtinToolNames).toEqual([]);
  });
});

describe("tools: Claude Code names", () => {
  it("maps Claude Code spellings to pi built-ins, case-insensitively", () => {
    const agent = load("tools: Read, Glob, Bash, MultiEdit, LS, Grep");

    expect(agent.builtinToolNames).toEqual(["read", "find", "bash", "edit", "ls", "grep"]);
  });

  it("de-duplicates after mapping", () => {
    expect(load("tools: read, Read, Edit, MultiEdit").builtinToolNames).toEqual(["read", "edit"]);
  });

  it("passes through a name pi does not know, so the runner can still warn", () => {
    expect(load("tools: Read, WebFetch").builtinToolNames).toEqual(["read", "WebFetch"]);
  });

  it("keeps `*` expanding to every built-in", () => {
    const agent = load('tools: "*, Read"');
    expect(agent.builtinToolNames).toContain("read");
    expect(new Set(agent.builtinToolNames).size).toBe(agent.builtinToolNames?.length);
  });
});

describe("disallowedTools", () => {
  it("accepts Claude Code's spelling of the key", () => {
    expect(load("disallowedTools: Bash").disallowedTools).toEqual(["Bash", "bash"]);
  });

  it("denies both the exact name and the built-in it maps to", () => {
    // `Glob` stays denied by its own name, so an extension tool named `Glob` is
    // not let through by the mapping to `find`.
    expect(load("disallowed_tools: Glob, write").disallowedTools).toEqual(["Glob", "find", "write"]);
  });

  it("prefers disallowed_tools when both spellings are present", () => {
    expect(load("disallowed_tools: write\ndisallowedTools: bash").disallowedTools).toEqual(["write"]);
  });
});

describe("project trust", () => {
  it("reads no project agent files from a project the user declined to trust", () => {
    // An agent file is project code with two levers: it overrides a global agent
    // of the same name, and its `extensions:` entries become explicit extension
    // sources pi loads without re-checking trust. A declined project gets neither.
    writeFileSync(join(cwd, ".pi", "agents", "probe.md"), "---\nname: probe\n---\n\nPrompt.\n");
    expect(loadCustomAgents(cwd, true, { trusted: false }).get("probe")).toBeUndefined();
    expect(loadCustomAgents(cwd, true, { trusted: true }).get("probe")).toBeDefined();
  });

  it("still loads global agents when the project is untrusted", () => {
    const globalDir = join(process.env.PI_CODING_AGENT_DIR as string, "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "shared.md"), "---\nname: shared\n---\n\nPrompt.\n");
    writeFileSync(join(cwd, ".pi", "agents", "probe.md"), "---\nname: probe\n---\n\nPrompt.\n");

    const agents = loadCustomAgents(cwd, true, { trusted: false });
    expect(agents.get("shared")?.name).toBe("shared");
    expect(agents.get("probe")).toBeUndefined();
  });

  it("keeps the historical behaviour when no session has resolved trust yet", () => {
    writeFileSync(join(cwd, ".pi", "agents", "probe.md"), "---\nname: probe\n---\n\nPrompt.\n");
    expect(loadCustomAgents(cwd, true).get("probe")).toBeDefined();
  });
});

describe("tools: wildcard intent", () => {
  it("records an omitted or starred list as the default, not a declaration", () => {
    expect(load("description: d").toolsWildcard).toBe(true);
    // Quoted: an unquoted `*` is a YAML alias and the file would not parse.
    expect(load('tools: "*"').toolsWildcard).toBe(true);
    expect(load("tools: all").toolsWildcard).toBe(true);
  });

  it("keeps an explicit list explicit, even when it names every built-in", () => {
    // The Claude Code backend needs the difference: an explicit `--tools` list is
    // a restriction, the default is "no restriction".
    const agent = load("tools: read, bash, edit, write, grep, find, ls");
    expect(agent.toolsWildcard).toBe(false);
    expect(agent.builtinToolNames).toHaveLength(7);
  });

  it("treats `tools: none` as a restriction", () => {
    expect(load("tools: none").toolsWildcard).toBe(false);
  });
});
