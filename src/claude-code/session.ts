/**
 * claude-code/session.ts — the `AgentSession`-shaped façade a Claude Code run
 * presents to the rest of the extension.
 *
 * `RunResult.session` is typed as pi's `AgentSession`, and a surprising amount of
 * the extension reads it structurally rather than using pi APIs:
 *
 *   - the conversation viewer reads `session.messages` every frame, subscribes
 *     for repaints, and asks `sessionManager.getCwd()` for its working directory;
 *   - `output-file.ts` streams `session.messages` to the `.output` transcript on
 *     `turn_end`;
 *   - `agent-manager.ts` reads `session.model` and `session.thinkingLevel` to
 *     make the run record authoritative, and calls `session.steer()` /
 *     `session.abort()`;
 *   - `usage.ts` reads `getSessionStats()` for the widget's token count.
 *
 * None of that is Claude-Code-specific, so the cheapest honest integration is a
 * small object that answers exactly those reads — at which point the widget, the
 * viewer, the transcript and the usage accounting are the *same code* as for a pi
 * subagent, which is what "looks exactly like any other subagent" requires.
 *
 * What this deliberately does NOT implement is pi's agent loop: `prompt()`,
 * `agent`, `state`, `bindExtensions` and friends exist only on the pi path and
 * are never reached for a Claude Code run, because the runner branches away
 * before them. They are absent rather than stubbed so that a future caller
 * reaching one fails loudly instead of silently doing nothing.
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { TaggedMessage } from "./translate.js";

/**
 * Callbacks the runner installs so the façade can drive the live process.
 * Optional because a settled session has nothing left to steer or abort, and the
 * manager may hold a reference long after the process is gone.
 */
export interface ClaudeCodeSessionHooks {
	abort?: () => void;
	steer?: (message: string) => void;
}

/** Stats shape `usage.ts` reads (`SessionStatsLike`). */
export interface ClaudeSessionStats {
	tokens: { input: number; output: number; cacheWrite: number };
	contextUsage?: { percent: number | null };
}

/** Listener signature, matching pi's `session.subscribe` usage. */
type Listener = (event: unknown) => void;

/**
 * Live view of one Claude Code subagent run.
 *
 * `messages` is the translator's array by reference, so the translator appending
 * or mutating the streaming tail is visible to every reader without a copy step.
 */
export class ClaudeCodeSession {
	/** pi-shaped message transcript, owned by the translator. */
	readonly messages: TaggedMessage[];
	readonly model: Model<any>;
	/** Set from the `--effort` we passed, so the record shows the effective level. */
	thinkingLevel?: string;
	readonly sessionManager: {
		getCwd(): string;
		getSessionFile(): string | undefined;
		getSessionId(): string;
	};
	/** Claude Code's own session id, usable with `--resume`. */
	sessionId: string | undefined;
	/**
	 * The `--tools` value this conversation was created with, re-sent on a resume.
	 *
	 * `undefined` means the CLI's default tool set; an empty array is `--tools ""`,
	 * which disables every built-in tool. Kept on the session because a resume
	 * re-spawns the process, and a per-invocation flag that were not reapplied
	 * would widen a restricted agent back to the full set.
	 */
	readonly allowedTools?: string[];
	/** The `--disallowedTools` value this conversation was created with. */
	readonly disallowedTools?: string[];
	/**
	 * Whether this run was written to Claude Code's session store.
	 *
	 * Unlike a pi session — which resume reuses as a live object — a Claude Code
	 * resume spawns a NEW process that must load the conversation from disk. A run
	 * started with `--no-session-persistence` therefore cannot be continued at all,
	 * so the flag has to be remembered to report that plainly instead of surfacing
	 * the CLI's "No conversation found with session ID".
	 */
	persisted: boolean;

	private readonly listeners = new Set<Listener>();
	private hooks: ClaudeCodeSessionHooks;
	private closed = false;
	/**
	 * Steers that arrived before the run had a process to send them to.
	 *
	 * The manager publishes the session (`onSessionCreated`) and flushes its own
	 * queued steers BEFORE the driver installs its hooks, so a steer sent while the
	 * agent was queued — or in that first instant — would otherwise be accepted and
	 * silently dropped. They are held here and flushed once the initial prompt has
	 * gone out, so the CLI sees them after the prompt rather than before it.
	 */
	private readonly pendingSteers: string[] = [];

