/**
 * claude-code/runner.ts — execute a subagent through the `claude` CLI.
 *
 * The counterpart to `runAgent`'s pi path. Where that builds a pi session and
 * calls `session.prompt()`, this spawns `claude --print` and translates its
 * `stream-json` output into the same pi messages, the same `RunOptions`
 * callbacks and the same `RunResult` — so the manager, widget, viewer,
 * transcript and usage accounting downstream are literally the same code.
 *
 * Transport choice: `--input-format stream-json` (not a prompt in argv) even
 * though it costs a stdin write, because it is the only transport that supports
 * the two mid-run controls this extension already exposes. Steering is a `user`
 * message on stdin; interrupting is a `control_request` of subtype `interrupt`.
 * Spawning with the prompt in argv would make both impossible and silently
 * degrade `steer_subagent` and the viewer's stop key on claude-backed agents.
 *
 * Completion: the run ends on the FIRST `result` event.
 *
 * Established by probing the real CLI rather than from the docs. A mid-run steer
 * sent while a tool call was in flight is injected into the ONGOING turn loop —
 * it does NOT produce a second `result`, and the single result that eventually
 * arrives already reflects the steer. (A steer arriving after the loop finished
 * would start a fresh query and emit another result, but by then this backend has
 * ended the run, exactly as `session.prompt()` resolves once for a pi session.)
 * So counting prompts against results, as an earlier version of this file did,
 * hangs forever on a genuine mid-run steer: two prompts are written, one result
 * ever comes back.
 *
 * The `result` event is therefore both the outcome and the completion signal.
 * Closing stdin is what lets the CLI exit — it stays alive waiting for further
 * input otherwise — and a watchdog covers the case where it does not.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunOptions, RunResult } from "../agent-runner.js";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getToolNamesForType,
} from "../agent-types.js";
import { runInChildSessionContext } from "../child-context.js";
import { buildParentContext } from "../context.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { detectEnv } from "../env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory.js";
import { buildAgentPrompt, type PromptExtras } from "../prompts.js";
import { preloadSkills } from "../skill-loader.js";
import type { SubagentType } from "../types.js";
import { effortForThinkingLevel } from "./model.js";
import {
	type ClaudeResultEvent,
	isInitEvent,
	isResultEvent,
	parseClaudeStreamLine,
} from "./protocol.js";
import { ClaudeCodeSession } from "./session.js";
import { claudeToolDenyList, claudeToolPolicyFor, isClaudeToolName } from "./tools.js";
import { ClaudeMessageTranslator, type TranslatedUsage } from "./translate.js";

/**
 * Values the pi runner already resolved, handed over rather than re-derived.
 *
 * `agent-runner.ts` owns the turn-limit and persistence settings (they live in
 * that module's state), and the runner is imported *by* it — so reading them
 * here would be a runtime import cycle. Passing them keeps the dependency
 * one-directional.
 */
export interface ClaudeRunnerContext {
	/** Effective turn cap, or undefined for unlimited. */
	maxTurns?: number;
	/** Turns of grace after the soft limit, from the `graceTurns` setting. */
	graceTurns: number;
	/** Whether to persist a resumable sidecar for this run. */
	persistSession: boolean;
	/** Directory for that sidecar, when persisting. */
	sessionDir?: string;
	/** Existing sidecar to resume from (the `@agent-<name>` / reopen path). */
	resumeSessionFile?: string;
}

/** Outcome of driving one `claude` process to completion. */
interface DriveOutcome {
	aborted: boolean;
	steered: boolean;
	failure?: string;
	responseText: string;
	structuredJson?: string;
	exitCode: number | null;
}

/** Overridable for tests and for a non-PATH install. */
export function claudeBinary(): string {
	return process.env.PI_SUBAGENTS_CLAUDE_BIN?.trim() || "claude";
}

