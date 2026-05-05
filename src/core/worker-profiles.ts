import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeWorkerProfile {
	id: string;
	label: string;
	description: string;
	agentId: RuntimeAgentId;
	requiredCapabilities: string[];
	optionalCapabilities: string[];
	defaultTaskMode: "act" | "plan";
}

export interface RuntimeWorkerProfilesResponse {
	profiles: RuntimeWorkerProfile[];
	generatedAt: number;
}

export const DEFAULT_WORKER_PROFILES: RuntimeWorkerProfile[] = [
	{
		id: "dispatcher",
		label: "Dispatcher",
		description: "Claims triage work, clarifies scope, assigns a worker profile, and unblocks ready tasks.",
		agentId: "codex",
		requiredCapabilities: ["agent", "terminal"],
		optionalCapabilities: ["github", "mcp"],
		defaultTaskMode: "plan",
	},
	{
		id: "specifier",
		label: "Specifier",
		description: "Turns rough triage cards into executable Todo tasks with dependencies and tool requirements.",
		agentId: "codex",
		requiredCapabilities: ["agent", "terminal"],
		optionalCapabilities: ["github", "web"],
		defaultTaskMode: "plan",
	},
	{
		id: "implementation",
		label: "Implementation",
		description: "Runs coding tasks in isolated worktrees.",
		agentId: "codex",
		requiredCapabilities: ["agent", "terminal", "git"],
		optionalCapabilities: ["github", "mcp"],
		defaultTaskMode: "act",
	},
	{
		id: "reviewer",
		label: "Reviewer",
		description: "Reviews finished work and decides whether it is ready to commit, PR, or revise.",
		agentId: "codex",
		requiredCapabilities: ["agent", "terminal", "git"],
		optionalCapabilities: ["github"],
		defaultTaskMode: "plan",
	},
];

export function getWorkerProfiles(): RuntimeWorkerProfilesResponse {
	return {
		profiles: DEFAULT_WORKER_PROFILES,
		generatedAt: Date.now(),
	};
}

export function getWorkerProfile(profileId: string | null | undefined): RuntimeWorkerProfile | null {
	const normalized = profileId?.trim();
	if (!normalized) {
		return null;
	}
	return DEFAULT_WORKER_PROFILES.find((profile) => profile.id === normalized) ?? null;
}
