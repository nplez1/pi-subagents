/**
 * schedule-live-rpc.ts — the client for `/loop`'s live backend.
 *
 * Scheduled work has two execution homes, and only one of them lives in this
 * extension. A *cold* job is a row in the subagent scheduler: each fire spawns a
 * fresh subagent, so `schedule-rpc.ts` serves it in-process. A *live* loop is a
 * timer inside `pi-config`'s `/loop` extension that re-enters the conversation
 * as a user message, inheriting the transcript, the model and the tools — so the
 * only thing that can create one is that extension, and the only way to reach it
 * is the event bus.
 *
 * This module is the client side of that pair:
 *
 *   loop:rpc:schedules:list    → { jobs: LiveLoopView[] }
 *   loop:rpc:schedules:create  → { id, intervalMs, nextAt? }
 *   loop:rpc:schedules:update  → { job, changed: string[] }
 *   loop:rpc:schedules:run     → { job, queuedForNextIdle: true }
 *   loop:rpc:schedules:remove  → { removed }
 *
 * The five literals are duplicated from `/loop`'s own
 * `extensions/shared/scheduled-rpc.ts` — two extensions, one wire, and no shared
 * module to hang the constants on. Change one, change both.
 *
 * A timeout is not a transport failure to shout about: it means `/loop` is not
 * loaded in this session, which is a fact the caller reports in the user's own
 * terms ("no /loop here, use the cold backend") rather than as a stack trace.
 *
 * Both backends are session-scoped. A live loop is visible exactly while its
 * session lives and comes back on `/resume`; nothing here outlives a session.
 */

/** Channels served by `/loop` (`loop.ts` → `wireLiveBackend`). */
export const LIVE_LIST = "loop:rpc:schedules:list";
export const LIVE_CREATE = "loop:rpc:schedules:create";
export const LIVE_UPDATE = "loop:rpc:schedules:update";
export const LIVE_RUN = "loop:rpc:schedules:run";
export const LIVE_REMOVE = "loop:rpc:schedules:remove";

/**
 * How long to wait for `/loop` to answer. Its handlers are synchronous and
 * in-process, so this only ever expires when nothing is listening — the same
 * trade `schedule-rpc.ts`'s callers already make for the cold scheduler.
 */
export const LIVE_RPC_TIMEOUT_MS = 4_000;

/** The slice of `pi.events` this module uses. */
export interface LiveEventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

/** A live loop as `/loop` reports it. */
export interface LiveLoopView {
	id: string;
	prompt: string;
	/** `fixed` is interval-armed; `dynamic` self-paces via `ScheduleWakeup`. */
	mode: "fixed" | "dynamic";
	/** Fixed loops only. */
	intervalMs?: number;
	/** Epoch ms of the next fire; absent while a dynamic loop awaits a wakeup. */
	nextAt?: number;
	runs: number;
	/** Paused loops keep their id and prompt but arm nothing. */
	paused: boolean;
}

/** What `create` answers with, so the caller can report the id and the cadence. */
export interface LiveCreateResult {
	id: string;
	intervalMs: number;
	nextAt?: number;
}

/** Reply envelope shared with `/loop`'s RPC layer. */
type RpcReply<T> = { success: true; data?: T } | { success: false; error: string };

let requestCounter = 0;

/**
 * Send one request to `/loop` and await its reply.
 *
 * The reply channel is scoped to the request id, so two in-flight calls (or two
 * extensions asking at once) cannot read each other's answers. Everything the
 * envelope carries that is not a success comes back as a thrown Error whose
 * message is written for the model to read and act on.
 */