	constructor(args: {
		messages: TaggedMessage[];
		model: Model<any>;
		cwd: string;
		sessionFile?: string;
		sessionId?: string;
		thinkingLevel?: string;
		persisted?: boolean;
		hooks?: ClaudeCodeSessionHooks;
		allowedTools?: string[];
		disallowedTools?: string[];
	}) {
		this.messages = args.messages;
		this.model = args.model;
		this.thinkingLevel = args.thinkingLevel;
		this.sessionId = args.sessionId;
		this.persisted = args.persisted ?? false;
		this.allowedTools = args.allowedTools;
		this.disallowedTools = args.disallowedTools;
		this.hooks = args.hooks ?? {};
		const cwd = args.cwd;
		const sessionFile = args.sessionFile;
		const sessionId = args.sessionId;
		this.sessionManager = {
			getCwd: () => cwd,
			// `Record.sessionFile` gates the `@agent-<name>` resume path, which
			// checks `existsSync` before reopening. Returning the sidecar we actually
			// write keeps that path working; absent it, the agent is simply not
			// resumable across sessions, which is the same as an in-memory pi session.
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId ?? "",
		};
	}

	/** Install/replace the process hooks (the runner owns these). */
	setHooks(hooks: ClaudeCodeSessionHooks): void {
		this.hooks = { ...this.hooks, ...hooks };
	}

	/**
	 * Send steers that were buffered while the run was starting.
	 *
	 * Called by the driver immediately AFTER the initial prompt is written: a
	 * steer is a message in the conversation, so delivering it first would put it
	 * ahead of the prompt it steers.
	 */
	flushPendingSteers(): void {
		if (!this.hooks.steer || this.pendingSteers.length === 0) return;
		for (const message of this.pendingSteers.splice(0)) this.hooks.steer(message);
	}

	/**
	 * Re-open a closed session for a continuation run.
	 *
	 * `close()` stops event delivery at the end of a run; a resume reuses the same
	 * session object — the transcript is one continuous conversation — so delivery
	 * has to start again or the resumed turns never reach the viewer, the widget or
	 * the `.output` transcript.
	 */
	reopen(): void {
		this.closed = false;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Notify subscribers. The event payload is intentionally minimal: every
	 * consumer on this path either ignores it (the viewer repaints on any event)
	 * or narrows on `type` (`output-file` needs `turn_end`).
	 */
	emit(event: { type: string } & Record<string, unknown>): void {
		if (this.closed && event.type !== "turn_end") return;
		for (const listener of [...this.listeners]) {
			try {
				listener(event);
			} catch {
				// A subscriber throwing must not abort the run's event pump.
			}
		}
	}

	/** Stop delivering events and forget listeners, at the end of a run. */
	close(): void {
		this.closed = true;
		this.listeners.clear();
		this.hooks = {};
	}

	/**
	 * pi renderers for a tool name. Always `undefined`: pi's own built-in
	 * definitions already cover every name `tools.ts` maps to (read, write, edit,
	 * bash, grep, find, ls), and the viewer falls back to them whenever this
	 * returns nothing. Returning a hand-built definition would be a second,
	 * drifting copy of renderers pi already owns.
	 */
	getToolDefinition(_name: string): undefined {
		return undefined;
	}

	/**
	 * Token totals for the widget/viewer.
	 *
	 * `contextUsage.percent` is always null. Claude Code reports tokens but not a
	 * context-window utilisation, and the synthetic model carries no
	 * `contextWindow` to divide by — inventing a percentage from a guessed window
	 * would put a confident wrong number in front of the user. Null renders as
	 * "unavailable", which is true.
	 *
	 * Token counts SUM the transcript's assistant messages, so they survive
	 * exactly as long as the messages do and agree with what the viewer shows.
	 */
	getSessionStats(): ClaudeSessionStats {
		let input = 0;
		let output = 0;
		let cacheWrite = 0;
		for (const msg of this.messages) {
			if ((msg as { role?: string }).role !== "assistant") continue;
			const usage = (msg as unknown as AssistantMessage).usage;
			if (!usage) continue;
			input += usage.input ?? 0;
			output += usage.output ?? 0;
			cacheWrite += usage.cacheWrite ?? 0;
		}
		return {
			tokens: { input, output, cacheWrite },
			contextUsage: { percent: null },
		};
	}

	/** Steer the live process; buffered while the run is still starting. */
	async steer(message: string): Promise<void> {
		if (!this.hooks.steer) {
			// Nothing to send to yet. The manager has already reported this steer as
			// accepted, so dropping it here would lose it silently.
			if (!this.closed) this.pendingSteers.push(message);
			return;
		}
		this.hooks.steer(message);
	}

	/** Interrupt the live process; a no-op once it has settled. */
	abort(): void {
		this.hooks.abort?.();
	}
}

/**
 * Structural test for "is this the Claude Code façade", used by the runner and
 * by `resumeAgent`/`steerAgent`/`getAgentConversation` to branch without an
 * `instanceof` that a clone or a proxy could defeat.
 */
export function isClaudeCodeSession(
	session: unknown,
): session is ClaudeCodeSession {
	return session instanceof ClaudeCodeSession;
}
