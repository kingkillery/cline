import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskGraph } from "../../src/core/api-contract";
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
});
