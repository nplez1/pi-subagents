import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../prompts.js";
import {
	CLAUDE_CODE_BRIDGE,
	claudeLoadedInstructionFiles,
	importsOf,
	withoutClaudeLoadedContext,
	withoutPiHarnessSections,
} from "./context-files.js";
import { claudeChildEnv } from "./runner.js";

/** A pi-rendered prompt carrying `files` as project_instructions blocks. */
function rendered(files: { path: string; body: string }[]): string {
	const blocks = files
		.map(
			(file) =>
				`<project_instructions path="${file.path}">\n${file.body}\n\n</project_instructions>\n\n`,
		)
		.join("");
	return `<docs>\nd\n</docs>\n\n<project_context>\nProject-specific instructions and guidelines:\n\n${blocks}</project_context>\n\n<skills>\ns\n</skills>`;
}

let root: string;
let home: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-ctx-")));
	home = join(root, "home");
	mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("importsOf", () => {
	it("resolves relative, absolute and home imports against the importing file", () => {
		expect(
			importsOf(
				"@AGENTS.md\nsee @./docs/a.md and @/abs/b.md\n@~/c.md",
				"/repo",
				"/h",
			),
		).toEqual(["/repo/AGENTS.md", "/repo/docs/a.md", "/abs/b.md", "/h/c.md"]);
	});

	it("ignores code fences, code spans and e-mail addresses", () => {
		expect(
			importsOf(
				"```\n@fenced.md\n```\nuse `@span.md`, mail me@example.com",
				"/r",
				"/h",
			),
		).toEqual([]);
	});
});

