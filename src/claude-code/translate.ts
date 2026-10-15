/**
 * claude-code/translate.ts — Claude Code stream events → pi messages.
 *
 * This is the fidelity layer. Everything downstream of a subagent run —
 * `collectResponseText`, `finalTurnError`, the conversation viewer, the output
 * transcript, usage accounting — reads *pi* messages off `session.messages` and
 * pi events off `session.subscribe`. So a Claude Code run is made to look like a
 * pi run by translating its wire format into exactly those shapes, at which
 * point every existing consumer works untouched.
 *
 * Three wire facts drive the design (see protocol.ts for the full detail):
 *
 *   1. `assistant` events arrive **per content block**, not per turn — the CLI
 *      emits one per `content_block_stop`. A turn's blocks therefore have to be
 *      merged into a single pi assistant message, keyed by the Anthropic message
 *      id they share. Treating each event as its own message would render one
 *      turn as a burst of fragments and inflate the turn count.
 *
 *   2. With `--include-partial-messages` the same content also arrives as
 *      `stream_event` SSE frames, indexed and incremental. Those drive live
 *      streaming; the per-block `assistant` events are the authoritative,
 *      complete version of each block. Live blocks are built from the frames and
 *      then *replaced* by the authoritative block, so a half-accumulated
 *      `input_json_delta` can never be mistaken for the final tool arguments.
 *
 *   3. Nested subagents (Claude Code's own `Task` tool) interleave their events
 *      into the same stream, distinguished only by `parent_tool_use_id`. They are
 *      kept as separate messages and tagged, so a viewer can attribute them to a
 *      child instead of crediting the parent with work it delegated.
 */

import type {
	AssistantMessage,
	Message,
	Model,
	StopReason,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	ClaudeAssistantEvent,
	ClaudeContentBlock,
	ClaudeMessage,
	ClaudeStreamEvent,
	ClaudeStreamFrameEvent,
	ClaudeToolResultBlock,
	ClaudeUsage,
	ClaudeUserEvent,
} from "./protocol.js";
import {
	isAssistantEvent,
	isNestedEvent,
	isStreamFrameEvent,
	isUserEvent,
} from "./protocol.js";
import { translateToolCall } from "./tools.js";

/**
 * Usage delta as the translator reports it — a subset of the extension's
 * `LifetimeUsage`, structural so this module needs no import of `usage.ts`.
 */
export interface TranslatedUsage {
	input: number;
	output: number;
	cacheWrite: number;
	cacheRead?: number;
	cost?: number;
}

/**
 * Minimal structural shapes for the callbacks the runner forwards to
 * `RunOptions`. Declared here rather than imported from `agent-runner` so this
 * module stays free of a cycle: the runner imports the translator, and
 * `agent-runner` imports the runner.
 */
export interface TranslatorCallbacks {
	onTextDelta?: (delta: string, fullText: string) => void;
	/** Mirrors pi's `ToolActivity`, restricted to the fields this backend emits. */
	onToolActivity?: (activity: {
		type: "start" | "end";
		toolName: string;
	}) => void;
	onAssistantUsage?: (usage: TranslatedUsage) => void;
	onTurnEnd?: (turnCount: number) => void;
}

/** A pi message carrying the extra provenance a Claude Code run can supply. */
export interface ClaudePiMessageMeta {
	/**
	 * Set on a message produced by a nested Claude Code subagent — the parent
	 * `tool_use` id that spawned it. Absent for the agent we spawned ourselves.
	 * Optional and additive: pi's own message types ignore it, and the viewer
	 * only reads it to indent.
	 */
	parentToolUseId?: string;
}

/** pi message with the optional provenance tag attached. */
export type TaggedMessage = Message & ClaudePiMessageMeta;

