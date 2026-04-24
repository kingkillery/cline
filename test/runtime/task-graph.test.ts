import { describe, expect, it } from "vitest";

import { runtimeTaskGraphSchema, type RuntimeBoardData, type RuntimeTaskGraph } from "../../src/core/api-contract";
import { applyRuntimeTaskGraphToBoard } from "../../src/core/task-graph";

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

describe("applyRuntimeTaskGraphToBoard", () => {
	it("creates tasks and dependency edges atomically", () => {
		const graph: RuntimeTaskGraph = {
			tasks: [
				{ clientId: "task-a", title: "Task A", summary: "Short summary", prompt: "Task A" },
				{ clientId: "task-b", prompt: "Task B" },
			],
			dependencies: [
				{
					dependentId: "task-b",
					prerequisiteId: "task-a",
					handoff: {
						context: "Use the output of Task A.",
						outputExpected: "Validated follow-on change.",
					},
				},
			],
			defaults: {
				baseRef: "main",
				startInPlanMode: true,
			},
		};

		const result = applyRuntimeTaskGraphToBoard(createBoard(), graph, {
			randomUuid: () => "abcde111",
			defaultBaseRef: "main",
		});

		expect(result.createdTaskIds).toHaveLength(2);
		expect(result.taskIdByClientId["task-a"]).toBeTruthy();
		expect(result.taskIdByClientId["task-b"]).toBeTruthy();
		expect(result.board.columns.find((column) => column.id === "backlog")?.cards).toHaveLength(2);
		expect(result.board.columns.find((column) => column.id === "backlog")?.cards[1]).toMatchObject({
			title: "Task A",
			summary: "Short summary",
		});
		expect(result.board.dependencies).toEqual([
			expect.objectContaining({
				fromTaskId: result.taskIdByClientId["task-b"],
				toTaskId: result.taskIdByClientId["task-a"],
				handoff: expect.objectContaining({
					context: "Use the output of Task A.",
					outputExpected: "Validated follow-on change.",
				}),
			}),
		]);
	});

	it("rejects duplicate graph client ids before mutating the board", () => {
		const graph: RuntimeTaskGraph = {
			tasks: [
				{ clientId: "task-a", prompt: "Task A" },
				{ clientId: "task-a", prompt: "Task B" },
			],
			dependencies: [],
		};

		expect(() =>
			applyRuntimeTaskGraphToBoard(createBoard(), graph, {
				randomUuid: () => "abcde111",
				defaultBaseRef: "main",
			}),
		).toThrow('Task graph contains duplicate clientId "task-a".');
	});

	it("rejects dependencies that reference unknown graph tasks", () => {
		const graph: RuntimeTaskGraph = {
			tasks: [{ clientId: "task-a", prompt: "Task A" }],
			dependencies: [{ dependentId: "task-a", prerequisiteId: "task-b" }],
		};

		expect(() =>
			applyRuntimeTaskGraphToBoard(createBoard(), graph, {
				randomUuid: () => "abcde111",
				defaultBaseRef: "main",
			}),
		).toThrow("Dependency references unknown task client IDs: task-a -> task-b.");
	});

	it("rejects cyclic dependency graphs", () => {
		const graph: RuntimeTaskGraph = {
			tasks: [
				{ clientId: "task-a", prompt: "Task A" },
				{ clientId: "task-b", prompt: "Task B" },
			],
			dependencies: [
				{ dependentId: "task-a", prerequisiteId: "task-b" },
				{ dependentId: "task-b", prerequisiteId: "task-a" },
			],
		};

		expect(() =>
			applyRuntimeTaskGraphToBoard(createBoard(), graph, {
				randomUuid: () => "abcde111",
				defaultBaseRef: "main",
			}),
		).toThrow("Task graph contains a dependency cycle.");
	});

	it("rejects blank task ids and prompts at schema-parse time", () => {
		const parsed = runtimeTaskGraphSchema.safeParse({
			tasks: [{ clientId: "   ", prompt: "   " }],
			dependencies: [],
		});

		expect(parsed.success).toBe(false);
		if (parsed.success) {
			return;
		}
		expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
			expect.arrayContaining([
				"Task graph task clientId is required.",
				"Task graph task prompt is required.",
			]),
		);
	});
});
