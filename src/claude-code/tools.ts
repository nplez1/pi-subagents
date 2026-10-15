/**
 * claude-code/tools.ts — Claude Code tool calls, restated as pi tool calls.
 *
 * The conversation viewer renders a tool call by looking up a pi tool
 * *definition* by name and feeding it the call's arguments
 * (`conversation-viewer.ts` → `toolDefinitionFor`). Claude Code names its tools
 * `Read`/`Edit`/`Bash` and keys them on `file_path`/`old_string`; pi names the
 * same operations `read`/`edit`/`bash` and keys them on `path`/`oldText`. Left
 * alone, every tool row in a Claude Code subagent would fall through to the
 * generic "unknown tool" card and the agent would visibly not look like a pi
 * subagent — which is the entire point of this backend.
 *
 * So each call is translated to the pi spelling before it becomes a pi message.
 * Two consequences worth stating plainly:
 *
 *   1. This is a *display and transcript* mapping. The tool that actually ran was
 *      Claude Code's, with its own semantics (`Edit`'s `replace_all`, `Grep`'s
 *      ripgrep flags, `Glob`'s glob syntax). The arguments are re-keyed, never
 *      reinterpreted, so a rendered row can be missing a nuance the pi tool
 *      would have shown.
 *   2. `Glob` maps to pi's `find`, which is the closest operation pi has. It is
 *      not a faithful match — `find` searches file names/paths while `Glob`
 *      matches glob patterns — so a glob call renders through `find`'s renderer
 *      with its `pattern` argument intact.
 *
 * Tools with no pi counterpart (`TodoWrite`, `WebFetch`, `Task`, `NotebookEdit`,
 * …) keep their Claude Code name. The viewer's `toolDefinitionFor` already falls
 * back to a generic card for an unknown name, which is the honest rendering: pi
 * has no equivalent, so there is nothing to pretend.
 */

import { BUILTIN_TOOL_NAMES } from "../agent-types.js";

/**
 * One translation rule. `args` renames Claude Code argument keys to their pi
 * equivalents; keys absent from the map are dropped, because a leftover
 * `file_path` alongside a mapped `path` would render twice in a definition that
 * only knows about `path`.
 */
interface ToolMapping {
	/** pi tool name that owns the renderer. */
	to: string;
	/** Claude Code argument key → pi argument key. Unlisted keys are dropped. */
	args?: Record<string, string>;
	/** Argument keys copied through unchanged. */
	keep?: readonly string[];
	/**
	 * Post-processing for arguments a rename cannot express — a unit change, or a
	 * shape pi spells differently (`edit`'s `edits[]`). Runs after `keep`/`args`.
	 */
	convert?: (raw: Record<string, unknown>, out: Record<string, unknown>) => void;
}

/**
 * Keyed by Claude Code's tool name, case-sensitively — that name is part of the
 * CLI's wire format, not user input.
 */
