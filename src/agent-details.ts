import type { AgentActivity, AgentDetails } from "./ui/agent-widget.js";
import { formatTokens } from "./ui/agent-widget.js";
import {
	getLifetimeCost,
	getLifetimeTotal,
	getSessionContextPercent,
	type LifetimeUsage,
	type SessionLike,
} from "./usage.js";

/** Minimal record data needed to render a foreground Agent result. */
export interface AgentDetailsRecord {
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	status: string;
	error?: string;
	id?: string;
	session?: SessionLike;
	lifetimeUsage: LifetimeUsage;
}

/** Build AgentDetails from a base + record-specific fields. Shared by live and final inline results. */
export function buildAgentDetails(
	base: Pick<
		AgentDetails,
		"displayName" | "description" | "subagentType" | "modelName" | "tags"
	>,
	record: AgentDetailsRecord,
	activity?: AgentActivity,
	overrides?: Partial<AgentDetails>,
): AgentDetails {
	return {
		...base,
		toolUses: record.toolUses,
		tokens: formatTokens(getLifetimeTotal(record.lifetimeUsage)),
		cost: getLifetimeCost(record.lifetimeUsage),
		contextPercent: getSessionContextPercent(record.session),
		turnCount: activity?.turnCount,
		maxTurns: activity?.maxTurns,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
		agentId: record.id,
		error: record.error,
		...overrides,
	};
}