export function callLiveRpc<T>(
	bus: LiveEventBus,
	channel: string,
	params: Record<string, unknown>,
	timeoutMs = LIVE_RPC_TIMEOUT_MS,
): Promise<T> {
	const requestId = `subagents-${++requestCounter}-${channel}`;
	const replyChannel = `${channel}:reply:${requestId}`;

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			fn();
		};
		const timer = setTimeout(
			() =>
				finish(() =>
					reject(
						new Error(
							`No live-loop backend answered ${channel} within ${timeoutMs}ms — the /loop extension is not loaded in this session, so only the cold backend is available.`,
						),
					),
				),
			timeoutMs,
		);
		const unsubscribe = bus.on(replyChannel, (raw) => {
			const reply = raw as RpcReply<T> | undefined;
			finish(() => {
				if (!reply) reject(new Error(`${channel} replied with no envelope`));
				else if (reply.success === true) resolve(reply.data as T);
				else reject(new Error(reply.error));
			});
		});
		bus.emit(channel, { ...params, requestId });
	});
}

/**
 * Arm a live loop. `schedule` must be a plain interval (`5m`, `30m`, `1h`,
 * `2d`) — cron and one-shot shapes only exist on the cold backend, and `/loop`
 * refuses them by name rather than rounding them into something else.
 */
export async function createLiveLoop(
	bus: LiveEventBus,
	input: { schedule: string; prompt: string },
): Promise<LiveCreateResult> {
	const data = await callLiveRpc<LiveCreateResult>(bus, LIVE_CREATE, {
		schedule: input.schedule,
		prompt: input.prompt,
	});
	if (!data?.id) throw new Error("The /loop extension accepted the request but returned no loop id.");
	return data;
}

/** Every live loop in this session. Throws when `/loop` is not loaded. */
export async function listLiveLoops(bus: LiveEventBus): Promise<LiveLoopView[]> {
	const data = await callLiveRpc<{ jobs?: LiveLoopView[] }>(bus, LIVE_LIST, {});
	return data?.jobs ?? [];
}

/** Cancel one live loop by id. Throws (with `/loop`'s own wording) when unknown. */
export async function cancelLiveLoop(bus: LiveEventBus, jobId: string): Promise<void> {
	await callLiveRpc<{ removed: string }>(bus, LIVE_REMOVE, { jobId });
}

/** What `update` accepts: every field optional, `jobId` required. */
export interface LiveLoopPatch {
	jobId: string;
	schedule?: string;
	prompt?: string;
	/** Pause (`true`) or resume (`false`). */
	paused?: boolean;
}

/**
 * Change a live loop in place: cadence, prompt and paused in one call.
 *
 * `/loop` refuses a call that changes nothing, so "did it work?" stays
 * answerable: a success means the field the caller named now differs.
 */
export async function updateLiveLoop(
	bus: LiveEventBus,
	patch: LiveLoopPatch,
): Promise<{ job: LiveLoopView; changed: string[] }> {
	const data = await callLiveRpc<{ job: LiveLoopView; changed: string[] }>(bus, LIVE_UPDATE, {
		jobId: patch.jobId,
		...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
		...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
		...(patch.paused !== undefined ? { paused: patch.paused } : {}),
	});
	if (!data?.job) throw new Error(`The /loop extension accepted the update but returned no loop "${patch.jobId}".`);
	return data;
}

/**
 * Fire a live loop now, ahead of its cadence.
 *
 * The fire happens at the next idle window, never inside the turn that asked for
 * it — a loop that steered its own creator would answer itself.
 */
export async function runLiveLoop(
	bus: LiveEventBus,
	jobId: string,
): Promise<{ job: LiveLoopView; queuedForNextIdle: boolean }> {
	const data = await callLiveRpc<{ job: LiveLoopView; queuedForNextIdle: boolean }>(bus, LIVE_RUN, {
		jobId,
	});
	if (!data?.job) throw new Error(`The /loop extension accepted the run request but returned no loop "${jobId}".`);
	return data;
}

/**
 * True when an error is "nobody is listening", not "that loop does not exist".
 *
 * The caller has to tell them apart: one means the id is wrong, the other means
 * this session has no live backend at all, and only the first is worth acting on.
 */
export function isLiveBackendAbsent(error: unknown): boolean {
	return error instanceof Error && /live-loop backend answered|is not loaded in this session/.test(error.message);
}
