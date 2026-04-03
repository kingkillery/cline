import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, FileSymlink, GitBranch, Network, Plus, Sparkles, Wand2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { BranchSelectDropdown, type BranchSelectOption } from "@/components/branch-select-dropdown";
import {
	applyNativeToolDraftGraphToBoard,
	type NativeToolComposerInput,
	type NativeToolDraftGraph,
	type NativeToolDraftNode,
	generateNativeToolDraftGraph,
	validateNativeToolDraftGraph,
} from "@/components/native-tool/native-tool-graph";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { BoardData, TaskAutoReviewMode } from "@/types";

const AUTO_REVIEW_MODE_OPTIONS: Array<{ value: TaskAutoReviewMode; label: string }> = [
	{ value: "commit", label: "Commit" },
	{ value: "pr", label: "PR" },
	{ value: "move_to_trash", label: "Trash" },
];
const DEFAULT_PLAN_MODE_CHECKBOX_ID = "native-tool-default-plan-mode";
const DEFAULT_AUTO_REVIEW_CHECKBOX_ID = "native-tool-default-auto-review";

function createExampleDraftGraph(defaults: NativeToolComposerInput): NativeToolDraftGraph {
	return {
		nodes: [
			{
				id: "draft-1",
				title: "Map the current behavior",
				outcome: "Capture how the current task and dependency workflow behaves before changing it.",
				implementationNotes: defaults.relevantContext,
				acceptanceCriteria: "Current behavior and constraints are documented in the task output.",
				dependsOn: [],
				handoff: {},
				startInPlanMode: true,
				autoReviewEnabled: false,
				autoReviewMode: defaults.defaultAutoReviewMode,
				baseRefOverride: "",
			},
			{
				id: "draft-2",
				title: "Implement the native tool surface",
				outcome: "Add the dedicated Tool panel and graph authoring flow.",
				implementationNotes: defaults.relevantContext,
				acceptanceCriteria: defaults.successCondition || "The Tool panel drafts and applies a task graph.",
				dependsOn: ["draft-1"],
				handoff: {
					context: "Carry forward the discovered workflow constraints into the implementation.",
					outputExpected: "A working native tool panel.",
				},
				startInPlanMode: defaults.defaultStartInPlanMode,
				autoReviewEnabled: defaults.defaultAutoReviewEnabled,
				autoReviewMode: defaults.defaultAutoReviewMode,
				baseRefOverride: "",
			},
			{
				id: "draft-3",
				title: "Validate dependency and handoff behavior",
				outcome: "Prove the new surface creates correct task links and preserves explicit handoff notes.",
				implementationNotes: defaults.relevantContext,
				acceptanceCriteria: "Targeted tests cover graph application and blocker semantics.",
				dependsOn: ["draft-2"],
				handoff: {
					context: "Summarize what changed and note any remaining gaps before shipping.",
					outputExpected: "Validation evidence and clear release notes.",
					validationGate: defaults.successCondition || "Tests and typecheck pass.",
				},
				startInPlanMode: defaults.defaultStartInPlanMode,
				autoReviewEnabled: defaults.defaultAutoReviewEnabled,
				autoReviewMode: defaults.defaultAutoReviewMode,
				baseRefOverride: "",
			},
		],
	};
}

function countGraphEdges(graph: NativeToolDraftGraph | null): number {
	if (!graph) {
		return 0;
	}
	return graph.nodes.reduce((count, node) => count + node.dependsOn.length, 0);
}

function countGraphHandoffs(graph: NativeToolDraftGraph | null): number {
	if (!graph) {
		return 0;
	}
	return graph.nodes.filter(
		(node) =>
			Boolean(node.handoff.context?.trim()) ||
			Boolean(node.handoff.outputExpected?.trim()) ||
			Boolean(node.handoff.validationGate?.trim()) ||
			Boolean(node.handoff.filesLikelyAffected?.length) ||
			Boolean(node.handoff.risksToWatch?.length),
	).length;
}

function createEmptyDraftNode(
	graph: NativeToolDraftGraph | null,
	defaults: NativeToolComposerInput,
): NativeToolDraftNode {
	const index = graph?.nodes.length ?? 0;
	return {
		id: `draft-${index + 1}`,
		title: `Task ${index + 1}`,
		outcome: "",
		implementationNotes: defaults.relevantContext,
		acceptanceCriteria: defaults.successCondition,
		dependsOn: [],
		handoff: {},
		startInPlanMode: defaults.defaultStartInPlanMode,
		autoReviewEnabled: defaults.defaultAutoReviewEnabled,
		autoReviewMode: defaults.defaultAutoReviewMode,
		baseRefOverride: "",
	};
}

