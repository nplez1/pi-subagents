import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isClaudeCodeEnabled, setClaudeCodeEnabled } from "./claude-code/model.js";
import {
	applySettings,
	loadSettings,
	readAgentOverridesForScope,
	saveAgentOverridesForScope,
	saveClaudeCodeSetting,
	saveSettings,
	type SettingsAppliers,
	type SubagentsSettings,
} from "./settings.js";

let agentDir: string;
let cwd: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "subagents-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "subagents-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	setClaudeCodeEnabled(undefined);
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const projectFile = () => join(cwd, ".pi", "subagents.json");
const globalFile = () => join(agentDir, "subagents.json");

describe("agentOverrides persistence", () => {
	it("round-trips through the project scope", () => {
		expect(
			saveAgentOverridesForScope({ Explore: { model: "a/b", thinking: "medium" } }, "project", cwd),
		).toBe(true);
		expect(readAgentOverridesForScope("project", cwd)).toEqual({
			Explore: { model: "a/b", thinking: "medium" },
		});
	});

	it("round-trips through the global scope", () => {
		saveAgentOverridesForScope({ Explore: { model: "a/b" } }, "global", cwd);
		expect(readAgentOverridesForScope("global", cwd)).toEqual({ Explore: { model: "a/b" } });
	});

	it("merges project over global per agent and per field", () => {
		saveAgentOverridesForScope(
			{ Explore: { model: "global/m", thinking: "low" }, Plan: { enabled: false } },
			"global",
			cwd,
		);
		saveAgentOverridesForScope({ Explore: { thinking: "high" } }, "project", cwd);

		expect(loadSettings(cwd).agentOverrides).toEqual({
			Explore: { model: "global/m", thinking: "high" },
			Plan: { enabled: false },
		});
	});

	it("drops invalid thinking levels before writing", () => {
		saveAgentOverridesForScope({ Explore: { thinking: "turbo" as never } }, "project", cwd);
		expect(readAgentOverridesForScope("project", cwd)).toEqual({});
	});

	it("removes the key entirely when the map is empty", () => {
		saveAgentOverridesForScope({ Explore: { model: "a/b" } }, "project", cwd);
		saveAgentOverridesForScope({}, "project", cwd);
		expect(readFileSync(projectFile(), "utf-8")).not.toContain("agentOverrides");
	});

	it("preserves other settings keys in the same file", () => {
		saveSettings({ maxConcurrent: 3 } as SubagentsSettings, cwd);
		saveAgentOverridesForScope({ Explore: { model: "a/b" } }, "project", cwd);
		const raw = JSON.parse(readFileSync(projectFile(), "utf-8"));
		expect(raw.maxConcurrent).toBe(3);
		expect(raw.agentOverrides).toEqual({ Explore: { model: "a/b" } });
	});

	it("refuses to overwrite a corrupt settings file", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), "{ not json", "utf-8");
		expect(saveAgentOverridesForScope({ Explore: { model: "a/b" } }, "project", cwd)).toBe(false);
		expect(readFileSync(projectFile(), "utf-8")).toBe("{ not json");
	});
});

