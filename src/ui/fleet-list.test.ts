import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { FleetList, type FleetUICtx } from "./fleet-list.js";

const theme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const runner = (over: Partial<AgentRecord> = {}): AgentRecord =>
	({
		id: "agent-1",
		type: "explore",
		description: "find auth files",
		status: "running",
		toolUses: 0,
		startedAt: Date.now() - 4200,
		session: {},
		...over,
	}) as unknown as AgentRecord;

const activity = (): Map<string, AgentActivity> =>
	new Map([
		[
			"agent-1",
			{
				activeTools: new Map([["t1", "grep"]]),
				toolUses: 1,
				responseText: "",
				turnCount: 2,
			},
		],
	]);

const manager = (records: AgentRecord[]): AgentManager =>
	({
		listAgents: () => records,
		abort: () => false,
		steer: () => {},
	}) as unknown as AgentManager;

/** Captures the registered widget factory + input handler so the test can drive both. */
function harness() {
	let factory: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined;
	let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const statuses = new Map<string, string | undefined>();
	const setWidget = vi.fn((key: string, content: unknown) => {
		if (key !== "fleet") return;
		factory = (content as typeof factory) ?? undefined;
	});
	const ui = {
		setWidget,
		setStatus: (key: string, text: string | undefined) => void statuses.set(key, text),
		onTerminalInput: (handler: typeof input) => {
			input = handler;
			return () => { input = undefined; };
		},
		getEditorText: () => "",
		notify: () => {},
		custom: async () => undefined,
	} as unknown as FleetUICtx;
	const tui = { terminal: { columns: 120 }, focusedComponent: null, requestRender: () => {} };
	return {
		ui,
		statuses,
		setWidget,
		render: () => factory?.(tui, theme).render(120) ?? [],
		key: (data: string) => input?.(data),
	};
}

describe("FleetList below-editor view", () => {
	let h: ReturnType<typeof harness>;

	beforeEach(() => {
		h = harness();
	});

	const mount = (records: AgentRecord[], mode: "all" | "background" | "off" = "all") => {
		const fleet = new FleetList(manager(records), activity(), () => false, () => mode, () => false);
		fleet.setUICtx(h.ui);
		fleet.setWorkflowSource(() => [], async () => {});
		fleet.update();
		return fleet;
	};

	it("draws the live agent tree while idle", () => {
		mount([runner()]);
		const lines = h.render();
		expect(lines[0]).toContain("Agents");
		expect(lines.some(l => l.includes("find auth files"))).toBe(true);
		expect(lines.some(l => l.includes("⎿") && l.includes("searching"))).toBe(true);
	});

	it("turns the same view into a selection in place on ↓", () => {
		mount([runner()]);
		const before = h.render();
		expect(before.some(l => l.includes("Agents"))).toBe(true);
		expect(before.some(l => l.includes("❯"))).toBe(false);
		expect(before.some(l => l.includes("main"))).toBe(false);

		h.key("\x1b[B"); // activate — cursor lands on the first agent
		const active = h.render();
		// The heading is unchanged: no `main` row replaces it (the hint just rides
		// on the same row).
		expect(active.some(l => l.includes("main"))).toBe(false);
		expect(active.some(l => l.includes("Agents"))).toBe(true);
		expect(active.some(l => l.includes("select"))).toBe(true);
		// And the layout does not shift: same number of lines as idle.
		expect(active.length).toBe(before.length);

		const agentRow = active.find(l => l.includes("find auth files"));
		expect(agentRow).toContain("❯");

		// Nothing shifts: the cursor occupies the row's existing 2-space indent,
		// so the connector stays in the same column as it is when idle.
		const idleRow = before.find(l => l.includes("find auth files"));
		expect(agentRow?.startsWith("❯ └─ ")).toBe(true);
		expect(idleRow?.startsWith("  └─ ")).toBe(true);
	});

	it("returns to the idle tree on Esc", () => {
		mount([runner()]);
		h.key("\x1b[B");
		expect(h.render().some(l => l.includes("❯"))).toBe(true);

		h.key("\x1b"); // escape
		expect(h.render().some(l => l.includes("❯"))).toBe(false);
		expect(h.render().some(l => l.includes("find auth files"))).toBe(true);
	});

	it("honors widgetMode=background by hiding known-foreground agents", () => {
		mount([runner({ isBackground: false })], "background");
		// Nothing renders, so the widget is never registered at all.
		expect(h.setWidget).not.toHaveBeenCalled();
		expect(h.render()).toEqual([]);
	});

	it("still shows a background agent under widgetMode=background", () => {
		mount([runner({ isBackground: true })], "background");
		expect(h.render().some(l => l.includes("find auth files"))).toBe(true);
	});

	it("keeps the live tree but refuses navigation when Fleet view is off", () => {
		const fleet = mount([runner()]);
		fleet.setEnabled(false);
		expect(h.render().some(l => l.includes("find auth files"))).toBe(true);
		h.key("\x1b[B"); // activation is disabled
		expect(h.render().some(l => l.includes("❯"))).toBe(false);
	});
});
