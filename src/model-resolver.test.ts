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

describe("pinned agent models", () => {
	it("pins the built-in Explore agent to Luna with medium thinking", () => {
		expect(DEFAULT_AGENTS.get("Explore")).toMatchObject({
			model: "github-copilot/gpt-6-luna",
			thinking: "medium",
		});
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

	it("refuses an unavailable Explore pin before spawning on the parent model", async () => {
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(
			tmpdir(),
			"pi-subagents-empty-agent-config",
			String(process.pid),
		);
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
				model: "github-copilot/gpt-6-luna",
				thinking: "medium",
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
		}
	});
});
