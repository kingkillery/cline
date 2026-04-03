import { applyRuntimeTaskGraphToBoard } from "@runtime-task-graph";
import type { BoardData, TaskAutoReviewMode } from "@/types";
import type { RuntimeTaskHandoffPacket } from "@/runtime/types";

export interface NativeToolComposerInput {
	goal: string;
	successCondition: string;
	constraints: string;
	relevantContext: string;
	defaultBaseRef: string;
	defaultStartInPlanMode: boolean;
	defaultAutoReviewEnabled: boolean;
	defaultAutoReviewMode: TaskAutoReviewMode;
}

export interface NativeToolDraftNode {
	id: string;
	title: string;
	outcome: string;
	implementationNotes: string;
	acceptanceCriteria: string;
	dependsOn: string[];
	handoff: RuntimeTaskHandoffPacket;
	startInPlanMode: boolean;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
	baseRefOverride: string;
}

export interface NativeToolDraftGraph {
	nodes: NativeToolDraftNode[];
}

export interface ApplyDraftGraphResult {
	board: BoardData;
	createdTaskIds: string[];
}

function sanitizeLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function parseListItems(text: string): string[] {
	const lines = text
		.split("\n")
		.map((line) => sanitizeLine(line))
		.filter(Boolean);
	if (lines.length < 2) {
		return [];
	}
	const numberedRegex = /^\d+[.)]\s+(.+)$/;
	const bulletRegex = /^[-*+•]\s+(.+)$/;
	const numberedItems = lines.map((line) => numberedRegex.exec(line));
	if (numberedItems.every((match) => match !== null)) {
		return numberedItems.map((match) => sanitizeLine(match?.[1] ?? ""));
	}
	const bulletItems = lines.map((line) => bulletRegex.exec(line));
	if (bulletItems.every((match) => match !== null)) {
		return bulletItems.map((match) => sanitizeLine(match?.[1] ?? ""));
	}
	return [];
}

function createDraftNodeId(index: number): string {
	return `draft-${index + 1}`;
}

function createDraftNode(
	index: number,
	title: string,
	input: NativeToolComposerInput,
	dependsOn: string[] = [],
): NativeToolDraftNode {
	const normalizedTitle = sanitizeLine(title) || `Task ${index + 1}`;
	return {
		id: createDraftNodeId(index),
		title: normalizedTitle,
		outcome: normalizedTitle,
		implementationNotes: input.relevantContext,
		acceptanceCriteria: input.successCondition,
		dependsOn,
		handoff: {},
		startInPlanMode: input.defaultStartInPlanMode,
		autoReviewEnabled: input.defaultAutoReviewEnabled,
		autoReviewMode: input.defaultAutoReviewMode,
		baseRefOverride: "",
	};
}

function buildScaffoldedGraph(input: NativeToolComposerInput): NativeToolDraftGraph {
	const goal = sanitizeLine(input.goal) || "Complete the requested work";
	const first = createDraftNode(0, `Map scope for ${goal}`, input);
	const second = createDraftNode(1, `Implement ${goal}`, input, [first.id]);
	const third = createDraftNode(2, `Validate and hand off ${goal}`, input, [second.id]);
	third.handoff = {
		context: "Summarize what changed and what downstream reviewers or follow-on tasks need to know.",
		outputExpected: "Verified implementation with clear handoff notes.",
		validationGate: input.successCondition || "Validation evidence is attached before the task is considered complete.",
	};
	return {
		nodes: [first, second, third],
	};
}

export function generateNativeToolDraftGraph(input: NativeToolComposerInput): NativeToolDraftGraph {
	const parsedItems = parseListItems(input.goal);
	if (parsedItems.length === 0) {
		return buildScaffoldedGraph(input);
	}
	const nodes = parsedItems.map((item, index) =>
		createDraftNode(index, item, input, index === 0 ? [] : [createDraftNodeId(index - 1)]),
	);
	const lastNode = nodes.at(-1);
	if (lastNode) {
		lastNode.handoff = {
			context: input.relevantContext || "Carry forward the upstream task context into the final validation step.",
			outputExpected: input.successCondition || "Concrete evidence that the requested work is complete.",
			validationGate: input.successCondition || "Validation completed.",
		};
	}
	return { nodes };
}

