/**
 * claude-code/model.ts — the `claude/*` model spec, and the synthetic pi `Model`
 * that stands in for it.
 *
 * A subagent whose model is spelled `claude/sonnet` is executed by the external
 * `claude` CLI (Claude Code, `-p` mode) instead of a pi session. Nothing else
 * about the spawn changes: the same agent frontmatter, the same Agent-tool
 * parameters, the same widget, conversation viewer and usage accounting. Only
 * the backend that produces the events differs.
 *
 * Backend selection deliberately rides on the *resolved model* rather than a new
 * config field or frontmatter key. Every spawn path in this extension already
 * resolves a model string to a `Model` and threads that object down through
 * `AgentInvocation` → `SpawnOptions` → `RunOptions`, so detecting the spec here —
 * before the registry is consulted — routes all of them (the `Agent` tool, the
 * nested delegation tools, workflow `agent()` calls, the scheduler, the
 * cross-extension RPC bridge, `/subagents` defaults and the runner's own
 * fallback) without a single one of them having to know Claude Code exists.
 * `runAgent` then branches on `model.provider`.
 *
 * The cost of that choice: a synthetic `Model` object reaches code paths that
 * assume a real registry entry. It is only ever consulted for `provider`, `id`,
 * `name` (via `describeModel`) and equality, and the run branches away before
 * any of them reach pi's session machinery — but a synthetic model must never
 * be handed to `createAgentSession`.
 */

import type { Model } from "@earendil-works/pi-ai";
import { readClaudeCodeSetting, settingsFileSignature } from "../settings.js";

/**
 * Provider id used for the synthetic model. Not a pi provider — no entry in
 * `models-store.json` claims it, and `enabledModels` never contains it, which is
 * why the scope check has to special-case it rather than resolve it.
 */
export const CLAUDE_CODE_PROVIDER = "claude";

/** `claude/` prefix, as authored in frontmatter and the `Agent` tool's `model`. */
const CLAUDE_CODE_PREFIX = `${CLAUDE_CODE_PROVIDER}/`;

/**
 * Whether this install may run the Claude Code backend at all. Defaults to
 * `true`, so an existing setup is unchanged.
 *
 * The switch exists for machines that cannot use the external CLI — no `claude`
 * binary, or a policy that forbids it — while the same Claude models remain
 * reachable through a provider pi serves (Copilot, Anthropic, Bedrock). On such a
 * machine the backend must be neither selectable nor silently substituted: a
 * `claude/sonnet` that fell through to fuzzy registry matching could land on
 * whatever else spells "sonnet".
 *
 * Module state rather than a parameter, matching `scopeModels` (model-scope.ts):
 * resolution happens in `resolveModel`, which is called from the Agent tool, the
 * cross-extension RPC bridge, workflows, the scheduler and the runner's fallback
 * — threading a settings scope through all of them would mean six ways to forget
 * it, and one of them being stale is exactly the bug.
 *
 * `undefined` means "no file set it", which reads as enabled. Keeping the two
 * apart matters when writing settings back, and is why this key is NOT part of
 * the settings-menu snapshot: a snapshot records the EFFECTIVE value, which would
 * freeze today's default `true` into a project file and silently shadow a `false`
 * set globally later. `saveClaudeCodeSetting` writes the file that already sets
 * it instead.
 *
 * The value is re-read from disk (mtime-guarded, so an unchanged file costs two
 * `stat`s and no parse) rather than captured once at extension start. The advisor
 * plugin reads the same two files on every call, and a machine whose backend was
 * switched off in `subagents.json` must be seen as off by BOTH the report and the
 * spawn — a startup-only copy would let a hand edit make the advisor refuse a
 * stage that runs, or promise one the spawn then refuses.
 */
let claudeCodeSetting: boolean | undefined;

/** Cache of the last file read; `signature` changes when either file does. */
let fileCache: { signature: string; value: boolean | undefined } | undefined;

function fileSetting(cwd: string): boolean | undefined {
  const signature = settingsFileSignature(cwd);
  if (fileCache?.signature === signature) return fileCache.value;
  const value = readClaudeCodeSetting(cwd);
  fileCache = { signature, value };
  return value;
}

/** `cwd` is the project scope; the callers default to the session's, tests to theirs. */
export function isClaudeCodeEnabled(cwd: string = process.cwd()): boolean {
  // Disk wins; the module value covers the one case disk cannot — a menu write
  // that failed to persist, which is reported as "session only" at the time.
  return (fileSetting(cwd) ?? claudeCodeSetting) !== false;
}

/**
 * The session-only value, the one thing a file cannot express: set by a menu
 * toggle whose write FAILED, and cleared by any write that succeeded. Exported so
 * the settings events can publish it — a listener must not be handed the effective
 * value instead, which is usually just the file's, re-published. A listener that
 * cached that would keep answering from a line the user has since deleted.
 */
export function getClaudeCodeSessionSetting(): boolean | undefined {
  return claudeCodeSetting;
}

/** `undefined` restores the default (enabled), for a file that stops setting it. */
export function setClaudeCodeEnabled(value: boolean | undefined): void {
  claudeCodeSetting = value;
  // A write may land in the same millisecond as the one the cache recorded.
  fileCache = undefined;
}

/**
 * The refusal for a `claude/*` spec on a machine with the backend switched off.
 * Names the switch and the way out, because the model string itself looks valid
 * and nothing else in the system would explain why it will not run.
 */