describe("claudeLoadedInstructionFiles", () => {
	it("walks CLAUDE.md up from cwd and follows its imports", () => {
		const repo = join(root, "code", "repo");
		const worktree = join(repo, "main");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n");
		writeFileSync(join(repo, "AGENTS.md"), "# rules\n");
		writeFileSync(
			join(worktree, "AGENTS.md"),
			"# worktree rules, imported by nothing\n",
		);

		const loaded = claudeLoadedInstructionFiles(worktree, {}, home);
		expect(loaded.has(join(repo, "CLAUDE.md"))).toBe(true);
		expect(loaded.has(join(repo, "AGENTS.md"))).toBe(true);
		expect(loaded.has(join(worktree, "AGENTS.md"))).toBe(false);
	});

	it("includes the user's ~/.claude/CLAUDE.md", () => {
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "me\n");
		expect(
			claudeLoadedInstructionFiles(root, {}, home).has(
				join(home, ".claude", "CLAUDE.md"),
			),
		).toBe(true);
	});

	it("loads nothing when the CLI has been told to skip its memory files", () => {
		writeFileSync(join(root, "CLAUDE.md"), "x\n");
		expect(
			claudeLoadedInstructionFiles(
				root,
				{ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" },
				home,
			).size,
		).toBe(0);
		expect(
			claudeLoadedInstructionFiles(
				root,
				{ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0" },
				home,
			).size,
		).toBe(1);
	});

	it("loads nothing when a settings file excludes CLAUDE.md files", () => {
		writeFileSync(join(root, "CLAUDE.md"), "x\n");
		mkdirSync(join(root, ".claude"));
		writeFileSync(
			join(root, ".claude", "settings.json"),
			'{"claudeMdExcludes":["**/CLAUDE.md"]}',
		);
		expect(claudeLoadedInstructionFiles(root, {}, home).size).toBe(0);
	});
});

describe("withoutClaudeLoadedContext", () => {
	const shared = { path: "/repo/AGENTS.md", body: "# shared rules" };
	const piOnly = {
		path: "/home/.pi/agent/AGENTS.md",
		body: "# pi user directives",
	};

	it("drops only the blocks the CLI will load", () => {
		const out = withoutClaudeLoadedContext(
			rendered([piOnly, shared]),
			new Set([shared.path]),
		);
		expect(out).toContain(piOnly.body);
		expect(out).not.toContain(shared.body);
		expect(out).toContain("<project_context>");
		expect(out).toContain("<skills>");
		expect(out).toBe(rendered([piOnly]));
	});

	it("drops an emptied project_context wrapper", () => {
		const out = withoutClaudeLoadedContext(
			rendered([shared]),
			new Set([shared.path]),
		);
		expect(out).not.toContain("project_context");
		expect(out).toBe("<docs>\nd\n</docs>\n\n<skills>\ns\n</skills>");
	});

	it("returns the prompt unchanged when nothing overlaps", () => {
		const prompt = rendered([piOnly, shared]);
		expect(
			withoutClaudeLoadedContext(prompt, new Set(["/elsewhere/CLAUDE.md"])),
		).toBe(prompt);
		expect(withoutClaudeLoadedContext(prompt, new Set())).toBe(prompt);
	});
});

describe("withoutPiHarnessSections", () => {
	const piPrompt = [
		"You are a coding assistant running inside Pi-Bolt, a build of pi (a coding agent harness) compiled ahead of time. Help users inspect files, run commands, and modify code.",
		"<tools>\n- read: Read file contents\n- codemode: Run JavaScript that calls other tools\n</tools>",
		"<rules>\n- Use read to examine files instead of cat or sed.\n</rules>",
		"<docs>\nPi documentation: /x/README.md\n</docs>",
		'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/r/AGENTS.md">\n# Rules\n<rules>\nkept: this is the project\'s text\n</rules>\n\n</project_instructions>\n</project_context>',
		"<skills>\nThe following skills…\n<available_skills>\n  <skill><name>s</name></skill>\n</available_skills>\n</skills>",
		"<cwd>\n/r\n</cwd>",
	].join("\n\n");

	it("keeps the project's instructions and drops pi's description of itself", () => {
		const out = withoutPiHarnessSections(piPrompt);
		expect(out.startsWith("<project_context>")).toBe(true);
		expect(out.endsWith("</project_context>")).toBe(true);
		for (const gone of [
			"Pi-Bolt",
			"<tools>",
			"codemode",
			"<docs>",
			"<skills>",
			"<cwd>",
		])
			expect(out).not.toContain(gone);
		// A `<rules>` line inside a project file is the project's, not pi's.
		expect(out).toContain("kept: this is the project's text");
	});

	it("keeps text it does not recognise, and returns empty when nothing is left", () => {
		expect(
			withoutPiHarnessSections("<tools>\nt\n</tools>\n\nAn extension's note."),
		).toBe("An extension's note.");
		expect(
			withoutPiHarnessSections("<tools>\nt\n</tools>\n\n<cwd>\n/r\n</cwd>"),
		).toBe("");
		// Not pi's identity line, so it stays.
		expect(withoutPiHarnessSections("You are a reviewer.")).toBe(
			"You are a reviewer.",
		);
	});

	it("gives an append-mode child the bridge it is handed instead of pi's", () => {
		const config = { name: "reviewer", promptMode: "append", systemPrompt: "" };
		const env = { isGitRepo: false, branch: "", platform: "darwin" };
		const out = buildAgentPrompt(
			config as Parameters<typeof buildAgentPrompt>[0],
			"/r",
			env as Parameters<typeof buildAgentPrompt>[2],
			"",
			{ bridge: CLAUDE_CODE_BRIDGE },
		);
		expect(out).toContain(CLAUDE_CODE_BRIDGE);
		expect(out).not.toContain("Use the read tool");
		// An empty inherited prompt falls back to the generic base, not to nothing.
		expect(out).toContain("general-purpose coding agent");
	});
});

describe("claudeChildEnv", () => {
	it("defaults the prompt-cache TTL to 5 minutes", () => {
		expect(claudeChildEnv({ PATH: "/bin" })).toEqual({
			PATH: "/bin",
			CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
		});
	});

	it("keeps a TTL the parent already chose", () => {
		const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" };
		expect(claudeChildEnv(env)).toBe(env);
	});
});