/** Live, still-streaming assistant turn. */
interface LiveTurn {
	/** Anthropic message id shared by every block of this turn. */
	messageId: string;
	/**
	 * `parent_tool_use_id` scope this turn belongs to, `""` for the agent we
	 * spawned. Frames carry no message id, so the scope is what routes them to
	 * the right turn when several nested agents interleave.
	 */
	scope: string;
	/** The parent `tool_use` id, when this is a nested agent's turn. */
	parentToolUseId?: string;
	/** The pi message pushed into `messages` and mutated in place while streaming. */
	target: AssistantMessage & ClaudePiMessageMeta;
	/** Content blocks by stream index; `provisional` marks ones only seen via frames. */
	blocks: Map<number, { block: ClaudeContentBlock; provisional: boolean }>;
	/** True once an authoritative `assistant` event has landed for this turn. */
	sawAuthoritativeBlock: boolean;
	nested: boolean;
	/** Set by `finalizeTurn`, so finalizing every open turn cannot double-count one. */
	finalized?: boolean;
}

/**
 * Scope key for interleaving purposes: the spawning `tool_use` id of a nested
 * agent, or `""` for the agent we spawned ourselves.
 */
function scopeOf(event: {
	parent_tool_use_id?: string | null;
}): string {
	return typeof event.parent_tool_use_id === "string"
		? event.parent_tool_use_id
		: "";
}

/** Identity of a turn within its own scope. */
function turnKey(scope: string, messageId: string): string {
	return `${scope}\u0000${messageId}`;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Claude's `stop_reason` → pi's `StopReason`. */
function toStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "refusal":
			return "error";
		default:
			return reason ? "stop" : "pending";
	}
}

/**
 * Claude usage → pi `Usage`.
 *
 * `cost` is deliberately zero here: Claude Code reports pricing once per run as
 * `total_cost_usd`, never per message, so a per-message cost would have to be
 * invented. The runner adds the run total separately (see `applyRunCost`).
 */
function toPiUsage(usage: ClaudeUsage | undefined): Usage {
	if (!usage) return { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } };
	const input = usage.input_tokens ?? 0;
	const output = usage.output_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Overlay only the usage fields the CLI actually reported.
 *
 * A partial payload must not zero what an earlier event established: Claude
 * Code's `message_delta` carries output tokens and often little else, and pi's
 * own Anthropic provider guards against exactly this ("Preserves input_tokens …
 * when proxies omit it in message_delta"). Replacing the whole object would
 * silently reset the input and cache figures `message_start` reported.
 */
function applyUsage(target: Usage, usage: ClaudeUsage | undefined): void {
	if (!usage) return;
	if (usage.input_tokens !== undefined) target.input = usage.input_tokens;
	if (usage.output_tokens !== undefined) target.output = usage.output_tokens;
	if (usage.cache_read_input_tokens !== undefined)
		target.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens !== undefined)
		target.cacheWrite = usage.cache_creation_input_tokens;
	target.totalTokens =
		target.input +
		target.output +
		(target.cacheRead ?? 0) +
		(target.cacheWrite ?? 0);
}

/**
 * Convert one Claude content block into the pi content it renders as.
 * Returns `undefined` for blocks pi has no representation for.
 */
function toPiContent(
	block: ClaudeContentBlock,
): AssistantMessage["content"][number] | undefined {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.signature ? { thinkingSignature: block.signature } : {}),
			};
		case "redacted_thinking":
			// pi models a redacted block as empty thinking carrying the opaque
			// payload, which is exactly how pi's own Anthropic path represents it.
			return {
				type: "thinking",
				thinking: "",
				thinkingSignature: block.data,
				redacted: true,
			};
		case "tool_use": {
			const translated = translateToolCall(block.name, block.input);
			return {
				type: "toolCall",
				id: block.id,
				name: translated.name,
				arguments: translated.arguments,
			};
		}
		case "server_tool_use":
		case "mcp_tool_use": {
			const translated = translateToolCall(block.name ?? "tool", block.input);
			return {
				type: "toolCall",
				id: block.id ?? "",
				name: translated.name,
				arguments: translated.arguments,
			};
		}
		default:
			return undefined;
	}
}

