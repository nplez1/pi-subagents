import { describe, expect, it } from "vitest";
import type { AgentActivity, Theme } from "./agent-widget.js";
import {
	buildQueuedRow,
	buildRunningAgentRow,
	buildSettledAgentRow,
	type LiveAgent,
	type LiveRowOptions,
} from "./agent-widget.js";

const theme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const opts: LiveRowOptions = { theme, frame: 0, showCost: false, showModel: false };

const activity = (over: Partial<AgentActivity> = {}): AgentActivity => ({
	activeTools: new Map(),
	toolUses: 0,
	responseText: "",
	turnCount: 2,
	...over,
});

const agent = (over: Partial<LiveAgent> = {}): LiveAgent => ({
	id: "a1",
	type: "explore",
	status: "running",
	description: "find auth files",
	startedAt: Date.now() - 4200,
	...over,
});

describe("live row builders", () => {
	it("draws a running agent as a header plus an activity line", () => {
		const [header, detail] = buildRunningAgentRow(
			agent(),
			activity({ activeTools: new Map([["t1", "grep"]]) }),
			opts,
		);

		expect(header).toContain("find auth files");
		expect(header).toContain("↻2");
		expect(header).toContain("4.2s");
		expect(header.startsWith("⠋")).toBe(true);
		expect(detail).toContain("⎿");
		expect(detail).toContain("searching");
	});

	it("falls back to thinking when no activity has been tracked", () => {
		const [, detail] = buildRunningAgentRow(agent(), undefined, opts);
		expect(detail).toContain("thinking…");
	});

	it("draws a settled agent on one line with its final duration", () => {
		const line = buildSettledAgentRow(
			agent({ status: "completed", completedAt: Date.now() }),
			undefined,
			opts,
		);
		expect(line).toContain("✓");
		expect(line).toContain("find auth files");
		expect(line.split("\n")).toHaveLength(1);
	});

	it("marks a failed agent and keeps its message", () => {
		const line = buildSettledAgentRow(
			agent({ status: "error", completedAt: Date.now(), error: "boom" }),
			undefined,
			opts,
		);
		expect(line).toContain("✗");
		expect(line).toContain("error: boom");
	});

	it("summarizes queued agents", () => {
		expect(buildQueuedRow(3, theme)).toBe("◦ 3 queued");
	});

	it("names the model and effort only when showModel is on", () => {
		const invoked = agent({ invocation: { modelShort: "DSv4Pro", thinking: "high" } as never });
		const withModel = buildRunningAgentRow(invoked, activity(), { ...opts, showModel: true })[0];
		const without = buildRunningAgentRow(invoked, activity(), opts)[0];
		expect(withModel).toContain("DSv4Pro/H");
		expect(without).not.toContain("DSv4Pro");
	});
});
