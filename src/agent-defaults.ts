/**
 * agent-defaults.ts — Runtime glue for the per-agent defaults configured with
 * `/subagents` (`subagents.json` → `agentOverrides`).
 *
 * The Agent tool and the nested delegation tools fold those defaults in through
 * `resolveAgentInvocationConfig`, which owns the precedence rule. This module is
 * for the paths that BYPASS that function — cross-extension RPC, `@handle`
 * mentions and the `Symbol.for("pi-subagents:manager")` registry (all funnelled
 * through `spawnResolved`), plus the scheduler — because an agent's configured
 * default should apply however it was started.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentConfig } from "./agent-types.js";
import { resolvePinnedModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import type { ThinkingLevel } from "./types.js";

export interface AgentDefaultResolution {
  /** The caller's model when it had one, else the configured default. */
  model?: Model<any>;
  /** The caller's level when it had one, else the configured default. */
  thinkingLevel?: ThinkingLevel;
  /**
   * A configured default existed but could not be used. Fail loud rather than
   * silently inheriting: the default is user configuration, and quietly running
   * a different model is the substitution `resolvePinnedModel` exists to refuse.
   */
  error?: string;
}

/**
 * Fill an agent's configured default model/thinking into spawn options a caller
 * left unset. Explicit options always win, so this never overrides a caller.
 *
 * Scope validation treats the default like frontmatter (`callerSupplied: false`):
 * it is user-level configuration, so an out-of-scope default WARNS and runs,
 * rather than erroring like a runtime LLM choice.
 */
export function applyAgentDefaults(
  type: string,
  options: { model?: Model<any> | null; thinkingLevel?: ThinkingLevel | null },
  ctx: ExtensionContext,
): AgentDefaultResolution {
  const cfg = getAgentConfig(type);
  const thinkingLevel = options.thinkingLevel ?? cfg?.defaultThinking ?? undefined;

  // `!= null` on purpose: a JSON-forwarding RPC caller can serialize an unset
  // field as null, and null means "inherit" — not an override to keep.
  if (options.model != null) return { model: options.model, thinkingLevel };

  const modelInput = cfg?.defaultModel;
  if (!modelInput) return { thinkingLevel };

  const resolved = resolvePinnedModel(modelInput, ctx.modelRegistry);
  if (typeof resolved === "string") {
    return {
      thinkingLevel,
      error: `Configured default model for ${cfg?.displayName ?? type} could not be used. ${resolved}`,
    };
  }

  const verdict = checkModelScope({
    model: resolved,
    cwd: ctx.cwd,
    modelRegistry: ctx.modelRegistry,
    callerSupplied: false,
    agentLabel: cfg?.displayName ?? type,
    modelInput,
  });
  if (verdict.kind === "warn") ctx.ui?.notify(verdict.message, "warning");
  if (verdict.kind === "error") return { thinkingLevel, error: verdict.message };
  return { model: resolved, thinkingLevel };
}