/** Text of a tool_result block, flattened to the string pi renders. */
function toolResultText(block: ClaudeToolResultBlock): string {
	if (typeof block.content === "string") return block.content;
	if (!Array.isArray(block.content)) return "";
	const parts: string[] = [];
	for (const part of block.content) {
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join("\n");
}

/**
 * Accumulates pi messages from a Claude Code event stream.
 *
 * `handle()` is synchronous and mutates `messages` in place, matching how pi's
 * own session behaves: a consumer holding a reference to the tail message sees
 * it grow. The return value says whether anything changed, so the caller can
 * decide whether to repaint.
 */
export class ClaudeMessageTranslator {
	readonly messages: TaggedMessage[];
	/** Most recently touched turn; the fallback when a scope has no live turn. */
	private live: LiveTurn | undefined;
	/** The live turn per agent scope, so interleaved nested agents keep their own. */
	private readonly liveByScope = new Map<string, LiveTurn>();
	/** Turns not yet finalized, keyed by scope + Anthropic message id. */
	private readonly openTurns = new Map<string, LiveTurn>();
	/** `tool_use` ids whose `tool_result` has not arrived yet. */
	private readonly awaitingResults = new Set<string>();
	/** Steer messages waiting for the tool results already in flight. */
	private readonly queuedSteers: string[] = [];
	private turns = 0;
	private readonly toolNamesById = new Map<string, string>();
	/** Run-level cost, held until the `result` event reports it. */
	private runCostUsd = 0;

	/**
	 * @param messages Existing transcript to continue, for a resume. Omitted to
	 *   start a fresh one. Passed by reference, so a resumed run appends to the
	 *   same array the session façade already exposes and the viewer keeps
	 *   rendering one continuous conversation.
	 */
	constructor(
		private readonly model: Model<any>,
		private readonly callbacks: TranslatorCallbacks = {},
		messages: TaggedMessage[] = [],
	) {
		this.messages = messages;
	}

	/** True when `message` is the streaming tail that consumers should treat as live. */
	isTail(message: unknown): boolean {
		return (
			this.messages.length > 0 &&
			this.messages[this.messages.length - 1] === message
		);
	}

	/**
	 * Last non-empty assistant text produced by this run, used as the fallback
	 * when the `result` event carries no `result` string.
	 */
	responseText(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const msg = this.messages[i];
			if (msg.role !== "assistant") continue;
			const text = (msg.content as AssistantMessage["content"])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();
			if (text) return text;
		}
		return "";
	}

	/** Error message from the final assistant turn, when the CLI flagged one. */
	finalError(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const msg = this.messages[i] as unknown as AssistantMessage;
			if (msg.role !== "assistant") continue;
			return msg.errorMessage?.trim() || undefined;
		}
		return undefined;
	}

	/**
	 * Emit the run's reported cost as a cost-only usage delta.
	 *
	 * Called once, after the `result` event. Token counts are already accounted
	 * per assistant message; only money is unreported until the run ends, so the
	 * delta carries cost and nothing else — adding the tokens again here would
	 * double every figure in the widget.
	 *
	 * A subscription-authenticated CLI commonly reports `0`, in which case
	 * nothing is emitted: the UI already renders "no cost reported" differently
	 * from "$0.00", and a zero delta would only mark the accumulator dirty.
	 */
	applyRunCost(totalCostUsd: number | undefined): void {
		if (!totalCostUsd || totalCostUsd <= 0) return;
		if (totalCostUsd <= this.runCostUsd) return;
		const delta = totalCostUsd - this.runCostUsd;
		this.runCostUsd = totalCostUsd;
		this.callbacks.onAssistantUsage?.({
			input: 0,
			output: 0,
			cacheWrite: 0,
			cacheRead: 0,
			cost: delta,
		});
	}

	/** Feed one parsed event. Returns true when the message list changed. */
	handle(event: ClaudeStreamEvent): boolean {
		if (isStreamFrameEvent(event)) return this.handleStreamFrame(event);
		if (isAssistantEvent(event)) return this.handleAssistant(event);
		if (isUserEvent(event)) return this.handleUser(event);
		return false;
	}

	// ─── Live streaming frames ───────────────────────────────────────────────

	private handleStreamFrame(event: ClaudeStreamFrameEvent): boolean {
		const frame = event.event;
		const nested = isNestedEvent(event);
		const scope = scopeOf(event);
		const parentToolUseId = nested
			? (event.parent_tool_use_id as string)
			: undefined;

		switch (frame.type) {
			case "message_start": {
				this.startTurn(frame.message, scope, parentToolUseId);
				return true;
			}
			case "content_block_start": {
				const turn = this.ensureTurn(scope, parentToolUseId);
				if (!turn || !frame.content_block) return false;
				const index =
					typeof frame.index === "number"
						? frame.index
						: this.nextFreeIndex(turn);
				turn.blocks.set(index, {
					block: frame.content_block,
					provisional: true,
				});
				this.rebuildTurn(turn);
				// A tool call is "running" from the moment its block opens, which is
				// what puts it on the widget's active-tool list at the right time.
				//
				// The name has to be the TRANSLATED one: `index.ts` clears the entry
				// by matching the name the `end` reports, and `end` (from the tool
				// result) carries the pi name. Announcing the raw `Bash` here would
				// leave `bash` on the active list for the rest of the run.
				//
				// `server_tool_use` is excluded on purpose: its result arrives as a
				// `web_search_tool_result`-style block, not a `tool_result`, so no
				// `end` would ever follow and the entry would strand exactly the way
				// the name mismatch used to.
				if (frame.content_block.type === "tool_use") {
					const translated = translateToolCall(
						frame.content_block.name,
						frame.content_block.input,
					);
					if (frame.content_block.id)
						this.toolNamesById.set(frame.content_block.id, translated.name);
					this.callbacks.onToolActivity?.({
						type: "start",
						toolName: translated.name,
					});
				}
				return true;
			}
			case "content_block_delta": {
				const turn = this.currentTurn(scope);
				if (!turn || typeof frame.index !== "number") return false;
				const entry = turn.blocks.get(frame.index);
				if (!entry) return false;
				const delta = frame.delta;
				if (!delta) return false;
				if (delta.type === "text_delta" && typeof delta.text === "string") {
					if (entry.block.type === "text") {
						entry.block.text += delta.text;
						this.rebuildTurn(turn);
						this.callbacks.onTextDelta?.(
							delta.text,
							this.currentTurnText(turn),
						);
						return true;
					}
				} else if (
					delta.type === "thinking_delta" &&
					typeof delta.thinking === "string"
				) {
					if (entry.block.type === "thinking") {
						entry.block.thinking += delta.thinking;
						// Rebuild like a text delta does: without it the accumulated
						// thinking stays invisible until the authoritative block lands.
						this.rebuildTurn(turn);
						return true;
					}
				} else if (
					delta.type === "input_json_delta" &&
					typeof delta.partial_json === "string"
				) {
					// Accumulated for completeness, but never trusted as final: the
					// authoritative block arrives with parsed input and replaces this.
					const acc = (entry as { partialJson?: string }).partialJson ?? "";
					(entry as { partialJson?: string }).partialJson =
						acc + delta.partial_json;
					return true;
				} else if (
					delta.type === "signature_delta" &&
					typeof delta.signature === "string"
				) {
					if (entry.block.type === "thinking") {
						entry.block.signature = delta.signature;
						this.rebuildTurn(turn);
						return true;
					}
				}
				return false;
			}
			case "message_delta": {
				const turn = this.currentTurn(scope);
				if (!turn) return false;
				applyUsage(turn.target.usage, frame.usage);
				if (frame.delta?.stop_reason !== undefined) {
					turn.target.stopReason = toStopReason(frame.delta.stop_reason);
				}
				return true;
			}
			case "message_stop": {
				if (!this.currentTurn(scope)) return false;
				// Streaming is done for this turn. The authoritative per-block
				// `assistant` events may still land; the turn stays open until the
				// next message in its scope begins, so those can still be applied.
				return true;
			}
			default:
				return false;
		}
	}

	// ─── Authoritative per-block assistant events ────────────────────────────

	private handleAssistant(event: ClaudeAssistantEvent): boolean {
		const nested = isNestedEvent(event);
		const scope = scopeOf(event);
		const parentToolUseId = nested
			? (event.parent_tool_use_id as string)
			: undefined;
		const message = event.message;
		const blocks = Array.isArray(message.content) ? message.content : [];

		const turn = this.startTurn(message, scope, parentToolUseId);

		// Usage on an assistant event is authoritative for the message, but only
		// for the fields it carries.
		applyUsage(turn.target.usage, message.usage);
		if (message.stop_reason !== undefined) {
			turn.target.stopReason = toStopReason(message.stop_reason);
		}
		if (event.error) {
			turn.target.errorMessage = event.error;
			turn.target.stopReason = "error";
		}
		turn.sawAuthoritativeBlock = true;

		const changed = blocks.length > 0;
		for (const block of blocks) {
			const index = this.matchBlockIndex(turn, block);
			turn.blocks.set(index, { block, provisional: false });
			if (block.type === "tool_use" && block.id) {
				this.toolNamesById.set(
					block.id,
					translateToolCall(block.name, block.input).name,
				);
				// Tracked so a steer arriving mid-call is filed after this call's
				// result rather than between the call and it.
				this.awaitingResults.add(block.id);
			} else if (
				(block.type === "server_tool_use" || block.type === "mcp_tool_use") &&
				block.id
			) {
				// Named for the transcript's benefit only — these never produce a
				// `tool_result`, so they are deliberately not tracked as awaiting one.
				this.toolNamesById.set(
					block.id,
					translateToolCall(block.name ?? "tool", block.input).name,
				);
			}
			this.rebuildTurn(turn);
		}
		return changed;
	}

	// ─── Tool results ────────────────────────────────────────────────────────

	private handleUser(event: ClaudeUserEvent): boolean {
		// Replayed user prompts are the CLI echoing input we already own; the
		// prompt is message[0] of this session, so a replay would duplicate it.
		if (event.isReplay) return false;

		const content = event.message.content;
		if (!Array.isArray(content)) return false;

		const results = content.filter(
			(block): block is ClaudeToolResultBlock => block.type === "tool_result",
		);
		if (results.length === 0) return false;

		const parentToolUseId = isNestedEvent(event)
			? (event.parent_tool_use_id as string)
			: undefined;
		for (const block of results) {
			const toolName = this.toolNamesById.get(block.tool_use_id) ?? "tool";
			this.awaitingResults.delete(block.tool_use_id);
			this.messages.push({
				role: "toolResult",
				toolCallId: block.tool_use_id,
				toolName,
				content: [{ type: "text", text: toolResultText(block) }],
				isError: block.is_error === true,
				timestamp: Date.now(),
				...(parentToolUseId ? { parentToolUseId } : {}),
			} as TaggedMessage);
			this.callbacks.onToolActivity?.({ type: "end", toolName });
		}
		// The call that was in flight has landed, so a steer waiting on it can be
		// filed now — before the next assistant message rather than before this
		// call's own result.
		this.flushQueuedSteers();
		return true;
	}

	// ─── Turn bookkeeping ────────────────────────────────────────────────────

	/**
	 * Record a steering message in the transcript.
	 *
	 * Placed where pi places one: after the results of any tool call already in
	 * flight, never between a call and its own result. Only the transcript entry
	 * is deferred — the caller has already written the message to the CLI's stdin,
	 * which is what actually steers the run.
	 */
	recordSteer(message: string): void {
		if (this.awaitingResults.size === 0) {
			this.pushUserMessage(message);
			return;
		}
		this.queuedSteers.push(message);
	}

	private pushUserMessage(message: string): void {
		this.messages.push({
			role: "user",
			content: message,
			timestamp: Date.now(),
		} as never);
	}

	/**
	 * File steers that were waiting on a tool call.
	 *
	 * `force` is for the end of a turn: whatever the tool bookkeeping thinks, the
	 * next message is an assistant one, so anything still queued belongs before it.
	 */
	private flushQueuedSteers(force = false): void {
		if (!force && this.awaitingResults.size > 0) return;
		for (const message of this.queuedSteers.splice(0))
			this.pushUserMessage(message);
	}

	/**
	 * The turn a frame or event belongs to.
	 *
	 * Scoped first, so two nested agents streaming at once keep their own turns
	 * instead of overwriting each other's blocks. `this.live` is the fallback for
	 * a CLI that omits `parent_tool_use_id` on some frame types, where the most
	 * recently touched turn is the best available guess.
	 */
	private currentTurn(scope: string): LiveTurn | undefined {
		return this.liveByScope.get(scope) ?? this.live;
	}

	/** Ensure a turn exists for this scope, creating one when frames precede `message_start`. */
	private ensureTurn(
		scope: string,
		parentToolUseId: string | undefined,
	): LiveTurn {
		return (
			this.liveByScope.get(scope) ??
			this.startTurn(undefined, scope, parentToolUseId)
		);
	}

	/**
	 * Open — or re-open — the turn a message belongs to.
	 *
	 * Re-opening matters for nested agents: Claude Code interleaves its children's
	 * events into one stream, so a child's second content block can arrive after
	 * another child's `message_start`. Treating that as a new turn would split one
	 * assistant message into several pi messages and inflate the turn count, so a
	 * known message id resumes its own turn instead.
	 *
	 * A genuinely new message in the same scope closes the previous turn there;
	 * turns in other scopes stay open, because their agent is still streaming.
	 */
	private startTurn(
		message: ClaudeMessage | undefined,
		scope: string,
		parentToolUseId: string | undefined,
	): LiveTurn {
		const messageId = message?.id ?? "";
		const key = turnKey(scope, messageId);
		const existing = messageId ? this.openTurns.get(key) : undefined;
		if (existing) {
			this.liveByScope.set(scope, existing);
			this.live = existing;
			return existing;
		}

		// Opened by frames alone (no `message_start`): adopt it rather than starting
		// a second message for the same turn, and take its id now that one exists.
		const implicit = this.liveByScope.get(scope);
		if (implicit && !implicit.messageId) {
			if (messageId) {
				implicit.messageId = messageId;
				this.openTurns.set(key, implicit);
			}
			this.live = implicit;
			return implicit;
		}

		this.finalizeTurn(this.liveByScope.get(scope));

		const target: AssistantMessage & ClaudePiMessageMeta = {
			role: "assistant",
			content: [],
			api: this.model.api,
			provider: this.model.provider,
			model: this.model.id,
			usage: toPiUsage(message?.usage),
			stopReason: "pending",
			timestamp: Date.now(),
			...(parentToolUseId ? { parentToolUseId } : {}),
		};
		this.messages.push(target as TaggedMessage);
		const turn: LiveTurn = {
			messageId,
			scope,
			parentToolUseId,
			target,
			blocks: new Map(),
			sawAuthoritativeBlock: false,
			nested: Boolean(parentToolUseId),
		};
		if (messageId) this.openTurns.set(key, turn);
		this.liveByScope.set(scope, turn);
		this.live = turn;
		return turn;
	}

	/**
	 * Which stream index an authoritative block replaces.
	 *
	 * Tool calls are matched by id, which is unique and stable. Text and thinking
	 * blocks have no id, so they take the earliest still-provisional slot of the
	 * same type; when none is provisional (the frames were complete, as with a
	 * short block whose deltas all arrived before the stop), the next free index
	 * is used. Getting this wrong would duplicate text rather than lose it, since
	 * a duplicate is visible and a silent drop is not.
	 */
	private matchBlockIndex(turn: LiveTurn, block: ClaudeContentBlock): number {
		if (
			block.type === "tool_use" ||
			block.type === "server_tool_use" ||
			block.type === "mcp_tool_use"
		) {
			const id = (block as { id?: string }).id;
			for (const [index, entry] of turn.blocks) {
				if (
					(entry.block.type === "tool_use" ||
						entry.block.type === "server_tool_use" ||
						entry.block.type === "mcp_tool_use") &&
					(entry.block as { id?: string }).id === id
				) {
					return index;
				}
			}
			return this.nextFreeIndex(turn);
		}
		for (const [index, entry] of turn.blocks) {
			if (entry.provisional && entry.block.type === block.type) return index;
		}
		return this.nextFreeIndex(turn);
	}

	/**
	 * One past the highest index in use.
	 *
	 * An implicit slot has to clear every explicit index, not sit next to a
	 * counter of its own: a monotonic counter starting at 0 would hand out index 0
	 * for a stream whose frames omitted `index`, overwriting the first real block.
	 */
	private nextFreeIndex(turn: LiveTurn): number {
		let max = -1;
		for (const index of turn.blocks.keys()) if (index > max) max = index;
		return max + 1;
	}

	/** Rebuild the pi content array from the block map, in stream order. */
	private rebuildTurn(turn: LiveTurn): void {
		const ordered = [...turn.blocks.entries()].sort((a, b) => a[0] - b[0]);
		const content: AssistantMessage["content"] = [];
		for (const [, entry] of ordered) {
			const converted = toPiContent(entry.block);
			if (converted) content.push(converted);
		}
		turn.target.content = content;
	}

	/** Text accumulated so far in the live turn, for `onTextDelta`'s `fullText`. */
	private currentTurnText(turn: LiveTurn): string {
		let text = "";
		for (const block of turn.target.content) {
			if (block.type === "text") text += block.text;
		}
		return text;
	}

	/**
	 * Emit usage and the turn count for one turn, and close it.
	 *
	 * Finalization is where usage and the turn counter are emitted, once per
	 * assistant message — the same cadence pi uses, so the lifetime accumulator
	 * and the `max_turns` logic see identical numbers on both backends.
	 */
	private finalizeTurn(turn: LiveTurn | undefined): void {
		if (!turn || turn.finalized) return;
		turn.finalized = true;
		const key = turnKey(turn.scope, turn.messageId);
		if (turn.messageId && this.openTurns.get(key) === turn)
			this.openTurns.delete(key);
		if (this.liveByScope.get(turn.scope) === turn)
			this.liveByScope.delete(turn.scope);
		if (this.live === turn) this.live = undefined;

		// A steer waiting on a tool call is filed once that call's result lands, so
		// this only has to cover the case where it never does. For OUR turn that is
		// the end of the tool phase — the results have already been seen, since the
		// next message could not have started otherwise. A NESTED turn ending says
		// nothing about the parent's outstanding `Task` call, and flushing there
		// would file the steer among the child's messages.
		if (!turn.nested) this.flushQueuedSteers(true);

		// A turn with no content is not a turn. The CLI can open a message with
		// `message_start` whose blocks never arrive, and counting that would both
		// inflate the turn count that `max_turns` is enforced against and leave an
		// empty assistant bubble in the transcript and viewer.
		if (turn.target.content.length === 0) {
			const index = this.messages.lastIndexOf(turn.target as TaggedMessage);
			if (index >= 0) this.messages.splice(index, 1);
			return;
		}

		const usage = turn.target.usage;
		if (usage.input || usage.output || usage.cacheWrite || usage.cacheRead) {
			this.callbacks.onAssistantUsage?.({
				input: usage.input,
				output: usage.output,
				cacheWrite: usage.cacheWrite,
				cacheRead: usage.cacheRead,
			});
		}

		// A nested agent's turn is real spend, which the usage delta above already
		// reports, but it is not a turn of the agent we spawned: counting it would
		// charge delegated work against the parent's `max_turns` and inflate the
		// turn count every surface shows.
		if (turn.nested) return;

		this.turns++;
		this.callbacks.onTurnEnd?.(this.turns);
	}

	/**
	 * Close every open turn at the end of a run.
	 *
	 * Called on the `result` event *and* on process exit, guarded so a normal
	 * completion (which sees both) cannot count the last turn twice. Every open
	 * turn is closed, not just the most recent one: interleaved nested agents can
	 * leave several open at once, and each still owes its usage delta.
	 */
	finish(): void {
		for (const turn of [...this.openTurns.values()]) this.finalizeTurn(turn);
		for (const turn of [...this.liveByScope.values()]) this.finalizeTurn(turn);
		this.finalizeTurn(this.live);
		// Last resort for a steer whose tool result never arrived: the run is over,
		// so a transcript entry with no turn after it still beats losing the message
		// the user was told had been accepted.
		this.flushQueuedSteers(true);
	}

	/** Number of completed assistant turns. */
	get turnCount(): number {
		return this.turns;
	}
}
