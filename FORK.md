# Fork notes — pi-subagents

This fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents)
is not a rebase-able branch: it was squashed at **upstream v0.19.0**, so
`git merge upstream/master` has no merge base and never will. Upstream fixes come
in by hand, one commit at a time, and this file records which ones and why.

Current state: upstream **v0.26.1** is fetched as the `upstream` remote
(`upstream/master`, 381 commits ahead of the squash point). Host pi is 1.5.2.

## What is ours, not upstream's

- `src/index.ts` — rewritten (tools, commands, menus, dispatch).
- `src/ui/*` — FleetView, conversation viewer, workflow dialog/menu/card.
- `src/workflow/{progress,task,worker-source}.ts`, `src/{settings,model-scope,model-resolver}.ts`.
- `src/claude-code/` — a whole backend upstream has nothing like.
- `src/schedule-preview.ts`, `docs/scheduling.md`, and the fire log / failure policy / lateness
  accounting in `src/schedule.ts` — `manage_schedules`' `preview`, `get` history and
  `pauseAfterFailures` have no upstream counterpart.
- Tests live beside their modules (`src/<module>.test.ts`). Upstream moved to a
  `test/` directory after 0.19.0; do not copy that layout in.

## Ported (2026-11-18)

| upstream | commit here | what it fixed |
|---|---|---|
| pi 1.x package shape (0.20.0) | `f714035` | Peers were `>=0.84.0` with `@sinclair/typebox` among them, devDeps pinned 0.84.2, so the fork had not been typechecked against a host we run on since 0.19.0. Peers are `>=1.1.0` + `typebox` only, devDeps pin 1.5.2. |
| `#384` mention clone | `6697294` | `@handle` in model mode never took the off-screen route: the clone assigned the getter-only `state.systemPrompt`, threw, and fell back to a visible turn. Rebuilt on `SessionManager.inMemory(cwd, undefined, getBranch())` + a `DefaultResourceLoader` `systemPromptOverride`; `withoutCwdSection` stops the parent's `<cwd>` rendering twice. |
| `#266` schedule lock | `4fe3de8` | A stale lock busy-waited 50 ms × 100 in a `while` loop — five frozen seconds — and a live holder looked the same. Reclaims our own PID or a dead one, fails fast otherwise. Fire-time writes go through `persist()` so a failed write is an event, not a throw out of a timer tick. |
| `#429` saved record | `87cf940` | A completion notification points at `get_subagent_result` for the full text, but the live record is evicted after ~10 min and gone after a reload. The fork appended a `subagents:record` entry at finish and never read it. `src/agent-record-entry.ts` now reads it back (id first, then handle/alias when nothing live answers). |
| `#368` resume budget | `16c9dd9` | `max_turns` was enforced in `runAgent` only; a resumed agent had no cap at all, and resume is exactly how a budget-exhausted run gets pushed further. `resumeAgent` now runs the same steer-then-abort ladder, returns `aborted`/`steered`, and `AgentManager.settleResume` mirrors the spawn settle (a hard abort becomes `aborted`, not `completed`). |
| `#306` thinking level | `0a9a284` | An unset level fell through to pi's global `defaultThinkingLevel`, so a `max` session spawned agents at whatever the machine defaults to. The chain now ends at the parent session's level (`resolveThinkingLevel`, typed for the `"off"` a session can report). |
| `#386` built-ins + trust | `14abbfa` | Subagent settings were trusted by default, so in a project the user declined to trust a subagent still loaded its `.pi` extensions and pi's built-in MCP started its `.pi/mcp.json` servers. `ctx.isProjectTrusted()` is now inherited; `builtin:mcp`/`codemode`/`tool-search` load in subagents at all; `renarrow()` respects `exposure`/`defaultActive`; an inline `tool_call` gate scopes codemode's `ctx.executeTool()` calls, which never reach `agent.beforeToolCall`. |
| `#416` tool names | `b3749eb` | A bare `mcp__<server>__<tool>` in `tools:` was dropped as a mistyped built-in, which left *every* MCP tool reachable. Claude Code spellings (`Read`, `LS`, `Glob`→`find`, `MultiEdit`→`edit`, `disallowedTools`) now parse, and an agent whose `tools:` resolves to nothing is refused instead of spawned tool-less. |
| review follow-ups | `243ad71` | Project agent files now follow project trust (their `extensions:` entries are explicit, trust-exempt sources); `toolsWildcard` keeps "explicit list of every built-in" distinct from `tools: *` for the Claude CLI's `--tools`; the scope gate fails closed before the scope is installed. |

## Assessed and deliberately not taken

- **`#256`/`#316` shutdown disposal** — the leak it fixes is upstream's
  above-editor widget, which this fork replaced with `FleetList` (already
  disposed). `GroupJoinManager` holds no timers. The one interval in that class,
  `AgentManager.cleanupInterval`, is already `unref`'d and cleared in `dispose()`.
- **`pi-vcc`** — nothing upstream worth merging; see
  `docs/upstream-audit-2026-11-18.md` in the parent repo. (`pi-advisor-subagent`
  was in this list until 2026-11-18, when that plugin was removed outright.)
- **Tier 3** (index.ts restructuring, fullscreen observer, workflow inspector,
  `/agents → Settings`) — ours are different implementations, not older ones.

## Known limits of the trust port

Flagged by the review and accepted for now, because each needs a decision about
what "trusted" means rather than a patch:

1. **Plain worktree spawns widen trust.** From a trusted subdirectory, a
   `isolation: "worktree"` spawn runs at the copy's *repository root* with no
   `configCwd`, so both child paths are equal and the child trusts that root's
   `.pi` config. Upstream's rule is equality of the two paths; binding trust to
   the authorized configuration root instead is the real fix.
2. **Cross-directory grandchildren lose extensions.** A nested spawn keeps the
   original `configCwd` but inherits the intermediate session's deliberately
   false trust bit, so discovery back in the trusted parent project is skipped.
3. **Windows `powershell`.** `BUILTIN_TOOL_NAMES` is derived from pi's coding and
   read-only tool factories on the current platform, so a Windows agent whose
   `tools:` names only `powershell` would be refused as "zero tools".
4. **MCP blast radius.** With the default `extensions: true` every subagent loads
   pi's built-in MCP extension and starts every enabled server, narrowed tools or
   not. Free on a machine with no `mcp.json` (none here); opt out with
   `exclude_extensions: builtin:mcp` or `--no-mcp`.

## Re-syncing

Established by the 2026-11-18 audit; a leaner pass than 381 commits will not work.

1. `git fetch upstream` (default branch is **`master`**, not `main`).
2. `git diff v0.19.0 v0.26.1 -- src/<file>` per file, not per commit — upstream
   touches our rewritten files in almost every release.
3. For each candidate: does it fix behaviour *this* fork has right now? Port it as
   its own commit, with a test beside the module.
4. Verify with `npx tsc --noEmit` and `npx vitest run` (baseline recorded there).
5. `biome check` fails repo-wide and has since before the fork work — there is no
   `biome.json`, so it runs on defaults against 2-space `ui/` code. Not a gate.
