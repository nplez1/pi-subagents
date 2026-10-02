import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { AgentDetailsRecord } from "./agent-details.js";
import { buildAgentDetails } from "./agent-details.js";
import extension from "./index.js";
import type { AgentActivity, Theme } from "./ui/agent-widget.js";
import { formatTokensWithContext } from "./ui/agent-widget.js";

const base = {
	displayName: "Explore",
	description: "inspect code",
	subagentType: "explore",
};

const activity = (session?: AgentDetailsRecord["session"]): AgentActivity => ({
	activeTools: new Map(),
	toolUses: 2,
	responseText: "",
	session,
	turnCount: 2,
});

const sessionAt = (percent: number | null) => ({
	getSessionStats: () => ({
		tokens: { input: 100, output: 50, cacheWrite: 0 },
		contextUsage: { percent },
	}),
});

const theme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const agentTool = (() => {
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
	if (!agent?.renderResult)
		throw new Error("Agent tool was not registered with a result renderer");
	return agent;
})();

function renderResult(
	status: "running" | "completed",
	contextPercent?: number | null,
): string {
	const renderTheme = {
		fg: (color: string, text: string) => `${color}:${text}`,
		bold: (text: string) => text,
		getBgAnsi: () => "",
	};
	const component = agentTool.renderResult?.(
		{
			content: [{ type: "text", text: "done" }],
			details: {
				status,
				modelName: "model-x",
				toolUses: 2,
				tokens: "3.2k token",
				contextPercent,
				turnCount: 2,
				durationMs: 1_000,
			},
		} as never,
		{
			expanded: false,
			isPartial: status === "running",
		},
		renderTheme as never,
		{ isError: false } as never,
	) as Text | undefined;
	if (!component)
		throw new Error("Agent result renderer returned no component");
	return component.render(120).join("\n");
}

function record(
	status: "running" | "completed",
	session?: AgentDetailsRecord["session"],
): AgentDetailsRecord {
	return {
		toolUses: 2,
		startedAt: 1_000,
		completedAt: status === "completed" ? 2_000 : undefined,
		status,
		session,
		lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
	};
}

describe("foreground Agent context stats", () => {
	for (const status of ["running", "completed"] as const) {
		it(`includes context usage in ${status} details`, () => {
			const session = sessionAt(72);
			const details = buildAgentDetails(
				base,
				record(status, session),
				activity(session),
			);

			expect(details.contextPercent).toBe(72);
			expect(
				formatTokensWithContext(details.tokens, details.contextPercent, theme),
			).toBe("150 token (72%)");
		});
	}

	it("omits the context annotation when context usage is unavailable", () => {
		const details = buildAgentDetails(base, record("completed"), activity());

		expect(details.contextPercent).toBeNull();
		expect(
			formatTokensWithContext(details.tokens, details.contextPercent, theme),
		).toBe("150 token");
	});

	for (const status of ["running", "completed"] as const) {
		it(`renders context usage in ${status} Agent results`, () => {
			expect(renderResult(status, 72)).toContain("3.2k token (warning:72%)");
		});
	}

	it("does not render a context annotation when unavailable", () => {
		const rendered = renderResult("completed", null);

		expect(rendered).toContain("3.2k token");
		expect(rendered).not.toMatch(/\d+%/);
	});
});
