/**
 * claude-code.test.ts — the Claude Code backend, end to end.
 *
 * The real CLI cannot be exercised here: it needs an authenticated Claude Code
 * install, and a subscription login is not something a test may assume. So the
 * process boundary is faked — a generated `claude` script replays recorded
 * `stream-json` output and honours the same stdin protocol — and everything
 * inside that boundary (argument construction, line parsing, block merging,
 * tool translation, usage accounting, steering, interrupt, run assembly) is the
 * real code.
 *
 * The scenarios mirror what Claude Code 2.1.x actually emits, including the two
 * shapes that are easy to get wrong: one `assistant` event PER CONTENT BLOCK
 * (not per turn), and interleaved nested-subagent events carrying
 * `parent_tool_use_id`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunOptions, runAgent } from "../agent-runner.js";
import {
	type ModelRegistry,
	resolveModel,
	resolvePinnedModel,
} from "../model-resolver.js";
import { checkModelScope, setScopeModelsEnabled } from "../model-scope.js";
import { BUILTIN_TOOL_NAMES } from "../agent-types.js";
import {
	createClaudeCodeModel,
	effortForThinkingLevel,
	isClaudeCodeModel,
	isClaudeCodeModelSpec,
} from "./model.js";
import { parseClaudeStreamLine } from "./protocol.js";
import {
	buildClaudeArgs,
	readSidecar,
	resumeClaudeCodeAgent,
	runClaudeCodeAgent,
	isClaudeSidecar,
} from "./runner.js";
import { ClaudeCodeSession, isClaudeCodeSession } from "./session.js";
import {
	claudeToolAllowList,
	claudeToolDenyList,
	claudeToolPolicyFor,
	isClaudeToolName,
	translateToolCall,
} from "./tools.js";
import { ClaudeMessageTranslator } from "./translate.js";

// ─── The fake CLI ────────────────────────────────────────────────────────────

/**
 * A stand-in for `claude`. Reads the same newline-delimited JSON on stdin,
 * writes the same newline-delimited JSON on stdout, and switches on
 * `FAKE_CLAUDE_SCENARIO` so one script can serve every case.
 */
const FAKE_CLAUDE_SOURCE = String.raw`#!/usr/bin/env node
const scenario = process.env.FAKE_CLAUDE_SCENARIO || "basic";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const init = (extra) => write(Object.assign({
  type: "system", subtype: "init", session_id: SESSION, model: "claude-sonnet-5-5",
  cwd: process.cwd(), tools: ["Read", "Edit", "Bash"], permissionMode: "bypassPermissions",
  claude_code_version: "2.1.296",
}, extra || {}));
const frame = (event, parent) => write({
  type: "stream_event", session_id: SESSION, parent_tool_use_id: parent || null, uuid: "u", event,
});
const assistant = (message, parent) => write({
  type: "assistant", session_id: SESSION, parent_tool_use_id: parent || null,
  uuid: "u", message,
});
const user = (message, parent) => write({
  type: "user", session_id: SESSION, parent_tool_use_id: parent || null, uuid: "u", message,
});
const result = (extra) => write(Object.assign({
  type: "result", subtype: "success", is_error: false, session_id: SESSION,
  duration_ms: 5, duration_api_ms: 4, num_turns: 1, result: "",
  total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
}, extra || {}));

// A text block, streamed as deltas then confirmed by the authoritative event.
function textTurn(id, text, usage, parent) {
  frame({ type: "message_start", message: { id, role: "assistant", usage } }, parent);
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent);
  for (const word of text.split(" ")) {
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: word + " " } }, parent);
  }
  frame({ type: "content_block_stop", index: 0 }, parent);
  assistant({ id, role: "assistant", usage, stop_reason: null, content: [{ type: "text", text: text + " " }] }, parent);
}

// One assistant message whose blocks arrive as SEPARATE assistant events — the
// real per-content_block_stop behaviour, and the case that must merge.
function textAndToolTurn(id, text, toolId, toolName, input, usage) {
  frame({ type: "message_start", message: { id, role: "assistant", usage } }, null);
  frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, null);
  frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, null);
  frame({ type: "content_block_stop", index: 0 }, null);
  assistant({ id, role: "assistant", usage, stop_reason: null, content: [{ type: "text", text }] }, null);
  frame({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolId, name: toolName, input: {} } }, null);
  frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"src/x' } }, null);
  frame({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '.ts"}' } }, null);
  frame({ type: "content_block_stop", index: 1 }, null);
  assistant({ id, role: "assistant", usage, stop_reason: "tool_use", content: [{ type: "tool_use", id: toolId, name: toolName, input }] }, null);
}

let pending = [];
function turn() {
  pending.shift()();
}

if (scenario === "crash") {
  process.stderr.write("boom: no such flag");
  process.exit(3);
}

init();

if (scenario === "die") {
  // A CLI that is gone before the runner writes anything to it. Writing into a
  // closed stdin fails asynchronously; without a stdin error handler that is an
  // uncaught EPIPE that takes the host process down.
  process.exit(0);
}

if (scenario === "closedstdin") {
  // Closes its OWN stdin descriptor while staying alive. Different from
  // process.stdin.destroy(), which leaves the fd open and swallows the write:
  // here the parent's next write fails with EPIPE while child.stdin.writable is
  // still true, so only the stream's error event can report it.
  require("node:fs").closeSync(0);
  setTimeout(() => { emitFinal(); process.exit(0); }, 900);
}

const argvFile = process.env.FAKE_CLAUDE_ARGV_FILE;
if (argvFile) {
  // Records the flags this invocation was given, so a test can assert what the
  // runner actually spawned rather than what a helper returns.
  require("node:fs").writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
}

if (scenario === "cap") {
  // Exactly one turn, so a run capped at one turn finalizes that turn as the
  // result arrives rather than before it.
  pending.push(() => { textTurn("c1", "Only answer", { input_tokens: 5, output_tokens: 2 }); });
}

if (scenario === "interleave") {
  // Two nested agents whose messages interleave: child A's second block arrives
  // AFTER child B opened its own message.
  pending.push(() => {
    assistant({ id: "a1", role: "assistant", content: [{ type: "text", text: "a-1" }] }, "taskA");
    assistant({ id: "b1", role: "assistant", content: [{ type: "text", text: "b-1" }] }, "taskB");
    assistant({ id: "a1", role: "assistant", content: [{ type: "text", text: "a-2" }] }, "taskA");
  });
}

if (scenario === "basic") {
  pending.push(() => { textTurn("m1", "Hello there", { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 }); });
  pending.push(() => {
    textAndToolTurn("m2", "Let me look.", "t1", "Read", { file_path: "src/x.ts" }, { input_tokens: 20, output_tokens: 6 });
    user({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] });
  });
  pending.push(() => { textTurn("m3", "Done now", { input_tokens: 30, output_tokens: 8, cache_creation_input_tokens: 3 }); });
  if (process.env.FAKE_CLAUDE_NESTED === "1") {
    pending.splice(2, 0, () => {
      textTurn("n1", "child is searching", { input_tokens: 5, output_tokens: 2 }, "t1");
    });
  }
}

let sawSteer = false;
let finished = false;
function emitFinal() {
  finished = true;
  result({
    result: scenario === "basic" ? "Done now" : scenario === "cap" ? "Only answer" : "steered answer",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 60, output_tokens: 18, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    num_turns: pending.length ? 3 : 1,
    ...(scenario === "structured" ? { structured_output: { name: "value", count: 2 } } : {}),
    ...(scenario === "error" ? { is_error: true, errors: ["rate limited"], result: "" } : {}),
    ...(scenario === "maxturns" ? { subtype: "error_max_turns" } : {}),
  });
}

// Per LINE, as the real CLI reads it: one data chunk can carry the prompt and a
// steer together, and a fake that switched on chunk boundaries would report a
// different conversation depending on how Node happened to coalesce the writes.
function handleUserMessage() {
  if (scenario === "steer") {
    // Faithful to the real CLI: the first prompt starts the turn loop and does
    // NOT produce a result; the steer is injected into that same loop, and
    // exactly ONE result follows. A test that let a steer produce its own
    // result would fail to catch the completion bug this models.
    if (!sawSteer) {
      sawSteer = true;
      textTurn("s1", "First answer", { input_tokens: 10, output_tokens: 3 });
      return;
    }
    textTurn("s2", "Second answer after steer", { input_tokens: 12, output_tokens: 4 });
    emitFinal();
    return;
  }
  if (scenario === "hang") return;
  if (scenario === "cap" && finished) {
    // A message arriving after this run's result is a NEW query. Reported as its
    // own result so a test can see a stray turn-cap steer reach the CLI.
    result({ result: "EXTRA QUERY", total_cost_usd: 0.5, usage: {} });
    return;
  }
  while (pending.length) turn();
  emitFinal();
}

let buffer = "";
if (scenario !== "closedstdin") {
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "control_request" && msg.request && msg.request.subtype === "interrupt") {
        // Graceful stop: acknowledge, stop working, and report an interrupted run.
        write({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
        result({ is_error: true, subtype: "error_during_execution", errors: ["interrupted"], result: "" });
        process.exit(0);
      }
      if (msg.type === "user") handleUserMessage();
    }
  });
  process.stdin.on("end", () => {
    // finished rather than sawSteer: a run whose result already went out must
    // not report a second one just because the runner closed its stdin.
    if (!finished) {
      while (pending.length) turn();
      emitFinal();
    }
  });
}
`;

