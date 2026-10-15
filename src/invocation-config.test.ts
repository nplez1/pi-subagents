import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
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

const filed = { sourcePath: "/tmp/Explore.md" };

describe("resolveAgentInvocationConfig model precedence", () => {
	it("lets a file pin outrank the caller and the configured default", () => {
		const result = resolveAgentInvocationConfig(
			cfg({ model: "pin/m", ...filed }),
			{ model: "caller/m" },
		);
		expect(result.modelInput).toBe("pin/m");
		expect(result.modelFromParams).toBe(false);
		expect(result.overridden?.model).toBe("caller/m");
	});

	it("lets the caller outrank a configured default", () => {
		const result = resolveAgentInvocationConfig(
			cfg({ defaultModel: "default/m", ...filed }),
			{ model: "caller/m" },
		);
		expect(result.modelInput).toBe("caller/m");
		expect(result.modelFromParams).toBe(true);
		expect(result.overridden?.model).toBeUndefined();
	});

	it("uses the configured default when the caller says nothing", () => {
		const result = resolveAgentInvocationConfig(cfg({ defaultModel: "default/m", ...filed }), {});
		expect(result.modelInput).toBe("default/m");
		expect(result.modelFromParams).toBe(false);
	});

	it("lets the configured default re-point a shipped embedded pin", () => {
		const result = resolveAgentInvocationConfig(
			cfg({ model: "shipped/m", isDefault: true }),
			{},
		);
		// Sanity: without a default the shipped pin still applies.
		expect(result.modelInput).toBe("shipped/m");

		const repointed = resolveAgentInvocationConfig(
			cfg({ model: "shipped/m", defaultModel: "default/m", isDefault: true }),
			{},
		);
		expect(repointed.modelInput).toBe("default/m");
	});

	it("lets a caller override a shipped embedded pin (only a file pin outranks the caller)", () => {
		const result = resolveAgentInvocationConfig(
			cfg({ model: "shipped/m", isDefault: true }),
			{ model: "caller/m" },
		);
		expect(result.modelInput).toBe("caller/m");
		expect(result.modelFromParams).toBe(true);
	});

	it("falls back to inherit when nothing names a model", () => {
		const result = resolveAgentInvocationConfig(cfg(), {});
		expect(result.modelInput).toBeUndefined();
		expect(result.modelFromParams).toBe(false);
	});
});

describe("resolveAgentInvocationConfig thinking precedence", () => {
	it("follows the same ladder as the model", () => {
		const pinned = resolveAgentInvocationConfig(
			cfg({ thinking: "low", defaultThinking: "high", ...filed }),
			{ thinking: "max" },
		);
		expect(pinned.thinking).toBe("low");
		expect(pinned.overridden?.thinking).toBe("max");

		const caller = resolveAgentInvocationConfig(
			cfg({ defaultThinking: "high", ...filed }),
			{ thinking: "max" },
		);
		expect(caller.thinking).toBe("max");

		const configured = resolveAgentInvocationConfig(cfg({ defaultThinking: "high", ...filed }), {});
		expect(configured.thinking).toBe("high");

		const shipped = resolveAgentInvocationConfig(cfg({ thinking: "low", isDefault: true }), {});
		expect(shipped.thinking).toBe("low");

		expect(resolveAgentInvocationConfig(cfg(), {}).thinking).toBeUndefined();
	});

	it("does not report a caller 'override' of a configured default", () => {
		const result = resolveAgentInvocationConfig(
			cfg({ defaultThinking: "high", ...filed }),
			{ thinking: "max" },
		);
		expect(result.overridden?.thinking).toBeUndefined();
	});
});
