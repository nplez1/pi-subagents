/**
 * claude-code.live.test.ts — the runner against a REAL `claude` CLI.
 *
 * Skipped by default. It needs an authenticated Claude Code install, which a
 * normal test run cannot assume, and it spends the account's quota. Run it
 * deliberately after touching the process boundary:
 *
 *     PI_SUBAGENTS_CLAUDE_LIVE=1 npx vitest run src/claude-code/claude-code.live.test.ts
 *
 * What the faked test cannot prove is that the assumptions this backend makes
 * about the CLI are still true: that `stream-json` requires `--verbose`, that
 * the stdin control channel accepts a user message and an interrupt, and that
 * `--json-schema` actually surfaces `structured_output` on the result. That is
 * exactly what this file checks.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunOptions } from "../agent-runner.js";
import { createClaudeCodeModel } from "./model.js";
import { resumeClaudeCodeAgent, runClaudeCodeAgent } from "./runner.js";
import type { ClaudeCodeSession } from "./session.js";

const live = process.env.PI_SUBAGENTS_CLAUDE_LIVE === "1";

let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "claude-live-"));
	writeFileSync(
		join(workDir, "secret.txt"),
		"The magic word is FLAMINGO.\n",
		"utf-8",
	);
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

function makeCtx(): ExtensionContext {
	return {
		cwd: workDir,
		getSystemPrompt: () => "You are a terse test agent.",
		modelRegistry: {},
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "sess",
		},
	} as unknown as ExtensionContext;
}

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
	return {
		pi: {
			exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		} as unknown as ExtensionAPI,
		model: createClaudeCodeModel("claude/haiku"),
		...overrides,
	} as RunOptions;
}

async function run(
	prompt: string,
	options: Partial<RunOptions> = {},
	runner: { persistSession?: boolean } = {},
) {
	const usage: Array<{ input: number; output: number; cost?: number }> = [];
	const tools: Array<{ type: string; toolName: string }> = [];
	const result = await runClaudeCodeAgent(
		makeCtx(),
		"general-purpose",
		prompt,
		makeOptions({
			onAssistantUsage: (u) => usage.push(u as never),
			onToolActivity: (a) => tools.push(a),
			...options,
		}),
		{
			graceTurns: 5,
			persistSession: runner.persistSession ?? false,
			// A Claude Code resume loads the conversation from disk, so the run must
			// have been persisted (and must have a session directory to write to).
			...(runner.persistSession ? { sessionDir: workDir } : {}),
		},
	);
	return { result, usage, tools };
}

const messagesOf = (result: { session: unknown }) =>
	(result.session as ClaudeCodeSession).messages as Array<Record<string, any>>;

describe.skipIf(!live)("runClaudeCodeAgent (live CLI)", () => {
	it("runs a real prompt and produces a pi-shaped result", {
		timeout: 180_000,
	}, async () => {
		const { result, usage } = await run(
			"Reply with exactly the single word: PONG",
		);
		expect(result.failure).toBeUndefined();
		expect(result.responseText.toUpperCase()).toContain("PONG");

		const messages = messagesOf(result);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toBe(
			"Reply with exactly the single word: PONG",
		);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant?.content?.[0]?.type).toBe("text");

		// Real token accounting, and a real reported cost.
		expect(usage.some((u) => u.input > 0 || u.output > 0)).toBe(true);
		expect(usage.at(-1)?.cost ?? 0).toBeGreaterThan(0);
	});

	it("translates a real tool call into a pi tool call and result", {
		timeout: 180_000,
	}, async () => {
		const { result } = await run(
			"Read the file secret.txt and reply with only the magic word it contains.",
		);
		const messages = messagesOf(result);
		const toolCall = messages
			.flatMap((m) => (m.role === "assistant" ? (m.content ?? []) : []))
			.find((c: { type: string }) => c.type === "toolCall");
		// The whole point of the tool table: Claude Code's `Read` becomes pi's `read`.
		expect(toolCall?.name).toBe("read");
		expect(toolCall?.arguments?.path).toContain("secret.txt");
		// ...and the result comes back as a pi toolResult carrying the tool's name.
		const toolResult = messages.find((m) => m.role === "toolResult");
		expect(toolResult?.toolName).toBe("read");
		expect(result.responseText.toUpperCase()).toContain("FLAMINGO");
	});

	it("returns structured output from --json-schema", {
		timeout: 180_000,
	}, async () => {
		const { result } = await run("Read secret.txt and report the magic word.", {
			structuredOutput: {
				schema: {
					type: "object",
					properties: { word: { type: "string" } },
					required: ["word"],
				},
				check: () => true,
			},
		});
		expect(result.structuredJson).toBeDefined();
		const parsed = JSON.parse(result.structuredJson as string);
		expect(String(parsed.word).toUpperCase()).toContain("FLAMINGO");
	});

	it("forwards nested subagent activity when Claude Code delegates", {
		timeout: 240_000,
	}, async () => {
		// Forces Claude Code's own Task tool, whose events must arrive tagged rather
		// than being credited to the agent we spawned.
		const { result } = await run(
			"Use the Task tool to spawn one subagent that finds the magic word in secret.txt, then reply with the word.",
		);
		const nested = messagesOf(result).filter((m) => m.parentToolUseId);
		// Non-fatal if the model declines to delegate — but when it does, the
		// provenance tag must be present.
		if (nested.length > 0) {
			expect(typeof nested[0].parentToolUseId).toBe("string");
		}
		expect(result.responseText.toUpperCase()).toContain("FLAMINGO");
	});

	it("resumes a conversation and keeps its context", {
		timeout: 240_000,
	}, async () => {
		const { result } = await run(
			"Remember this codeword for later: PLATYPUS. Reply with only the word OK.",
			{},
			{ persistSession: true },
		);
		const session = result.session as unknown as ClaudeCodeSession;
		expect(session.sessionId).toBeTruthy();

		// A real continuation: the CLI holds the context, so the codeword must come
		// back without it being repeated in the follow-up prompt.
		const { text, failure } = await resumeClaudeCodeAgent(
			session,
			"What was the codeword I asked you to remember? Reply with only that word.",
			{},
		);
		expect(failure).toBeUndefined();
		expect(text.toUpperCase()).toContain("PLATYPUS");
	});

	it("accepts a mid-run steer", { timeout: 240_000 }, async () => {
		let session: ClaudeCodeSession | undefined;
		// A long, permitted task: several filesystem scans that keep the turn loop
		// busy well past the steer point. (A bare `sleep` is rejected by the CLI's
		// sandbox, which would end the turn before the steer could land.)
		const promise = run(
			"Use the Bash tool to run each of these commands in order, one per tool call: " +
				"`find /usr -name '*.h' | wc -l`, `find / -maxdepth 4 -type d 2>/dev/null | wc -l`, " +
				"`find /usr/share -type f 2>/dev/null | wc -l`. Then reply with only the word DONE.",
			{
				onSessionCreated: (s) => {
					session = s as unknown as ClaudeCodeSession;
				},
			},
		);
		// Steer while the scans are genuinely running. The CLI injects the message
		// into the ongoing turn loop; it does NOT emit an extra result (verified
		// against the real CLI).
		await new Promise((resolve) => setTimeout(resolve, 3000));
		await session?.steer(
			"Stop what you are doing. Reply with only the word STEERED.",
		);
		const { result } = await promise;
		expect(result.responseText.toUpperCase()).toContain("STEERED");
		// The steer is visible in the transcript, as it would be on the pi path.
		expect(
			messagesOf(result).some(
				(m) => m.role === "user" && String(m.content).includes("STEERED"),
			),
		).toBe(true);
	});

	it("stops a run on abort", { timeout: 240_000 }, async () => {
		let session: ClaudeCodeSession | undefined;
		// A nested delegation: Claude Code's own subagent takes tens of seconds, so the
		// parent is provably still working when the abort lands. (A bare `sleep` is
		// rejected by the CLI's sandbox, and filesystem scans finish in a second or two
		// once the page cache is warm — both make this test timing-dependent.)
		const promise = run(
			"Use the Task tool to spawn one subagent (subagent_type Explore) to count every " +
				"file under /usr/share and under /usr/lib, then reply with only the word DONE.",
			{
				onSessionCreated: (s) => {
					session = s as unknown as ClaudeCodeSession;
				},
			},
		);
		// Abort while the delegated work is still running, which is the only window in
		// which an interrupt is meaningful.
		// Early on purpose: the abort has to land while the run is live. A nested
		// delegation takes tens of seconds, so 3s is comfortably inside it, whereas a
		// later abort risks the run having already finished (a no-op, and a false failure).
		await new Promise((resolve) => setTimeout(resolve, 3000));
		session?.abort();
		const { result } = await promise;
		expect(result.aborted).toBe(true);
	});
});
