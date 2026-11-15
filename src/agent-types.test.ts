/**
 * agent-types.test.ts — dispatch resolution for a caller-supplied type.
 *
 * The Agent tool's `subagent_type` is optional, so "no type at all" has to be a
 * deliberate answer rather than a schema rejection: it is the same
 * unresolvable-name branch `fallbackSubagent` governs, which keeps a project
 * that routes unknown types somewhere specific routing an omitted one the same
 * way — and keeps `fallbackSubagent: none` fail-closed for it too.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	buildAgentRegistry,
	NO_FALLBACK,
	resolveSpawnTypeIn,
	setFallbackSubagent,
} from "./agent-types.js";

/** The embedded defaults, which is all these cases need. */
function registry() {
	return buildAgentRegistry(new Map());
}

// Module state: every case sets it, and this keeps one case's policy out of
// the next.
afterEach(() => {
	setFallbackSubagent(undefined);
});

describe("resolveSpawnTypeIn with an omitted type", () => {
	it("falls back to general-purpose when no fallback is configured", () => {
		setFallbackSubagent(undefined);
		const dispatch = resolveSpawnTypeIn(registry(), undefined);
		expect(dispatch).toEqual({
			ok: true,
			type: "general-purpose",
			fellBackFrom: "",
		});
	});

	it("treats an absent type exactly like a blank one", () => {
		setFallbackSubagent(undefined);
		expect(resolveSpawnTypeIn(registry(), "")).toEqual(
			resolveSpawnTypeIn(registry(), undefined),
		);
		expect(resolveSpawnTypeIn(registry(), "   ")).toEqual(
			resolveSpawnTypeIn(registry(), undefined),
		);
		// A non-string (a model that fills the field with null) is not a type either.
		expect(resolveSpawnTypeIn(registry(), null)).toEqual(
			resolveSpawnTypeIn(registry(), undefined),
		);
	});

	it("uses a configured fallback agent instead of general-purpose", () => {
		setFallbackSubagent("Explore");
		const dispatch = resolveSpawnTypeIn(registry(), undefined);
		expect(dispatch).toEqual({ ok: true, type: "Explore", fellBackFrom: "" });
	});

	it("fails closed under strict dispatch, naming the reason", () => {
		setFallbackSubagent(NO_FALLBACK);
		const dispatch = resolveSpawnTypeIn(registry(), undefined);
		expect(dispatch.ok).toBe(false);
		if (dispatch.ok) return;
		expect(dispatch.message).toContain("No agent type given.");
		// The available list is what makes the refusal actionable.
		expect(dispatch.message).toContain("general-purpose");
	});

	it("still refuses on a configured fallback that does not resolve", () => {
		setFallbackSubagent("no-such-agent");
		const dispatch = resolveSpawnTypeIn(registry(), undefined);
		expect(dispatch.ok).toBe(false);
		if (dispatch.ok) return;
		expect(dispatch.message).toContain(
			'The configured fallbackSubagent "no-such-agent" is itself',
		);
	});
});
