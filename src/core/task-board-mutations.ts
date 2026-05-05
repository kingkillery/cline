import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskClaim,
	RuntimeTaskEvent,
	RuntimeTaskEventType,
	RuntimeTaskAutoReviewMode,
	RuntimeTaskImage,
	RuntimeTaskRun,
} from "./api-contract";
import { createUniqueTaskId } from "./task-id";

export interface RuntimeCreateTaskInput {
	taskId?: string;
	prompt: string;
	profileId?: string;
	requiredCapabilities?: string[];
	blockedReason?: string | null;
	maxAttempts?: number;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	baseRef: string;
}

export interface RuntimeUpdateTaskInput {
	prompt: string;
	profileId?: string;
	requiredCapabilities?: string[];
	blockedReason?: string | null;
	maxAttempts?: number;
	startInPlanMode?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: RuntimeTaskAutoReviewMode;
	images?: RuntimeTaskImage[];
	baseRef: string;
}

function normalizeTaskAutoReviewMode(value: RuntimeTaskAutoReviewMode | null | undefined): RuntimeTaskAutoReviewMode {
	if (value === "pr" || value === "move_to_trash") {
		return value;
	}
	return "commit";
}

// Copy image metadata so board tasks do not retain caller-owned array or object references.
function cloneTaskImages(images?: RuntimeTaskImage[]): RuntimeTaskImage[] | undefined {
	return images && images.length > 0 ? images.map((image) => ({ ...image })) : undefined;
}

function cloneRequiredCapabilities(requiredCapabilities?: string[]): string[] | undefined {
	const normalized = [...new Set((requiredCapabilities ?? []).map((capability) => capability.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

export interface RuntimeCreateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard;
}

export interface RuntimeMoveTaskResult {
	moved: boolean;
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	fromColumnId: RuntimeBoardColumnId | null;
}

export interface RuntimeUpdateTaskResult {
	board: RuntimeBoardData;
	task: RuntimeBoardCard | null;
	updated: boolean;
}

export interface RuntimeAddTaskDependencyResult {
	board: RuntimeBoardData;
	added: boolean;
	reason?: "missing_task" | "same_task" | "duplicate" | "trash_task" | "non_backlog";
	dependency?: RuntimeBoardDependency;
}

export interface RuntimeRemoveTaskDependencyResult {
	board: RuntimeBoardData;
	removed: boolean;
}

export interface RuntimeTrashTaskResult extends RuntimeMoveTaskResult {
	readyTaskIds: string[];
}

export interface RuntimeDeleteTasksResult {
	board: RuntimeBoardData;
	deleted: boolean;
	deletedTaskIds: string[];
}

export interface RuntimeClaimTaskInput {
	taskId: string;
	assignee: string;
	profileId?: string | null;
	agentId?: RuntimeTaskRun["agentId"];
	pid?: number | null;
	claimTtlMs: number;
	maxAttempts?: number;
	now?: number;
}

export interface RuntimeClaimTaskResult {
	board: RuntimeBoardData;
	claimed: boolean;
	task: RuntimeBoardCard | null;
	run: RuntimeTaskRun | null;
	lockId: string | null;
	reason?: "missing_task" | "already_claimed" | "blocked" | "attempts_exhausted";
}

export interface RuntimeTaskHeartbeatResult {
	board: RuntimeBoardData;
	updated: boolean;
	reason?: "missing_task" | "no_claim" | "lock_mismatch" | "expired";
}

export interface RuntimeReleaseTaskClaimResult {
	board: RuntimeBoardData;
	released: boolean;
	reason?: "missing_task" | "no_claim" | "lock_mismatch";
}

export interface RuntimeMarkTaskRunStartedResult {
	board: RuntimeBoardData;
	updated: boolean;
	reason?: "missing_task" | "no_run";
}

export interface RuntimeReclaimExpiredTasksResult {
	board: RuntimeBoardData;
	reclaimedTaskIds: string[];
}

function collectExistingTaskIds(board: RuntimeBoardData): Set<string> {
	const existingIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			existingIds.add(card.id);
		}
	}
	return existingIds;
}

function collectTaskIds(board: RuntimeBoardData): Set<string> {
	const taskIds = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskIds.add(card.id);
		}
	}
	return taskIds;
}

