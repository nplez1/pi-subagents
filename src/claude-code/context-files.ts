/**
 * claude-code/context-files.ts — keep a claude-backed child from reading the
 * same instruction file twice.
 *
 * An `append`-mode agent inherits the parent's rendered system prompt, and pi
 * renders every context file it loaded into that prompt as a
 * `<project_instructions path="…">` block. The `claude` CLI then does its own
 * discovery: every `CLAUDE.md` from the working directory up to the root, the
 * user's `~/.claude/CLAUDE.md`, and whatever those import with `@path`. Where
 * the two overlap — a repo whose `CLAUDE.md` is `@AGENTS.md`, the common way to
 * share one file between both harnesses — the child got that file once in
 * `--append-system-prompt` and again from the CLI. Measured on this machine's
 * reviewer runs, the duplicate was a 27 KB `AGENTS.md`, on every turn of every
 * run.
 *
 * The CLI's copy is the one kept: it is loaded whatever this extension does, so
 * only the inherited copy can be dropped. Files the CLI does NOT load (an
 * `AGENTS.md` nothing imports, pi's own `~/.pi/agent/AGENTS.md`) stay in the
 * inherited prompt, untouched.
 *
 * Deliberately conservative: when the CLI has been told to skip some or all of
 * its instruction files (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, or a
 * `claudeMdExcludes` setting anywhere it reads one), nothing is stripped, so a
 * file is never lost just because the two discovery rules disagree.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The `<sub_agent_context>` a claude-backed child gets in place of pi's, which
 * tells it to prefer pi tools (`read`, `edit`, `find`, `grep`) the CLI does not
 * have. What stays is what holds in either harness.
 */
export const CLAUDE_CODE_BRIDGE = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
- Make independent tool calls in parallel: when you already know several files or searches you need, issue them all in one turn
- Use absolute file paths
- Do not use emojis
- Be concise but complete
</sub_agent_context>`;

/**
 * The top-level sections of pi's rendered prompt that describe pi itself: its
 * tool list, the rules for those tools, its own documentation, its skill index,
 * and its working directory. A claude-backed child has none of those tools —
 * the CLI brings its own, its own skills, and an environment block — so these
 * cost tokens on every turn and point it at tools that do not exist
 * (`codemode`, `todo`, `manage_schedules`). Measured on this machine's reviewer
 * runs, about 16k characters once the duplicate `AGENTS.md` was gone.
 */
const PI_HARNESS_SECTIONS = ["tools", "rules", "docs", "skills", "cwd"];

/** pi's identity paragraph — "You are … inside pi" / "… inside Pi-Bolt" — when it opens the prompt. */
const PI_IDENTITY =
	/^You are [^\n]*\binside (?:Pi-Bolt|pi)\b[^\n]*(?:\n(?!\n)[^\n]*)*\n*/;

function withoutSections(text: string): string {
	let out = text;
	for (const tag of PI_HARNESS_SECTIONS) {
		out = out.replace(
			new RegExp(`(^|\\n)<${tag}>\\n[\\s\\S]*?\\n</${tag}>(?=\\n|$)\\n*`, "g"),
			"$1",
		);
	}
	return out;
}

/**
 * The inherited prompt with pi's harness description removed: its identity
 * paragraph and its `<tools>`, `<rules>`, `<docs>`, `<skills>` and `<cwd>`
 * sections. What is left is what the user and the project said — the
 * `<project_context>` files and anything an extension appended that this does
 * not recognise, which is kept rather than guessed at.
 *
 * Text inside `<project_context>` is never touched, so an `AGENTS.md` that
 * happens to contain a `<rules>` line keeps it. Returns "" when nothing is
 * left, which `buildAgentPrompt` answers with its generic base.
 */
export function withoutPiHarnessSections(prompt: string): string {
	const OPEN = "<project_context>";
	const CLOSE = "</project_context>";
	let out = "";
	let at = 0;
	for (;;) {
		const start = prompt.indexOf(OPEN, at);
		const end = start < 0 ? -1 : prompt.indexOf(CLOSE, start);
		if (start < 0 || end < 0) break;
		out +=
			withoutSections(prompt.slice(at, start)) +
			prompt.slice(start, end + CLOSE.length);
		at = end + CLOSE.length;
	}
	out += withoutSections(prompt.slice(at));
	out = out.replace(PI_IDENTITY, "");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** The CLI follows `@path` imports to this depth, and no further. */
const MAX_IMPORT_DEPTH = 5;

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * `@path` imports in a memory file, resolved against that file's directory.
 * Imports inside fenced code blocks or inline code spans are not imports, which
 * is also how the CLI reads them.
 */
export function importsOf(
	text: string,
	fromDir: string,
	home = homedir(),
): string[] {
	const out: string[] = [];
	let fenced = false;
	for (const line of text.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const prose = line.replace(/`[^`]*`/g, "");
		for (const match of prose.matchAll(
			/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@]+)/g,
		)) {
			const raw = match[1].replace(/[),.;:!?]+$/, "");
			if (!raw) continue;
			const path = raw.startsWith("~/")
				? join(home, raw.slice(2))
				: isAbsolute(raw)
					? raw
					: join(fromDir, raw);
			out.push(path);
		}
	}
	return out;
}