let fakeBin: string;
let workDir: string;

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "claude-code-test-"));
	fakeBin = join(workDir, "claude");
	writeFileSync(fakeBin, FAKE_CLAUDE_SOURCE, "utf-8");
	chmodSync(fakeBin, 0o755);
	process.env.PI_SUBAGENTS_CLAUDE_BIN = fakeBin;
});

afterAll(() => {
	delete process.env.PI_SUBAGENTS_CLAUDE_BIN;
	rmSync(workDir, { recursive: true, force: true });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeCtx(cwd: string): ExtensionContext {
	return {
		cwd,
		getSystemPrompt: () => "PARENT SYSTEM PROMPT",
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
		model: createClaudeCodeModel("claude/sonnet"),
		...overrides,
	} as RunOptions;
}

async function run(
	scenario: string,
	options: Partial<RunOptions> = {},
	extra: { nested?: boolean; persistSession?: boolean; maxTurns?: number } = {},
) {
	process.env.FAKE_CLAUDE_SCENARIO = scenario;
	if (extra.nested) process.env.FAKE_CLAUDE_NESTED = "1";
	else delete process.env.FAKE_CLAUDE_NESTED;
	const usage: Array<{ input: number; output: number; cost?: number }> = [];
	const tools: Array<{ type: string; toolName: string }> = [];
	const turns: number[] = [];
	const result = await runClaudeCodeAgent(
		makeCtx(workDir),
		"general-purpose",
		"do the thing",
		makeOptions({
			onAssistantUsage: (u) => usage.push(u as never),
			onToolActivity: (a) => tools.push(a),
			onTurnEnd: (t) => turns.push(t),
			...options,
		}),
		{
			graceTurns: 5,
			persistSession: extra.persistSession ?? false,
			...(extra.maxTurns !== undefined ? { maxTurns: extra.maxTurns } : {}),
			// Production always resolves a session directory (see
			// `resolveClaudeRunnerContext`); the sidecar, and so resumability,
			// depends on having one.
			...(extra.persistSession ? { sessionDir: workDir } : {}),
		},
	);
	return { result, usage, tools, turns };
}

const messagesOf = (result: { session: unknown }) =>
	(result.session as ClaudeCodeSession).messages as Array<Record<string, any>>;

// ─── Model recognition ───────────────────────────────────────────────────────

describe("claude/* model specs", () => {
	it("recognizes only a non-empty claude/ prefix", () => {
		expect(isClaudeCodeModelSpec("claude/sonnet")).toBe(true);
		expect(isClaudeCodeModelSpec("claude/opus-4-5")).toBe(true);
		// A bare prefix names no model; falling through to the registry makes it a
		// loud "model not found" instead of a CLI call with an empty --model.
		expect(isClaudeCodeModelSpec("claude/")).toBe(false);
		expect(isClaudeCodeModelSpec("github-copilot/claude-opus-5.5")).toBe(false);
		expect(isClaudeCodeModelSpec(undefined)).toBe(false);
	});

	it("resolves without consulting the registry, and survives the pinned path", () => {
		// An empty registry: a `claude/*` spec must not need one.
		const registry: ModelRegistry = {
			getAvailable: () => [],
			getAll: () => [],
			find: () => undefined,
		};
		const model = resolveModel("claude/sonnet", registry);
		expect(typeof model).not.toBe("string");
		expect(model.provider).toBe("claude");
		expect(model.id).toBe("sonnet");
		expect(isClaudeCodeModel(model)).toBe(true);

		// `resolvePinnedModel` refuses provider/id substitution; the synthetic model
		// must satisfy that check rather than being rejected as a substitution.
		const pinned = resolvePinnedModel("claude/opus", registry);
		expect(typeof pinned).not.toBe("string");
		expect(pinned.id).toBe("opus");
	});

	it("maps thinking levels to --effort, folding minimal into low", () => {
		expect(effortForThinkingLevel("minimal")).toBe("low");
		expect(effortForThinkingLevel("low")).toBe("low");
		expect(effortForThinkingLevel("xhigh")).toBe("xhigh");
		expect(effortForThinkingLevel(undefined)).toBeUndefined();
		expect(effortForThinkingLevel("bogus")).toBeUndefined();
	});

	it("passes the model-scope gate that enabledModels would otherwise fail", () => {
		// `enabledModels` can never list a claude/* entry, so applying the
		// allowlist would reject every Claude Code spawn.
		const verdict = checkModelScope({
			model: createClaudeCodeModel("claude/sonnet"),
			cwd: workDir,
			modelRegistry: {} as never,
			callerSupplied: true,
			agentLabel: "Agent",
			modelInput: "claude/sonnet",
		});
		expect(verdict.kind).toBe("ok");
	});
});

// ─── Argument construction ───────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
	it("always requests stream-json with the flags it depends on", () => {
		const argv = buildClaudeArgs({
			modelSpec: "sonnet",
			systemPrompt: "SYS",
			persistSession: false,
		});
		// --verbose is mandatory: --print + stream-json errors without it.
		expect(argv).toContain("--verbose");
		expect(argv).toContain("--print");
		expect(argv.join(" ")).toContain("--output-format stream-json");
		expect(argv).toContain("--include-partial-messages");
		expect(argv).toContain("--forward-subagent-text");
		expect(argv).toContain("--dangerously-skip-permissions");
		expect(argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
		expect(argv).toEqual(expect.arrayContaining(["--system-prompt", "SYS"]));
		expect(argv).toContain("--no-session-persistence");
	});

	it("uses append semantics when the agent file asks for append mode", () => {
		const argv = buildClaudeArgs({
			modelSpec: "sonnet",
			systemPrompt: "SYS",
			appendSystemPrompt: true,
			persistSession: true,
		});
		expect(argv).toEqual(
			expect.arrayContaining(["--append-system-prompt", "SYS"]),
		);
		expect(argv).not.toContain("--system-prompt");
		expect(argv).not.toContain("--no-session-persistence");
	});

	it("omits the system prompt on a resume but keeps an explicitly requested schema", () => {
		const argv = buildClaudeArgs({
			modelSpec: "sonnet",
			systemPrompt: "SYS",
			jsonSchema: "{}",
			resumeSessionId: "abc",
			persistSession: true,
		});
		// A resumed conversation keeps the instructions it was created with.
		expect(argv).not.toContain("--system-prompt");
		expect(argv).not.toContain("--append-system-prompt");
		// The schema, by contrast, describes THIS turn's output contract, so an
		// explicitly requested one still applies.
		expect(argv).toEqual(expect.arrayContaining(["--json-schema", "{}"]));
		expect(argv).toEqual(expect.arrayContaining(["--resume", "abc"]));
	});

	it("passes --effort only when a thinking level is set", () => {
		expect(
			buildClaudeArgs({
				modelSpec: "sonnet",
				thinkingLevel: "high",
				systemPrompt: "S",
				persistSession: true,
			}),
		).toEqual(expect.arrayContaining(["--effort", "high"]));
		expect(
			buildClaudeArgs({
				modelSpec: "sonnet",
				systemPrompt: "S",
				persistSession: true,
			}),
		).not.toContain("--effort");
	});
});

// ─── Wire parsing and tool translation ───────────────────────────────────────

describe("stream parsing", () => {
	it("ignores blanks and non-JSON without throwing", () => {
		expect(parseClaudeStreamLine("")).toBeUndefined();
		expect(parseClaudeStreamLine("   ")).toBeUndefined();
		expect(parseClaudeStreamLine("boom")).toBeUndefined();
		expect(parseClaudeStreamLine("[1,2]")).toBeUndefined();
		expect(parseClaudeStreamLine('{"type":"result"}')?.type).toBe("result");
	});

	it("preserves unknown fields so a newer CLI cannot break a run", () => {
		const event = parseClaudeStreamLine(
			'{"type":"result","brand_new_field":42}',
		);
		expect(event).toMatchObject({ brand_new_field: 42 });
	});
});

describe("tool translation", () => {
	it("re-keys Claude Code tools onto pi names and arguments", () => {
		expect(translateToolCall("Read", { file_path: "a.ts", offset: 5 })).toEqual(
			{
				name: "read",
				arguments: { path: "a.ts", offset: 5 },
				mapped: true,
			},
		);
				expect(
			translateToolCall("Edit", {
				file_path: "a",
				old_string: "x",
				new_string: "y",
				replace_all: true,
			}),
		).toEqual({
			name: "edit",
			// pi's canonical shape: `edits[]`, not the legacy top-level pair.
			arguments: { path: "a", edits: [{ oldText: "x", newText: "y" }], replaceAll: true },
			mapped: true,
		});
		expect(
			translateToolCall("Write", { file_path: "a", content: "body" }),
		).toEqual({
			name: "write",
			// Without `content` the row has no body and cannot be replayed.
			arguments: { path: "a", content: "body" },
			mapped: true,
		});
		expect(
			translateToolCall("Bash", {
				command: "ls",
				// Claude Code counts milliseconds, pi counts seconds.
				timeout: 120000,
				description: "list",
			}),
		).toEqual({
			name: "bash",
			arguments: { command: "ls", timeout: 120 },
			mapped: true,
		});
		expect(
			translateToolCall("Grep", {
				pattern: "x",
				"-i": true,
				"-C": 3,
				head_limit: 5,
			}),
		).toEqual({
			name: "grep",
			arguments: { pattern: "x", ignoreCase: true, context: 3, limit: 5 },
			mapped: true,
		});
		expect(translateToolCall("Glob", { pattern: "**/*.ts" })).toMatchObject({
			name: "find",
			mapped: true,
		});
	});

	it("passes unmapped tools through untouched rather than blanking them", () => {
		const translated = translateToolCall("TodoWrite", {
			todos: [{ content: "x" }],
		});
		expect(translated.name).toBe("TodoWrite");
		expect(translated.mapped).toBe(false);
		expect(translated.arguments).toEqual({ todos: [{ content: "x" }] });
	});
});

// ─── Translation ─────────────────────────────────────────────────────────────

describe("ClaudeMessageTranslator", () => {
	const model = createClaudeCodeModel("claude/sonnet");

	it("merges per-content-block assistant events into ONE pi message", () => {
		const translator = new ClaudeMessageTranslator(model);
		// Two authoritative events sharing a message id — the CLI's real shape.
		translator.handle({
			type: "assistant",
			message: {
				id: "m1",
				usage: { input_tokens: 3, output_tokens: 1 },
				content: [{ type: "text", text: "hi" }],
			},
		});
		translator.handle({
			type: "assistant",
			message: {
				id: "m1",
				usage: { input_tokens: 3, output_tokens: 1 },
				stop_reason: "tool_use",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Read",
						input: { file_path: "a.ts" },
					},
				],
			},
		});
		expect(translator.messages).toHaveLength(1);
		const assistant = translator.messages[0] as never as { content: any[] };
		expect(assistant.content).toHaveLength(2);
		expect(assistant.content[0]).toEqual({ type: "text", text: "hi" });
		expect(assistant.content[1]).toMatchObject({
			type: "toolCall",
			id: "t1",
			name: "read",
		});
	});

	it("streams text deltas while keeping the authoritative block", () => {
		const deltas: string[] = [];
		const translator = new ClaudeMessageTranslator(model, {
			onTextDelta: (d) => deltas.push(d),
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "message_start",
				message: { id: "m1", usage: { input_tokens: 1, output_tokens: 0 } },
			},
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "he" },
			},
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "llo" },
			},
		});
		expect(deltas).toEqual(["he", "llo"]);
		// The authoritative block replaces the accumulated provisional one.
		translator.handle({
			type: "assistant",
			message: {
				id: "m1",
				usage: { input_tokens: 1, output_tokens: 2 },
				content: [{ type: "text", text: "hello" }],
			},
		});
		expect(
			(translator.messages[0] as never as { content: any[] }).content,
		).toEqual([{ type: "text", text: "hello" }]);
	});

	it("emits one usage delta and one turn per assistant message", () => {
		const usage: Array<{ input: number; output: number }> = [];
		const turns: number[] = [];
		const translator = new ClaudeMessageTranslator(model, {
			onAssistantUsage: (u) => usage.push(u),
			onTurnEnd: (t) => turns.push(t),
		});
		for (const id of ["m1", "m2"]) {
			translator.handle({
				type: "assistant",
				message: {
					id,
					usage: { input_tokens: 5, output_tokens: 2 },
					content: [{ type: "text", text: id }],
				},
			});
			// Starting the next message finalizes the previous one.
			translator.handle({
				type: "stream_event",
				event: { type: "message_start", message: { id: `${id}-next` } },
			});
		}
		translator.finish();
		expect(usage).toEqual([
			{ input: 5, output: 2, cacheWrite: 0, cacheRead: 0 },
			{ input: 5, output: 2, cacheWrite: 0, cacheRead: 0 },
		]);
		expect(turns).toEqual([1, 2]);
	});

	it("tags nested-subagent messages so they are not credited to the parent", () => {
		const translator = new ClaudeMessageTranslator(model);
		translator.handle({
			type: "assistant",
			parent_tool_use_id: "task-1",
			message: { id: "n1", content: [{ type: "text", text: "child work" }] },
		});
		expect(
			(translator.messages[0] as never as { parentToolUseId?: string })
				.parentToolUseId,
		).toBe("task-1");
	});

	it("converts tool results into pi toolResult messages", () => {
		const tools: Array<{ type: string; toolName: string }> = [];
		const translator = new ClaudeMessageTranslator(model, {
			onToolActivity: (a) => tools.push(a),
		});
		translator.handle({
			type: "assistant",
			message: {
				id: "m1",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						input: { command: "ls" },
					},
				],
			},
		});
		translator.handle({
			type: "user",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }],
			},
		});
		const toolResult = translator.messages.find(
			(m) => (m as { role: string }).role === "toolResult",
		) as never as {
			toolName: string;
			isError: boolean;
			content: any[];
		};
		expect(toolResult.toolName).toBe("bash");
		expect(toolResult.isError).toBe(false);
		expect(toolResult.content).toEqual([{ type: "text", text: "out" }]);
		// The tool result closes the call. A "start" only accompanies a streamed
		// block; the manager counts tool uses on "end", so an end alone still counts
		// correctly, and the activity tracker ignores an end it never saw a start for.
		expect(tools).toEqual([{ type: "end", toolName: "bash" }]);
	});

	it("reports cost once, as a cost-only delta", () => {
		const usage: Array<{ input: number; output: number; cost?: number }> = [];
		const translator = new ClaudeMessageTranslator(model, {
			onAssistantUsage: (u) => usage.push(u),
		});
		translator.applyRunCost(0.5);
		translator.applyRunCost(0.5);
		expect(usage).toEqual([
			{ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0.5 },
		]);
		// A subscription-authenticated CLI reports 0; nothing should be emitted.
		const none: unknown[] = [];
		const quiet = new ClaudeMessageTranslator(model, {
			onAssistantUsage: (u) => none.push(u),
		});
		quiet.applyRunCost(0);
		quiet.applyRunCost(undefined);
		expect(none).toEqual([]);
	});
});