function createDependencyId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}

function createBoardEventId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function createRunId(): string {
	return `run-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function createLockId(): string {
	return `lock-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function appendTaskEvent(
	board: RuntimeBoardData,
	input: {
		taskId: string;
		type: RuntimeTaskEventType;
		now?: number;
		actor?: string;
		runId?: string | null;
		fromColumnId?: RuntimeBoardColumnId | null;
		toColumnId?: RuntimeBoardColumnId | null;
		message?: string | null;
		metadata?: Record<string, unknown>;
	},
): RuntimeBoardData {
	const event: RuntimeTaskEvent = {
		id: createBoardEventId(),
		taskId: input.taskId,
		type: input.type,
		createdAt: input.now ?? Date.now(),
		actor: input.actor,
		runId: input.runId,
		fromColumnId: input.fromColumnId,
		toColumnId: input.toColumnId,
		message: input.message,
		metadata: input.metadata,
	};
	return {
		...board,
		events: [...(board.events ?? []), event],
	};
}

function updateTaskRun(board: RuntimeBoardData, run: RuntimeTaskRun): RuntimeBoardData {
	const runs = board.runs ?? [];
	const existingIndex = runs.findIndex((candidate) => candidate.id === run.id);
	if (existingIndex === -1) {
		return {
			...board,
			runs: [...runs, run],
		};
	}
	return {
		...board,
		runs: runs.map((candidate, index) => (index === existingIndex ? run : candidate)),
	};
}

function createDependencyPairKey(backlogTaskId: string, linkedTaskId: string): string {
	return `${backlogTaskId}::${linkedTaskId}`;
}

function hasDependencyPair(board: RuntimeBoardData, backlogTaskId: string, linkedTaskId: string): boolean {
	const pairKey = createDependencyPairKey(backlogTaskId, linkedTaskId);
	for (const dependency of board.dependencies) {
		const existing = resolveDependencyEndpoints(board, dependency.fromTaskId, dependency.toTaskId);
		if ("reason" in existing) {
			continue;
		}
		if (createDependencyPairKey(existing.backlogTaskId, existing.linkedTaskId) === pairKey) {
			return true;
		}
	}
	return false;
}

function findTaskLocation(
	board: RuntimeBoardData,
	taskId: string,
): {
	columnIndex: number;
	taskIndex: number;
	columnId: RuntimeBoardColumnId;
	task: RuntimeBoardCard;
} | null {
	for (const [columnIndex, column] of board.columns.entries()) {
		const taskIndex = column.cards.findIndex((card) => card.id === taskId);
		if (taskIndex === -1) {
			continue;
		}
		const task = column.cards[taskIndex];
		if (!task) {
			continue;
		}
		return {
			columnIndex,
			taskIndex,
			columnId: column.id,
			task,
		};
	}
	return null;
}

function resolveDependencyEndpoints(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
):
	| {
			backlogTaskId: string;
			linkedTaskId: string;
	  }
	| { reason: RuntimeAddTaskDependencyResult["reason"] } {
	const firstColumnId = getTaskColumnId(board, firstTaskId);
	const secondColumnId = getTaskColumnId(board, secondTaskId);
	if (!firstColumnId || !secondColumnId) {
		return { reason: "missing_task" };
	}
	if (firstColumnId === "trash" || secondColumnId === "trash") {
		return { reason: "trash_task" };
	}
	const firstIsBacklog = firstColumnId === "backlog";
	const secondIsBacklog = secondColumnId === "backlog";
	if (firstIsBacklog && secondIsBacklog) {
		return {
			backlogTaskId: firstTaskId,
			linkedTaskId: secondTaskId,
		};
	}
	if (!firstIsBacklog && !secondIsBacklog) {
		return { reason: "non_backlog" };
	}
	return firstIsBacklog
		? { backlogTaskId: firstTaskId, linkedTaskId: secondTaskId }
		: { backlogTaskId: secondTaskId, linkedTaskId: firstTaskId };
}

function getLinkedBacklogTaskIdsReadyAfterTaskTrashed(
	board: RuntimeBoardData,
	taskId: string,
	fromColumnId: RuntimeBoardColumnId | null,
): string[] {
	if (!taskId || board.dependencies.length === 0 || fromColumnId !== "review") {
		return [];
	}
	const readyTaskIds = new Set<string>();
	for (const dependency of board.dependencies) {
		if (dependency.toTaskId !== taskId) {
			continue;
		}
		if (getTaskColumnId(board, dependency.fromTaskId) !== "backlog") {
			continue;
		}
		readyTaskIds.add(dependency.fromTaskId);
	}
	return [...readyTaskIds];
}

export function updateTaskDependencies(board: RuntimeBoardData): RuntimeBoardData {
	if (board.dependencies.length === 0) {
		return board;
	}
	const taskIds = collectTaskIds(board);
	const dependencies: RuntimeBoardDependency[] = [];
	const existingPairs = new Set<string>();
	for (const dependency of board.dependencies) {
		const firstTaskId = dependency.fromTaskId.trim();
		const secondTaskId = dependency.toTaskId.trim();
		if (!firstTaskId || !secondTaskId || firstTaskId === secondTaskId) {
			continue;
		}
		if (!taskIds.has(firstTaskId) || !taskIds.has(secondTaskId)) {
			continue;
		}
		const resolved = resolveDependencyEndpoints(board, firstTaskId, secondTaskId);
		if ("reason" in resolved) {
			continue;
		}
		const pairKey = createDependencyPairKey(resolved.backlogTaskId, resolved.linkedTaskId);
		if (existingPairs.has(pairKey)) {
			continue;
		}
		existingPairs.add(pairKey);
		dependencies.push({
			id: dependency.id,
			fromTaskId: resolved.backlogTaskId,
			toTaskId: resolved.linkedTaskId,
			createdAt: dependency.createdAt,
		});
	}
	if (
		dependencies.length === board.dependencies.length &&
		dependencies.every((dependency, index) => {
			const current = board.dependencies[index];
			return (
				current &&
				current.id === dependency.id &&
				current.fromTaskId === dependency.fromTaskId &&
				current.toTaskId === dependency.toTaskId &&
				current.createdAt === dependency.createdAt
			);
		})
	) {
		return board;
	}
	return {
		...board,
		dependencies,
	};
}

export function addTaskToColumn(
	board: RuntimeBoardData,
	columnId: RuntimeBoardColumnId,
	input: RuntimeCreateTaskInput,
	randomUuid: () => string,
	now: number = Date.now(),
): RuntimeCreateTaskResult {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Task prompt is required.");
	}
	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task baseRef is required.");
	}
	const existingIds = collectExistingTaskIds(board);
	const explicitTaskId = input.taskId?.trim();
	if (explicitTaskId && existingIds.has(explicitTaskId)) {
		throw new Error(`Task "${explicitTaskId}" already exists.`);
	}
	const task: RuntimeBoardCard = {
		id: explicitTaskId || createUniqueTaskId(existingIds, randomUuid),
		prompt,
		profileId: input.profileId?.trim() || undefined,
		requiredCapabilities: cloneRequiredCapabilities(input.requiredCapabilities),
		blockedReason: input.blockedReason?.trim() || null,
		claim: null,
		attemptCount: 0,
		maxAttempts: input.maxAttempts,
		lastError: null,
		lastRunId: null,
		startInPlanMode: Boolean(input.startInPlanMode),
		autoReviewEnabled: Boolean(input.autoReviewEnabled),
		autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
		images: cloneTaskImages(input.images),
		baseRef,
		createdAt: now,
		updatedAt: now,
	};

	const targetColumnIndex = board.columns.findIndex((column) => column.id === columnId);
	if (targetColumnIndex === -1) {
		throw new Error(`Column ${columnId} not found.`);
	}

	const columns = board.columns.map((column, index) => {
		if (index !== targetColumnIndex) {
			return column;
		}
		return {
			...column,
			cards: [task, ...column.cards],
		};
	});

	const boardWithTask = {
		...board,
		columns,
	};
	return {
		board: appendTaskEvent(boardWithTask, {
			taskId: task.id,
			type: "created",
			now,
			toColumnId: columnId,
		}),
		task,
	};
}