/**
 * Build the CLI argument vector.
 *
 * `--verbose` is not optional: `--print` with `--output-format stream-json`
 * exits with an argument error without it. `--dangerously-skip-permissions`
 * implements the documented decision that a Claude Code subagent runs with the
 * same autonomy as a pi subagent — in `-p` mode there is no human to answer a
 * permission prompt, so the alternative is not "safer", it is "the agent stalls".
 */
export function buildClaudeArgs(args: {
	modelSpec: string;
	thinkingLevel?: string;
	systemPrompt?: string;
	appendSystemPrompt?: boolean;
	cwd?: string;
	configCwd?: string;
	jsonSchema?: string;
	resumeSessionId?: string;
	/**
	 * The conversation id this run is created under, when the caller already
	 * knows it. Pinning it makes the conversation identifiable BEFORE the first
	 * hook fires, which is what lets a host that launched us attribute our
	 * session to the run from its very first event. Ignored on a resume: the CLI
	 * rejects `--session-id` alongside `--resume`.
	 */
	sessionId?: string;
	persistSession: boolean;
	/**
	 * The agent's pi built-in allowlist, already translated to Claude Code tool
	 * names. `undefined` leaves the CLI's default tool set alone; an EMPTY array
	 * means "no built-in tools", which the CLI spells `--tools ""`.
	 */
	tools?: string[];
	/** The agent's `disallowed_tools`, translated to Claude Code tool names. */
	disallowedTools?: string[];
}): string[] {
	const argv = [
		"--print",
		"--verbose",
		"--output-format",
		"stream-json",
		"--include-partial-messages",
		"--input-format",
		"stream-json",
		"--forward-subagent-text",
		"--dangerously-skip-permissions",
		"--model",
		args.modelSpec,
	];
	const effort = effortForThinkingLevel(args.thinkingLevel);
	if (effort) argv.push("--effort", effort);
	// Honouring `tools:`/`disallowed_tools:` is what keeps a read-only agent
	// read-only here: permissions are bypassed wholesale, so the only thing that
	// can withhold Write/Edit from such an agent is the CLI's own tool list. Only
	// an explicit `tools:` is translated — an agent that declared none keeps the
	// CLI's default set rather than being narrowed to pi's built-ins.
	if (args.tools !== undefined) argv.push("--tools", args.tools.join(","));
	if (args.disallowedTools?.length)
		argv.push("--disallowedTools", args.disallowedTools.join(","));
	// A resume continues an existing conversation, whose system prompt was fixed
	// when that session was created; re-sending one would either be ignored or
	// silently fork the conversation's instructions.
	if (args.systemPrompt && !args.resumeSessionId) {
		if (args.appendSystemPrompt)
			argv.push("--append-system-prompt", args.systemPrompt);
		else argv.push("--system-prompt", args.systemPrompt);
	}
	if (args.jsonSchema) argv.push("--json-schema", args.jsonSchema);
	if (args.resumeSessionId) {
		argv.push("--resume", args.resumeSessionId);
	} else {
		if (args.sessionId) argv.push("--session-id", args.sessionId);
		if (args.configCwd && args.cwd && args.configCwd !== args.cwd) {
			// Only when the two actually differ — a worktree copy or a redirected
			// working directory — so the child can still reach the project config.
			argv.push("--add-dir", args.configCwd);
		}
	}
	// Keeps an ephemeral child from leaving resumable Claude Code sessions behind.
	if (!args.persistSession && !args.resumeSessionId)
		argv.push("--no-session-persistence");
	return argv;
}

/** Build the initial prompt / steer message the CLI reads from stdin. */
function stdinUserMessage(content: string): string {
	return `${JSON.stringify({
		type: "user",
		session_id: "",
		message: { role: "user", content },
		parent_tool_use_id: null,
		uuid: randomUUID(),
	})}\n`;
}

/** Interrupt request the CLI answers with a `control_response`. */
function stdinInterrupt(): string {
	return `${JSON.stringify({
		type: "control_request",
		request_id: randomUUID(),
		request: { subtype: "interrupt" },
	})}\n`;
}