// ─── End-to-end through the process boundary ─────────────────────────────────

describe("runClaudeCodeAgent", () => {
	it("produces a pi-shaped transcript, usage and result", async () => {
		const { result, usage, tools, turns } = await run("basic");
		expect(result.responseText).toBe("Done now");
		expect(result.aborted).toBe(false);
		expect(result.failure).toBeUndefined();

		const messages = messagesOf(result);
		// user prompt, assistant text, assistant text+tool, toolResult, final assistant
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(messages[0].content).toBe("do the thing");
		// The text+tool turn merged into ONE message with both blocks.
		expect(messages[2].content.map((c: { type: string }) => c.type)).toEqual([
			"text",
			"toolCall",
		]);
		expect(messages[2].content[1]).toMatchObject({
			name: "read",
			arguments: { path: "src/x.ts" },
		});
		expect(messages[3].toolName).toBe("read");

		// Token totals come from per-message usage; cost from the run's total.
		const totalInput = usage.reduce((sum, u) => sum + u.input, 0);
		expect(totalInput).toBe(60);
		expect(usage.at(-1)?.cost).toBe(0.0123);
		expect(turns.at(-1)).toBeGreaterThanOrEqual(3);
		expect(tools.some((t) => t.type === "start" && t.toolName === "read")).toBe(
			true,
		);
		expect(tools.some((t) => t.type === "end" && t.toolName === "read")).toBe(
			true,
		);
	});

	it("exposes a session façade the viewer and usage accounting accept", async () => {
		const { result } = await run("basic");
		expect(isClaudeCodeSession(result.session)).toBe(true);
		const session = result.session as unknown as ClaudeCodeSession;
		// `getSessionStats` is what the widget reads for its token count.
		expect(session.getSessionStats().tokens.input).toBe(60);
		// Context percent is honestly unknown rather than guessed.
		expect(session.getSessionStats().contextUsage?.percent).toBeNull();
		// The viewer asks for tool renderers; undefined makes it use pi's built-ins.
		expect(session.getToolDefinition("read")).toBeUndefined();
		expect(session.sessionManager.getCwd()).toBe(workDir);
		// pi's session ids are the CLI's, which is what a resume needs.
		expect(session.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
	});

	it("forwards nested subagent work, tagged with its parent tool call", async () => {
		const { result } = await run("basic", {}, { nested: true });
		const nested = messagesOf(result).filter((m) => m.parentToolUseId);
		expect(nested.length).toBeGreaterThan(0);
		expect(nested[0].parentToolUseId).toBe("t1");
	});

	it("returns structured output from --json-schema runs", async () => {
		const { result } = await run("structured", {
			structuredOutput: { schema: { type: "object" }, check: () => true },
		});
		expect(result.structuredJson).toBe(
			JSON.stringify({ name: "value", count: 2 }),
		);
	});

	it("reports a failing run as a failure rather than a silent empty completion", async () => {
		const { result } = await run("error");
		expect(result.failure).toBe("rate limited");
	});

	it("reports a non-success result subtype", async () => {
		const { result } = await run("maxturns");
		expect(result.failure).toContain("error_max_turns");
	});

	it("surfaces a CLI that cannot start", async () => {
		const previous = process.env.PI_SUBAGENTS_CLAUDE_BIN;
		process.env.PI_SUBAGENTS_CLAUDE_BIN = join(workDir, "definitely-not-here");
		try {
			const { result } = await run("basic");
			expect(result.failure).toContain("Could not run the claude CLI");
		} finally {
			process.env.PI_SUBAGENTS_CLAUDE_BIN = previous;
		}
	});

	it("accepts a mid-run steer without waiting for a second result", async () => {
		let session: ClaudeCodeSession | undefined;
		const promise = run("steer", {
			onSessionCreated: (s) => {
				session = s as unknown as ClaudeCodeSession;
			},
		});
		// Steer while the first turn is in flight — before any result event.
		// The CLI injects it into the ongoing loop and still emits exactly one
		// result, so a run that waited for a result per prompt would hang here.
		await new Promise((resolve) => setTimeout(resolve, 120));
		await session?.steer("now also do the other thing");
		const { result } = await promise;
		expect(result.responseText).toBe("steered answer");
		// The steer is part of the transcript, as it is on the pi path.
		expect(
			messagesOf(result).some(
				(m) => m.role === "user" && m.content === "now also do the other thing",
			),
		).toBe(true);
	});

	it("resumes a conversation by Claude Code session id", async () => {
		const { result } = await run("basic", {}, { persistSession: true });
		const session = result.session as unknown as ClaudeCodeSession;
		// The CLI's own session id is the resume handle.
		expect(session.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		const before = session.messages.length;

		const { text, failure } = await resumeClaudeCodeAgent(
			session,
			"and then?",
			{},
		);
		expect(failure).toBeUndefined();
		expect(text.length).toBeGreaterThan(0);
		// It appends to the SAME transcript rather than starting a new conversation.
		expect(session.messages.length).toBeGreaterThan(before);
		expect(
			session.messages.some(
				(m) =>
					(m as { role: string }).role === "user" &&
					(m as { content?: unknown }).content === "and then?",
			),
		).toBe(true);
	});

	it("refuses to resume a run that was never persisted", async () => {
		// A Claude Code resume loads the conversation from the CLI's own store, so
		// a run started with --no-session-persistence cannot be continued. The
		// failure must say that rather than relaying the CLI's opaque error.
		const { result } = await run("basic", {}, { persistSession: false });
		const session = result.session as unknown as ClaudeCodeSession;
		const { text, failure } = await resumeClaudeCodeAgent(session, "again", {});
		expect(text).toBe("");
		expect(failure).toContain("not persisted");
	});

	it("stops a running agent on abort and reports it as aborted", async () => {
		let session: ClaudeCodeSession | undefined;
		const promise = run("hang", {
			onSessionCreated: (s) => {
				session = s as unknown as ClaudeCodeSession;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		session?.abort();
		const { result } = await promise;
		expect(result.aborted).toBe(true);
	});

	it("aborts when the caller's signal fires", async () => {
		const controller = new AbortController();
		const promise = run("hang", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 150));
		controller.abort();
		const { result } = await promise;
		expect(result.aborted).toBe(true);
	});
});

// ─── Regressions for the Opus 5.5 review ─────────────────────────────────────

describe("tool activity names (H1)", () => {
	it("announces a start under the SAME name the end reports", async () => {
		const { tools } = await run("basic");
		const starts = tools.filter((t) => t.type === "start").map((t) => t.toolName);
		const ends = tools.filter((t) => t.type === "end").map((t) => t.toolName);
		// `index.ts` clears the widget's active-tool entry by matching the name the
		// end reports, so a `Bash`/`bash` mismatch strands every tool for the rest
		// of the run.
		expect(starts).toEqual(["read"]);
		expect(ends).toEqual(["read"]);
	});

	it("does not announce a server tool that never gets an end", () => {
		const model = createClaudeCodeModel("claude/sonnet");
		const tools: Array<{ type: string; toolName: string }> = [];
		const translator = new ClaudeMessageTranslator(model, {
			onToolActivity: (a) => tools.push(a),
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "server_tool_use",
					id: "s1",
					name: "web_search",
				},
			},
		});
		// A server tool's result arrives as a `web_search_tool_result`, never a
		// `tool_result`, so nothing would ever close this entry.
		expect(tools).toEqual([]);
	});
});

describe("nested turns (H3)", () => {
	it("does not count a nested agent's turns against the parent", async () => {
		const { turns, usage } = await run("basic", {}, { nested: true });
		// Three parent turns; the child's is not one of them, so it cannot steer
		// the parent into its turn cap.
		expect(turns).toEqual([1, 2, 3]);
		// Its tokens are still real spend, so they are still reported.
		expect(usage.reduce((sum, u) => sum + u.input, 0)).toBe(65);
	});

	it("keeps an interleaved nested message in ONE pi message", async () => {
		const { result } = await run("interleave");
		const assistants = messagesOf(result).filter((m) => m.role === "assistant");
		expect(assistants).toHaveLength(2);
		const childA = assistants.find((m) => m.parentToolUseId === "taskA");
		expect(childA?.content.map((c: { text: string }) => c.text)).toEqual([
			"a-1",
			"a-2",
		]);
	});
});

describe("event stream shape (M2, M3)", () => {
	it("emits one turn_end per completed turn, so .output streams live", async () => {
		const events: string[] = [];
		await run("basic", {
			onSessionCreated: (s) => {
				(s as unknown as ClaudeCodeSession).subscribe((e) =>
					events.push((e as { type: string }).type),
				);
			},
		});
		expect(events.filter((e) => e === "turn_end")).toHaveLength(3);
	});

	it("delivers a resumed run's events to subscribers", async () => {
		const { result } = await run("basic", {}, { persistSession: true });
		const session = result.session as unknown as ClaudeCodeSession;
		const events: string[] = [];
		session.subscribe((e) => events.push((e as { type: string }).type));
		// The spawn closed the session; a resume reuses it, so delivery has to start
		// again or the continuation is invisible to the viewer and the transcript.
		const { failure } = await resumeClaudeCodeAgent(session, "and then?", {});
		expect(failure).toBeUndefined();
		expect(events).toContain("message_update");
		expect(events).toContain("result");
	});
});

describe("usage accounting (M5)", () => {
	it("keeps the input/cache counts a partial message_delta omits", () => {
		const model = createClaudeCodeModel("claude/sonnet");
		const translator = new ClaudeMessageTranslator(model);
		translator.handle({
			type: "stream_event",
			event: {
				type: "message_start",
				message: {
					id: "m1",
					usage: { input_tokens: 10, cache_read_input_tokens: 2 },
				},
			},
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		});
		translator.handle({
			type: "stream_event",
			event: {
				type: "message_delta",
				usage: { output_tokens: 4 },
			},
		});
		const usage = (
			translator.messages[0] as unknown as { usage: Record<string, number> }
		).usage;
		expect(usage.input).toBe(10);
		expect(usage.cacheRead).toBe(2);
		expect(usage.output).toBe(4);
		expect(usage.totalTokens).toBe(16);
	});
});

describe("completion and control (M1, H5, M4)", () => {
	it("does not steer a conversation the result already ended", async () => {
		// maxTurns 1 is reached by the single turn this scenario produces, which
		// finalizes AS the result arrives. A wrap-up steer written after that would
		// start a new paid query — visible here as the CLI's second result.
		const { result } = await run("cap", {}, { maxTurns: 1 });
		expect(result.responseText).toBe("Only answer");
	});

	it("does not drop a steer sent while the run is still starting", async () => {
		const { result } = await run("steer", {
			onSessionCreated: (s) => {
				// The manager flushes its queued steers from `onSessionCreated`, which
				// fires before the driver has a process: this is that exact steer.
				void (s as unknown as ClaudeCodeSession).steer(
					"now also do the other thing",
				);
			},
		});
		const messages = messagesOf(result);
		expect(
			messages.filter((m) => m.role === "user").map((m) => m.content),
		).toEqual(["do the thing", "now also do the other thing"]);
		// It reached the CLI AFTER the prompt it steers, so it steered the running
		// loop rather than opening a new one.
		expect(messages.at(-1)?.content?.[0]?.text.trim()).toBe(
			"Second answer after steer",
		);
	});

	it("settles when the CLI exits before stdin is written", async () => {
		// A liveness check, not an EPIPE reproduction: the process is already gone,
		// so `child.stdin.writable` is false and no write happens at all. The write
		// race itself is covered by the "closes its own stdin" test below.
		const { result } = await run("die");
		expect(typeof result.responseText).toBe("string");
	});

	it("files a steer after the result of the call it interrupted", () => {
		// A steer that lands while a `Task` call is in flight must appear after that
		// call's result, not among the nested agent's messages — and a nested turn
		// finalizing must not flush it early.
		const model = createClaudeCodeModel("claude/sonnet");
		const translator = new ClaudeMessageTranslator(model);
		translator.handle({
			type: "assistant",
			message: {
				id: "m1",
				content: [
					{ type: "tool_use", id: "t1", name: "Task", input: {} },
				],
			},
		});
		// The child starts working and produces two messages, so its first turn
		// finalizes while the parent's Task call is still outstanding.
		translator.handle({
			type: "assistant",
			parent_tool_use_id: "t1",
			message: { id: "n1", content: [{ type: "text", text: "child one" }] },
		});
		translator.recordSteer("steer while the task runs");
		translator.handle({
			type: "assistant",
			parent_tool_use_id: "t1",
			message: { id: "n2", content: [{ type: "text", text: "child two" }] },
		});
		translator.handle({
			type: "user",
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }],
			},
		});
		const order = translator.messages.map((m) =>
			(m as { role: string }).role === "toolResult"
				? "toolResult"
				: ((m as { content: unknown }).content === "steer while the task runs"
					? "steer"
					: (m as { parentToolUseId?: string }).parentToolUseId
						? "nested"
						: "parent"),
		);
		expect(order).toEqual([
			"parent",
			"nested",
			"nested",
			"toolResult",
			"steer",
		]);
	});

	it("survives steering a CLI that closed its own stdin and stayed alive", async () => {
		// The one shape where an EPIPE is reachable: the pipe is closed but the
		// process is still running, so `writable` is still true and the failure can
		// only arrive asynchronously. Without the stdin error handler in
		// `driveClaudeProcess` this surfaces as an unhandled EPIPE and takes the test
		// process with it.
		let session: ClaudeCodeSession | undefined;
		const promise = run("closedstdin", {
			onSessionCreated: (s) => {
				session = s as unknown as ClaudeCodeSession;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
		await session?.steer("steer into a closed pipe");
		const { result } = await promise;
		expect(typeof result.responseText).toBe("string");
	});
});

describe("sidecar and resume dispatch (H2, M7)", () => {
	/** A throwaway agent dir, so nothing the default paths resolve can leak out. */
	function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "claude-code-agent-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		return fn(agentDir).finally(() => {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			if (previousSessionDir !== undefined)
				process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
			rmSync(agentDir, { recursive: true, force: true });
		});
	}

	it("recognizes only a sidecar this extension wrote", () => {
		const piFile = join(workDir, "pi-session.jsonl");
		writeFileSync(piFile, `${JSON.stringify({ type: "session", id: "x" })}\n`);
		expect(isClaudeSidecar(piFile)).toBe(false);

		const sidecarFile = join(workDir, "sidecar.json");
		writeFileSync(
			sidecarFile,
			JSON.stringify({
				type: "pi-subagents:claude-code-session",
				claudeSessionId: "abc",
				model: "sonnet",
				cwd: workDir,
			}),
		);
		expect(isClaudeSidecar(sidecarFile)).toBe(true);
		expect(readSidecar(sidecarFile)?.claudeSessionId).toBe("abc");
	});

	it("persists a resumable sidecar with no session directory configured", async () => {
		await withAgentDir(async (agentDir) => {
			const result = await runAgent(
				makeCtx(workDir),
				"general-purpose",
				"do the thing",
				makeOptions(),
			);
			const session = result.session as unknown as ClaudeCodeSession;
			const file = session.sessionManager.getSessionFile();
			// Without the fallback to pi's own session directory there is no sidecar,
			// no `record.sessionFile`, and so no `@agent-<name>` reopen at all.
			expect(file).toBeDefined();
			expect(isClaudeSidecar(file)).toBe(true);
			expect(file?.startsWith(agentDir)).toBe(true);
			expect(existsSync(file as string)).toBe(true);
		});
	});

	it("runs the CLI when the resume target is a sidecar, whatever the model says", async () => {
		await withAgentDir(async (agentDir) => {
			// The `@agent-<name>` reopen path re-resolves a model from the agent's
			// defaults rather than remembering the backend, so a model that says "pi"
			// must not send a Claude Code conversation through `SessionManager.open`.
			const sessionDir = join(agentDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
			const sidecarFile = join(sessionDir, "claude-code-existing.json");
			writeFileSync(
				sidecarFile,
				JSON.stringify({
					type: "pi-subagents:claude-code-session",
					claudeSessionId: "old-session-id",
					model: "sonnet",
					cwd: workDir,
				}),
			);

			process.env.FAKE_CLAUDE_SCENARIO = "basic";
			const result = await runAgent(
				makeCtx(workDir),
				"general-purpose",
				"continue please",
				makeOptions({
					model: {
						id: "gpt-6-luna",
						provider: "github-copilot",
						api: "openai-chat",
						name: "Luna",
					} as never,
					resumeSessionFile: sidecarFile,
				}),
			);
			expect(result.responseText).toBe("Done now");
			// Rewritten in place, not duplicated beside it: the resume handle now
			// points at the conversation the CLI actually continued.
			expect(readSidecar(sidecarFile)?.claudeSessionId).toBe(
				"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			);
		});
	});

	it("refuses to open a pi session file as a Claude Code conversation", async () => {
		await withAgentDir(async (agentDir) => {
			process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, "sessions");
			const piFile = join(workDir, "not-a-sidecar.jsonl");
			writeFileSync(piFile, `${JSON.stringify({ type: "session" })}\n`);
			// Opening it through pi would fail on the JSON shape; running the CLI
			// over it would overwrite the transcript with a sidecar. Refuse instead.
			await expect(
				runAgent(
					makeCtx(workDir),
					"general-purpose",
					"continue please",
					makeOptions({ resumeSessionFile: piFile }),
				),
			).rejects.toThrow(/not a Claude Code sidecar/);
			// The file it refused to open is untouched.
			expect(JSON.parse(readFileSync(piFile, "utf-8")).type).toBe("session");
		});
	});
});

