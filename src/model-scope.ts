/**
 * model-scope.ts — `scopeModels` policy, shared by the top-level Agent tool and
 * the nested delegation tools so a nested spawn can't escape the allowlist the
 * top-level path enforces.
 *
 * State lives here (rather than in an index.ts closure) for the same reason
 * `disableDefaults` lives in agent-types.ts: both entry points need it.
 */

import { isClaudeCodeModel } from "./claude-code/model.js";
import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";

/**
 * Whether `enabledModels` opts a `claude/*` backend in.
 *
 * Matching is the same exact, case-insensitive `provider/spec` form the rest of
 * the allowlist uses, plus a `claude/*` wildcard for "any Claude Code model" —
 * the spec after the prefix is resolved by the CLI, so there is no registry list
 * to enumerate and picking one spelling per Claude release would go stale.
 */
function isClaudeSpecAllowed(
  model: { provider: string; id: string },
  patterns: string[] | undefined,
): boolean {
  if (!patterns) return false;
  const wanted = model.id.toLowerCase();
  return patterns.some(pattern => {
    const trimmed = pattern?.trim().toLowerCase();
    if (!trimmed?.startsWith("claude/")) return false;
    const spec = trimmed.slice("claude/".length);
    return spec === "*" || spec === wanted;
  });
}

/** Message for a claude spec the allowlist does not carry, naming the fix. */
function claudeOptInHint(): string {
  return [
    "Claude Code models are gated by the same `enabledModels` list. Add the",
    'backend there to allow it, e.g. "claude/sonnet" — or "claude/*" for any',
    "Claude Code model.",
  ].join(" ");
}

/**
 * When enabled, subagent model choices are validated against `enabledModels`
 * from pi's settings — both global `<agentDir>/settings.json` and project-local
 * `<cwd>/.pi/settings.json` (project overrides global). Off by default; opt-in
 * via `/agents → Settings`. See the SubagentsSettings.scopeModels docstring for
 * the hard-error vs warn-and-proceed policy and its rationale.
 */
let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

export type ModelScopeVerdict =
  /** In scope, or nothing to validate against (feature off / no allowlist). */
  | { kind: "ok" }
  /** Caller-supplied out-of-scope choice — refuse the spawn with this message. */
  | { kind: "error"; message: string }
  /** Frontmatter-pinned or parent-inherited — proceed, but tell the user. */
  | { kind: "warn"; message: string };

/**
 * Check the effective resolved model against the user's enabledModels list.
 *
 * scopeModels guards against *runtime* LLM choices, not user-level config:
 *   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
 *     out-of-scope choice; surface it so it picks differently).
 *   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
 *     user authored/installed this agent or chose the parent's model; trust it).
 */
export function checkModelScope(args: {
  model: { provider: string; id: string } | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  /** True when the model came from the tool call rather than frontmatter. */
  callerSupplied: boolean;
  /** Display name used in the warning toast. */
  agentLabel: string;
  /** The raw `model:` input, when there was one. */
  modelInput?: string;
}): ModelScopeVerdict {
  const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
  if (!model) return { kind: "ok" };

  // `claude/*` selects an execution backend rather than a model pi serves, so it
  // can never resolve through `enabledModels` — that list holds provider/modelId
  // pairs pi can actually reach, and `resolveEnabledModels` drops anything it
  // cannot find in the registry. The allowlist therefore cannot *describe* a
  // claude spec, and applying it as written would reject every Claude Code spawn.
  //
  // What it can still do is gate the backend, which matters because the model can
  // be chosen by the LLM through the Agent tool's `model` parameter: without a
  // gate, `model: claude/opus` would be a way around a scope the user switched on
  // deliberately — and the CLI it spawns runs with permissions bypassed. So a
  // `claude/…` entry (or `claude/*` for all of them) in the same list is how the
  // user opts the backend in. Scope enforcement off means no gate at all, exactly
  // as it does for every other model.
  if (isClaudeCodeModel(model)) {
    if (!scopeModelsEnabled) return { kind: "ok" };
    if (isClaudeSpecAllowed(model, readEnabledModels(cwd))) return { kind: "ok" };
    const list = claudeOptInHint();
    if (callerSupplied) {
      return {
        kind: "error",
        message: `Model not in scope: "${modelInput ?? model.id}".\n\n${list}`,
      };
    }
    return {
      kind: "warn",
      message: `Agent "${agentLabel}" using out-of-scope model "${modelInput ?? model.id}"`,
    };
  }

  if (!scopeModelsEnabled) return { kind: "ok" };

  const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
  if (!allowed || isModelInScope(model, allowed)) return { kind: "ok" };

  if (callerSupplied) {
    const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
    return {
      kind: "error",
      message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
    };
  }
  const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
  return {
    kind: "warn",
    message: `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
  };
}
