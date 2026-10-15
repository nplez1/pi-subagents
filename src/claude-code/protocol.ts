/**
 * claude-code/protocol.ts — the `claude --print --output-format stream-json`
 * wire format, as actually emitted by Claude Code 2.1.x.
 *
 * Every type here is a *partial* description on purpose. The CLI's schema grows
 * between releases (2.0.55 → 2.1.296 alone added `hook_started`, `subagent_stats`,
 * `capabilities` and `terminal_reason`), and an agent run must not break because
 * a newer CLI attached a field this file has never heard of. Readers therefore
 * narrow defensively and ignore what they do not recognize; nothing validates
 * exhaustively. The one place a shape is load-bearing is the `result` event,
 * whose `usage`/`total_cost_usd` feed the token and cost accounting.
 *
 * Wire notes worth keeping:
 *   - `stream-json` output requires `--verbose` in print mode; without it the
 *     CLI exits with an argument error rather than degrading to text.
 *   - With `--include-partial-messages`, each Anthropic SSE frame arrives as a
 *     `stream_event`, and `assistant` events are emitted *per content block*
 *     (one event per `content_block_stop`), not once per turn. Consumers must
 *     merge by `message.id` rather than assuming one assistant event per turn.
 *   - `parent_tool_use_id` is set on events produced by Claude Code's own
 *     nested subagents (its `Task` tool). A non-null value means the event
 *     belongs to a child, never to the agent we spawned.
 */

/** Anthropic message content blocks, as they appear in `assistant`/`user`. */
export interface ClaudeTextBlock {
	type: "text";
	text: string;
}

export interface ClaudeThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface ClaudeRedactedThinkingBlock {
	type: "redacted_thinking";
	data: string;
}

export interface ClaudeToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content?: string | Array<Record<string, unknown>>;
	is_error?: boolean;
}

export interface ClaudeServerToolUseBlock {
	type: "server_tool_use" | "mcp_tool_use";
	id: string;
	name: string;
	input?: Record<string, unknown>;
}

export interface ClaudeToolResultishBlock {
	type:
		| "web_search_tool_result"
		| "web_fetch_tool_result"
		| "code_execution_tool_result"
		| "mcp_tool_result"
		| "bash_code_execution_tool_result"
		| "text_editor_code_execution_tool_result"
		| "container_upload";
	[key: string]: unknown;
}

export type ClaudeContentBlock =
	| ClaudeTextBlock
	| ClaudeThinkingBlock
	| ClaudeRedactedThinkingBlock
	| ClaudeToolUseBlock
	| ClaudeToolResultBlock
	| ClaudeServerToolUseBlock
	| ClaudeToolResultishBlock;

/** Token accounting, as the CLI reports it. */
export interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	service_tier?: string;
	[key: string]: unknown;
}

export interface ClaudeMessage {
	id?: string;
	role?: "assistant" | "user" | string;
	model?: string;
	content?: ClaudeContentBlock[] | string;
	usage?: ClaudeUsage;
	stop_reason?: string | null;
}

interface ClaudeEventBase {
	session_id?: string;
	uuid?: string;
	parent_tool_use_id?: string | null;
	[key: string]: unknown;
}

/** `system`/`init` — the first real event; carries the CLI's session id. */
export interface ClaudeInitEvent extends ClaudeEventBase {
	type: "system";
	subtype: "init";
	model?: string;
	cwd?: string;
	tools?: string[];
	permissionMode?: string;
	agents?: string[];
	skills?: string[];
	claude_code_version?: string;
	capabilities?: string[];
}

/** Any other `system` subtype (`hook_started`, `hook_response`, `status`, …). */
export interface ClaudeSystemEvent extends ClaudeEventBase {
	type: "system";
	subtype: string;
	compact_metadata?: { trigger?: string; pre_tokens?: number };
}

export interface ClaudeAssistantEvent extends ClaudeEventBase {
	type: "assistant";
	message: ClaudeMessage;
	/** Set when the CLI itself flags a provider error on this message. */
	error?: string;
	is_api_error_message?: boolean;
	timestamp?: string;
}

