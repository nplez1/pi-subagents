import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadSettings,
	readAgentOverridesForScope,
	saveAgentOverridesForScope,
	saveSettings,
	type SubagentsSettings,
} from "./settings.js";

let agentDir: string;
let cwd: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "subagents-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "subagents-project-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
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

describe("saveSettings preservation", () => {
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