export function getTaskColumnId(board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return null;
	}
	const found = findTaskLocation(board, normalizedTaskId);
	return found ? found.columnId : null;
}

export function addTaskDependency(
	board: RuntimeBoardData,
	firstTaskId: string,
	secondTaskId: string,
): RuntimeAddTaskDependencyResult {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId) {
		return { board, added: false, reason: "missing_task" };
	}
	if (normalizedFirstTaskId === normalizedSecondTaskId) {
		return { board, added: false, reason: "same_task" };
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return { board, added: false, reason: resolved.reason };
	}
	if (hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId)) {
		return { board, added: false, reason: "duplicate" };
	}
	const dependency: RuntimeBoardDependency = {
		id: createDependencyId(),
		fromTaskId: resolved.backlogTaskId,
		toTaskId: resolved.linkedTaskId,
		createdAt: Date.now(),
	};
	return {
		board: appendTaskEvent(
			{
				...board,
				dependencies: [...board.dependencies, dependency],
			},
			{
				taskId: resolved.backlogTaskId,
				type: "dependency_linked",
				message: `Linked to ${resolved.linkedTaskId}`,
				metadata: { dependencyId: dependency.id, linkedTaskId: resolved.linkedTaskId },
			},
		),
		added: true,
		dependency,
	};
}

