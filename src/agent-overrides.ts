/**
 * agent-overrides.ts — Per-agent defaults and enable/disable state configured
 * through `/subagents`, persisted in `subagents.json` (`agentOverrides`).
 *
 * Why this exists outside the agent `.md`:
 *
 *   - A frontmatter `model:`/`thinking:` is a PIN — the driving model cannot
 *     override it (`invocation-config.ts` gives it top precedence). What a user
 *     wants to configure per agent here is a DEFAULT: it applies only where
 *     neither the file nor the caller said anything, so `Agent({ model })` still
 *     wins. That is a different precedence slot, so it needs a different field.
 *   - Plugin-provided agents live in someone else's repo, often as symlinks
 *     (`~/.pi/agent/agents/rpiv-advisor.md` → a dotfiles checkout). Writing
 *     `enabled:` or `model:` into them would mutate an unrelated working tree.
 *     Settings are ours to write; agent files may not be.
 *
 * The module is deliberately pure: it knows about `AgentConfig` and JSON, not
 * about the filesystem or the model registry, so the merge and apply rules can
 * be unit-tested without a session.
 *
 * Precedence this feeds into (see `resolveAgentInvocationConfig`):
 *
 *   file pin > caller param > configured default > shipped default > inherit
 */

import type { AgentConfig, ThinkingLevel } from "./types.js";

/**
 * Thinking levels accepted in an override. Mirrors the list the Agent tool and
 * the `/agents` manual wizard advertise (pi-ai's EXTENDED_THINKING_LEVELS);
 * a value outside it is dropped rather than persisted as a level pi would
 * reject at spawn time.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const VALID_THINKING: ReadonlySet<string> = new Set(THINKING_LEVELS);

/**
 * One agent's configured overrides. Every field is independently optional, and
 * an absent field means "not configured" — never "set to undefined", which is
 * why `setOverrideField` deletes rather than stores undefined.
 */
export interface AgentOverride {
  /** Overridable default model — `provider/modelId` or a fuzzy alias. */
  model?: string;
  /** Overridable default thinking level. */
  thinking?: ThinkingLevel;
  /**
   * Explicit enable/disable. `false` disables even an agent with no disable
   * flag; `true` re-enables one whose `.md` carries `enabled: false` (the menu
   * needs that without editing the file). Absent, the agent file decides.
   */
  enabled?: boolean;
}

export type AgentOverrideMap = Record<string, AgentOverride>;

/** Where an override map is read from / written to. */
export type OverrideScope = "global" | "project";

/** Drop anything that isn't a well-formed override. Silent — garbage becomes absent. */
export function sanitizeAgentOverrides(raw: unknown): AgentOverrideMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: AgentOverrideMap = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = name.trim();
    if (!key) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const entry: AgentOverride = {};
    if (typeof v.model === "string" && v.model.trim()) entry.model = v.model.trim();
    if (typeof v.thinking === "string" && VALID_THINKING.has(v.thinking)) {
      entry.thinking = v.thinking as ThinkingLevel;
    }
    if (typeof v.enabled === "boolean") entry.enabled = v.enabled;
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

/**
 * Merge two override maps field-by-field, project over global. A shallow spread
 * of the settings objects would replace the whole `agentOverrides` map, so a
 * project that configured one agent would silently erase every global default.
 */
export function mergeAgentOverrides(
  base: AgentOverrideMap | undefined,
  override: AgentOverrideMap | undefined,
): AgentOverrideMap {
  const out: AgentOverrideMap = { ...(base ?? {}) };
  for (const [name, patch] of Object.entries(override ?? {})) {
    out[name] = { ...out[name], ...patch };
  }
  return out;
}

/**
 * Immutably set/clear fields on one agent's override. A `patch` value of
 * `undefined` clears that field; an entry left with no fields is removed
 * entirely so a cleared override does not linger as `{}` in the file.
 * Re-setting a field to its current value returns an equal map, which lets the
 * caller skip the write.
 */
