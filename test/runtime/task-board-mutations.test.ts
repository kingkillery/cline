import { describe, expect, it } from "vitest";

import type { RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	claimTaskForRun,
	deleteTasksFromBoard,
	heartbeatTaskClaim,
	markTaskRunStarted,
	reclaimExpiredTaskClaims,
	releaseTaskClaim,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("task claim lifecycle", () => {
	it("claims a task, heartbeats the lease, then releases the run", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Claim me", baseRef: "main" },
			() => "aaaaa111",
			1000,
		);

		const claimed = claimTaskForRun(created.board, {
			taskId: created.task.id,
			assignee: "implementation",
			profileId: "implementation",
			agentId: "codex",
			pid: 123,
			claimTtlMs: 5000,
			now: 2000,
		});

		expect(claimed.claimed).toBe(true);
		expect(claimed.lockId).toBeTruthy();
		expect(claimed.task?.claim?.expiresAt).toBe(7000);
		expect(claimed.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(created.task.id);
		expect(claimed.board.runs?.[0]?.status).toBe("claimed");
		expect(claimed.board.events?.some((event) => event.type === "claimed")).toBe(true);

		const heartbeat = heartbeatTaskClaim(claimed.board, created.task.id, claimed.lockId ?? "", 5000, 3000);

		expect(heartbeat.updated).toBe(true);
		const heartbeatTask = heartbeat.board.columns.find((column) => column.id === "in_progress")?.cards[0];
		expect(heartbeatTask?.claim?.heartbeatAt).toBe(3000);
		expect(heartbeatTask?.claim?.expiresAt).toBe(8000);

		const running = markTaskRunStarted(heartbeat.board, created.task.id, { pid: 456, now: 3500 });

		expect(running.updated).toBe(true);
		expect(running.board.runs?.[0]?.status).toBe("running");
		expect(running.board.runs?.[0]?.pid).toBe(456);
		expect(running.board.events?.some((event) => event.type === "started")).toBe(true);

		const released = releaseTaskClaim(running.board, created.task.id, claimed.lockId, {
			status: "succeeded",
			summary: "Done",
			now: 4000,
		});

		expect(released.released).toBe(true);
		const releasedTask = released.board.columns.find((column) => column.id === "in_progress")?.cards[0];
		expect(releasedTask?.claim).toBeNull();
		expect(released.board.runs?.[0]?.status).toBe("succeeded");
		expect(released.board.runs?.[0]?.summary).toBe("Done");
	});

	it("does not claim a live claim and reclaims expired claims", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Claim me", baseRef: "main" },
			() => "aaaaa111",
			1000,
		);
		const claimed = claimTaskForRun(created.board, {
			taskId: created.task.id,
			assignee: "implementation",
			claimTtlMs: 1000,
			now: 2000,
		});
		const duplicate = claimTaskForRun(claimed.board, {
			taskId: created.task.id,
			assignee: "reviewer",
			claimTtlMs: 1000,
			now: 2500,
		});

		expect(duplicate.claimed).toBe(false);
		expect(duplicate.reason).toBe("already_claimed");

		const reclaimed = reclaimExpiredTaskClaims(claimed.board, 4000);

		expect(reclaimed.reclaimedTaskIds).toEqual([created.task.id]);
		const reclaimedTask = reclaimed.board.columns.find((column) => column.id === "in_progress")?.cards[0];
		expect(reclaimedTask?.claim).toBeNull();
		expect(reclaimed.board.runs?.[0]?.status).toBe("reclaimed");
		expect(reclaimed.board.events?.some((event) => event.type === "reclaimed")).toBe(true);
	});
});