export function canAddTaskDependency(board: RuntimeBoardData, firstTaskId: string, secondTaskId: string): boolean {
	const normalizedFirstTaskId = firstTaskId.trim();
	const normalizedSecondTaskId = secondTaskId.trim();
	if (!normalizedFirstTaskId || !normalizedSecondTaskId || normalizedFirstTaskId === normalizedSecondTaskId) {
		return false;
	}
	const resolved = resolveDependencyEndpoints(board, normalizedFirstTaskId, normalizedSecondTaskId);
	if ("reason" in resolved) {
		return false;
	}
	return !hasDependencyPair(board, resolved.backlogTaskId, resolved.linkedTaskId);
}

export function removeTaskDependency(board: RuntimeBoardData, dependencyId: string): RuntimeRemoveTaskDependencyResult {
	const dependencies = board.dependencies.filter((dependency) => dependency.id !== dependencyId);
	if (dependencies.length === board.dependencies.length) {
		return { board, removed: false };
	}
	const removedDependency = board.dependencies.find((dependency) => dependency.id === dependencyId);
	return {
		board: removedDependency
			? appendTaskEvent(
					{
						...board,
						dependencies,
					},
					{
						taskId: removedDependency.fromTaskId,
						type: "dependency_unlinked",
						message: `Unlinked from ${removedDependency.toTaskId}`,
						metadata: { dependencyId },
					},
				)
			: {
					...board,
					dependencies,
				},
		removed: true,
	};
}

export function getReadyLinkedTaskIdsForTaskInTrash(board: RuntimeBoardData, taskId: string): string[] {
	return getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, getTaskColumnId(board, taskId));
}

export function trashTaskAndGetReadyLinkedTaskIds(
	board: RuntimeBoardData,
	taskId: string,
	now: number = Date.now(),
): RuntimeTrashTaskResult {
	const fromColumnId = getTaskColumnId(board, taskId);
	const readyTaskIds = getLinkedBacklogTaskIdsReadyAfterTaskTrashed(board, taskId, fromColumnId);
	const movedToTrash = moveTaskToColumn(board, taskId, "trash", now);
	return {
		...movedToTrash,
		readyTaskIds: movedToTrash.moved ? readyTaskIds : [],
	};
}