/** Whether a settings file the CLI reads sets `claudeMdExcludes`. */
function excludesConfigured(settingsFiles: string[]): boolean {
	for (const file of settingsFiles) {
		const text = readText(file);
		if (text?.includes("claudeMdExcludes")) return true;
	}
	return false;
}

/**
 * Canonical paths of every instruction file the `claude` CLI will load for a run
 * in `cwd`: each `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` from
 * `cwd` up to the root, `~/.claude/CLAUDE.md`, and their `@` imports.
 *
 * Returns an empty set — strip nothing — when the CLI has been told to load
 * fewer files than that rule finds.
 */
export function claudeLoadedInstructionFiles(
	cwd: string,
	env: Record<string, string | undefined> = process.env,
	home = homedir(),
): Set<string> {
	const loaded = new Set<string>();
	const disabled = env.CLAUDE_CODE_DISABLE_CLAUDE_MDS?.trim();
	if (disabled && disabled !== "0" && disabled.toLowerCase() !== "false")
		return loaded;

	const roots: string[] = [];
	const settings: string[] = [join(home, ".claude", "settings.json")];
	let dir = resolve(cwd);
	for (;;) {
		roots.push(
			join(dir, "CLAUDE.md"),
			join(dir, "CLAUDE.local.md"),
			join(dir, ".claude", "CLAUDE.md"),
		);
		settings.push(
			join(dir, ".claude", "settings.json"),
			join(dir, ".claude", "settings.local.json"),
		);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	roots.push(join(home, ".claude", "CLAUDE.md"));
	if (excludesConfigured(settings)) return loaded;

	const visit = (path: string, depth: number) => {
		if (depth > MAX_IMPORT_DEPTH || !existsSync(path)) return;
		const key = canonical(path);
		if (loaded.has(key)) return;
		loaded.add(key);
		const text = readText(path);
		if (text === undefined) return;
		for (const imported of importsOf(text, dirname(path), home))
			visit(imported, depth + 1);
	};
	for (const root of roots) visit(root, 0);
	return loaded;
}

/**
 * `prompt` without the `<project_instructions path="…">` blocks whose file is
 * in `loaded`. A `<project_context>` wrapper left with no block in it goes too.
 * Byte-identical when nothing matches, so a prompt with no overlap — or a
 * `replace`-mode prompt, which inherits none — is unaffected.
 */
export function withoutClaudeLoadedContext(
	prompt: string,
	loaded: ReadonlySet<string>,
): string {
	if (loaded.size === 0) return prompt;
	const OPEN = '<project_instructions path="';
	const CLOSE = "\n</project_instructions>";
	let out = "";
	let at = 0;
	let removed = false;
	for (;;) {
		const start = prompt.indexOf(OPEN, at);
		if (start < 0) break;
		const pathEnd = prompt.indexOf('">', start + OPEN.length);
		const end = pathEnd < 0 ? -1 : prompt.indexOf(CLOSE, pathEnd);
		if (pathEnd < 0 || end < 0) break;
		let blockEnd = end + CLOSE.length;
		const path = prompt.slice(start + OPEN.length, pathEnd);
		if (loaded.has(canonical(path))) {
			while (prompt[blockEnd] === "\n") blockEnd += 1;
			out += prompt.slice(at, start);
			removed = true;
		} else {
			out += prompt.slice(at, blockEnd);
		}
		at = blockEnd;
	}
	if (!removed) return prompt;
	out += prompt.slice(at);
	return out.replace(
		/<project_context>\nProject-specific instructions and guidelines:\n\n*<\/project_context>\n*/,
		"",
	);
}
