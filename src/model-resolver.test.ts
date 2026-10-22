import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { resolveDefaultModel } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import extension from "./index.js";
import { type ModelRegistry, resolvePinnedModel } from "./model-resolver.js";

interface TestModel {
	provider: string;
	id: string;
	name: string;
}

function registry(models: TestModel[]): ModelRegistry {
	return {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider, id) =>
			models.find((model) => model.provider === provider && model.id === id),
	};
}

const luna: TestModel = {
	provider: "github-copilot",
	id: "gpt-6-luna",
	name: "GPT-6 Luna",
};

const parent: TestModel = {
	provider: "openai",
	id: "gpt-parent",
	name: "Parent Model",
};

const registeredAgentTool = (() => {
	const registered: ToolDefinition[] = [];
	const noop = () => {};
	const pi = new Proxy(
		{ events: new Proxy({}, { get: () => noop }) },
		{
			get(target, key) {
				if (key in target) return target[key as keyof typeof target];
				if (key === "registerTool")
					return (tool: ToolDefinition) => registered.push(tool);
				return noop;
			},
		},
	) as unknown as ExtensionAPI;

	extension(pi);
	const agent = registered.find((tool) => tool.name === "Agent");
	if (!agent) throw new Error("Agent tool did not register");
	return agent;
})();

describe("shipped agent models", () => {
	it("ships no model or thinking pin on the built-in agents", () => {
		// A shipped pin names a provider ID the host machine may not have, and the
		// machine cannot retarget it without editing the extension. The model
		// belongs in the machine-owned `agentOverrides` (subagents.json, the
		// `/subagents` menu) or in an agent file's frontmatter.
		for (const name of ["general-purpose", "Explore", "Plan"]) {
			expect(DEFAULT_AGENTS.get(name)?.model).toBeUndefined();
			expect(DEFAULT_AGENTS.get(name)?.thinking).toBeUndefined();
		}
	});

	it("resolves the exact provider-qualified model", () => {
		expect(
			resolvePinnedModel("github-copilot/gpt-6-luna", registry([luna])),
		).toBe(luna);
	});

	it("refuses a provider fallback for a provider-qualified pin", () => {
		const alternate = { ...luna, provider: "openai" };
		const result = resolvePinnedModel(
			"github-copilot/gpt-6-luna",
			registry([alternate]),
		);

		expect(typeof result).toBe("string");
		expect(result).toContain("openai/gpt-6-luna");
		expect(result).toContain("Refusing to substitute");
	});

	it("refuses an unavailable pin instead of inheriting the parent model", () => {
		expect(() =>
			resolveDefaultModel(
				parent as never,
				registry([]),
				"github-copilot/gpt-6-luna",
			),
		).toThrow(/Ask the user before selecting another model/);
	});

	it("inherits the parent model only when there is no configured pin", () => {
		expect(resolveDefaultModel(parent as never, registry([]))).toBe(parent);
	});

	it("refuses an unavailable configured model before spawning on the parent model", async () => {
		// The model is not shipped in the extension: it comes from the machine-owned
		// `agentOverrides` in subagents.json. The execute path reloads agents and
		// settings from disk, so the override has to live in the agent dir this test
		// points at — otherwise the test would silently depend on the developer's
		// own ~/.pi/agent and pass or fail with their local model choice.
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-override-"));
		writeFileSync(
			join(agentDir, "subagents.json"),
			JSON.stringify({
				agentOverrides: {
					Explore: { model: "xiaomi/mimo-v2.6-flash", thinking: "medium" },
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const result = await registeredAgentTool.execute(
				"model-pin-smoke",
				{
					prompt: "Return only OK.",
					description: "invalid model pin",
					subagent_type: "Explore",
				} as never,
				undefined,
				undefined,
				{
					cwd: process.cwd(),
					model: parent,
					modelRegistry: registry([]),
					ui: {},
				} as never,
			);
			const message = result.content
				.map((part) => ("text" in part ? part.text : ""))
				.join("\n");

			expect(getAgentConfig("Explore")).toMatchObject({
				defaultModel: "xiaomi/mimo-v2.6-flash",
				defaultThinking: "medium",
			});
			expect(message).toContain(
				"Configured model for Explore could not be used",
			);
			expect(message).toContain(
				"No fallback was started. Ask the user before selecting another model.",
			);
			expect(result.details).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined)
				delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
