/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Vendor prefixes collapsed on tight rows, longest-first. An empty target drops
 * the vendor entirely — "Kimi K3" and "MiniMax-M3" keep their identity in the
 * version, and only a handful of model names are unmistakable without a vendor.
 * DeepSeek keeps two letters because "v4Pro" alone names no one.
 */
const VENDOR_ABBREVIATIONS: ReadonlyArray<readonly [string, string]> = [
  ["deepseek", "DS"],
  ["minimax", ""],
  ["moonshot", ""],
  ["kimi", ""],
  ["claude", ""],
];

/**
 * A model name squeezed onto a widget row: "DeepSeek V4 Pro" → "DSv4Pro",
 * "GLM-5.3-Flash" → "GLM5.3Flash", "Kimi K3" → "K3".
 *
 * Separators go, and a version marker is lowercased ("V4" → "v4") so the letter
 * reads as part of the number. An unknown vendor only loses its separators: a
 * short label that is merely long beats one that is wrong.
 */
export function shortModelLabel(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  const vendor = VENDOR_ABBREVIATIONS.find(([prefix]) => lower.startsWith(prefix));
  const body = vendor ? trimmed.slice(vendor[0].length) : trimmed;
  return ((vendor?.[1] ?? "") + body).replace(/[\s_-]+/g, "").replace(/V(?=\d)/g, "v");
}

/**
 * Three display forms of a model. `modelShort` goes on tight rows (the widget),
 * `modelName` on roomier ones (the Agent tool result), and `modelId` — the
 * canonical `provider/id` — where two providers serving similarly-named models
 * must be told apart (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string; modelShort: string } {
  const display = model.name ?? model.id;
  return {
    modelName: display.replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
    modelShort: shortModelLabel(display),
  };
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
  const availableSet = new Set(all.map(m => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: prefer exact id match > id contains > name contains > provider+id contains
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  if (slashIdx !== -1) {
    const bare = resolveModel(input.slice(slashIdx + 1), registry);
    if (typeof bare !== "string") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/**
 * Resolve an explicit model request without silently substituting another
 * provider/model for a provider-qualified pin. Unqualified aliases such as
 * "haiku" remain fuzzy by design; provider-qualified requests must resolve to
 * that provider and the same model identity (dot/dash and trailing-date
 * variations are cosmetic).
 */
type ModelResolution = ReturnType<typeof resolveModel>;

export function resolvePinnedModel(
  input: string,
  registry: ModelRegistry,
): ModelResolution {
  const resolved = resolveModel(input, registry);
  if (typeof resolved === "string") {
    return `${resolved}\n\nNo fallback was started. Ask the user before selecting another model.`;
  }

  const slash = input.indexOf("/");
  if (slash === -1) return resolved;

  const requestedProvider = input.slice(0, slash).toLowerCase();
  const requestedId = input.slice(slash + 1);
  const normalizeId = (id: string) => id.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  if (
    resolved.provider.toLowerCase() !== requestedProvider
    || normalizeId(resolved.id) !== normalizeId(requestedId)
  ) {
    return `Requested model "${input}" resolved to "${resolved.provider}/${resolved.id}" instead. `
      + "Refusing to substitute a different pinned model or provider. "
      + "No fallback was started. Ask the user before selecting another model.";
  }
  return resolved;
}