export function claudeCodeDisabledMessage(input: string): string {
  return [
    `The Claude Code backend is disabled on this machine, so "${input}" cannot run.`,
    "It is switched off by `\"claudeCode\": false` in subagents.json — /agents → Settings → Claude Code.",
    "Pick a model from a provider pi serves instead (for the same Claude models, e.g. the",
    "Copilot or Anthropic entries in /subagents), or remove that setting to re-enable the backend.",
  ].join(" ");
}

/**
 * Cheap shape test for a raw model *string* (`"claude/sonnet"`), before any
 * resolution. Requires a non-empty spec, so a bare `"claude/"` is not a Claude
 * Code request and falls through to the registry, where it fails loudly as an
 * unknown model instead of spawning a CLI whose `--model` is empty.
 */
export function isClaudeCodeModelSpec(input: string | undefined): boolean {
	if (typeof input !== "string") return false;
	const trimmed = input.trim();
	return (
		trimmed.startsWith(CLAUDE_CODE_PREFIX) &&
		trimmed.length > CLAUDE_CODE_PREFIX.length
	);
}

/**
 * The alias specs offered by the `/subagents` model picker.
 *
 * A convenience list, not a registry: the CLI resolves any alias or full id
 * itself, and `custom…` in the picker still accepts others. Kept to the stable
 * aliases rather than enumerating dated ids that go stale with every release.
 */
export const CLAUDE_CODE_MODEL_ALIASES: readonly string[] = ["opus", "sonnet", "fable", "haiku"];

/**
 * The part after `claude/`, passed to the CLI as `--model`. Claude Code accepts
 * both aliases (`sonnet`, `opus`, `fable`) and full ids
 * (`claude-sonnet-4-5-20250929`), and resolves them itself — so this is a
 * pass-through, deliberately not validated against a list that would go stale
 * with every model release.
 */
export function claudeCodeModelSpec(input: string): string {
	return input.trim().slice(CLAUDE_CODE_PREFIX.length);
}

/**
 * Marker carried by the synthetic model, so the backend is recognized by what
 * this module built rather than by the provider string alone.
 *
 * A plain `provider === "claude"` test would also match a *real* pi provider
 * named `claude` (a user can define one), silently routing that provider's
 * models to the external CLI. The marker is a plain enumerable property, so it
 * survives a structured clone or a cross-extension RPC hop — which is why the
 * check is keyed on the object rather than on identity.
 */
export const CLAUDE_CODE_BACKEND_MARKER = "claudeCodeBackend";

/**
 * Whether a resolved model selects the Claude Code backend.
 *
 * Takes a structural argument rather than pi's `Model` because callers check it
 * at different points in resolution — `checkModelScope` sees a bare
 * `{ provider, id }`, which a nominal `Model` signature would reject.
 */
export function isClaudeCodeModel(
	model:
		| { provider?: string; id?: string; claudeCodeBackend?: boolean }
		| undefined
		| null,
): boolean {
	return (
		model?.provider === CLAUDE_CODE_PROVIDER &&
		model.claudeCodeBackend === true
	);
}

/**
 * Build the stand-in `Model` for a `claude/*` spec.
 *
 * Fields are filled to satisfy pi's `Model` interface rather than to be
 * meaningful: `contextWindow`/`maxTokens`/`cost` are zero because the CLI
 * reports its own usage and pricing (the `result` event's `usage` and
 * `total_cost_usd`), and this object never prices anything. `reasoning` is true
 * because every current Claude model does, which keeps the thinking-level
 * surfaces from hiding the control the `--effort` mapping below drives.
 *
 * `api` is `anthropic-messages` for the same reason the provider is `claude`:
 * it is the truthful description of what is on the other end, so any diagnostic
 * that prints it says something accurate.
 */
export function createClaudeCodeModel(input: string): Model<any> {
	return buildClaudeCodeModel(claudeCodeModelSpec(input));
}

/**
 * The reverse: a bare spec taken from a sidecar (`"sonnet"`) back into the
 * synthetic model. Used when a resume is dispatched by the sidecar rather than
 * by a `claude/*` model string the caller supplied.
 */
export function claudeCodeModelFromSpec(spec: string): Model<any> {
	return buildClaudeCodeModel(spec);
}

function buildClaudeCodeModel(spec: string): Model<any> {
	return {
		id: spec,
		name: spec,
		api: "anthropic-messages",
		provider: CLAUDE_CODE_PROVIDER,
		// What `isClaudeCodeModel` keys on: the provider string alone is not
		// enough, since a user-defined pi provider may be called `claude` too.
		claudeCodeBackend: true,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
		maxTokens: 0,
	} as unknown as Model<any>;
}

/**
 * pi thinking levels → Claude Code's `--effort` values.
 *
 * The two scales are nearly the same enum, with one asymmetry: pi has `minimal`
 * and Claude Code does not, while Claude Code's lowest setting (`low`) is
 * already "spend as little as possible". Folding `minimal` into `low` keeps the
 * setting accepted — the alternative, dropping it, would silently run a
 * `thinking: minimal` agent at the CLI's default and make the frontmatter a lie.
 *
 * `undefined` returns nothing, so the flag is omitted and the CLI's own default
 * applies — which is what `thinking:` unset means for a pi agent too.
 */
export function effortForThinkingLevel(
	level: string | undefined,
): string | undefined {
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return undefined;
	}
}
