import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeBoardColumnId } from "../core/api-contract";
import { buildKanbanRuntimeUrl } from "../core/runtime-endpoint";
import { moveTaskToColumn, updateTask } from "../core/task-board-mutations";
import { detectRuntimeTools } from "../core/tool-detection";
import { getWorkerProfile } from "../core/worker-profiles";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
}): Promise<Record<string, unknown>> {
	const workspace = await resolveWorkspace(input.projectPath, input.cwd);
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const readyCapabilities = resolveReadyCapabilities();
	const promotedTaskIds: string[] = [];
	const blockedTaskIds: string[] = [];

	await mutateWorkspaceState(workspace.repoPath, (state) => {
		let board = state.board;
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
	if (input.startReadyTasks) {
		const latestState = await runtimeClient.workspace.getState.query();
		for (const task of getCardsInColumn(latestState.board, "backlog")) {
			if (task.blockedReason) {
				continue;
			}
			const profile = getWorkerProfile(task.profileId) ?? getWorkerProfile("implementation");
			const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
				taskId: task.id,
				baseRef: task.baseRef,
			});
			if (!ensured.ok) {
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
				continue;
			}
			await mutateWorkspaceState(workspace.repoPath, (state) => {
				const moved = moveTaskToColumn(state.board, task.id, "in_progress");
				return {
					board: moved.board,
					value: null,
				};
			});
			startedTaskIds.push(task.id);
		}
		await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
	}

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		promotedTaskIds,
		blockedTaskIds,
		startedTaskIds,
	};
}

export function registerDispatcherCommand(program: Command): void {
	const dispatcher = program.command("dispatcher").description("Run dispatcher actions over the current board.");

	dispatcher
		.command("tick")
		.description("Promote triage tasks to Todo or mark them blocked when required tools are missing.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--start-ready", "Start unblocked Todo tasks using their assigned worker profile.")
		.action(async (options: { projectPath?: string; startReady?: boolean }) => {
			try {
				printJson(
					await tickDispatcher({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						startReadyTasks: options.startReady === true,
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
}