export function KanbanNativeToolPanel({
	board,
	setBoard,
	setSelectedTaskId,
	workspaceId,
	branchRef,
	branchOptions,
	startInPlanMode,
	autoReviewEnabled,
	autoReviewMode,
}: {
	board: BoardData;
	setBoard: (value: BoardData) => void;
	setSelectedTaskId: (taskId: string | null) => void;
	workspaceId: string | null;
	branchRef: string;
	branchOptions: BranchSelectOption[];
	startInPlanMode: boolean;
	autoReviewEnabled: boolean;
	autoReviewMode: TaskAutoReviewMode;
}): ReactElement {
	const [goal, setGoal] = useState("");
	const [successCondition, setSuccessCondition] = useState("");
	const [constraints, setConstraints] = useState("");
	const [relevantContext, setRelevantContext] = useState("");
	const [defaultBaseRef, setDefaultBaseRef] = useState(branchRef);
	const [defaultStartInPlanMode, setDefaultStartInPlanMode] = useState(startInPlanMode);
	const [defaultAutoReviewEnabled, setDefaultAutoReviewEnabled] = useState(autoReviewEnabled);
	const [defaultAutoReviewMode, setDefaultAutoReviewMode] = useState(autoReviewMode);
	const [draftGraph, setDraftGraph] = useState<NativeToolDraftGraph | null>(null);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

	const defaults = useMemo<NativeToolComposerInput>(
		() => ({
			goal,
			successCondition,
			constraints,
			relevantContext,
			defaultBaseRef,
			defaultStartInPlanMode,
			defaultAutoReviewEnabled,
			defaultAutoReviewMode,
		}),
		[
			constraints,
			defaultAutoReviewEnabled,
			defaultAutoReviewMode,
			defaultBaseRef,
			defaultStartInPlanMode,
			goal,
			relevantContext,
			successCondition,
		],
	);

	const selectedNode = draftGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
	const validationErrors = useMemo(() => (draftGraph ? validateNativeToolDraftGraph(draftGraph) : []), [draftGraph]);

	const updateSelectedNode = useCallback(
		(mutator: (node: NativeToolDraftNode) => NativeToolDraftNode) => {
			if (!draftGraph || !selectedNodeId) {
				return;
			}
			setDraftGraph({
				nodes: draftGraph.nodes.map((node) => (node.id === selectedNodeId ? mutator(node) : node)),
			});
		},
		[draftGraph, selectedNodeId],
	);

	const handleGenerateGraph = useCallback(() => {
		const nextGraph = generateNativeToolDraftGraph(defaults);
		setDraftGraph(nextGraph);
		setSelectedNodeId(nextGraph.nodes[0]?.id ?? null);
	}, [defaults]);

	const handleLoadExample = useCallback(() => {
		const nextGraph = createExampleDraftGraph(defaults);
		setDraftGraph(nextGraph);
		setSelectedNodeId(nextGraph.nodes[0]?.id ?? null);
	}, [defaults]);

	const handleAddDraftNode = useCallback(() => {
		const nextNode = createEmptyDraftNode(draftGraph, defaults);
		const nextGraph = {
			nodes: [...(draftGraph?.nodes ?? []), nextNode],
		};
		setDraftGraph(nextGraph);
		setSelectedNodeId(nextNode.id);
	}, [defaults, draftGraph]);

	const handleDeleteSelectedNode = useCallback(() => {
		if (!draftGraph || !selectedNodeId) {
			return;
		}
		const nextNodes = draftGraph.nodes
			.filter((node) => node.id !== selectedNodeId)
			.map((node) => ({
				...node,
				dependsOn: node.dependsOn.filter((dependencyId) => dependencyId !== selectedNodeId),
			}));
		setDraftGraph(nextNodes.length > 0 ? { nodes: nextNodes } : null);
		setSelectedNodeId(nextNodes[0]?.id ?? null);
	}, [draftGraph, selectedNodeId]);

	const handleApplyToBoard = useCallback(() => {
		if (!draftGraph) {
			return;
		}
		if (!workspaceId) {
			showAppToast({
				intent: "warning",
				icon: "warning-sign",
				message: "Select a project before applying a task graph.",
				timeout: 3000,
			});
			return;
		}
		if (validationErrors.length > 0) {
			showAppToast({
				intent: "warning",
				icon: "warning-sign",
				message: validationErrors[0] ?? "The task graph is not ready to apply.",
				timeout: 3500,
			});
			return;
		}
		try {
			const applied = applyNativeToolDraftGraphToBoard(board, draftGraph, defaults);
			setBoard(applied.board);
			setSelectedTaskId(applied.createdTaskIds[0] ?? null);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: `Created ${applied.createdTaskIds.length} task${applied.createdTaskIds.length === 1 ? "" : "s"} from the draft graph.`,
				timeout: 3000,
			});
		} catch (error) {
			showAppToast({
				intent: "danger",
				icon: "warning-sign",
				message: error instanceof Error ? error.message : "Could not apply the task graph.",
				timeout: 4000,
			});
		}
	}, [board, defaults, draftGraph, setBoard, setSelectedTaskId, validationErrors, workspaceId]);

	const dependencyChoices = draftGraph?.nodes.filter((node) => node.id !== selectedNodeId) ?? [];

	return (
		<div className="flex w-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-surface-2">
			<div className="border-b border-border px-3 py-3">
				<div className="flex items-center justify-between gap-2">
					<div>
						<div className="text-[13px] font-semibold text-text-primary">Build Task Graph</div>
						<div className="mt-1 text-[11px] text-text-secondary">
							Draft connected tasks with explicit blockers and handoffs before applying them to the board.
						</div>
					</div>
					<div className="flex items-center gap-1">
						<StatPill icon={<Network size={11} />} label={`${draftGraph?.nodes.length ?? 0} tasks`} />
						<StatPill icon={<FileSymlink size={11} />} label={`${countGraphEdges(draftGraph)} links`} />
						<StatPill icon={<Sparkles size={11} />} label={`${countGraphHandoffs(draftGraph)} handoffs`} />
					</div>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
				<section className="rounded-md border border-border-bright bg-surface-1 p-3">
					<div className="mb-3 text-[12px] font-medium text-text-primary">Goal Composer</div>
					<div className="space-y-2.5">
						<LabeledTextarea
							label="Goal"
							value={goal}
							onChange={setGoal}
							placeholder="Describe the goal, or paste a short task breakdown list."
							minRows={4}
						/>
						<LabeledTextarea
							label="Success condition"
							value={successCondition}
							onChange={setSuccessCondition}
							placeholder="What must be true for this graph to be complete?"
							minRows={2}
						/>
						<LabeledTextarea
							label="Constraints"
							value={constraints}
							onChange={setConstraints}
							placeholder="Guardrails, constraints, or things the implementation must avoid."
							minRows={2}
						/>
						<LabeledTextarea
							label="Relevant files / issues / docs"
							value={relevantContext}
							onChange={setRelevantContext}
							placeholder="Files, URLs, issue numbers, or context to carry into every task."
							minRows={2}
						/>
						<div>
							<div className="mb-1 text-[11px] text-text-secondary">Default base ref</div>
							<BranchSelectDropdown
								options={branchOptions}
								selectedValue={defaultBaseRef}
								onSelect={setDefaultBaseRef}
								fill
								size="sm"
								emptyText="No branches detected"
							/>
						</div>
						<div className="grid grid-cols-[1fr_auto] gap-2">
							<label
								htmlFor={DEFAULT_PLAN_MODE_CHECKBOX_ID}
								className="flex items-center gap-2 text-[12px] text-text-primary"
							>
								<RadixCheckbox.Root
									id={DEFAULT_PLAN_MODE_CHECKBOX_ID}
									checked={defaultStartInPlanMode}
									onCheckedChange={(checked) => setDefaultStartInPlanMode(checked === true)}
									className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
								>
									<RadixCheckbox.Indicator>
										<Check size={10} className="text-white" />
									</RadixCheckbox.Indicator>
								</RadixCheckbox.Root>
								Start new graph tasks in plan mode
							</label>
							<div className="relative inline-flex">
								<select
									value={defaultAutoReviewMode}
									onChange={(event) => setDefaultAutoReviewMode(event.currentTarget.value as TaskAutoReviewMode)}
									className="h-7 appearance-none rounded-md border border-border-bright bg-surface-2 pl-2 pr-7 text-[12px] text-text-primary"
								>
									{AUTO_REVIEW_MODE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
									<GitBranch
										size={12}
										className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary"
									/>
							</div>
						</div>
						<label
							htmlFor={DEFAULT_AUTO_REVIEW_CHECKBOX_ID}
							className="flex items-center gap-2 text-[12px] text-text-primary"
						>
							<RadixCheckbox.Root
								id={DEFAULT_AUTO_REVIEW_CHECKBOX_ID}
								checked={defaultAutoReviewEnabled}
								onCheckedChange={(checked) => setDefaultAutoReviewEnabled(checked === true)}
								className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
							>
								<RadixCheckbox.Indicator>
									<Check size={10} className="text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							Enable automatic review action by default
						</label>
						<div className="flex gap-2 pt-1">
							<Button variant="primary" size="sm" onClick={handleGenerateGraph} disabled={!goal.trim()}>
								<Wand2 size={13} />
								Generate graph
							</Button>
							<Button size="sm" onClick={handleLoadExample}>
								Load example
							</Button>
						</div>
					</div>
				</section>

				<section className="mt-3 rounded-md border border-border-bright bg-surface-1 p-3">
					<div className="mb-2 flex items-center justify-between">
						<div className="text-[12px] font-medium text-text-primary">Draft Graph</div>
						<Button size="sm" variant="ghost" onClick={handleAddDraftNode}>
							<Plus size={12} />
							Add task
						</Button>
					</div>
					{!draftGraph ? (
						<div className="rounded-md border border-dashed border-border-bright bg-surface-2/70 px-3 py-4 text-[12px] text-text-secondary">
							Build a graph from a goal or load the example flow. This panel becomes the native board-authoring
							surface for connected tasks.
						</div>
					) : (
						<div className="space-y-2">
							{draftGraph.nodes.map((node) => {
								const isSelected = node.id === selectedNodeId;
								return (
									<button
										key={node.id}
										type="button"
										onClick={() => setSelectedNodeId(node.id)}
										className={cn(
											"w-full rounded-md border px-3 py-2 text-left transition-colors",
											isSelected
												? "border-accent bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-accent)]"
												: "border-border-bright bg-surface-2 hover:bg-surface-3",
										)}
									>
										<div className="flex items-start justify-between gap-2">
											<div>
												<div className="text-[12px] font-medium text-text-primary">{node.title}</div>
												<div className="mt-1 text-[11px] text-text-secondary">{node.outcome || "No outcome yet."}</div>
											</div>
											<div className="flex shrink-0 items-center gap-1">
												{node.dependsOn.length > 0 ? (
													<span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] text-status-orange">
														{node.dependsOn.length} blocker{node.dependsOn.length === 1 ? "" : "s"}
													</span>
												) : (
													<span className="rounded-full bg-status-blue/15 px-1.5 py-0.5 text-[10px] text-status-blue">
														Ready
													</span>
												)}
												{countGraphHandoffs({ nodes: [node] }) > 0 ? (
													<span className="rounded-full bg-status-violet/15 px-1.5 py-0.5 text-[10px] text-status-violet">
														Handoff
													</span>
												) : null}
											</div>
										</div>
										{node.dependsOn.length > 0 ? (
											<div className="mt-2 text-[10px] text-text-tertiary">
												Blocked by{" "}
												{node.dependsOn
													.map((dependencyId) => draftGraph.nodes.find((candidate) => candidate.id === dependencyId)?.title ?? "Task")
													.join(", ")}
											</div>
										) : null}
									</button>
								);
							})}
						</div>
					)}
				</section>

				<section className="mt-3 rounded-md border border-border-bright bg-surface-1 p-3">
					<div className="mb-2 flex items-center justify-between">
						<div className="text-[12px] font-medium text-text-primary">Inspector</div>
						{selectedNode ? (
							<Button size="sm" variant="ghost" onClick={handleDeleteSelectedNode}>
								Delete
							</Button>
						) : null}
					</div>
					{!selectedNode ? (
						<div className="rounded-md border border-dashed border-border-bright bg-surface-2/70 px-3 py-4 text-[12px] text-text-secondary">
							Select a draft task to edit its prompt shape, blockers, and handoff packet.
						</div>
					) : (
						<div className="space-y-2.5">
							<LabeledInput
								label="Title"
								value={selectedNode.title}
								onChange={(value) => updateSelectedNode((node) => ({ ...node, title: value }))}
								placeholder="Short task title"
							/>
							<LabeledTextarea
								label="Outcome"
								value={selectedNode.outcome}
								onChange={(value) => updateSelectedNode((node) => ({ ...node, outcome: value }))}
								placeholder="What should this task accomplish?"
								minRows={2}
							/>
							<LabeledTextarea
								label="Implementation notes"
								value={selectedNode.implementationNotes}
								onChange={(value) =>
									updateSelectedNode((node) => ({ ...node, implementationNotes: value }))
								}
								placeholder="Files, caveats, or repo context to include in the prompt."
								minRows={3}
							/>
							<LabeledTextarea
								label="Acceptance criteria"
								value={selectedNode.acceptanceCriteria}
								onChange={(value) =>
									updateSelectedNode((node) => ({ ...node, acceptanceCriteria: value }))
								}
								placeholder="How should completion be verified?"
								minRows={2}
							/>
							<div>
								<div className="mb-1 text-[11px] text-text-secondary">Depends on</div>
								<div className="flex flex-wrap gap-1.5">
									{dependencyChoices.length === 0 ? (
										<div className="text-[11px] text-text-tertiary">No other tasks yet.</div>
									) : (
										dependencyChoices.map((node) => {
											const isActive = selectedNode.dependsOn.includes(node.id);
											return (
												<button
													key={node.id}
													type="button"
													onClick={() =>
														updateSelectedNode((currentNode) => ({
															...currentNode,
															dependsOn: isActive
																? currentNode.dependsOn.filter((dependencyId) => dependencyId !== node.id)
																: [...currentNode.dependsOn, node.id],
														}))
													}
													className={cn(
														"rounded-full border px-2 py-1 text-[11px]",
														isActive
															? "border-accent bg-accent/15 text-accent"
															: "border-border-bright bg-surface-2 text-text-secondary hover:text-text-primary",
													)}
												>
													{node.title}
												</button>
											);
										})
									)}
								</div>
							</div>
							<LabeledTextarea
								label="Handoff context"
								value={selectedNode.handoff.context ?? ""}
								onChange={(value) =>
									updateSelectedNode((node) => ({
										...node,
										handoff: { ...node.handoff, context: value },
									}))
								}
								placeholder="What should downstream tasks know when this task completes?"
								minRows={2}
							/>
							<LabeledTextarea
								label="Output expected"
								value={selectedNode.handoff.outputExpected ?? ""}
								onChange={(value) =>
									updateSelectedNode((node) => ({
										...node,
										handoff: { ...node.handoff, outputExpected: value },
									}))
								}
								placeholder="Expected artifact or result of the handoff."
								minRows={2}
							/>
							<LabeledTextarea
								label="Validation gate"
								value={selectedNode.handoff.validationGate ?? ""}
								onChange={(value) =>
									updateSelectedNode((node) => ({
										...node,
										handoff: { ...node.handoff, validationGate: value },
									}))
								}
								placeholder="What must be true before downstream work should continue?"
								minRows={2}
							/>
						</div>
					)}
				</section>
			</div>

			<div className="border-t border-border px-3 py-3">
				{validationErrors.length > 0 ? (
					<div className="mb-2 rounded-md border border-status-red/30 bg-status-red/10 px-2.5 py-2 text-[11px] text-status-red">
						{validationErrors[0]}
					</div>
				) : null}
				<div className="mb-2 text-[11px] text-text-secondary">
					Apply result: {draftGraph?.nodes.length ?? 0} task{draftGraph?.nodes.length === 1 ? "" : "s"},{" "}
					{countGraphEdges(draftGraph)} link{countGraphEdges(draftGraph) === 1 ? "" : "s"},{" "}
					{countGraphHandoffs(draftGraph)} handoff packet{countGraphHandoffs(draftGraph) === 1 ? "" : "s"}.
				</div>
				<Button
					variant="primary"
					fill
					onClick={handleApplyToBoard}
					disabled={!draftGraph || validationErrors.length > 0 || !defaultBaseRef}
				>
					Apply to board
				</Button>
			</div>
		</div>
	);
}

function StatPill({ icon, label }: { icon: ReactElement; label: string }): ReactElement {
	return (
		<span className="inline-flex items-center gap-1 rounded-full border border-border-bright bg-surface-1 px-2 py-1 text-[10px] text-text-secondary">
			{icon}
			{label}
		</span>
	);
}

function LabeledInput({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
}): ReactElement {
	return (
		<label className="block">
			<div className="mb-1 text-[11px] text-text-secondary">{label}</div>
			<input
				type="text"
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				placeholder={placeholder}
				className="w-full rounded-md border border-border-bright bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
			/>
		</label>
	);
}

function LabeledTextarea({
	label,
	value,
	onChange,
	placeholder,
	minRows,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	minRows: number;
}): ReactElement {
	return (
		<label className="block">
			<div className="mb-1 text-[11px] text-text-secondary">{label}</div>
			<textarea
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
				placeholder={placeholder}
				rows={minRows}
				className="w-full resize-y rounded-md border border-border-bright bg-surface-2 px-2.5 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
			/>
		</label>
	);
}