const TOOL_MAPPINGS: Record<string, ToolMapping> = {
	Read: { to: "read", args: { file_path: "path" }, keep: ["offset", "limit"] },
	// `content` is the whole point of the call. Without it the transcript shows a
	// write with no body and the row cannot be replayed, since pi's `write`
	// requires `{path, content}` (dist/core/tools/write.js).
	Write: { to: "write", args: { file_path: "path" }, keep: ["content"] },
	// pi's `edit` schema is `{path, edits: [{oldText, newText}]}`
	// (dist/core/tools/edit.js), so the call is rebuilt into that shape rather
	// than relying on the renderer's legacy top-level `oldText`/`newText` branch
	// — emitting BOTH would make `prepareArguments` push a duplicate edit.
	// `replace_all` has no pi argument (pi edits every listed occurrence
	// explicitly), so it is carried for the transcript alone; a renderer ignores
	// keys it does not know.
	Edit: {
		to: "edit",
		args: { file_path: "path", replace_all: "replaceAll" },
		convert: (raw, out) => {
			if (typeof raw.old_string === "string" && typeof raw.new_string === "string") {
				out.edits = [{ oldText: raw.old_string, newText: raw.new_string }];
			}
		},
	},
	Bash: {
		to: "bash",
		keep: ["command"],
		// Claude Code's Bash timeout is MILLISECONDS; pi's is SECONDS
		// (dist/core/tools/bash.js: "Timeout in seconds (optional, no default
		// timeout)"). Passing the number through renders a 120000 ms cap as
		// "120000s" and would fail pi's own maximum on replay.
		convert: (raw, out) => {
			const ms = typeof raw.timeout === "number" ? raw.timeout : Number.NaN;
			if (Number.isFinite(ms) && ms > 0) out.timeout = Math.ceil(ms / 1000);
		},
	},
	Grep: {
		to: "grep",
		// Claude Code spells these the ripgrep way. pi's schema calls them
		// `ignoreCase` and `context` (dist/core/tools/grep.js).
		args: { head_limit: "limit", "-i": "ignoreCase", "-C": "context" },
		// No pi argument exists for the rest of ripgrep's flags (`-A`, `-B`, `-n`,
		// `type`, `output_mode`, `multiline`, `offset`), but they describe what was
		// actually searched, so they stay for the transcript.
		keep: [
			"pattern",
			"path",
			"glob",
			"context",
			"-A",
			"-B",
			"-n",
			"type",
			"output_mode",
			"multiline",
			"offset",
		],
	},
	Glob: { to: "find", keep: ["pattern", "path"] },
	LS: { to: "ls", keep: ["path", "limit"] },
};

/** Result of translating one tool call. */
export interface TranslatedToolCall {
	name: string;
	arguments: Record<string, unknown>;
	/** True when a pi renderer was found for this call. */
	mapped: boolean;
}

/**
 * Translate a Claude Code tool call into its pi spelling.
 *
 * An unrecognized tool keeps its own name and receives its arguments untouched,
 * so a generic card can still show what happened rather than an empty payload.
 */
export function translateToolCall(
	name: string,
	input: Record<string, unknown> | undefined | null,
): TranslatedToolCall {
	const raw = (input ?? {}) as Record<string, unknown>;
	const mapping = TOOL_MAPPINGS[name];
	if (!mapping) return { name, arguments: { ...raw }, mapped: false };

	const out: Record<string, unknown> = {};
	for (const key of mapping.keep ?? []) {
		if (raw[key] !== undefined) out[key] = raw[key];
	}
	for (const [from, to] of Object.entries(mapping.args ?? {})) {
		if (raw[from] !== undefined) out[to] = raw[from];
	}
	mapping.convert?.(raw, out);
	return { name: mapping.to, arguments: out, mapped: true };
}

/**
 * The pi tool names this module can render. Exposed so the session façade can
 * answer `getToolDefinition` for built-ins without depending on the viewer's own
 * imports, and so tests can assert the table stays in sync with pi's built-ins.
 */
export const MAPPED_PI_TOOL_NAMES: readonly string[] = [
	...new Set(Object.values(TOOL_MAPPINGS).map((m) => m.to)),
];

/**
 * pi built-in tool → the Claude Code tool that does the same job.
 *
 * Used for the *policy* flags (`--tools`, `--disallowedTools`), not for the
 * transcript: a tool call still renders through `translateToolCall` above.
 * `find` → `Glob` is the closest pair each side has, matching the transcript
 * mapping rather than a perfect equivalence.
 */
const PI_TO_CLAUDE_TOOL: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	ls: "LS",
};

/**
 * Claude Code's own built-in tool names, canonical casing preserved.
 *
 * Taken from a real `system:init` event (`tools`) on Claude Code 2.1.296, plus
 * the names earlier releases used for the same jobs and that this CLI still
 * accepts (`Glob`, `Grep`, `LS`, `MultiEdit`). Recognized so an agent file
 * written against Claude Code's vocabulary — `tools: Read, WebFetch` — keeps
 * working instead of silently losing every entry it names. An unknown name is
 * ignored by the CLI, so a name that a future release drops is harmless here.
 */
const CLAUDE_TOOL_NAMES: readonly string[] = [
	"Task",
	"TaskStop",
	"Bash",
	"Edit",
	"Glob",
	"Grep",
	"LS",
	"MultiEdit",
	"NotebookEdit",
	"Read",
	"Write",
	"WebFetch",
	"WebSearch",
	"Skill",
	"TodoWrite",
	"BashOutput",
	"KillShell",
	"SlashCommand",
];