export function deleteTasksFromBoard(board: RuntimeBoardData, taskIds: Iterable<string>): RuntimeDeleteTasksResult {
	const normalizedTaskIds = new Set(
		Array.from(taskIds, (taskId) => taskId.trim()).filter((taskId) => taskId.length > 0),
	);
	if (normalizedTaskIds.size === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIds: string[] = [];
	const columns = board.columns.map((column) => {
		const remainingCards = column.cards.filter((card) => {
			if (!normalizedTaskIds.has(card.id)) {
				return true;
			}
			deletedTaskIds.push(card.id);
			return false;
		});
		return remainingCards.length === column.cards.length ? column : { ...column, cards: remainingCards };
	});

	if (deletedTaskIds.length === 0) {
		return {
			board,
			deleted: false,
			deletedTaskIds: [],
		};
	}

	const deletedTaskIdSet = new Set(deletedTaskIds);
	const dependencies = board.dependencies.filter(
		(dependency) => !deletedTaskIdSet.has(dependency.fromTaskId) && !deletedTaskIdSet.has(dependency.toTaskId),
	);

	return {
		board: deletedTaskIds.reduce(
			(nextBoard, taskId) =>
				appendTaskEvent(nextBoard, {
					taskId,
					type: "deleted",
				}),
			{
				...board,
				columns,
				dependencies,
			},
		),
		deleted: true,
		deletedTaskIds,
	};
}

export function moveTaskToColumn(
	board: RuntimeBoardData,
	taskId: string,
	targetColumnId: RuntimeBoardColumnId,
	now: number = Date.now(),
): RuntimeMoveTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}

	const found = findTaskLocation(board, normalizedTaskId);
	if (!found) {
		return {
			moved: false,
			board,
			task: null,
			fromColumnId: null,
		};
	}
	if (found.columnId === targetColumnId) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const targetColumnIndex = board.columns.findIndex((column) => column.id === targetColumnId);
	if (targetColumnIndex === -1) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceColumn = board.columns[found.columnIndex];
	const targetColumn = board.columns[targetColumnIndex];
	if (!sourceColumn || !targetColumn) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}

	const sourceCards = [...sourceColumn.cards];
	const [task] = sourceCards.splice(found.taskIndex, 1);
	if (!task) {
		return {
			moved: false,
			board,
			task: found.task,
			fromColumnId: found.columnId,
		};
	}
	const movedTask: RuntimeBoardCard = {
		...task,
		updatedAt: now,
	};
	const targetCards =
		targetColumnId === "trash" ? [movedTask, ...targetColumn.cards] : [...targetColumn.cards, movedTask];

	const columns = board.columns.map((column, index) => {
		if (index === found.columnIndex) {
			return {
				...column,
				cards: sourceCards,
			};
		}
		if (index === targetColumnIndex) {
			return {
				...column,
				cards: targetCards,
			};
		}
		return column;
	});

	return {
		moved: true,
		board: appendTaskEvent(
			updateTaskDependencies({
				...board,
				columns,
			}),
			{
				taskId: normalizedTaskId,
				type: "moved",
				now,
				fromColumnId: found.columnId,
				toColumnId: targetColumnId,
			},
		),
		task: movedTask,
		fromColumnId: found.columnId,
	};
}

export function updateTask(
	board: RuntimeBoardData,
	taskId: string,
	input: RuntimeUpdateTaskInput,
	now: number = Date.now(),
): RuntimeUpdateTaskResult {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const prompt = input.prompt.trim();
	if (!prompt) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	const baseRef = input.baseRef.trim();
	if (!baseRef) {
		return {
			board,
			task: null,
			updated: false,
		};
	}

	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let columnUpdated = false;
		const cards = column.cards.map((card) => {
			if (card.id !== normalizedTaskId) {
				return card;
			}
			columnUpdated = true;
			updatedTask = {
				...card,
				prompt,
				profileId: input.profileId === undefined ? card.profileId : input.profileId.trim() || undefined,
				requiredCapabilities:
					input.requiredCapabilities === undefined
						? card.requiredCapabilities
						: cloneRequiredCapabilities(input.requiredCapabilities),
				blockedReason: input.blockedReason === undefined ? card.blockedReason : input.blockedReason?.trim() || null,
				maxAttempts: input.maxAttempts === undefined ? card.maxAttempts : input.maxAttempts,
				startInPlanMode: Boolean(input.startInPlanMode),
				autoReviewEnabled: Boolean(input.autoReviewEnabled),
				autoReviewMode: normalizeTaskAutoReviewMode(input.autoReviewMode),
				images: input.images === undefined ? card.images : cloneTaskImages(input.images),
				baseRef,
				updatedAt: now,
			};
			return updatedTask;
		});
		return columnUpdated ? { ...column, cards } : column;
	});

	if (!updatedTask) {
		return {
			board,
			task: null,
			updated: false,
		};
	}
	const eventTask: RuntimeBoardCard = updatedTask;

	return {
		board: appendTaskEvent(
			{
				...board,
				columns,
			},
			{
				taskId: normalizedTaskId,
				type: eventTask.blockedReason ? "blocked" : "updated",
				now,
				message: eventTask.blockedReason ?? null,
			},
		),
		task: updatedTask,
		updated: true,
	};
}

