import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeBoardColumnId,
	RuntimeTaskRunStatus,
} from "../core/api-contract";
import { buildKanbanRuntimeUrl } from "../core/runtime-endpoint";
import {
	claimTaskForRun,
	heartbeatTaskClaim,
	markTaskRunStarted,
	moveTaskToColumn,
	reclaimExpiredTaskClaims,
	releaseTaskClaim,
	updateTask,
} from "../core/task-board-mutations";
import { detectRuntimeTools } from "../core/tool-detection";
import { getWorkerProfile } from "../core/worker-profiles";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function normalizeRunStatus(value: string | undefined): RuntimeTaskRunStatus | undefined {
	if (
		value === "claimed" ||
		value === "running" ||
		value === "succeeded" ||
		value === "failed" ||
		value === "reclaimed" ||
		value === "cancelled"
	) {
		return value;
	}
	return undefined;
}

async function listDispatcherEvents(input: {
	cwd: string;
	projectPath?: string;
	taskId?: string;
	limit?: number;
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const state = await loadWorkspaceState(workspace.repoPath);
	const normalizedTaskId = input.taskId?.trim();
	const limit = input.limit && Number.isFinite(input.limit) && input.limit > 0 ? input.limit : 50;
	const events = (state.board.events ?? [])
		.filter((event) => !normalizedTaskId || event.taskId === normalizedTaskId)
		.slice(-limit)
		.reverse();
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		events,
	};
}

async function listDispatcherRuns(input: {
	cwd: string;
	projectPath?: string;
	taskId?: string;
	limit?: number;
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const state = await loadWorkspaceState(workspace.repoPath);
	const normalizedTaskId = input.taskId?.trim();
	const limit = input.limit && Number.isFinite(input.limit) && input.limit > 0 ? input.limit : 50;
	const runs = (state.board.runs ?? [])
		.filter((run) => !normalizedTaskId || run.taskId === normalizedTaskId)
		.slice(-limit)
		.reverse();
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		runs,
	};
}

async function heartbeatDispatcherTask(input: {
	cwd: string;
	projectPath?: string;
	taskId: string;
	lockId: string;
	claimTtlMs?: number;
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const claimTtlMs = input.claimTtlMs ?? 15 * 60 * 1000;
	const heartbeat = await mutateWorkspaceState(workspace.repoPath, (state) => {
		const result = heartbeatTaskClaim(state.board, input.taskId, input.lockId, claimTtlMs);
		return {
			board: result.board,
			value: result,
			save: result.updated,
		};
	});
	return {
		ok: heartbeat.value.updated,
		workspacePath: workspace.repoPath,
		reason: heartbeat.value.reason,
	};
}

async function releaseDispatcherTask(input: {
	cwd: string;
	projectPath?: string;
	taskId: string;
	lockId?: string;
	status?: RuntimeTaskRunStatus;
	error?: string;
	summary?: string;
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const released = await mutateWorkspaceState(workspace.repoPath, (state) => {
		const result = releaseTaskClaim(state.board, input.taskId, input.lockId ?? null, {
			status: input.status,
			error: input.error,
			summary: input.summary,
		});
		return {
			board: result.board,
			value: result,
			save: result.released,
		};
	});
	return {
		ok: released.value.released,
		workspacePath: workspace.repoPath,
		reason: released.value.reason,
	};
}

function createRuntimeTrpcClient(workspaceId: string) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => ({ "x-kanban-workspace-id": workspaceId }),
			}),
		],
	});
}

function getCardsInColumn(board: RuntimeBoardData, columnId: RuntimeBoardColumnId): RuntimeBoardCard[] {
	return board.columns.find((column) => column.id === columnId)?.cards ?? [];
}

function resolveReadyCapabilities(): Set<string> {
	const readyCapabilities = new Set<string>();
	for (const tool of detectRuntimeTools().tools) {
		if (tool.status !== "ready") {
			continue;
		}
		for (const capability of tool.capabilities) {
			readyCapabilities.add(capability);
		}
	}
	return readyCapabilities;
}

function getMissingCapabilities(requiredCapabilities: readonly string[], readyCapabilities: Set<string>): string[] {
	return requiredCapabilities.filter((capability) => !readyCapabilities.has(capability));
}