/** Canonical Claude Code tool name for a case-insensitive spelling, if any. */
const CLAUDE_TOOL_BY_LOWER: ReadonlyMap<string, string> = new Map(
	CLAUDE_TOOL_NAMES.map((name) => [name.toLowerCase(), name]),
);

/**
 * Whether `name` is a tool the Claude Code CLI itself provides.
 *
 * Used to tell a frontmatter typo from a name written in Claude Code's own
 * vocabulary: the latter is translated and works, so it must not be reported as
 * an unknown built-in.
 */
export function isClaudeToolName(name: string): boolean {
	return CLAUDE_TOOL_BY_LOWER.has(name.trim().toLowerCase());
}

/**
 * Claude Code's nested-subagent tool.
 *
 * Added to any allowlist: what gates delegating further on the pi path is
 * `maxSubagentDepth`, not the `tools:` frontmatter key, so omitting it would
 * make a claude-backed agent less able to delegate than the same agent run in
 * process.
 */
const CLAUDE_TASK_TOOL = "Task";

/**
 * Translate a pi tool declaration into Claude Code `--tools` names.
 *
 * Each entry is either a pi built-in (mapped) or an already-Claude Code tool
 * name (passed through, canonicalized), so a Claude-Code-flavoured agent file
 * keeps the tools it names. Anything else is dropped, and a list where NOTHING
 * survives translates to an empty list — the CLI's `tools:` equivalent of "no
 * built-ins", which is also what pi grants for a name it does not know.
 */
export function claudeToolAllowList(piToolNames: readonly string[]): string[] {
	const names = new Set<string>();
	for (const raw of piToolNames) {
		const name = raw.trim();
		const resolved =
			PI_TO_CLAUDE_TOOL[name.toLowerCase()] ??
			CLAUDE_TOOL_BY_LOWER.get(name.toLowerCase());
		if (resolved) names.add(resolved);
	}
	if (names.size === 0) return [];
	names.add(CLAUDE_TASK_TOOL);
	return [...names];
}

/**
 * The `--tools` value for an agent's declared pi tool list.
 *
 * `undefined` means "no restriction", and covers two cases that are the same
 * thing here: the agent declared nothing, or its list names every pi built-in —
 * which is what an OMITTED `tools:` and `tools: *` both parse to
 * (`parseToolsField` fills the default). Sending that as `--tools` would strip
 * Claude Code's OWN tools (`WebFetch`, `WebSearch`, `Skill`, …) from an agent
 * that never asked to be narrowed, which is a different agent from the one the
 * pi path would run.
 *
 * An empty result is `--tools ""` — the CLI's documented "disable every
 * built-in", and what pi grants when a declared list matches nothing.
 */
export function claudeToolPolicyFor(
	declaredToolNames: string[] | undefined,
): string[] | undefined {
	if (!declaredToolNames) return undefined;
	if (namesEveryPiBuiltin(declaredToolNames)) return undefined;
	return claudeToolAllowList(declaredToolNames);
}

/**
 * Whether a declaration is really "all built-ins".
 *
 * Non-empty on purpose: `tools: none` parses to an empty list, which is a
 * restriction (no built-in tools), not an absence of one.
 */
function namesEveryPiBuiltin(declared: readonly string[]): boolean {
	return (
		declared.length > 0 &&
		BUILTIN_TOOL_NAMES.every((name) => declared.includes(name))
	);
}

/**
 * Translate a pi `disallowed_tools` list into Claude Code `--disallowedTools`.
 *
 * A deny list only ever removes something the user named, so an entry with no
 * Claude Code equivalent is simply dropped rather than widening the list.
 */
export function claudeToolDenyList(piToolNames: readonly string[]): string[] {
	return [
		...new Set(
			piToolNames
				.map(
					(name) =>
						PI_TO_CLAUDE_TOOL[name.trim().toLowerCase()] ??
						CLAUDE_TOOL_BY_LOWER.get(name.trim().toLowerCase()),
				)
				.filter((name): name is string => Boolean(name)),
		),
	];
}