/**
 * The resumable sidecar for a Claude Code run.
 *
 * Deliberately NOT a pi session file: it records the one thing needed to
 * continue this conversation, which is Claude Code's own session id. It exists
 * so `Record.sessionFile` is populated, because that field is what the
 * `@agent-<name>` reopen path tests with `existsSync` before trying to resume.
 */
interface ClaudeSessionSidecar {
	type: "pi-subagents:claude-code-session";
	claudeSessionId: string;
	model: string;
	cwd: string;
}

/**
 * How much of a candidate file to inspect.
 *
 * Bounded on purpose: `readSidecar` also runs on the PI path (a resume has to
 * ask which backend owns the file it was handed), where the path is usually a
 * pi session transcript that can be many megabytes. A sidecar is one small JSON
 * object, so the first 64 KB settle it either way.
 */
const SIDECAR_PROBE_BYTES = 64 * 1024;

/** Read at most `SIDECAR_PROBE_BYTES` from the start of a file. */
function readPrefix(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(SIDECAR_PROBE_BYTES);
		const read = readSync(fd, buffer, 0, SIDECAR_PROBE_BYTES, 0);
		return buffer.subarray(0, read).toString("utf-8");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* already closed */
			}
		}
	}
}

/** True when `path` is a sidecar this module wrote (or could have written). */
export function isClaudeSidecar(path: string | undefined): boolean {
	return Boolean(path && readSidecar(path));
}

/**
 * Read a Claude Code sidecar.
 *
 * Exported because `agent-runner` has to know which backend owns a resume before
 * it picks one: the `@agent-<name>` reopen path re-resolves a model from the
 * agent's current defaults rather than remembering the backend the original run
 * used, so the FILE is the only authority on that.
 */
export function readSidecar(path: string): ClaudeSessionSidecar | undefined {
	try {
		const prefix = readPrefix(path);
		if (prefix === undefined) return undefined;
		const parsed = JSON.parse(prefix) as ClaudeSessionSidecar;
		if (parsed?.type !== "pi-subagents:claude-code-session") return undefined;
		return typeof parsed.claudeSessionId === "string" && parsed.claudeSessionId
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

function writeSidecar(path: string, data: ClaudeSessionSidecar): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(data), "utf-8");
	} catch {
		// A run that cannot persist is still a successful run; it just is not
		// resumable, which is the same position an in-memory pi session is in.
	}
}

/**
 * Spawn a `claude` process, wire it to the session façade, and resolve once it
 * has fully exited and its streams have closed.
 *
 * `close` rather than `exit` on purpose: `exit` can fire with stdout still
 * buffered, which would truncate the tail of a transcript — including the
 * `result` event that carries the run's usage and cost.
 */
