import { describe, expect, it } from "vitest";

import {
	applyNativeToolDraftGraphToBoard,
	generateNativeToolDraftGraph,
	validateNativeToolDraftGraph,
} from "@/components/native-tool/native-tool-graph";
import { createInitialBoardData } from "@/data/board-data";

describe("native tool graph helpers", () => {
	const defaults = {
		goal: "1. Capture the current behavior\n2. Build the native tool\n3. Validate the flow",
		successCondition: "The graph can be applied to the board and the new flow is testable.",
		constraints: "No new dependencies.",
		relevantContext: "Touch the sidebar and board state carefully.",
		defaultBaseRef: "main",
		defaultStartInPlanMode: true,
		defaultAutoReviewEnabled: false,
		defaultAutoReviewMode: "commit" as const,
	};

	it("generates an editable sequential draft graph from a list goal", () => {
		const graph = generateNativeToolDraftGraph(defaults);
		expect(graph.nodes).toHaveLength(3);
		expect(graph.nodes[1]?.dependsOn).toEqual(["draft-1"]);
		expect(graph.nodes[2]?.dependsOn).toEqual(["draft-2"]);
	});

	it("validates missing dependency references", () => {
		const errors = validateNativeToolDraftGraph({
			nodes: [
				{
					id: "draft-1",
					title: "Task 1",
					outcome: "",
					implementationNotes: "",
					acceptanceCriteria: "",
					dependsOn: ["missing"],
					handoff: {},
					startInPlanMode: false,
					autoReviewEnabled: false,
					autoReviewMode: "commit",
					baseRefOverride: "",
				},
			],
		});
		expect(errors).toContain("A dependency references a missing draft node.");
	});

	it("rejects dependency cycles", () => {
		const errors = validateNativeToolDraftGraph({
			nodes: [
				{
					id: "draft-1",
					title: "Task 1",
					outcome: "",
					implementationNotes: "",
					acceptanceCriteria: "",
					dependsOn: ["draft-2"],
					handoff: {},
					startInPlanMode: false,
					autoReviewEnabled: false,
					autoReviewMode: "commit",
					baseRefOverride: "",
				},
				{
					id: "draft-2",
					title: "Task 2",
					outcome: "",
					implementationNotes: "",
					acceptanceCriteria: "",
					dependsOn: ["draft-1"],
					handoff: {},
					startInPlanMode: false,
					autoReviewEnabled: false,
					autoReviewMode: "commit",
					baseRefOverride: "",
				},
			],
		});
		expect(errors).toContain("This draft graph contains a dependency cycle.");
	});

	it("applies a draft graph atomically to the board with links", () => {
		const graph = generateNativeToolDraftGraph(defaults);
		const result = applyNativeToolDraftGraphToBoard(createInitialBoardData(), graph, defaults);
		const backlog = result.board.columns.find((column) => column.id === "backlog")?.cards ?? [];

		expect(result.createdTaskIds).toHaveLength(3);
		expect(backlog).toHaveLength(3);
		expect(result.board.dependencies).toHaveLength(2);
		expect(result.board.dependencies.every((dependency) => dependency.handoff !== undefined)).toBe(true);
	});
});