export function claimTaskForRun(board: RuntimeBoardData, input: RuntimeClaimTaskInput): RuntimeClaimTaskResult {
	const now = input.now ?? Date.now();
	const found = findTaskLocation(board, input.taskId.trim());
	if (!found) {
		return { board, claimed: false, task: null, run: null, lockId: null, reason: "missing_task" };
	}
	if (found.task.blockedReason) {
		return { board, claimed: false, task: found.task, run: null, lockId: null, reason: "blocked" };
	}
	if (found.task.claim && found.task.claim.expiresAt > now) {
		return { board, claimed: false, task: found.task, run: null, lockId: null, reason: "already_claimed" };
	}
	const maxAttempts = input.maxAttempts ?? found.task.maxAttempts ?? 3;
	const attemptCount = found.task.attemptCount ?? 0;
	if (attemptCount >= maxAttempts) {
		return { board, claimed: false, task: found.task, run: null, lockId: null, reason: "attempts_exhausted" };
	}
	const lockId = createLockId();
	const runId = createRunId();
	const claim: RuntimeTaskClaim = {
		assignee: input.assignee.trim() || "dispatcher",
		lockId,
		claimedAt: now,
		expiresAt: now + input.claimTtlMs,
		heartbeatAt: now,
		pid: input.pid ?? null,
	};
	const run: RuntimeTaskRun = {
		id: runId,
		taskId: found.task.id,
		profileId: input.profileId ?? found.task.profileId ?? null,
		agentId: input.agentId ?? null,
		status: "claimed",
		startedAt: now,
		updatedAt: now,
		finishedAt: null,
		pid: input.pid ?? null,
		error: null,
		summary: null,
	};
	let updatedTask: RuntimeBoardCard = {
		...found.task,
		claim,
		attemptCount: attemptCount + 1,
		maxAttempts,
		lastError: null,
		lastRunId: runId,
		updatedAt: now,
	};
	let columns = board.columns.map((column, columnIndex) => {
		if (columnIndex !== found.columnIndex) {
			return column;
		}
		return {
			...column,
			cards: column.cards.map((card, taskIndex) => (taskIndex === found.taskIndex ? updatedTask : card)),
		};
	});
	let nextBoard: RuntimeBoardData = { ...board, columns };
	if (found.columnId !== "in_progress") {
		const moved = moveTaskToColumn(nextBoard, found.task.id, "in_progress", now);
		nextBoard = moved.board;
		updatedTask = moved.task ?? updatedTask;
		columns = nextBoard.columns;
	}
	nextBoard = updateTaskRun(nextBoard, run);
	nextBoard = appendTaskEvent(nextBoard, {
		taskId: found.task.id,
		type: "claimed",
		now,
		actor: claim.assignee,
		runId,
		fromColumnId: found.columnId,
		toColumnId: "in_progress",
		metadata: { lockId, attempt: updatedTask.attemptCount ?? 1 },
	});
	return {
		board: nextBoard,
		claimed: true,
		task: updatedTask,
		run,
		lockId,
	};
}

export function heartbeatTaskClaim(
	board: RuntimeBoardData,
	taskId: string,
	lockId: string,
	claimTtlMs: number,
	now: number = Date.now(),
): RuntimeTaskHeartbeatResult {
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, updated: false, reason: "missing_task" };
	}
	if (!found.task.claim) {
		return { board, updated: false, reason: "no_claim" };
	}
	if (found.task.claim.lockId !== lockId) {
		return { board, updated: false, reason: "lock_mismatch" };
	}
	if (found.task.claim.expiresAt <= now) {
		return { board, updated: false, reason: "expired" };
	}
	const task: RuntimeBoardCard = {
		...found.task,
		claim: {
			...found.task.claim,
			heartbeatAt: now,
			expiresAt: now + claimTtlMs,
		},
		updatedAt: now,
	};
	const columns = board.columns.map((column, columnIndex) =>
		columnIndex === found.columnIndex
			? { ...column, cards: column.cards.map((card, taskIndex) => (taskIndex === found.taskIndex ? task : card)) }
			: column,
	);
	return {
		board: appendTaskEvent(
			{
				...board,
				columns,
			},
			{
				taskId: found.task.id,
				type: "heartbeat",
				now,
				actor: found.task.claim.assignee,
				runId: found.task.lastRunId,
			},
		),
		updated: true,
	};
}