async function driveClaudeProcess(opts: {
	args: string[];
	cwd: string;
	initialPrompt: string;
	translator: ClaudeMessageTranslator;
	session: ClaudeCodeSession;
	signal?: AbortSignal;
	maxTurns?: number;
	graceTurns: number;
	/** Forwarded to `RunOptions.onCompaction` for `compact_boundary` events. */
	onCompaction?: (info: {
		reason: "manual" | "threshold" | "overflow";
		tokensBefore: number;
	}) => void;
	/**
	 * Installed before the process starts so the translator's `turn_end` can be
	 * routed into the cap enforcement below. The translator is built by the caller
	 * (it owns the message array the session façade exposes), so the handler has to
	 * be handed across rather than closed over.
	 */
	bindTurnLimit?: (handler: (turns: number) => void) => void;
}): Promise<DriveOutcome> {
	const { translator, session } = opts;
	let aborted = false;
	let steered = false;
	let failure: string | undefined;
	let structuredJson: string | undefined;
	let runResultText = "";
	let processClosed = false;
	/** True once the run's `result` has landed and stdin has been closed. */
	let finalized = false;
	/** True once a `result` event has been handled, whatever the process does next. */
	let resultSeen = false;
	let softLimitReached = false;

	const child = await runInChildSessionContext(
		async () =>
			spawn(claudeBinary(), opts.args, {
				cwd: opts.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			}) as ChildProcessWithoutNullStreams,
	);

	const done = new Promise<void>((resolve) => {
		child.on("close", () => {
			processClosed = true;
			resolve();
		});
		// A spawn failure (ENOENT) emits "error"; on some Node versions "close"
		// never follows, so resolving on both keeps the run from hanging forever.
		child.on("error", () => {
			processClosed = true;
			resolve();
		});
	});

	// A write to stdin that loses the race with the child exiting fails
	// ASYNCHRONOUSLY, as an "error" event — no try/catch around the write can see
	// it, and an unhandled EPIPE takes the whole pi process down. The exit path
	// below reports the outcome, so the error itself is only ever swallowed.
	child.stdin.on("error", () => undefined);

	function send(payload: string): void {
		try {
			if (!processClosed && child.stdin.writable) child.stdin.write(payload);
		} catch {
			// A closed stdin means the CLI is already gone; the exit path reports it.
		}
	}

	function interrupt(): void {
		send(stdinInterrupt());
		// Belt and braces: the control request is the graceful path, but a CLI too
		// old to honour it (or one wedged in a tool call) would otherwise ignore the
		// stop entirely and leave the record "running" forever.
		setTimeout(() => {
			if (!processClosed) {
				try {
					child.kill("SIGTERM");
				} catch {
					/* already gone */
				}
			}
		}, 2000).unref?.();
	}

	/** Soft/hard turn cap, mirroring the pi path's grace-turn behaviour. */
	function enforceTurnLimit(turns: number): void {
		const maxTurns = opts.maxTurns;
		if (maxTurns == null) return;
		// The cap is meaningless once the conversation is over. Turns finalize
		// lazily, so the turn that ENDS the run can finalize inside `handleResult` —
		// a wrap-up steer written after that would start a fresh, paid query on a
		// run that has already reported its result.
		if (resultSeen || finalized) return;
		if (!softLimitReached && turns >= maxTurns) {
			softLimitReached = true;
			steered = true;
			send(
				stdinUserMessage(
					"You have reached your turn limit. Wrap up immediately — provide your final answer now.",
				),
			);
		} else if (softLimitReached && turns >= maxTurns + opts.graceTurns) {
			aborted = true;
			interrupt();
		}
	}

	// The caller owns the translator, so the cap handler has to be published to it.
	opts.bindTurnLimit?.(enforceTurnLimit);

	session.setHooks({
		abort: () => {
			aborted = true;
			interrupt();
		},
		steer: (message) => {
			// A steer is only meaningful while the turn loop is still running. Once the
			// result has landed the conversation is over, and half-accepting the message
			// would leave it in the transcript with no turn ever answering it.
			if (finalized || processClosed) return;
			// The CLI does not echo our own input back — `--replay-user-messages` is
			// not passed — so the transcript entry has to be written here. Without it a
			// steered turn would appear in the viewer as work nobody asked for.
			// The translator files it after any tool call already in flight, so the
			// transcript reads call → result → steer, as it does on the pi path.
			translator.recordSteer(message);
			session.emit({ type: "message_update" });
			send(stdinUserMessage(message));
		},
	});

	// Forward an external abort signal (the manager's /agents stop, or the
	// parent's Esc) into the same interrupt path.
	const onAbortSignal = () => {
		aborted = true;
		interrupt();
	};
	if (opts.signal) {
		if (opts.signal.aborted) onAbortSignal();
		else opts.signal.addEventListener("abort", onAbortSignal, { once: true });
	}

	/** Apply a `result` event: the run's authoritative outcome and spend. */
	function handleResult(event: ClaudeResultEvent): void {
		// FIRST, before anything below can finalize a turn: the turn cap is
		// enforced from `onTurnEnd`, and a run that ends exactly on `max_turns`
		// finalizes its last turn inside `translator.finish()`. Without this flag
		// already set, the cap would write a wrap-up steer to a conversation that
		// had just ended — which the CLI answers as a NEW, paid query.
		resultSeen = true;
		if (typeof event.result === "string" && event.result.trim())
			runResultText = event.result;
		if (event.structured_output !== undefined) {
			try {
				structuredJson = JSON.stringify(event.structured_output);
			} catch {
				structuredJson = undefined;
			}
		}
		if (event.is_error) {
			const detail = event.errors?.filter(Boolean).join("; ");
			failure =
				detail ||
				runResultText.trim() ||
				event.subtype ||
				"Claude Code reported an error";
		} else if (event.subtype && event.subtype !== "success") {
			failure = `Claude Code ended the run: ${event.subtype}`;
		}
		// Close the final turn BEFORE reporting run-level cost, so the cost delta is
		// the last usage a listener sees and reads as the run's total.
		translator.finish();
		translator.applyRunCost(
			typeof event.total_cost_usd === "number"
				? event.total_cost_usd
				: undefined,
		);
		// Done with usage accounting; decide whether the conversation is over.
		// (`resultSeen` was set on entry — see the note there.)

		// The result ends the run (see the completion note at the top of this file),
		// so close stdin to let the CLI exit. The watchdog is a backstop, not a
		// normal path: closing stdin normally ends the process promptly, but a wedged
		// CLI must not leave the subagent "running" forever.
		if (!finalized && !processClosed) {
			finalized = true;
			try {
				child.stdin.end();
			} catch {
				/* already closed */
			}
			setTimeout(() => {
				if (!processClosed) {
					try {
						child.kill("SIGTERM");
					} catch {
						/* already gone */
					}
				}
			}, 10_000).unref?.();
		}
	}

	child.stdout.setEncoding("utf-8");
	let buffer = "";
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			const event = parseClaudeStreamLine(line);
			if (!event) continue;
			if (isInitEvent(event)) {
				if (event.session_id) session.sessionId = event.session_id;
				continue;
			}
			if (isResultEvent(event)) {
				handleResult(event);
				session.emit({ type: "result" });
				continue;
			}
			// Claude Code compacts a long conversation on its own; surfacing it keeps
			// the widget's compaction count honest, and warns a reader that the model's
			// context was summarised even though this transcript keeps growing.
			if (
				event.type === "system" &&
				(event as { subtype?: string }).subtype === "compact_boundary"
			) {
				const meta = (
					event as {
						compact_metadata?: { trigger?: string; pre_tokens?: number };
					}
				).compact_metadata;
				opts.onCompaction?.({
					reason: /manual/i.test(meta?.trigger ?? "") ? "manual" : "threshold",
					tokensBefore:
						typeof meta?.pre_tokens === "number" ? meta.pre_tokens : 0,
				});
				continue;
			}
			if (translator.handle(event)) session.emit({ type: "message_update" });
		}
		// A trailing line with no newline is incomplete JSON; it is picked up when
		// the rest arrives, or dropped at exit.
	});

	let stderr = "";
	child.stderr.setEncoding("utf-8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("error", (err) => {
		failure ??= `Could not run the claude CLI (${claudeBinary()}): ${err.message}`;
	});

	// Kick off the run. A steer that arrived while the agent was still starting has
	// been held by the session; it goes out now, after the prompt it steers.
	send(stdinUserMessage(opts.initialPrompt));
	session.flushPendingSteers();

	await done;

	if (opts.signal) opts.signal.removeEventListener("abort", onAbortSignal);
	translator.finish();

	// Only a run with no result to report is judged by its exit code. A run whose
	// result already landed has succeeded whatever the process did afterwards —
	// including the watchdog's SIGTERM, which leaves `exitCode` null.
	if (!failure && !resultSeen && child.exitCode !== 0 && !aborted) {
		const detail = stderr.trim().split("\n").slice(-3).join(" ").trim();
		failure = detail || `claude CLI exited with code ${child.exitCode}`;
	}

	return {
		aborted,
		steered,
		failure,
		responseText: runResultText.trim() || translator.responseText(),
		structuredJson,
		exitCode: child.exitCode,
	};
}

