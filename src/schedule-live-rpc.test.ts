/**
 * schedule-live-rpc.test.ts — the client half of `/loop`'s live backend.
 *
 * The contract is small but every part of it is load-bearing for the
 * `manage_schedules` tool, so each case here is about what a *caller* can rely
 * on rather than about the wire format:
 *   - a reply reaches only the request that asked (the reply channel is
 *     per-request, and two extensions can be in flight at once),
 *   - a refusal arrives as a readable Error, not as an empty success,
 *   - a silent channel means "no /loop in this session" and says so, because
 *     that message is what the model repeats to the user.
 */

import { describe, expect, it } from "vitest";
import {
	cancelLiveLoop,
	createLiveLoop,
	LIVE_CREATE,
	LIVE_LIST,
	LIVE_REMOVE,
	listLiveLoops,
	type LiveEventBus,
} from "./schedule-live-rpc.js";

type Call = { event: string; data: unknown };

/**
 * A bus that records what was emitted and lets a test answer on a handler's
 * behalf — the same shape `pi.events` has, minus everything else.
 */
function fakeBus(): LiveEventBus & { calls: Call[] } {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const calls: Call[] = [];
	return {
		calls,
		on(event, handler) {
			const set = listeners.get(event) ?? new Set();
			set.add(handler);
			listeners.set(event, set);
			return () => set.delete(handler);
		},
		emit(event, data) {
			calls.push({ event, data });
			for (const handler of listeners.get(event) ?? []) handler(data);
		},
	};
}

describe("live backend client", () => {
	it("creates a loop and answers with its id and cadence", async () => {
		const bus = fakeBus();
		bus.on(LIVE_CREATE, (raw) => {
			const { requestId } = raw as { requestId: string };
			bus.emit(`${LIVE_CREATE}:reply:${requestId}`, {
				success: true,
				data: { id: "loop42", intervalMs: 1_500_000, nextAt: 1_700_000_000_000 },
			});
		});

		const created = await createLiveLoop(bus, { schedule: "25m", prompt: "Still alive." });

		expect(created).toEqual({ id: "loop42", intervalMs: 1_500_000, nextAt: 1_700_000_000_000 });
		expect(bus.calls[0]?.event).toBe(LIVE_CREATE);
		expect(bus.calls[0]?.data).toMatchObject({ schedule: "25m", prompt: "Still alive." });
	});

	it("keeps two in-flight requests apart even when they are answered out of order", async () => {
		const bus = fakeBus();
		// Answer the SECOND request first: a shared reply channel would hand the
		// first caller the second loop's id, and the user would cancel the wrong one.
		const pending: Array<{ requestId: string }> = [];
		bus.on(LIVE_CREATE, (raw) => pending.push(raw as { requestId: string }));
		bus.on(LIVE_LIST, (raw) => {
			const { requestId } = raw as { requestId: string };
			bus.emit(`${LIVE_LIST}:reply:${requestId}`, {
				success: true,
				data: { jobs: [{ id: "b", prompt: "second", mode: "fixed", runs: 0 }] },
			});
		});

		const [first, second] = await Promise.all([
			(async () => {
				bus.on(LIVE_CREATE, (raw) => {
					const { requestId } = raw as { requestId: string };
					// Hold the first answer until the list has already resolved.
					setTimeout(
						() =>
							bus.emit(`${LIVE_CREATE}:reply:${requestId}`, {
								success: true,
								data: { id: "a", intervalMs: 60_000 },
							}),
						0,
					);
				});
				return createLiveLoop(bus, { schedule: "1m", prompt: "first" });
			})(),
			listLiveLoops(bus),
		]);

		expect(first.id).toBe("a");
		expect(second.map((job) => job.id)).toEqual(["b"]);
	});

	it("surfaces a refusal as the readable error the model will repeat", async () => {
		const bus = fakeBus();
		bus.on(LIVE_CREATE, (raw) => {
			const { requestId } = raw as { requestId: string };
			bus.emit(`${LIVE_CREATE}:reply:${requestId}`, {
				success: false,
				error: '"0 0 9 * * 1" is not an interval. A live loop needs one of 5m / 30m / 1h / 2d',
			});
		});

		await expect(createLiveLoop(bus, { schedule: "0 0 9 * * 1", prompt: "x" })).rejects.toThrow(
			/not an interval/,
		);
	});

	it("reports a silent channel as /loop being absent, not as a crash", async () => {
		const bus = fakeBus();
		await expect(listLiveLoops(bus)).rejects.toThrow(/\/loop extension is not loaded/);
	});

	it("cancels by id over the remove channel", async () => {
		const bus = fakeBus();
		bus.on(LIVE_REMOVE, (raw) => {
			const { requestId, jobId } = raw as { requestId: string; jobId: string };
			bus.emit(`${LIVE_REMOVE}:reply:${requestId}`, {
				success: jobId === "loop42" ? true : false,
				error: `No live loop with id "${jobId}".`,
				data: { removed: jobId },
			});
		});

		await expect(cancelLiveLoop(bus, "loop42")).resolves.toBeUndefined();
		await expect(cancelLiveLoop(bus, "nope")).rejects.toThrow(/No live loop with id "nope"/);
	});
});