async function resolveWorkspace(projectPath: string | undefined, cwd: string) {
	const resolvedPath = projectPath?.trim() ? resolveProjectInputPath(projectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath);
}

async function tickDispatcher(input: {
	cwd: string;
	projectPath?: string;
	startReadyTasks?: boolean;
	claimTtlMs?: number;
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const readyCapabilities = resolveReadyCapabilities();
	const promotedTaskIds: string[] = [];
	const blockedTaskIds: string[] = [];
	const reclaimedTaskIds: string[] = [];
	const claimTtlMs = input.claimTtlMs ?? 15 * 60 * 1000;

	await mutateWorkspaceState(workspace.repoPath, (state) => {
		const reclaimed = reclaimExpiredTaskClaims(state.board);
		let board = reclaimed.board;
		reclaimedTaskIds.push(...reclaimed.reclaimedTaskIds);
		for (const task of getCardsInColumn(board, "triage")) {
			const profileId = task.profileId ?? "implementation";
			const profile = getWorkerProfile(profileId);
			const requiredCapabilities = task.requiredCapabilities ?? profile?.requiredCapabilities ?? ["agent", "terminal"];
			const missingCapabilities = getMissingCapabilities(requiredCapabilities, readyCapabilities);
			const nextTask = updateTask(board, task.id, {
				prompt: task.prompt,
				baseRef: task.baseRef,
				profileId,
				requiredCapabilities: [...requiredCapabilities],
				blockedReason:
					missingCapabilities.length > 0
						? `Missing required capabilities: ${missingCapabilities.join(", ")}`
						: null,
				maxAttempts: task.maxAttempts,
				startInPlanMode: task.startInPlanMode,
				autoReviewEnabled: task.autoReviewEnabled,
				autoReviewMode: task.autoReviewMode,
				images: task.images,
			});
			board = nextTask.board;
			if (missingCapabilities.length > 0) {
				blockedTaskIds.push(task.id);
				continue;
			}
			const moved = moveTaskToColumn(board, task.id, "backlog");
			board = moved.board;
			if (moved.moved) {
				promotedTaskIds.push(task.id);
			}
		}
		return {
			board,
			value: null,
		};
	});

	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);

	const startedTaskIds: string[] = [];
	const claimedTaskIds: string[] = [];
	const failedStartTaskIds: string[] = [];
	if (input.startReadyTasks) {
		const latestState = await runtimeClient.workspace.getState.query();
		for (const task of getCardsInColumn(latestState.board, "backlog")) {
			if (task.blockedReason) {
				continue;
			}
			const profile = getWorkerProfile(task.profileId) ?? getWorkerProfile("implementation");
			const claim = await mutateWorkspaceState(workspace.repoPath, (state) => {
				const claimed = claimTaskForRun(state.board, {
					taskId: task.id,
					assignee: profile?.id ?? "implementation",
					profileId: profile?.id,
					agentId: profile?.agentId ?? null,
					pid: null,
					claimTtlMs,
				});
				return {
					board: claimed.board,
					value: claimed,
					save: claimed.claimed,
				};
			});
			if (!claim.value.claimed || !claim.value.task || !claim.value.lockId) {
				continue;
			}
			claimedTaskIds.push(task.id);
			const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
				taskId: task.id,
				baseRef: task.baseRef,
			});
			if (!ensured.ok) {
				await mutateWorkspaceState(workspace.repoPath, (state) => ({
					board: releaseTaskClaim(state.board, task.id, claim.value.lockId, {
						status: "failed",
						error: ensured.error ?? "Could not ensure task worktree.",
					}).board,
					value: null,
				}));
				failedStartTaskIds.push(task.id);
				continue;
			}
			const started = await runtimeClient.runtime.startTaskSession.mutate({
				taskId: task.id,
				prompt: task.prompt,
				images: task.images,
				startInPlanMode: profile?.defaultTaskMode === "plan" || task.startInPlanMode,
				mode: profile?.defaultTaskMode,
				agentId: profile?.agentId,
				baseRef: task.baseRef,
			});
			if (!started.ok) {
				await mutateWorkspaceState(workspace.repoPath, (state) => ({
					board: releaseTaskClaim(state.board, task.id, claim.value.lockId, {
						status: "failed",
						error: started.error ?? "Could not start task session.",
					}).board,
					value: null,
				}));
				failedStartTaskIds.push(task.id);
				continue;
			}
			await mutateWorkspaceState(workspace.repoPath, (state) => {
				const startedRun = markTaskRunStarted(state.board, task.id, {
					pid: started.summary?.pid ?? null,
				});
				return {
					board: startedRun.board,
					value: null,
					save: startedRun.updated,
				};
			});
			startedTaskIds.push(task.id);
		}
		await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
	}

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		reclaimedTaskIds,
		promotedTaskIds,
		blockedTaskIds,
		claimedTaskIds,
		startedTaskIds,
		failedStartTaskIds,
	};
}