export async function runClaudeCodeAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
	runnerCtx: ClaudeRunnerContext,
): Promise<RunResult> {
	const agentConfig = getAgentConfig(type);
	const effectiveCwd = options.cwd ?? ctx.cwd;
	const configCwd = options.configCwd ?? effectiveCwd;
	const model = options.model;
	if (!model) throw new Error("runClaudeCodeAgent requires a resolved model");

	const env = await detectEnv(options.pi, effectiveCwd);
	const parentSystemPrompt = ctx.getSystemPrompt();

	const extras: PromptExtras = {};
	if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;

	// Same skill preloading the pi path does, so `skills:` means the same thing.
	const skills = options.isolated ? false : agentConfig?.skills;
	if (Array.isArray(skills)) {
		const loaded = preloadSkills(skills, configCwd);
		if (loaded.length > 0) extras.skillBlocks = loaded;
	}

	// Memory, with the same write-capability branch the pi path takes. The tool
	// names only shape the prompt here — Claude Code owns the actual tool set —
	// but a read-only memory scope must still produce the read-only prompt.
	if (agentConfig?.memory) {
		const existing = new Set(getToolNamesForType(type));
		const denied = agentConfig.disallowedTools
			? new Set(agentConfig.disallowedTools)
			: undefined;
		const effectivelyHas = (name: string) =>
			existing.has(name) && !denied?.has(name);
		if (effectivelyHas("write") || effectivelyHas("edit")) {
			extras.memoryBlock = buildMemoryBlock(
				agentConfig.name,
				agentConfig.memory,
				configCwd,
			);
		} else {
			extras.memoryBlock = buildReadOnlyMemoryBlock(
				agentConfig.name,
				agentConfig.memory,
				configCwd,
			);
		}
	}

	let systemPrompt: string;
	if (agentConfig) {
		systemPrompt = buildAgentPrompt(
			agentConfig,
			effectiveCwd,
			env,
			parentSystemPrompt,
			extras,
		);
	} else {
		const fallback = DEFAULT_AGENTS.get("general-purpose");
		if (!fallback)
			throw new Error(
				`No fallback config available for unknown type "${type}"`,
			);
		systemPrompt = buildAgentPrompt(
			{ ...fallback, name: type },
			effectiveCwd,
			env,
			parentSystemPrompt,
			extras,
		);
	}

	// Report the same frontmatter mistakes the pi path reports, so a typo'd
	// `tools:` entry is no quieter just because the backend differs. A name counts
	// as known if pi knows it OR the Claude Code CLI does: one written in Claude's
	// own vocabulary (`WebFetch`, `TodoWrite`) is translated rather than reported as
	// unknown, and only a name neither side recognizes warns.
	if (agentConfig?.builtinToolNames?.length) {
		for (const name of agentConfig.builtinToolNames) {
			if (!BUILTIN_TOOL_NAMES.includes(name) && !isClaudeToolName(name)) {
				options.onToolActivity?.({
					type: "end",
					toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
				});
			}
		}
	}

	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

	const resumeSidecar = runnerCtx.resumeSessionFile
		? readSidecar(runnerCtx.resumeSessionFile)
		: undefined;

	// Sidecar path for THIS run. Reused when resuming so a continuation overwrites
	// the record in place rather than accumulating one file per resume. Only a
	// file that parsed as a sidecar is reused: overwriting a path we could not
	// read — a pi session file, say — would destroy a conversation.
	const sidecarPath = runnerCtx.persistSession
		? (resumeSidecar
			? runnerCtx.resumeSessionFile
			: runnerCtx.sessionDir
				? join(runnerCtx.sessionDir, `claude-code-${randomUUID()}.json`)
				: undefined)
		: undefined;

	/**
	 * Set by the driver, which owns the turn-cap behaviour. Routed through a
	 * mutable binding because the translator needs it at construction but the
	 * driver only exists once the arguments are built.
	 */
	let turnLimitHandler: ((turns: number) => void) | undefined;

	const translator = new ClaudeMessageTranslator(model, {
		onTextDelta: options.onTextDelta,
		onToolActivity: options.onToolActivity,
		onAssistantUsage: options.onAssistantUsage,
		onTurnEnd: (turns) => {
			options.onTurnEnd?.(turns);
			// One pi event per completed turn, exactly as the pi path emits it.
			// `output-file.ts` flushes the `.output` transcript on this event, so
			// omitting it would hold the whole transcript back until the run ended.
			// The turn is complete at this point (finalization runs before the next
			// message is appended), so a flush here cannot write a half-streamed one.
			session.emit({ type: "turn_end" });
			turnLimitHandler?.(turns);
		},
	});

	// Tool policy, translated once so the session can remember it: a resumed
	// conversation re-spawns the CLI, and a per-invocation `--tools` that were not
	// reapplied would silently widen a restricted agent back to the full set.
	const allowedTools = claudeToolPolicyFor(agentConfig?.builtinToolNames);
	const disallowedTools = agentConfig?.disallowedTools
		? claudeToolDenyList(agentConfig.disallowedTools)
		: undefined;

	const session = new ClaudeCodeSession({
		messages: translator.messages,
		model,
		cwd: effectiveCwd,
		sessionFile: sidecarPath,
		thinkingLevel,
		allowedTools,
		disallowedTools,
		// Pinned here rather than discovered from the CLI's first event: a host
		// watching this run's hooks needs the conversation identified before the
		// first of them lands, and a resume keeps the id its conversation already has.
		sessionId: resumeSidecar?.claudeSessionId ?? randomUUID(),
		// Having a sidecar path IS being resumable: the sidecar is the record this
		// extension needs to reopen the conversation later.
		persisted: Boolean(sidecarPath),
	});

	// The prompt is the transcript's first entry, exactly as it is for a pi
	// session — `output-file.ts` starts writing at index 1 on that assumption.
	let effectivePrompt = prompt;
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx);
		if (parentContext) effectivePrompt = parentContext + prompt;
	}
	translator.messages.push({
		role: "user",
		content: effectivePrompt,
		timestamp: Date.now(),
	} as never);

	const args = buildClaudeArgs({
		modelSpec: model.id,
		thinkingLevel,
		systemPrompt,
		appendSystemPrompt: agentConfig?.promptMode === "append",
		cwd: effectiveCwd,
		configCwd,
		jsonSchema: options.structuredOutput
			? JSON.stringify(options.structuredOutput.schema)
			: undefined,
		resumeSessionId: resumeSidecar?.claudeSessionId,
		sessionId: session.sessionId,
		// The user asked for persistence, not the sidecar's presence: a run that
		// cannot be recorded here should still behave as configured rather than
		// quietly turning into an ephemeral one.
		persistSession: runnerCtx.persistSession,
		tools: allowedTools,
		disallowedTools,
	});

	// Publish the session before driving the process: the manager wires steering,
	// abort and output streaming off `onSessionCreated`, and a steer arriving
	// during the first turn has to land on a live session.
	options.onSessionCreated?.(session as unknown as RunResult["session"]);

	const outcome = await driveClaudeProcess({
		args,
		cwd: effectiveCwd,
		initialPrompt: effectivePrompt,
		translator,
		session,
		signal: options.signal,
		maxTurns: runnerCtx.maxTurns,
		graceTurns: runnerCtx.graceTurns,
		onCompaction: options.onCompaction,
		bindTurnLimit: (handler) => {
			turnLimitHandler = handler;
		},
	});

	// Persist the sidecar once the run has a session id, so a later resume can
	// reach it. Written after the fact because the id only exists mid-run.
	if (sidecarPath && session.sessionId && !outcome.aborted) {
		writeSidecar(sidecarPath, {
			type: "pi-subagents:claude-code-session",
			claudeSessionId: session.sessionId,
			model: model.id,
			cwd: effectiveCwd,
		});
	}

	session.close();

	return {
		responseText: outcome.responseText,
		session: session as unknown as RunResult["session"],
		aborted: outcome.aborted,
		steered: outcome.steered,
		failure: outcome.failure,
		...(outcome.structuredJson !== undefined
			? { structuredJson: outcome.structuredJson }
			: {}),
	};
}