describe("backend opt-in and tool policy (M8)", () => {
	it("does not mistake a user's own provider named claude for the backend", () => {
		expect(isClaudeCodeModel({ provider: "claude", id: "sonnet" })).toBe(false);
		expect(isClaudeCodeModel(createClaudeCodeModel("claude/sonnet"))).toBe(true);
		// ...and a registry that HAS a provider named claude owns the prefix: the
		// backend must stand aside rather than shadowing the user's own models.
		const theirs = { id: "sonnet", name: "sonnet", provider: "claude" };
		const registry: ModelRegistry = {
			getAvailable: () => [theirs],
			getAll: () => [theirs],
			find: () => theirs as never,
		};
		const resolved = resolveModel("claude/sonnet", registry);
		expect(isClaudeCodeModel(resolved)).toBe(false);
	});

	function projectWith(enabledModels: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "claude-code-project-"));
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "settings.json"),
			JSON.stringify({ enabledModels }),
		);
		return dir;
	}

	it("refuses a caller-supplied claude model the allowlist does not carry", () => {
		const dir = projectWith(["deepseek/deepseek-v4-pro"]);
		setScopeModelsEnabled(true);
		try {
			const verdict = checkModelScope({
				model: createClaudeCodeModel("claude/opus"),
				cwd: dir,
				modelRegistry: { getAll: () => [] } as never,
				callerSupplied: true,
				agentLabel: "Agent",
				modelInput: "claude/opus",
			});
			// The backend runs with permissions bypassed, so the allowlist has to be
			// able to gate it — otherwise `model: claude/opus` is a way around a scope
			// the user switched on deliberately.
			expect(verdict.kind).toBe("error");
		} finally {
			setScopeModelsEnabled(false);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("allows it once the allowlist opts the backend in", () => {
		setScopeModelsEnabled(true);
		try {
			for (const entry of ["claude/sonnet", "claude/*"]) {
				const dir = projectWith([entry, "deepseek/deepseek-v4-pro"]);
				try {
					const verdict = checkModelScope({
						model: createClaudeCodeModel("claude/sonnet"),
						cwd: dir,
						modelRegistry: { getAll: () => [] } as never,
						callerSupplied: true,
						agentLabel: "Agent",
						modelInput: "claude/sonnet",
					});
					expect(verdict.kind).toBe("ok");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		} finally {
			setScopeModelsEnabled(false);
		}
	});

	it("translates tools:/disallowed_tools instead of ignoring them", () => {
		// Explore's declared set: everything it lists maps, and the nested-agent
		// tool comes along because pi gates delegation by depth, not by `tools:`.
		expect(claudeToolAllowList(["read", "bash", "grep", "find", "ls"])).toEqual([
			"Read",
			"Bash",
			"Grep",
			"Glob",
			"LS",
			"Task",
		]);
		expect(claudeToolDenyList(["write", "edit", "memory"])).toEqual([
			"Write",
			"Edit",
		]);

		const argv = buildClaudeArgs({
			modelSpec: "sonnet",
			persistSession: false,
			tools: ["Read", "Bash"],
			disallowedTools: ["Write"],
		});
		expect(argv).toEqual(
			expect.arrayContaining([
				"--tools",
				"Read,Bash",
				"--disallowedTools",
				"Write",
			]),
		);
		// `tools: none` is a restriction, and the CLI spells it as an empty value.
		expect(
			buildClaudeArgs({ modelSpec: "sonnet", persistSession: false, tools: [] }),
		).toEqual(expect.arrayContaining(["--tools", ""]));
	});

	it("does not narrow an agent that never declared a tool list", () => {
		// `parseToolsField` fills an omitted `tools:` with the full built-in set, so
		// "every built-in" is what an agent with NO `tools:` line looks like. Treating
		// that as an allowlist would strip Claude Code's own tools (WebFetch, Skill,
		// NotebookEdit, …) from an agent that never asked to be narrowed.
		expect(claudeToolPolicyFor(undefined)).toBeUndefined();
		expect(claudeToolPolicyFor([...BUILTIN_TOOL_NAMES])).toBeUndefined();
		expect(
			claudeToolPolicyFor([...BUILTIN_TOOL_NAMES, "ext:some-extension"]),
		).toBeUndefined();
		// A real restriction is translated.
		expect(claudeToolPolicyFor(["read", "bash", "grep", "find", "ls"])).toEqual([
			"Read",
			"Bash",
			"Grep",
			"Glob",
			"LS",
			"Task",
		]);
		// ...including the empty declaration, which means "no built-ins".
		expect(claudeToolPolicyFor([])).toEqual([]);
	});

	it("recognizes a Claude Code tool name as known rather than as a typo", () => {
		// The runner warns about a `tools:` entry neither side knows. A name in
		// Claude Code's own vocabulary is translated and works, so it must not be
		// reported as missing — only a genuinely unknown one is.
		expect(isClaudeToolName("WebFetch")).toBe(true);
		expect(isClaudeToolName("  todowrite ")).toBe(true);
		expect(isClaudeToolName("memory")).toBe(false);
	});

	it("keeps Claude Code's own tool names and never widens an unmatched list", () => {
		// An agent file written against Claude Code's vocabulary keeps what it names
		// — and `Glob` survives even though pi spells the same job `find`.
		expect(claudeToolPolicyFor(["Read", "Grep", "Glob", "WebFetch"])).toEqual([
			"Read",
			"Grep",
			"Glob",
			"WebFetch",
			"Task",
		]);
		// Nothing recognizable is a restriction that matches nothing, which pi grants
		// as "no tools" — granting EVERY tool instead would invert the declaration.
		expect(claudeToolPolicyFor(["memory"])).toEqual([]);
		// Case and whitespace are the CLI's, not the user's, problem.
		expect(claudeToolPolicyFor([" read ", "WEBFETCH"])).toEqual([
			"Read",
			"WebFetch",
			"Task",
		]);
	});

	it("re-sends the tool policy on a resume rather than widening it", async () => {
		// A resume rebuilds the argv from scratch. Dropping a per-invocation flag
		// would hand a restricted agent the full tool set on its continuation, so the
		// policy is asserted on the flags the CLI was actually spawned with.
		const argvFile = join(workDir, "resume-argv.json");
		const previousArgvFile = process.env.FAKE_CLAUDE_ARGV_FILE;
		process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
		process.env.FAKE_CLAUDE_SCENARIO = "basic";
		try {
			const session = new ClaudeCodeSession({
				messages: [],
				model: createClaudeCodeModel("claude/sonnet"),
				cwd: workDir,
				sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				persisted: true,
				allowedTools: ["Read", "Grep", "Task"],
				disallowedTools: ["Write"],
			});
			const { failure } = await resumeClaudeCodeAgent(session, "and then?", {});
			expect(failure).toBeUndefined();
			const argv = JSON.parse(readFileSync(argvFile, "utf-8")) as string[];
			expect(argv).toEqual(
				expect.arrayContaining(["--tools", "Read,Grep,Task"]),
			);
			expect(argv).toEqual(
				expect.arrayContaining(["--disallowedTools", "Write"]),
			);
			expect(argv).toEqual(
				expect.arrayContaining([
					"--resume",
					"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				]),
			);
		} finally {
			if (previousArgvFile === undefined) delete process.env.FAKE_CLAUDE_ARGV_FILE;
			else process.env.FAKE_CLAUDE_ARGV_FILE = previousArgvFile;
		}
	});
});