export function validateNativeToolDraftGraph(graph: NativeToolDraftGraph): string[] {
	const errors: string[] = [];
	const nodeIdSet = new Set(graph.nodes.map((node) => node.id));
	const dependencyMap = new Map(graph.nodes.map((node) => [node.id, node.dependsOn]));
	for (const node of graph.nodes) {
		if (!sanitizeLine(node.title)) {
			errors.push("Every task needs a title.");
		}
		for (const dependencyId of node.dependsOn) {
			if (!nodeIdSet.has(dependencyId)) {
				errors.push("A dependency references a missing draft node.");
			}
			if (dependencyId === node.id) {
				errors.push("A task cannot depend on itself.");
			}
		}
	}
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const hasCycleFrom = (nodeId: string): boolean => {
		if (visiting.has(nodeId)) {
			return true;
		}
		if (visited.has(nodeId)) {
			return false;
		}
		visiting.add(nodeId);
		for (const dependencyId of dependencyMap.get(nodeId) ?? []) {
			if (hasCycleFrom(dependencyId)) {
				return true;
			}
		}
		visiting.delete(nodeId);
		visited.add(nodeId);
		return false;
	};
	for (const node of graph.nodes) {
		if (hasCycleFrom(node.id)) {
			errors.push("This draft graph contains a dependency cycle.");
			break;
		}
	}
	return Array.from(new Set(errors));
}

function buildTaskPrompt(node: NativeToolDraftNode, input: NativeToolComposerInput): string {
	const sections: string[] = [node.title];
	const outcome = sanitizeLine(node.outcome);
	if (outcome) {
		sections.push(`Outcome:\n${outcome}`);
	}
	const implementationNotes = node.implementationNotes.trim() || input.relevantContext.trim();
	if (implementationNotes) {
		sections.push(`Context:\n${implementationNotes}`);
	}
	const acceptanceCriteria = node.acceptanceCriteria.trim() || input.successCondition.trim();
	if (acceptanceCriteria) {
		sections.push(`Acceptance criteria:\n${acceptanceCriteria}`);
	}
	const constraintText = input.constraints.trim();
	if (constraintText) {
		sections.push(`Constraints:\n${constraintText}`);
	}
	const handoffParts: string[] = [];
	if (node.handoff.context?.trim()) {
		handoffParts.push(`Context: ${node.handoff.context.trim()}`);
	}
	if (node.handoff.outputExpected?.trim()) {
		handoffParts.push(`Output expected: ${node.handoff.outputExpected.trim()}`);
	}
	if (node.handoff.filesLikelyAffected && node.handoff.filesLikelyAffected.length > 0) {
		handoffParts.push(`Files likely affected: ${node.handoff.filesLikelyAffected.join(", ")}`);
	}
	if (node.handoff.validationGate?.trim()) {
		handoffParts.push(`Validation gate: ${node.handoff.validationGate.trim()}`);
	}
	if (node.handoff.risksToWatch && node.handoff.risksToWatch.length > 0) {
		handoffParts.push(`Risks to watch: ${node.handoff.risksToWatch.join(", ")}`);
	}
	if (handoffParts.length > 0) {
		sections.push(`Handoff packet:\n${handoffParts.join("\n")}`);
	}
	return sections.join("\n\n");
}

export function applyNativeToolDraftGraphToBoard(
	board: BoardData,
	graph: NativeToolDraftGraph,
	input: NativeToolComposerInput,
): ApplyDraftGraphResult {
	const errors = validateNativeToolDraftGraph(graph);
	if (errors.length > 0) {
		throw new Error(errors[0]);
	}
	const applied = applyRuntimeTaskGraphToBoard(
		board,
		{
			tasks: graph.nodes.map((node) => ({
				clientId: node.id,
				title: node.title,
				summary: node.outcome,
				prompt: buildTaskPrompt(node, input),
				baseRef: node.baseRefOverride.trim() || input.defaultBaseRef,
				startInPlanMode: node.startInPlanMode,
				autoReviewEnabled: node.autoReviewEnabled,
				autoReviewMode: node.autoReviewMode,
			})),
			dependencies: graph.nodes.flatMap((node) =>
				node.dependsOn.map((prerequisiteId) => ({
					dependentId: node.id,
					prerequisiteId,
					handoff: node.handoff,
				})),
			),
			defaults: {
				baseRef: input.defaultBaseRef,
				startInPlanMode: input.defaultStartInPlanMode,
				autoReviewEnabled: input.defaultAutoReviewEnabled,
				autoReviewMode: input.defaultAutoReviewMode,
			},
		},
		{
			randomUuid: () => crypto.randomUUID(),
			defaultBaseRef: input.defaultBaseRef,
		},
	);

	return {
		board: applied.board,
		createdTaskIds: applied.createdTaskIds,
	};
}