describe("the claudeCode switch", () => {
	it("is unset when no file sets one, so the default stands", () => {
		expect(loadSettings(cwd).claudeCode).toBeUndefined();
	});

	it("lets the project override the global file", () => {
		saveClaudeCodeSetting(false, cwd);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ claudeCode: true }), "utf-8");
		expect(loadSettings(cwd).claudeCode).toBe(true);
	});

	it("writes the global file when nothing defines the key", () => {
		// The documented setup is machine-wide, and the settings menu must not turn
		// it into project configuration that a committed file would spread.
		expect(saveClaudeCodeSetting(false, cwd)).toBe(true);
		expect(JSON.parse(readFileSync(globalFile(), "utf-8")).claudeCode).toBe(false);
		expect(existsSync(projectFile())).toBe(false);
	});

	it("updates the scope that already defines it instead of stacking an override", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ claudeCode: false }), "utf-8");
		saveClaudeCodeSetting(true, cwd);
		expect(JSON.parse(readFileSync(projectFile(), "utf-8")).claudeCode).toBe(true);
		expect(existsSync(globalFile())).toBe(false);
	});

	it("preserves every other key and drops the key for undefined", () => {
		saveClaudeCodeSetting(false, cwd);
		const global = JSON.parse(readFileSync(globalFile(), "utf-8"));
		global.maxConcurrent = 4;
		global.agentOverrides = { Explore: { model: "a/b" } };
		writeFileSync(globalFile(), JSON.stringify(global), "utf-8");

		saveClaudeCodeSetting(undefined, cwd);
		const after = JSON.parse(readFileSync(globalFile(), "utf-8"));
		expect(after.claudeCode).toBeUndefined();
		expect(after.maxConcurrent).toBe(4);
		expect(after.agentOverrides).toEqual({ Explore: { model: "a/b" } });
	});

	it("refuses to overwrite a corrupt target file", () => {
		writeFileSync(globalFile(), "{ not json", "utf-8");
		expect(saveClaudeCodeSetting(true, cwd)).toBe(false);
		expect(readFileSync(globalFile(), "utf-8")).toBe("{ not json");
	});

	it("does not seed a session value from the file", () => {
		// The files are the switch's state, so a loaded copy in memory would be a
		// second one: it would survive the user deleting the line, and it would answer
		// for a hand edit made after startup.
		const calls: unknown[][] = [];
		const appliers = new Proxy(
			{},
			{ get: (_t, key) => (...args: unknown[]) => calls.push([key, ...args]) },
		) as unknown as SettingsAppliers;

		applySettings({ claudeCode: false }, appliers);

		expect(calls.some(([key]) => key === "setClaudeCode")).toBe(false);
	});

	it("re-reads the file, so a hand edit needs no restart", () => {
		// pi-subagents and the advisor both read these files; a startup-only copy
		// would let one report a stage the other refuses.
		saveClaudeCodeSetting(false, cwd);
		expect(isClaudeCodeEnabled(cwd)).toBe(false);
		// A hand edit — not through the settings API at all.
		writeFileSync(globalFile(), JSON.stringify({ claudeCode: true }), "utf-8");
		expect(isClaudeCodeEnabled(cwd)).toBe(true);
	});
});

describe("saveSettings preservation", () => {
	it("does not erase the project's claudeCode switch", () => {
		// The snapshot omits the key; without re-attaching the file's copy this write
		// would delete it, silently re-enabling a backend that project turned off
		// while memory still said it was off.
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ claudeCode: false }), "utf-8");
		saveSettings({ maxConcurrent: 3 } as SubagentsSettings, cwd);
		const raw = JSON.parse(readFileSync(projectFile(), "utf-8"));
		expect(raw.claudeCode).toBe(false);
		expect(raw.maxConcurrent).toBe(3);
	});

	it("does not erase project agentOverrides when the settings menu saves", () => {
		saveAgentOverridesForScope({ Explore: { model: "a/b" } }, "project", cwd);
		saveSettings({ maxConcurrent: 7 } as SubagentsSettings, cwd);
		const raw = JSON.parse(readFileSync(projectFile(), "utf-8"));
		expect(raw.maxConcurrent).toBe(7);
		expect(raw.agentOverrides).toEqual({ Explore: { model: "a/b" } });
	});

	it("does not copy global overrides into the project file", () => {
		saveAgentOverridesForScope({ Explore: { model: "global/m" } }, "global", cwd);
		saveSettings({ maxConcurrent: 2 } as SubagentsSettings, cwd);
		const raw = JSON.parse(readFileSync(projectFile(), "utf-8"));
		expect(raw.agentOverrides).toBeUndefined();
		expect(raw.maxConcurrent).toBe(2);
	});

	it("strips an empty project map from the written file", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(projectFile(), JSON.stringify({ agentOverrides: {} }), "utf-8");
		saveSettings({ maxConcurrent: 1 } as SubagentsSettings, cwd);
		const raw = JSON.parse(readFileSync(projectFile(), "utf-8"));
		expect(raw.agentOverrides).toBeUndefined();
	});

	it("global overrides stay out of the project file path entirely", () => {
		saveAgentOverridesForScope({ Explore: { model: "global/m" } }, "global", cwd);
		expect(readFileSync(globalFile(), "utf-8")).toContain("global/m");
		expect(loadSettings(cwd).agentOverrides).toEqual({ Explore: { model: "global/m" } });
	});
});
