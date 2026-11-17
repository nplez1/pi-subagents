import { describe, expect, it } from "vitest";
import { runWorkflow, type WorkflowHost } from "./runtime.js";
import { collapse, type WorkflowEntry } from "./progress.js";

/**
 * The round inference, driven through a real run.
 *
 * Every case here is a script shape rather than a rule: the signal is the
 * script's own `phase()` sequence, and the only honest way to test it is to run
 * a script through the worker. A stub host keeps it to spawning, and no model is
 * involved — `spawnAgent` answers immediately.
 */
function stubHost(): WorkflowHost {
  return {
    async spawnAgent() {
      return { ok: true, text: "ok", tokens: 10, outputTokens: 5 };
    },
    abortAgent() {
      /* nothing in flight outlives the call */
    },
  };
}

/** Round of each agent, in launch order, from the collapsed log. */
async function roundsOf(script: string): Promise<number[]> {
  const result = await runWorkflow({ script, host: stubHost() });
  return collapse(result.progress as WorkflowEntry[]).agents.map(agent => agent.roundIndex ?? 1);
}

const meta = `export const meta = { name: "rounds", description: "round inference" };`;

describe("round inference", () => {
	it("counts a loop's passes when it returns to its first phase", async () => {
		// The shape the ps-drive workflows have: four phases re-entered each pass.
		const rounds = await roundsOf(`
${meta}
for (let i = 0; i < 3; i++) {
  phase("Wait"); await agent("claim");
  phase("Sync"); await agent("sync");
  phase("Run"); await agent("run");
}
return "done";
`);
		expect(rounds).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
	});

	it("counts a one-phase loop, which has no forward movement to detect", async () => {
		// Re-entering the same phase counts only when work happened under it, so
		// this is the second half of the inference rather than an accident of it.
		const rounds = await roundsOf(`
${meta}
for (let i = 0; i < 3; i++) {
  phase("Tick"); await agent("tick");
}
return "done";
`);
		expect(rounds).toEqual([1, 2, 3]);
	});

	it("leaves a linear script in one round", async () => {
		const rounds = await roundsOf(`
${meta}
phase("Triage"); await agent("triage");
phase("Fix"); await agent("fix");
phase("Review"); await agent("review");
return "done";
`);
		expect(rounds).toEqual([1, 1, 1]);
	});

	it("does not count a phase re-entered before any work ran under it", async () => {
		// An idempotent `phase()` call is not a loop: nothing happened since the
		// first one, and a round boundary there would be invented.
		const rounds = await roundsOf(`
${meta}
phase("Scan");
phase("Scan");
await agent("scan");
return "done";
`);
		expect(rounds).toEqual([1]);
	});

	it("never counts an explicit agent({ phase }) as a pass on its own", async () => {
		// `opts.phase` files an agent under a phase without moving the ambient one,
		// so a pipeline whose stages only use it leaves the cursor untouched — which
		// is what keeps interleaved stages from inventing rounds.
		const rounds = await roundsOf(`
${meta}
await pipeline([0, 1, 2], (i) => agent("item " + i, { phase: "Stage" }));
return "done";
`);
		expect(rounds).toEqual([1, 1, 1]);
	});

	it("gives a nested run's agents the round that called it", async () => {
		const host = stubHost();
		const child = `export const meta = { name: "child", description: "child" };\nawait agent("kid");\nreturn "child done";`;
		host.loadWorkflow = () => ({ ok: true, script: child });
		const result = await runWorkflow({
			script: `
${meta}
phase("A"); await agent("a1");
phase("B"); await agent("b1");
phase("A"); await agent("a2");
await workflow("child");
return "done";
`,
			host,
		});
		const rounds = collapse(result.progress as WorkflowEntry[]).agents.map(agent => agent.roundIndex ?? 1);
		// Round 2 starts at the second "A"; the child runs inside it, in a scope of
		// its own that must not advance the parent's cursor.
		expect(rounds).toEqual([1, 1, 2, 2]);
	});
});

describe("round inference around fan-outs", () => {
	// A `phase()` inside a fan-out is per-item work, not a pass: N items each
	// naming a phase is one round over N items. Counting them as revisits made a
	// pipeline of three look like three rounds, which then drew one item as "the
	// live round" and measured the size warning against a single agent.
	it("treats a parallel() of phase-setting thunks as one round", async () => {
		const rounds = await roundsOf(`
${meta}
await parallel([0, 1, 2].map(i => async () => {
  phase("Review");
  return await agent("review " + i);
}));
return "done";
`);
		expect(rounds).toEqual([1, 1, 1]);
	});

	it("treats a pipeline() whose stages name phases as one round", async () => {
		const rounds = await roundsOf(`
${meta}
await pipeline([0, 1, 2],
  (i) => { phase("Review"); return agent("review " + i); },
  (r, i) => { phase("Fix"); return agent("fix " + i); });
return "done";
`);
		expect(rounds).toEqual([1, 1, 1, 1, 1, 1]);
	});

	it("still counts the loop that wraps a fan-out", async () => {
		const rounds = await roundsOf(`
${meta}
for (let n = 0; n < 2; n++) {
  phase("Wait"); await agent("claim");
  phase("Run"); await pipeline([0, 1], (i) => { phase("Triage"); return agent("triage " + i); });
  phase("Report"); await agent("report");
}
return "done";
`);
		// Round 1: claim, two triages, report. Round 2: the same.
		expect(rounds).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
	});
});
