import type { RuntimeBoardData, RuntimeTaskGraph } from "./api-contract";
import { addTaskDependency, addTaskToColumn } from "./task-board-mutations";

export interface RuntimeApplyTaskGraphResult {
	board: RuntimeBoardData;
	taskIdByClientId: Record<string, string>;
	createdTaskIds: string[];
}

export function applyRuntimeTaskGraphToBoard(
	board: RuntimeBoardData,
	graph: RuntimeTaskGraph,
	options: {
		randomUuid: () => string;
		defaultBaseRef: string;
	},
): RuntimeApplyTaskGraphResult {
	let nextBoard = board;
	const taskIdByClientId = new Map<string, string>();
	const createdTaskIds: string[] = [];

	for (const task of graph.tasks) {
		const created = addTaskToColumn(
			nextBoard,
			"backlog",
			{
				prompt: task.prompt,
				title: task.title,
				summary: task.summary,
				baseRef: task.baseRef?.trim() || graph.defaults?.baseRef?.trim() || options.defaultBaseRef,
				startInPlanMode: task.startInPlanMode ?? graph.defaults?.startInPlanMode,
				autoReviewEnabled: task.autoReviewEnabled ?? graph.defaults?.autoReviewEnabled,
				autoReviewMode: task.autoReviewMode ?? graph.defaults?.autoReviewMode,
			},
			options.randomUuid,
		);
		nextBoard = created.board;
		taskIdByClientId.set(task.clientId, created.task.id);
		createdTaskIds.push(created.task.id);
	}

	for (const dependency of graph.dependencies) {
		const dependentTaskId = taskIdByClientId.get(dependency.dependentId);
		const prerequisiteTaskId = taskIdByClientId.get(dependency.prerequisiteId);
		if (!dependentTaskId || !prerequisiteTaskId) {
			throw new Error(
				`Dependency references unknown task client IDs: ${dependency.dependentId} -> ${dependency.prerequisiteId}.`,
			);
		}
		const linked = addTaskDependency(nextBoard, dependentTaskId, prerequisiteTaskId, {
			handoff: dependency.handoff,
		});
		if (!linked.added) {
			throw new Error(`Could not create dependency ${dependency.dependentId} -> ${dependency.prerequisiteId}.`);
		}
		nextBoard = linked.board;
	}

	return {
		board: nextBoard,
		taskIdByClientId: Object.fromEntries(taskIdByClientId),
		createdTaskIds,
	};
}