export function markTaskRunStarted(
	board: RuntimeBoardData,
	taskId: string,
	input: { pid?: number | null; now?: number } = {},
): RuntimeMarkTaskRunStartedResult {
	const now = input.now ?? Date.now();
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, updated: false, reason: "missing_task" };
	}
	const run = (board.runs ?? []).find((candidate) => candidate.id === found.task.lastRunId);
	if (!run) {
		return { board, updated: false, reason: "no_run" };
	}
	let nextBoard = updateTaskRun(board, {
		...run,
		status: "running",
		updatedAt: now,
		pid: input.pid ?? run.pid,
	});
	nextBoard = appendTaskEvent(nextBoard, {
		taskId: found.task.id,
		type: "started",
		now,
		actor: found.task.claim?.assignee,
		runId: run.id,
	});
	return { board: nextBoard, updated: true };
}

export function releaseTaskClaim(
	board: RuntimeBoardData,
	taskId: string,
	lockId: string | null,
	input: {
		status?: RuntimeTaskRun["status"];
		error?: string | null;
		summary?: string | null;
		now?: number;
	} = {},
): RuntimeReleaseTaskClaimResult {
	const now = input.now ?? Date.now();
	const found = findTaskLocation(board, taskId.trim());
	if (!found) {
		return { board, released: false, reason: "missing_task" };
	}
	if (!found.task.claim) {
		return { board, released: false, reason: "no_claim" };
	}
	if (lockId && found.task.claim.lockId !== lockId) {
		return { board, released: false, reason: "lock_mismatch" };
	}
	const task: RuntimeBoardCard = {
		...found.task,
		claim: null,
		lastError: input.error ?? null,
		updatedAt: now,
	};
	const columns = board.columns.map((column, columnIndex) =>
		columnIndex === found.columnIndex
			? { ...column, cards: column.cards.map((card, taskIndex) => (taskIndex === found.taskIndex ? task : card)) }
			: column,
	);
	let nextBoard: RuntimeBoardData = { ...board, columns };
	const run = (nextBoard.runs ?? []).find((candidate) => candidate.id === found.task.lastRunId);
	if (run) {
		nextBoard = updateTaskRun(nextBoard, {
			...run,
			status: input.status ?? "cancelled",
			updatedAt: now,
			finishedAt: now,
			error: input.error ?? null,
			summary: input.summary ?? null,
		});
	}
	nextBoard = appendTaskEvent(nextBoard, {
		taskId: found.task.id,
		type: input.error ? "failed" : "released",
		now,
		actor: found.task.claim.assignee,
		runId: found.task.lastRunId,
		message: input.error ?? input.summary ?? null,
	});
	return { board: nextBoard, released: true };
}

export function reclaimExpiredTaskClaims(
	board: RuntimeBoardData,
	now: number = Date.now(),
): RuntimeReclaimExpiredTasksResult {
	let nextBoard = board;
	const reclaimedTaskIds: string[] = [];
	for (const column of board.columns) {
		for (const task of column.cards) {
			if (!task.claim || task.claim.expiresAt > now) {
				continue;
			}
			const released = releaseTaskClaim(nextBoard, task.id, task.claim.lockId, {
				status: "reclaimed",
				error: "Claim expired before the worker heartbeat was renewed.",
				now,
			});
			nextBoard = appendTaskEvent(released.board, {
				taskId: task.id,
				type: "reclaimed",
				now,
				actor: task.claim.assignee,
				runId: task.lastRunId,
			});
			reclaimedTaskIds.push(task.id);
		}
	}
	return { board: nextBoard, reclaimedTaskIds };
}
