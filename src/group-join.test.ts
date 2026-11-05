import { describe, expect, it, vi } from "vitest";
import { GroupJoinManager } from "./group-join.js";
import type { AgentRecord } from "./types.js";

function record(id: string): AgentRecord {
	return { id } as AgentRecord;
}

describe("GroupJoinManager", () => {
	it("delivers each grouped completion immediately without waiting for peers", () => {
		const deliver = vi.fn();
		const manager = new GroupJoinManager(deliver);
		manager.registerGroup("batch", ["fast", "slow"]);

		expect(manager.onAgentComplete(record("fast"))).toBe("delivered");
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(deliver).toHaveBeenCalledWith([
			expect.objectContaining({ id: "fast" }),
		]);
		expect(manager.isGrouped("slow")).toBe(true);

		expect(manager.onAgentComplete(record("slow"))).toBe("delivered");
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(manager.isGrouped("fast")).toBe(false);
		expect(manager.isGrouped("slow")).toBe(false);
	});

	it("passes through agents that are not in a group", () => {
		const deliver = vi.fn();
		const manager = new GroupJoinManager(deliver);

		expect(manager.onAgentComplete(record("ungrouped"))).toBe("pass");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("does not deliver an agent more than once", () => {
		const deliver = vi.fn();
		const manager = new GroupJoinManager(deliver);
		manager.registerGroup("batch", ["agent"]);

		expect(manager.onAgentComplete(record("agent"))).toBe("delivered");
		expect(manager.onAgentComplete(record("agent"))).toBe("pass");
		expect(deliver).toHaveBeenCalledTimes(1);
	});
});
