/**
 * A stop must land even when the child never honours it, and must not lose a
 * child's output when it does. The runner below stands in for a child wedged
 * on something that ignores abort: its promise never settles. Before the fix,
 * `spawnAndWait` awaited that promise bare, so `manager.abort()` flipped the
 * status and fired the controller while the caller — a workflow's agent()
 * call, a blocking Agent tool call — hung forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./agent-runner.js", () => ({
	// Never resolves by default: the wedged child.
	runAgent: vi.fn(() => new Promise<string>(() => {})),
	resumeAgent: vi.fn(() => new Promise<string>(() => {})),
}));

import * as runner from "./agent-runner.js";
import { ABORT_GRACE_MS, AgentManager, settleOrAbandon } from "./agent-manager.js";

describe("settleOrAbandon", () => {
	it("resolves with the value when the run settles", async () => {
		const controller = new AbortController();
		await expect(
			settleOrAbandon(Promise.resolve("done"), controller.signal),
		).resolves.toEqual({ settled: true, value: "done" });
	});

	it("gives a cooperative run its grace window, so its value is kept", async () => {
		const controller = new AbortController();
		const released = settleOrAbandon(
			new Promise<string>((resolve) => setTimeout(() => resolve("partial work"), 10)),
			controller.signal,
			1_000,
		);
		controller.abort();
		await expect(released).resolves.toEqual({ settled: true, value: "partial work" });
	});

	it("abandons a wedged run once the grace window passes after abort", async () => {
		const controller = new AbortController();
		const released = settleOrAbandon(new Promise<never>(() => {}), controller.signal, 20);
		controller.abort();
		await expect(released).resolves.toEqual({ settled: false });
	});

	it("abandons a wedged run when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			settleOrAbandon(new Promise<never>(() => {}), controller.signal, 10),
		).resolves.toEqual({ settled: false });
	});

	it("without a signal, waits for the run", async () => {
		await expect(settleOrAbandon(Promise.resolve(7), undefined)).resolves.toEqual({
			settled: true,
			value: 7,
		});
	});

	it("rejects when the run rejects, so startup failures still surface", async () => {
		const controller = new AbortController();
		await expect(
			settleOrAbandon(Promise.reject(new Error("boom")), controller.signal),
		).rejects.toThrow("boom");
		await expect(
			settleOrAbandon(Promise.reject(new Error("boom")), undefined),
		).rejects.toThrow("boom");
	});
});

describe("AgentManager.abort on a spawned child", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function spawnWaiting(manager: AgentManager) {
		let spawnedId: string | undefined;
		const waiting = manager.spawnAndWait(
			{} as never,
			{} as never,
			"general-purpose",
			"do the thing",
			{ description: "child" } as never,
			(id) => {
				spawnedId = id;
			},
		);
		const idSeen = () => {
			if (spawnedId === undefined) throw new Error("not spawned yet");
			return spawnedId;
		};
		return { waiting, idSeen };
	}

	it("releases a waiting spawnAndWait after the grace window and marks the agent stopped", async () => {
		const manager = new AgentManager();
		try {
			const { waiting, idSeen } = spawnWaiting(manager);
			await vi.waitFor(idSeen);
			expect(manager.abort(idSeen())).toBe(true);

			// The child never settles, so only the grace window releases the caller.
			await vi.advanceTimersByTimeAsync(ABORT_GRACE_MS);
			const { record } = await waiting;
			expect(record.status).toBe("stopped");
			expect(record.error).toMatch(/did not respond to the stop/);
		} finally {
			manager.dispose();
		}
	});

	it("keeps the result of a child that honours the stop", async () => {
		vi.mocked(runner.runAgent).mockImplementationOnce(((
			_ctx: unknown,
			_type: unknown,
			_prompt: unknown,
			options: { signal: AbortSignal },
		) =>
			new Promise<unknown>((resolve) => {
				options.signal.addEventListener(
					"abort",
					() =>
						setTimeout(
							() =>
								resolve({
									responseText: "partial work",
									session: { dispose: () => {} },
									aborted: true,
									steered: false,
								}),
							50,
						),
					{ once: true },
				);
			})) as never);

		const manager = new AgentManager();
		try {
			const { waiting, idSeen } = spawnWaiting(manager);
			await vi.waitFor(idSeen);
			expect(manager.abort(idSeen())).toBe(true);

			// The child settles inside the grace window, so the caller gets its output.
			await vi.advanceTimersByTimeAsync(50);
			const { record } = await waiting;
			expect(record.status).toBe("stopped");
			expect(record.result).toBe("partial work");
			expect(record.error).toBeUndefined();
		} finally {
			manager.dispose();
		}
	});
});
