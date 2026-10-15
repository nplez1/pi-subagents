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

/**
 * Provider id used for the synthetic model. Not a pi provider — no entry in
 * `models-store.json` claims it, and `enabledModels` never contains it, which is
 * why the scope check has to special-case it rather than resolve it.
 */
export const CLAUDE_CODE_PROVIDER = "claude";

/** `claude/` prefix, as authored in frontmatter and the `Agent` tool's `model`. */
const CLAUDE_CODE_PREFIX = `${CLAUDE_CODE_PROVIDER}/`;

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
