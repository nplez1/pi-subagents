/**
 * agent-tool-schema.test.ts — the `Agent` tool's parameter schema as pi reads it.
 *
 * pi validates a tool call against `tool.parameters` *before* any extension code
 * runs, so anything the schema marks required is a hard failure the tool can
 * never explain its way out of. `subagent_type` was one of those: a model that
 * omitted it got `- subagent_type: missing` and no agent at all. It is optional
 * now and answered by the resolver (see agent-types.test.ts); these cases pin
 * that from the outside, through the same validator pi uses, and check the
 * nested tool's own narrower rule.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import extension from "./index.js";
import { createNestedSubagentTools } from "./nested-tools.js";
import type { AgentRecord } from "./types.js";

/**
 * pi's own argument check: `Compile` from typebox, which is what pi-ai's
 * `validateToolArguments` runs against a tool's schema. Only `Check` is used —
 * the coercion pi layers on top cannot turn an absent field into a present one.
 */
function accepts(tool: ToolDefinition, args: unknown): boolean {
	return Compile(tool.parameters as never).Check(args);
}

const noop = () => {};

/** Register the extension against a no-op pi and take the `Agent` tool. */
function agentTool(): ToolDefinition {
	const registered: ToolDefinition[] = [];
	const pi = new Proxy(
		{ events: new Proxy({}, { get: () => noop }) },
		{
			get(target, key) {
				if (key in target) return target[key as keyof typeof target];
				if (key === "registerTool")
					return (tool: ToolDefinition) => registered.push(tool);
				return noop;
			},
			set: () => true,
		},
	) as unknown as ExtensionAPI;
	extension(pi);
	const tool = registered.find((t) => t.name === "Agent");
	if (!tool) throw new Error("Agent tool was not registered");
	return tool;
}

describe("Agent tool schema", () => {
	const tool = agentTool();

	it("accepts a call with no subagent_type", () => {
		expect(
			accepts(tool, { prompt: "do the thing", description: "do it" }),
		).toBe(true);
	});

	it("still requires the prompt and the description", () => {
		expect(accepts(tool, { description: "do it" })).toBe(false);
		expect(accepts(tool, { prompt: "do the thing" })).toBe(false);
	});

	it("advertises the agent an omitted type reaches", () => {
		const schema = tool.parameters as {
			properties: Record<string, { description?: string }>;
		};
		expect(schema.properties.subagent_type?.description).toContain(
			"Omit it to use general-purpose",
		);
	});
});

describe("nested Agent tool", () => {
	/** The nested tools as one agent session builds them, over a stub manager. */
	function nested(allowedSubagents: "all" | string[]) {
		const spawned: string[] = [];
		const record = {
			id: "child1",
			status: "completed",
			result: "done",
		} as AgentRecord;
		const tools = createNestedSubagentTools({
			manager: {
				spawn: () => "child1",
				awaitStartup: async () => {},
				spawnAndWait: async (_pi, _ctx, type) => {
					spawned.push(type);
					return { id: record.id, record };
				},
				getRecord: () => undefined,
				resume: async () => undefined,
			},
			pi: {} as ExtensionAPI,
			parentAgentId: "parent1",
			depth: 1,
			maxSubagentDepth: 2,
			allowedSubagents,
			configCwd: process.cwd(),
		});
		const tool = tools.find((t) => t.name === "Agent");
		if (!tool) throw new Error("nested Agent tool was not built");
		return { tool, spawned };
	}

	const ctx = {
		cwd: process.cwd(),
		model: undefined,
		modelRegistry: undefined,
	} as unknown as ExtensionContext;

	it("accepts a call with no subagent_type", () => {
		const { tool } = nested(["general-purpose"]);
		expect(
			accepts(tool, { prompt: "do the thing", description: "do it" }),
		).toBe(true);
	});

	it("uses the only allowed type when one is allowed", async () => {
		const { tool, spawned } = nested(["general-purpose"]);
		const result = await tool.execute(
			"call1",
			{ prompt: "do the thing", description: "do it" },
			undefined,
			undefined,
			ctx,
		);
		expect(spawned).toEqual(["general-purpose"]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
	});

	it("refuses with the allowed list when the allowlist cannot decide", async () => {
		const { tool, spawned } = nested("all");
		const result = await tool.execute(
			"call1",
			{ prompt: "do the thing", description: "do it" },
			undefined,
			undefined,
			ctx,
		);
		expect(spawned).toEqual([]);
		expect((result as { isError?: boolean }).isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain(
			"No nested agent type given.",
		);
	});
});
