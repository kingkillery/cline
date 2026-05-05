import { spawnSync } from "node:child_process";

import type { RuntimeAgentId } from "./api-contract";
import { RUNTIME_AGENT_CATALOG } from "./agent-catalog";
import { createGitProcessEnv } from "./git-process-env";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";

export type RuntimeToolAuthState = "authenticated" | "unauthenticated" | "unknown" | "not_applicable";

export interface RuntimeToolStatus {
	id: string;
	label: string;
	command: string;
	installed: boolean;
	authState: RuntimeToolAuthState;
	status: "ready" | "missing" | "needs_auth" | "unknown";
	detail: string | null;
	capabilities: string[];
	agentId?: RuntimeAgentId;
}

export interface RuntimeToolStatusResponse {
	tools: RuntimeToolStatus[];
	generatedAt: number;
}

function runProbe(command: string, args: string[], timeoutMs = 5_000): { status: number | null; output: string } {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		env: createGitProcessEnv(),
	});
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return {
		status: result.status,
		output,
	};
}

function toStatus(installed: boolean, authState: RuntimeToolAuthState): RuntimeToolStatus["status"] {
	if (!installed) {
		return "missing";
	}
	if (authState === "unauthenticated") {
		return "needs_auth";
	}
	if (authState === "authenticated" || authState === "not_applicable") {
		return "ready";
	}
	return "unknown";
}

function probeGhAuth(installed: boolean): Pick<RuntimeToolStatus, "authState" | "detail"> {
	if (!installed) {
		return { authState: "unknown", detail: null };
	}
	const result = runProbe("gh", ["auth", "status"], 5_000);
	if (result.status === 0) {
		return { authState: "authenticated", detail: "GitHub CLI is authenticated." };
	}
	return {
		authState: "unauthenticated",
		detail: result.output || "GitHub CLI is installed but not authenticated.",
	};
}

function probeAgentAuth(agentId: RuntimeAgentId, installed: boolean): Pick<RuntimeToolStatus, "authState" | "detail"> {
	if (!installed) {
		return { authState: "unknown", detail: null };
	}
	if (agentId === "cline") {
		return { authState: "unknown", detail: "Cline provider auth is managed by Kanban settings." };
	}
	if (agentId === "codex") {
		const result = runProbe("codex", ["auth", "status"], 5_000);
		if (result.status === 0) {
			return { authState: "authenticated", detail: "Codex auth status command succeeded." };
		}
		return { authState: "unknown", detail: result.output || "Codex auth status is unavailable." };
	}
	if (agentId === "claude") {
		const result = runProbe("claude", ["doctor"], 5_000);
		if (result.status === 0) {
			return { authState: "authenticated", detail: "Claude doctor completed successfully." };
		}
		return { authState: "unknown", detail: result.output || "Claude auth status is unavailable." };
	}
	return { authState: "unknown", detail: "No read-only auth probe is defined for this agent yet." };
}

function createToolStatus(input: Omit<RuntimeToolStatus, "status">): RuntimeToolStatus {
	return {
		...input,
		status: toStatus(input.installed, input.authState),
	};
}

export function detectRuntimeTools(): RuntimeToolStatusResponse {
	const tools: RuntimeToolStatus[] = [];

	for (const agent of RUNTIME_AGENT_CATALOG) {
		const installed = isBinaryAvailableOnPath(agent.binary);
		const auth = probeAgentAuth(agent.id, installed);
		tools.push(
			createToolStatus({
				id: `agent:${agent.id}`,
				label: agent.label,
				command: [agent.binary, ...agent.baseArgs].join(" "),
				installed,
				authState: auth.authState,
				detail: auth.detail,
				capabilities: ["agent", "terminal"],
				agentId: agent.id,
			}),
		);
	}

	const ghInstalled = isBinaryAvailableOnPath("gh");
	const ghAuth = probeGhAuth(ghInstalled);
	tools.push(
		createToolStatus({
			id: "cli:gh",
			label: "GitHub CLI",
			command: "gh",
			installed: ghInstalled,
			authState: ghAuth.authState,
			detail: ghAuth.detail,
			capabilities: ["github", "git"],
		}),
	);

	for (const command of ["git", "node", "npm", "npx", "uvx"]) {
		const installed = isBinaryAvailableOnPath(command);
		tools.push(
			createToolStatus({
				id: `cli:${command}`,
				label: command,
				command,
				installed,
				authState: "not_applicable",
				detail: installed ? `${command} is available on PATH.` : null,
				capabilities: command === "git" ? ["git"] : ["runtime"],
			}),
		);
	}

	return {
		tools,
		generatedAt: Date.now(),
	};
}