export function setOverrideField(
  map: AgentOverrideMap,
  name: string,
  patch: AgentOverride,
): AgentOverrideMap {
  const merged: AgentOverride = { ...map[name] };
  for (const key of ["model", "thinking", "enabled"] as const) {
    // `in`, not `=== undefined`: an ABSENT key means "leave this field alone",
    // while a key explicitly set to undefined means "clear it".
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else (merged as Record<string, unknown>)[key] = value;
  }
  const out: AgentOverrideMap = { ...map };
  if (Object.keys(merged).length === 0) delete out[name];
  else out[name] = merged;
  return out;
}

/** Whether an override carries anything at all. */
export function isEmptyOverride(override: AgentOverride | undefined): boolean {
  return !override || Object.keys(override).length === 0;
}

/** True when two override maps are field-for-field identical (write-skip check). */
export function agentOverridesEqual(a: AgentOverrideMap, b: AgentOverrideMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (!x || !y) {
      if (x !== y) return false;
      continue;
    }
    if (x.model !== y.model || x.thinking !== y.thinking || x.enabled !== y.enabled) return false;
  }
  return true;
}

/**
 * Resolve an override's key against a registry's canonical names. Exact match
 * wins; otherwise the name must match exactly one key case-insensitively,
 * mirroring `resolveUnambiguousKeyIn` — two agents differing only in case are
 * reachable, and guessing between them would apply a model to the wrong agent.
 */
export function resolveOverrideKey(
  agents: Map<string, AgentConfig>,
  name: string,
): string | undefined {
  if (agents.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...agents.keys()].filter((key) => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The map key that already holds an override for `name`, or undefined. Same
 * exact-then-unique-case-insensitive rule as `resolveOverrideKey`, but over the
 * persisted map — so `/subagents` edits a hand-written `Explore:` entry instead
 * of adding a second `explore:` key beside it.
 */
export function resolveOverrideMapKey(
  map: AgentOverrideMap,
  name: string,
): string | undefined {
  if (map[name]) return name;
  const lower = name.toLowerCase();
  const matches = Object.keys(map).filter((key) => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Fold overrides into a built registry.
 *
 * Overridden agents are CLONED rather than mutated in place. The embedded
 * `DEFAULT_AGENTS` objects are shared by value across every registry — the
 * process-wide one and each nested config root's private one — so mutating one
 * to apply a project's default would leak that default into an unrelated
 * session's registry.
 *
 * An override naming an agent that isn't registered is ignored: the agent may
 * have been deleted, or its file may not exist yet. The override stays in the
 * file, so re-adding the agent picks the default back up.
 */
export function applyAgentOverrides(
  agents: Map<string, AgentConfig>,
  overrides: AgentOverrideMap | undefined,
): void {
  if (!overrides) return;
  for (const [name, override] of Object.entries(overrides)) {
    const key = resolveOverrideKey(agents, name);
    if (key === undefined) continue;
    const cfg = agents.get(key);
    if (!cfg) continue;
    const next: AgentConfig = { ...cfg };
    if (override.model !== undefined) next.defaultModel = override.model;
    if (override.thinking !== undefined) next.defaultThinking = override.thinking;
    if (override.enabled !== undefined) next.enabled = override.enabled;
    agents.set(key, next);
  }
}

/**
 * Whether a config's `model`/`thinking` is an authored file pin (authoritative)
 * or the shipped default of an embedded agent (itself a default).
 *
 * A user `.md` that overrides a built-in replaces the embedded config wholesale,
 * so `isDefault && no sourcePath` identifies only the shipped entries in
 * `DEFAULT_AGENTS`. That distinction is what lets a bare `Explore` — pinned to
 * the exploration model by the extension itself — still have that pin
 * re-pointed by a configured default, while a pin the user or a plugin wrote in
 * a file keeps its authority.
 */
export function isFilePin(cfg: AgentConfig | undefined): boolean {
  return cfg?.isDefault !== true || cfg?.sourcePath !== undefined;
}