export interface ClaudeUserEvent extends ClaudeEventBase {
	type: "user";
	message: ClaudeMessage;
	/** True for prompts the CLI re-emits for acknowledgement. */
	isReplay?: boolean;
	/** True for CLI-authored (not user-authored) user messages. */
	isSynthetic?: boolean;
	tool_use_result?: unknown;
}

/** One raw Anthropic SSE frame, when `--include-partial-messages` is on. */
export interface ClaudeStreamFrameEvent extends ClaudeEventBase {
	type: "stream_event";
	event: {
		type: string;
		index?: number;
		message?: ClaudeMessage;
		content_block?: ClaudeContentBlock;
		delta?: {
			type?: string;
			text?: string;
			thinking?: string;
			partial_json?: string;
			signature?: string;
			stop_reason?: string | null;
		};
		usage?: ClaudeUsage;
	};
}

/** Periodic progress for long-running tools (currently only `Bash`). */
export interface ClaudeToolProgressEvent extends ClaudeEventBase {
	type: "tool_progress";
	tool_use_id?: string;
	tool_name?: string;
	elapsed_time_seconds?: number;
}

/**
 * The terminal event of a turn. `subtype` is `success`, or one of
 * `error_max_turns` / `error_max_budget_usd` /
 * `error_max_structured_output_retries` / `error_during_execution`.
 */
export interface ClaudeResultEvent extends ClaudeEventBase {
	type: "result";
	subtype?: string;
	is_error?: boolean;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	/** Final assistant text, for a successful run. */
	result?: string;
	total_cost_usd?: number;
	usage?: ClaudeUsage;
	modelUsage?: Record<string, unknown>;
	permission_denials?: Array<{ tool_name?: string }>;
	/** Present only when the run was started with `--json-schema`. */
	structured_output?: unknown;
	errors?: string[];
	api_error_status?: unknown;
	[key: string]: unknown;
}

export type ClaudeStreamEvent =
	| ClaudeInitEvent
	| ClaudeSystemEvent
	| ClaudeAssistantEvent
	| ClaudeUserEvent
	| ClaudeStreamFrameEvent
	| ClaudeToolProgressEvent
	| ClaudeResultEvent
	| (ClaudeEventBase & { type: string });

/**
 * Parse one line of the CLI's stdout.
 *
 * Returns `undefined` for blank lines and for anything that is not JSON. The
 * latter is not defensive padding: the CLI writes non-JSON to stdout on some
 * failure paths, and a stray banner must not take down a run that is otherwise
 * producing perfectly good events.
 */
export function parseClaudeStreamLine(
	line: string,
): ClaudeStreamEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			return undefined;
		const event = parsed as ClaudeStreamEvent;
		return typeof (event as { type?: unknown }).type === "string"
			? event
			: undefined;
	} catch {
		return undefined;
	}
}

/** Narrowing helpers, so consumers do not repeat string comparisons inline. */
export function isResultEvent(
	event: ClaudeStreamEvent,
): event is ClaudeResultEvent {
	return event.type === "result";
}

export function isInitEvent(
	event: ClaudeStreamEvent,
): event is ClaudeInitEvent {
	return (
		event.type === "system" && (event as ClaudeSystemEvent).subtype === "init"
	);
}

export function isAssistantEvent(
	event: ClaudeStreamEvent,
): event is ClaudeAssistantEvent {
	return event.type === "assistant";
}

export function isUserEvent(
	event: ClaudeStreamEvent,
): event is ClaudeUserEvent {
	return event.type === "user";
}

export function isStreamFrameEvent(
	event: ClaudeStreamEvent,
): event is ClaudeStreamFrameEvent {
	return event.type === "stream_event";
}

/**
 * True when an event belongs to a nested Claude Code subagent rather than to the
 * agent we spawned. Its text and tool calls are still rendered — as indented
 * child rows — but must not be attributed to the parent's own turn.
 */
export function isNestedEvent(event: ClaudeStreamEvent): boolean {
	return (
		typeof event.parent_tool_use_id === "string" &&
		event.parent_tool_use_id.length > 0
	);
}
