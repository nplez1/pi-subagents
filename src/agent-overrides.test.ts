import { describe, expect, it } from "vitest";
import {
	applyAgentOverrides,
	agentOverridesEqual,
	isFilePin,
	mergeAgentOverrides,
	resolveOverrideKey,
	resolveOverrideMapKey,
	sanitizeAgentOverrides,
	setOverrideField,
} from "./agent-overrides.js";
import type { AgentConfig } from "./types.js";

function cfg(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "Explore",
		description: "explore",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "replace",
		...over,
	};
}

function registry(...configs: AgentConfig[]): Map<string, AgentConfig> {
	return new Map(configs.map((c) => [c.name, c]));
}

describe("sanitizeAgentOverrides", () => {
	it("keeps well-formed entries and trims", () => {
		expect(
			sanitizeAgentOverrides({
				Explore: { model: " github-copilot/gpt-6-luna ", thinking: "medium", enabled: false },
			}),
		).toEqual({ Explore: { model: "github-copilot/gpt-6-luna", thinking: "medium", enabled: false } });
	});

	it("drops unknown thinking levels, empty values, and non-object entries", () => {
		expect(
			sanitizeAgentOverrides({
				a: { thinking: "turbo" },
				b: { model: "   " },
				c: "nope",
				d: null,
				e: [],
				"  ": { model: "x" },
			}),
		).toEqual({});
	});

	it("returns {} for non-objects", () => {
		expect(sanitizeAgentOverrides(undefined)).toEqual({});
		expect(sanitizeAgentOverrides("x")).toEqual({});
		expect(sanitizeAgentOverrides([1, 2])).toEqual({});
	});
});

describe("mergeAgentOverrides", () => {
	it("merges per agent and per field, project winning", () => {
		const base = { Explore: { model: "a/b", thinking: "low" as const }, Plan: { enabled: false } };
		const over = { Explore: { thinking: "high" as const } };
		expect(mergeAgentOverrides(base, over)).toEqual({
			Explore: { model: "a/b", thinking: "high" },
			Plan: { enabled: false },
		});
	});

	it("does not mutate the base map", () => {
		const base = { Explore: { model: "a/b" } };
		mergeAgentOverrides(base, { Explore: { model: "c/d" } });
		expect(base.Explore.model).toBe("a/b");
	});
});

describe("setOverrideField", () => {
	it("sets fields and deletes on undefined", () => {
		const set = setOverrideField({}, "Explore", { model: "a/b", thinking: "high" });
		expect(set).toEqual({ Explore: { model: "a/b", thinking: "high" } });
		expect(setOverrideField(set, "Explore", { thinking: undefined })).toEqual({ Explore: { model: "a/b" } });
	});

	it("removes an entry left with no fields", () => {
		expect(setOverrideField({ Explore: { model: "a/b" } }, "Explore", { model: undefined })).toEqual({});
	});
});

describe("agentOverridesEqual", () => {
	it("compares field-for-field, including absences", () => {
		expect(agentOverridesEqual({ A: { model: "x" } }, { A: { model: "x" } })).toBe(true);
		expect(agentOverridesEqual({ A: { model: "x" } }, { A: { model: "y" } })).toBe(false);
		expect(agentOverridesEqual({ A: { model: "x" } }, { A: { model: "x", enabled: true } })).toBe(false);
		expect(agentOverridesEqual({}, {})).toBe(true);
	});
});

describe("resolveOverrideKey", () => {
	it("prefers an exact key and accepts a unique case variant", () => {
		const agents = registry(cfg({ name: "Explore" }));
		expect(resolveOverrideKey(agents, "Explore")).toBe("Explore");
		expect(resolveOverrideKey(agents, "explore")).toBe("Explore");
	});

	it("refuses to guess between two case variants", () => {
		const agents = registry(cfg({ name: "Explore" }), cfg({ name: "explore" }));
		expect(resolveOverrideKey(agents, "EXPLORE")).toBeUndefined();
	});
});

describe("resolveOverrideMapKey", () => {
	it("finds an existing key case-insensitively so a second one is not added", () => {
		expect(resolveOverrideMapKey({ Explore: { model: "x" } }, "explore")).toBe("Explore");
		expect(resolveOverrideMapKey({}, "explore")).toBeUndefined();
	});
});

describe("applyAgentOverrides", () => {
	it("sets defaults and enable state without mutating the source config", () => {
		const shared = cfg();
		const agents = registry(shared);
		applyAgentOverrides(agents, {
			Explore: { model: "a/b", thinking: "high", enabled: false },
		});
		const applied = agents.get("Explore")!;
		expect(applied).not.toBe(shared);
		expect(applied.defaultModel).toBe("a/b");
		expect(applied.defaultThinking).toBe("high");
		expect(applied.enabled).toBe(false);
		// The shared object every registry reuses must stay pristine.
		expect(shared.defaultModel).toBeUndefined();
		expect(shared.enabled).toBeUndefined();
	});

	it("leaves other agents untouched (same object identity)", () => {
		const plan = cfg({ name: "Plan" });
		const agents = registry(cfg(), plan);
		applyAgentOverrides(agents, { Explore: { model: "a/b" } });
		expect(agents.get("Plan")).toBe(plan);
	});

	it("ignores overrides for agents that are not registered", () => {
		const agents = registry(cfg());
		applyAgentOverrides(agents, { Ghost: { model: "a/b" } });
		expect(agents.get("Ghost")).toBeUndefined();
		expect(agents.get("Explore")!.defaultModel).toBeUndefined();
	});
});

describe("isFilePin", () => {
	it("treats a shipped embedded default as a default, not a pin", () => {
		expect(isFilePin(cfg({ isDefault: true, model: "a/b" }))).toBe(false);
	});

	it("treats a file-backed agent as pinned", () => {
		expect(isFilePin(cfg({ sourcePath: "/tmp/Explore.md", model: "a/b" }))).toBe(true);
		// An ejected default carries a sourcePath, so its model is a file pin.
		expect(isFilePin(cfg({ isDefault: true, sourcePath: "/tmp/Explore.md", model: "a/b" }))).toBe(true);
	});
});
