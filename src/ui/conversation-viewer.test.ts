import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { ConversationViewer, hitTestContent, type ViewerContentEntry } from "./conversation-viewer.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("hitTestContent", () => {
	const layout: ViewerContentEntry[] = [
		{ component: {} as never, start: 0, height: 2 },
		{ component: {} as never, start: 2, height: 3 },
	];

	it("maps a viewport row to the component line under it", () => {
		expect(hitTestContent(layout, 3, 3, 5, 0)).toMatchObject({ localY: 0, height: 2 });
		expect(hitTestContent(layout, 4, 3, 5, 0)).toMatchObject({ localY: 1, height: 2 });
		expect(hitTestContent(layout, 5, 3, 5, 0)).toMatchObject({ localY: 0, height: 3 });
		expect(hitTestContent(layout, 7, 3, 5, 0)).toMatchObject({ localY: 2, height: 3 });
	});

	it("accounts for the scroll offset", () => {
		// Two lines scrolled away: the first visible row is content line 2.
		expect(hitTestContent(layout, 3, 3, 4, 2)).toMatchObject({ localY: 0, height: 3 });
	});

	it("misses rows outside the viewport or the layout", () => {
		expect(hitTestContent(layout, 2, 3, 4, 0)).toBeUndefined(); // above the content
		expect(hitTestContent(layout, 8, 3, 4, 0)).toBeUndefined(); // below the viewport
		expect(hitTestContent([], 3, 3, 4, 0)).toBeUndefined();
	});

	it("misses the gap when the layout does not cover a line", () => {
		const sparse: ViewerContentEntry[] = [{ component: {} as never, start: 5, height: 1 }];
		expect(hitTestContent(sparse, 3, 3, 4, 0)).toBeUndefined();
	});
});

function makeViewer(contentLayout: ViewerContentEntry[], cachedLines: string[] = []) {
	const tui = {
		terminal: { rows: 40, columns: 100 },
		requestRender: vi.fn(),
	} as unknown as TUI;
	const session = {
		messages: [],
		subscribe: () => () => {},
		sessionManager: { getCwd: () => "/tmp" },
	} as unknown as AgentSession;
	const record = {
		id: "a1",
		type: "explore",
		description: "inspect",
		status: "completed",
		startedAt: Date.now(),
		toolUses: 0,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
	} as unknown as AgentRecord;
	const viewer = new ConversationViewer(
		tui,
		session,
		record,
		undefined,
		theme,
		() => {},
	);
	// Stand in for a render at width 40: cached content means scrollBounds() is a
	// pure geometry read, so the test does not need a real session transcript.
	const v = viewer as unknown as Record<string, unknown>;
	v.lastInnerW = 40;
	v.lastContentTop = 3;
	v.cachedWidth = 40;
	v.cachedLines = cachedLines;
	v.dirty = false;
	v.contentSig = (viewer as unknown as { contentSignature(): string }).contentSignature();
	v.contentLayout = contentLayout;
	return { viewer, tui };
}

describe("ConversationViewer mouse routing", () => {
	it("forwards a left click to the component under the pointer", () => {
		const child = { handleMouse: vi.fn(() => ({ handled: true })) };
		const { viewer } = makeViewer([{ component: child as never, start: 0, height: 2 }]);

		const result = viewer.handleMouse({ type: "click", button: 0, x: 5, y: 4, width: 60, height: 20 });

		expect(result).toEqual({ handled: true });
		expect(child.handleMouse).toHaveBeenCalledWith(
			expect.objectContaining({ type: "click", x: 3, y: 1, width: 40, height: 2 }),
		);
	});

	it("ignores non-left-click events so selection and wheel keep working", () => {
		const child = { handleMouse: vi.fn(() => ({ handled: true })) };
		const { viewer } = makeViewer([{ component: child as never, start: 0, height: 2 }]);

		expect(viewer.handleMouse({ type: "press", button: 0, x: 5, y: 4, width: 60, height: 20 })).toBeUndefined();
		expect(viewer.handleMouse({ type: "click", button: 1, x: 5, y: 4, width: 60, height: 20 })).toBeUndefined();
		expect(child.handleMouse).not.toHaveBeenCalled();
	});

	it("does nothing for a click outside the content viewport", () => {
		const child = { handleMouse: vi.fn(() => ({ handled: true })) };
		const { viewer } = makeViewer([{ component: child as never, start: 0, height: 2 }]);

		// Row 1 is the header border, above the content area.
		expect(viewer.handleMouse({ type: "click", button: 0, x: 5, y: 1, width: 60, height: 20 })).toBeUndefined();
		expect(child.handleMouse).not.toHaveBeenCalled();
	});

	it("does nothing when the component does not handle the click", () => {
		const { viewer } = makeViewer([{ component: {} as never, start: 0, height: 2 }]);
		expect(viewer.handleMouse({ type: "click", button: 0, x: 5, y: 4, width: 60, height: 20 })).toBeUndefined();
	});
});
