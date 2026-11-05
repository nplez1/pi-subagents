/**
 * group-join.ts — Tracks smart-join batches without delaying completion notices.
 *
 * Smart join still identifies agents spawned together, but each completed
 * agent is delivered immediately rather than waiting for its peers.
 */

import type { AgentRecord } from "./types.js";

export type DeliveryCallback = (records: AgentRecord[]) => void;

export class GroupJoinManager {
	private groups = new Map<string, Set<string>>();
	private agentToGroup = new Map<string, string>();

	constructor(private deliverCb: DeliveryCallback) {}

	/** Register a batch of agent IDs whose completions should be tracked. */
	registerGroup(groupId: string, agentIds: string[]): void {
		const ids = new Set(agentIds);
		this.groups.set(groupId, ids);
		for (const id of ids) {
			const previousGroup = this.agentToGroup.get(id);
			if (previousGroup && previousGroup !== groupId) {
				this.groups.get(previousGroup)?.delete(id);
				if (this.groups.get(previousGroup)?.size === 0)
					this.groups.delete(previousGroup);
			}
			this.agentToGroup.set(id, groupId);
		}
	}

	/**
	 * Deliver a grouped agent immediately.
	 * Returns 'pass' for ungrouped agents and 'delivered' for grouped agents.
	 */
	onAgentComplete(record: AgentRecord): "delivered" | "pass" {
		const groupId = this.agentToGroup.get(record.id);
		if (!groupId) return "pass";

		this.agentToGroup.delete(record.id);
		const group = this.groups.get(groupId);
		group?.delete(record.id);
		if (group?.size === 0) this.groups.delete(groupId);

		this.deliverCb([record]);
		return "delivered";
	}

	/** Check if an agent is in a registered batch. */
	isGrouped(agentId: string): boolean {
		return this.agentToGroup.has(agentId);
	}

	dispose(): void {
		this.groups.clear();
		this.agentToGroup.clear();
	}
}
