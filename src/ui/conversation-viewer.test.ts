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

	it("ignores non-left-click events so pi's text selection stays in charge", () => {
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

	it("claims the wheel and scrolls the viewer rather than the transcript behind it", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const { viewer, tui } = makeViewer([{ component: {} as never, start: 0, height: 200 }], lines);
		const offset = () => (viewer as unknown as { scrollOffset: number }).scrollOffset;
		const autoScroll = () => (viewer as unknown as { autoScroll: boolean }).autoScroll;

		// A notch down, then two lines back up: pi's own delta is applied as given.
		expect(viewer.handleMouse({ type: "wheel", button: 64, x: 5, y: 4, width: 60, height: 20, wheelDelta: 5 })).toEqual({
			handled: true,
		});
		expect(offset()).toBe(5);
		expect(autoScroll()).toBe(false);

		expect(viewer.handleMouse({ type: "wheel", button: 64, x: 5, y: 4, width: 60, height: 20, wheelDelta: -2 })).toEqual({
			handled: true,
		});
		expect(offset()).toBe(3);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("clamps the wheel to the transcript's bounds", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const { viewer } = makeViewer([{ component: {} as never, start: 0, height: 200 }], lines);
		const offset = () => (viewer as unknown as { scrollOffset: number }).scrollOffset;
		const autoScroll = () => (viewer as unknown as { autoScroll: boolean }).autoScroll;
		const maxScroll = () => (viewer as unknown as { scrollBounds(): { maxScroll: number } }).scrollBounds().maxScroll;

		// Up from the top moves nothing (never below zero) and parks auto-follow.
		viewer.handleMouse({ type: "wheel", button: 64, x: 5, y: 4, width: 60, height: 20, wheelDelta: -5 });
		expect(offset()).toBe(0);
		expect(autoScroll()).toBe(false);

		// A notch far past the end stops on the last line and resumes following.
		viewer.handleMouse({ type: "wheel", button: 64, x: 5, y: 4, width: 60, height: 20, wheelDelta: 100_000 });
		expect(offset()).toBe(maxScroll());
		expect(autoScroll()).toBe(true);
	});
});


describe("ConversationViewer nested subagent gutter", () => {
	/**
	 * The Claude Code backend tags a delegated child's messages with
	 * `parentToolUseId` (Claude Code interleaves its own subagents into one
	 * stream). Those rows must render with a gutter so the child's work does not
	 * read as the parent's own.
	 *
	 * Drives the render path with injected components rather than real pi
	 * components: `UserMessageComponent.render` needs a full markdown theme, and
	 * this test is about the gutter, not about markdown.
	 */
	function build(nested: boolean) {
		const tui = {
			terminal: { rows: 40, columns: 100 },
			requestRender: vi.fn(),
		} as unknown as TUI;
		const session = {
			messages: [],
			subscribe: () => () => {},
			sessionManager: { getCwd: () => "/tmp" },
			getToolDefinition: () => undefined,
		} as unknown as AgentSession;
		const record = {
			id: "a1",
			type: "general-purpose",
			description: "inspect",
			status: "completed",
			startedAt: Date.now(),
			toolUses: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		} as unknown as AgentRecord;
		const viewer = new ConversationViewer(tui, session, record, undefined, theme, () => {});

		const parent = { render: () => ["PARENT"], invalidate: () => {} };
		const child = { render: () => ["CHILD"], invalidate: () => {} };
		const v = viewer as unknown as Record<string, unknown> & {
			transcript: unknown[];
			contentLayout: ViewerContentEntry[];
			nestedComponents: Set<unknown>;
		};
		// Replace the transcript source so the render loop sees exactly these.
		v.rebuildTranscript = () => {
			v.transcript = [parent, child];
		};
		if (nested) v.nestedComponents.add(child);

		const lines = (
			viewer as unknown as { tryBuildComponentLines(w: number): string[] | undefined }
		).tryBuildComponentLines(60);
		return { lines, layout: v.contentLayout, parent, child };
	}

	it("indents a nested child's rows and leaves the parent's flush", () => {
		const { lines } = build(true);
		expect(lines).toBeDefined();
		// The theme stub is identity, so the gutter arrives verbatim.
		expect(lines).toContain("PARENT");
		expect(lines).toContain("  ▏ CHILD");
	});

	it("leaves a pi transcript (nothing tagged nested) entirely flush", () => {
		const { lines } = build(false);
		expect(lines).toContain("PARENT");
		expect(lines).toContain("CHILD");
		expect((lines ?? []).some((l) => l.includes("▏"))).toBe(false);
	});

	it("keeps every row clickable — indentation must not wrap components", () => {
		// The gutter is applied at render time precisely so `contentLayout` still
		// maps a rendered line back to the ORIGINAL component; wrapping would break
		// click-to-expand for tool rows inside a nested block.
		const { layout, parent, child } = build(true);
		const entries = layout as unknown as ViewerContentEntry[];
		expect(entries.map((e) => e.component)).toEqual([parent, child]);
		// Both rows render exactly one line, so the ranges are contiguous.
		expect(entries.map((e) => e.height)).toEqual([1, 1]);
	});
});