/**
 * Continue an existing Claude Code conversation.
 *
 * Reuses the session's own message array so the transcript stays one continuous
 * conversation, and resumes by Claude Code session id rather than by replaying
 * history — the CLI holds the real context, including anything it compacted.
 */
export async function resumeClaudeCodeAgent(
	session: ClaudeCodeSession,
	prompt: string,
	options: {
		onToolActivity?: (activity: {
			type: "start" | "end";
			toolName: string;
		}) => void;
		onAssistantUsage?: (usage: TranslatedUsage) => void;
		signal?: AbortSignal;
	} = {},
): Promise<{ text: string; failure?: string }> {
	if (!session.sessionId) {
		return {
			text: "",
			failure: "This Claude Code session has no session id to resume.",
		};
	}
	// A resume spawns a new process that must load the conversation from Claude
	// Code's own store, so a run started with `--no-session-persistence` can never
	// be continued. Say that, rather than relaying "No conversation found".
	if (!session.persisted) {
		return {
			text: "",
			failure:
				"This Claude Code session was not persisted to disk, so it cannot be resumed.",
		};
	}

	// A resumed run re-spawns the process but reuses the SESSION, so event delivery
	// has to be turned back on and the CLI arguments rebuilt from what this
	// conversation was created with.
	session.reopen();

	// `options.onAssistantUsage` is shaped like the translator's callback; the
	// extra `cacheRead`/`cost` fields the runner's own usage type carries are
	// already optional.
	const translator = new ClaudeMessageTranslator(
		session.model,
		{
			onToolActivity: options.onToolActivity,
			onAssistantUsage: options.onAssistantUsage,
			// Same event the spawn path emits, for the same reason: without it the
			// continuation's `.output` transcript is not streamed until the run ends.
			onTurnEnd: () => session.emit({ type: "turn_end" }),
		},
		session.messages,
	);
	translator.messages.push({
		role: "user",
		content: prompt,
		timestamp: Date.now(),
	} as never);

	const args = buildClaudeArgs({
		modelSpec: session.model.id,
		thinkingLevel: session.thinkingLevel,
		// No system prompt and no --json-schema: a resumed conversation keeps the
		// instructions it was created with, and a schema is a property of the
		// original request rather than of the continuation.
		persistSession: true,
		resumeSessionId: session.sessionId,
		// Carried over rather than dropped: these are per-invocation flags, so a
		// continuation that omitted them would undo the agent's declared tool set.
		tools: session.allowedTools,
		disallowedTools: session.disallowedTools,
	});

	try {
		const outcome = await driveClaudeProcess({
			args,
			cwd: session.sessionManager.getCwd(),
			initialPrompt: prompt,
			translator,
			session,
			signal: options.signal,
			maxTurns: undefined,
			graceTurns: 0,
		});

		return { text: outcome.responseText, failure: outcome.failure };
	} finally {
		// Back to settled, as `runClaudeCodeAgent` leaves it, so the next resume
		// re-opens explicitly rather than relying on a stale flag.
		session.close();
	}
}