export function registerDispatcherCommand(program: Command): void {
	const dispatcher = program.command("dispatcher").description("Run dispatcher actions over the current board.");

	dispatcher
		.command("tick")
		.description("Promote triage tasks to Todo or mark them blocked when required tools are missing.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--start-ready", "Start unblocked Todo tasks using their assigned worker profile.")
		.option("--claim-ttl-ms <milliseconds>", "Claim lease duration in milliseconds.", (value) => Number(value))
		.action(async (options: { projectPath?: string; startReady?: boolean; claimTtlMs?: number }) => {
			try {
				printJson(
					await tickDispatcher({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						startReadyTasks: options.startReady === true,
						claimTtlMs: Number.isFinite(options.claimTtlMs) ? options.claimTtlMs : undefined,
					}),
				);
			} catch (error) {
				printJson({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
				process.exitCode = 1;
			}
		});

	dispatcher
		.command("events")
		.description("List dispatcher task events.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--task-id <taskId>", "Only show events for one task.")
		.option("--limit <count>", "Maximum events to show.", (value) => Number(value))
		.action(async (options: { projectPath?: string; taskId?: string; limit?: number }) => {
			try {
				printJson(
					await listDispatcherEvents({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId: options.taskId,
						limit: options.limit,
					}),
				);
			} catch (error) {
				printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
				process.exitCode = 1;
			}
		});

	dispatcher
		.command("runs")
		.description("List dispatcher task run attempts.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--task-id <taskId>", "Only show runs for one task.")
		.option("--limit <count>", "Maximum runs to show.", (value) => Number(value))
		.action(async (options: { projectPath?: string; taskId?: string; limit?: number }) => {
			try {
				printJson(
					await listDispatcherRuns({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId: options.taskId,
						limit: options.limit,
					}),
				);
			} catch (error) {
				printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
				process.exitCode = 1;
			}
		});

	dispatcher
		.command("heartbeat")
		.description("Renew a task claim lease.")
		.argument("<task-id>")
		.argument("<lock-id>")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--claim-ttl-ms <milliseconds>", "Claim lease duration in milliseconds.", (value) => Number(value))
		.action(async (taskId: string, lockId: string, options: { projectPath?: string; claimTtlMs?: number }) => {
			try {
				printJson(
					await heartbeatDispatcherTask({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId,
						lockId,
						claimTtlMs: Number.isFinite(options.claimTtlMs) ? options.claimTtlMs : undefined,
					}),
				);
			} catch (error) {
				printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
				process.exitCode = 1;
			}
		});

	dispatcher
		.command("release")
		.description("Release a task claim and close its run attempt.")
		.argument("<task-id>")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--lock-id <lockId>", "Expected lock id. Omit only for operator recovery.")
		.option("--status <status>", "Run status: succeeded, failed, cancelled, or reclaimed.")
		.option("--error <message>", "Failure message.")
		.option("--summary <message>", "Completion summary.")
		.action(
			async (
				taskId: string,
				options: {
					projectPath?: string;
					lockId?: string;
					status?: RuntimeTaskRunStatus;
					error?: string;
					summary?: string;
				},
			) => {
				try {
					printJson(
						await releaseDispatcherTask({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							taskId,
							lockId: options.lockId,
							status: normalizeRunStatus(options.status),
							error: options.error,
							summary: options.summary,
						}),
					);
				} catch (error) {
					printJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
					process.exitCode = 1;
				}
			},
		);
}
