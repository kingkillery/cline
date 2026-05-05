// Task-oriented facade for native Cline sessions.
// runtime-api.ts uses this service to start sessions, send messages, load
// history, and subscribe to summaries and chat events without knowing SDK
// host, repository, or event-adapter details.
import type {
	RuntimeClineReasoningEffort,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import {
	compactPersistedMessagesForContextOverflow,
	isContextOverflowError,
} from "./cline-context-overflow-compaction";
import {
	applyClineSessionEvent,
	classifyClineProviderError,
	isClineInsufficientBalanceError,
} from "./cline-event-adapter";
import {
	type ClineMessageRepository,
	createInMemoryClineMessageRepository,
	createTaskEntryFromPersistedSession,
} from "./cline-message-repository";
import { type ClineRuntimeSetup, createClineRuntimeSetup } from "./cline-runtime-setup";
import {
	type ClineSessionRuntime,
	type CreateInMemoryClineSessionRuntimeOptions,
	createInMemoryClineSessionRuntime,
} from "./cline-session-runtime";
import {
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	clearActiveTurnState,
	cloneSummary,
	createAssistantMessage,
	createDefaultSummary,
	createMessage,
	latestAssistantMessageMatches,
	now,
	setOrCreateAssistantMessage,
	updateSummary,
} from "./cline-session-state";
import {
	type ClineRuntimeSetupLease,
	type ClineWatcherRegistry,
	createClineWatcherRegistry,
} from "./cline-watcher-registry";
import { SDK_DEFAULT_MODEL_ID, SDK_DEFAULT_PROVIDER_ID } from "./sdk-provider-boundary";
import {
	type ClineSdkPersistedMessage,
	type ClineSdkSlashCommand,
	listClineSdkWorkflowSlashCommands,
	resolveClineSdkSystemPrompt,
} from "./sdk-runtime-boundary.js";

export type { ClineTaskMessage } from "./cline-session-state";

export interface StartClineTaskSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	initialMessages?: ClineSdkPersistedMessage[];
	images?: RuntimeTaskImage[];
	resumeFromTrash?: boolean;
	providerId?: string | null;
	modelId?: string | null;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	systemPrompt?: string | null;
}

export interface ClineTaskSessionService {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	listSlashCommands(workspacePath: string): Promise<ClineSdkSlashCommand[]>;
	loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): Promise<void>;
}

export interface CreateInMemoryClineTaskSessionServiceOptions {
	createSessionRuntime?: (options: CreateInMemoryClineSessionRuntimeOptions) => ClineSessionRuntime;
	createMessageRepository?: () => ClineMessageRepository;
	createRuntimeSetup?: (workspacePath: string) => Promise<ClineRuntimeSetup>;
	watcherRegistry?: ClineWatcherRegistry;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0) {
			return message;
		}
	}
	return "Unknown error";
}

function readAgentResultText(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	if (!("text" in result)) {
		return null;
	}
	const text = result.text;
	if (typeof text !== "string") {
		return null;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? normalized : null;
}

function formatStartWarnings(warnings: readonly string[] | undefined): string | null {
	if (!warnings) {
		return null;
	}
	const normalized = warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0);
	if (normalized.length === 0) {
		return null;
	}
	if (normalized.length === 1) {
		return normalized[0] ?? null;
	}
	return `${normalized[0]} (+${normalized.length - 1} more MCP warning${normalized.length === 2 ? "" : "s"})`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isTaskEntryRebindCandidate(entry: ClineTaskSessionEntry, allowFailed: boolean): boolean {
	return (
		entry.summary.state === "running" ||
		entry.summary.state === "awaiting_review" ||
		(allowFailed && entry.summary.state === "failed")
	);
}

function extractAgentErrorMessageFromEvent(event: unknown): string | null {
	const eventRecord = asRecord(event);
	if (!eventRecord || eventRecord.type !== "agent_event") {
		return null;
	}
	const payload = asRecord(eventRecord.payload);
	const agentEvent = asRecord(payload?.event);
	if (!agentEvent || agentEvent.type !== "error") {
		return null;
	}
	if (typeof agentEvent.error === "string") {
		const normalized = agentEvent.error.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (agentEvent.error instanceof Error) {
		const normalized = agentEvent.error.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	const errorRecord = asRecord(agentEvent.error);
	if (typeof errorRecord?.message === "string") {
		const normalized = errorRecord.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (typeof agentEvent.message === "string") {
		const normalized = agentEvent.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	return null;
}

export class InMemoryClineTaskSessionService implements ClineTaskSessionService {
	private readonly pendingTurnCancelTaskIds = new Set<string>();
	private readonly taskGenerationByTaskId = new Map<string, number>();
	private readonly sessionRuntime: ClineSessionRuntime;
	private readonly messageRepository: ClineMessageRepository;
	private readonly watcherRegistry: ClineWatcherRegistry;
	private readonly providerContextByTaskId = new Map<string, { providerId: string | null; modelId: string | null }>();
	private readonly runtimeSetupLeaseByWorkspacePath = new Map<string, Promise<ClineRuntimeSetupLease>>();

	constructor(options: CreateInMemoryClineTaskSessionServiceOptions = {}) {
		const createSessionRuntime = options.createSessionRuntime ?? createInMemoryClineSessionRuntime;
		const createMessageRepository = options.createMessageRepository ?? createInMemoryClineMessageRepository;
		this.watcherRegistry =
			options.watcherRegistry ??
			createClineWatcherRegistry({
				createRuntimeSetup: options.createRuntimeSetup ?? createClineRuntimeSetup,
			});
		this.sessionRuntime = createSessionRuntime({
			onTaskEvent: (taskId: string, event: unknown) => {
				this.handleTaskEvent(taskId, event);
			},
		});
		this.messageRepository = createMessageRepository();
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.messageRepository.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		return this.messageRepository.onMessage(listener);
	}

	private nextTaskGeneration(taskId: string): number {
		const generation = (this.taskGenerationByTaskId.get(taskId) ?? 0) + 1;
		this.taskGenerationByTaskId.set(taskId, generation);
		return generation;
	}

	private getTaskGeneration(taskId: string): number {
		return this.taskGenerationByTaskId.get(taskId) ?? 0;
	}

	private isCurrentTaskOperation(taskId: string, entry: ClineTaskSessionEntry, generation: number): boolean {
		return this.messageRepository.getTaskEntry(taskId) === entry && this.getTaskGeneration(taskId) === generation;
	}

	private async clearStaleRuntimeBinding(taskId: string, sessionId: string | null): Promise<void> {
		if (!sessionId || this.sessionRuntime.getTaskSessionId(taskId) !== sessionId) {
			return;
		}
		await this.sessionRuntime.clearTaskSessions(taskId).catch(() => undefined);
	}

	private emitTaskFailure(
		taskId: string,
		entry: ClineTaskSessionEntry,
		context: "start" | "send",
		error: unknown,
		generation: number,
	): void {
		if (!this.isCurrentTaskOperation(taskId, entry, generation)) {
			return;
		}
		const errorMessage = toErrorMessage(error);
		const providerContext = this.providerContextByTaskId.get(taskId);
		const recovery = classifyClineProviderError(errorMessage, providerContext);
		const isInsufficientBalanceError = isClineInsufficientBalanceError(errorMessage);
		if (!isInsufficientBalanceError) {
			const systemMessage = createMessage(
				taskId,
				"system",
				`Cline SDK ${context} failed: ${recovery.message}. You can send another message to continue the conversation.`,
			);
			entry.messages.push(systemMessage);
			this.emitMessage(taskId, systemMessage);
		}
		clearActiveTurnState(entry);
		const errorSummary = updateSummary(entry, {
			state: "awaiting_review",
			reviewReason: "error",
			lastOutputAt: now(),
			lastHookAt: now(),
			warningMessage: isInsufficientBalanceError ? null : recovery.message,
			latestHookActivity: {
				activityText: `${context === "start" ? "Start" : "Send"} failed: ${recovery.message}`,
				toolName: null,
				toolInputSummary: null,
				finalMessage: recovery.message,
				hookEventName: "agent_error",
				notificationType: recovery.notificationType,
				source: "cline-sdk",
			},
		});
		this.emitSummary(errorSummary);
	}

	private async dispatchResolvedTaskInput(input: {
		taskId: string;
		prompt: string;
		mode?: RuntimeTaskSessionMode;
		images?: RuntimeTaskImage[];
		delivery?: "queue" | "steer";
		forceRestart?: boolean;
	}): Promise<{
		result: unknown;
		warnings?: string[];
	}> {
		if (!input.forceRestart && this.sessionRuntime.getTaskSessionId(input.taskId)) {
			return {
				result: await this.sessionRuntime.sendTaskSessionInput(
					input.taskId,
					input.prompt,
					input.mode,
					input.images,
					input.delivery,
				),
			};
		}

		const persistedSnapshot = await this.sessionRuntime.readPersistedTaskSession(input.taskId);
		await this.sessionRuntime.resumeTaskSession(input.taskId).catch(() => null);
		const restartedSession = await this.sessionRuntime.restartTaskSession({
			taskId: input.taskId,
			prompt: input.prompt,
			mode: input.mode,
			images: input.images,
			initialMessages: persistedSnapshot?.messages,
		});
		return {
			result: restartedSession.result,
			warnings: restartedSession.warnings,
		};
	}

	private settleTaskWithFinalResultText(
		taskId: string,
		entry: ClineTaskSessionEntry,
		finalText: string,
		assistantCountBeforeOperation: number,
		generation: number,
	): void {
		if (!this.isCurrentTaskOperation(taskId, entry, generation) || entry.summary.state !== "running") {
			return;
		}
		const assistantCountAfterOperation = entry.messages.filter((message) => message.role === "assistant").length;
		const message = setOrCreateAssistantMessage(entry, taskId, finalText);
		if (message) {
			this.emitMessage(taskId, message);
		} else if (
			assistantCountAfterOperation <= assistantCountBeforeOperation &&
			!latestAssistantMessageMatches(entry, finalText)
		) {
			const assistantMessage = createAssistantMessage(entry, taskId, finalText);
			this.emitMessage(taskId, assistantMessage);
		}

		const previousSummary = cloneSummary(entry.summary);
		const previousHookActivity = entry.summary.latestHookActivity;
		clearActiveTurnState(entry);
		const summary = updateSummary(entry, {
			state: "awaiting_review",
			reviewReason: "exit",
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `Final: ${finalText}`,
				toolName: previousHookActivity?.toolName ?? null,
				toolInputSummary: previousHookActivity?.toolInputSummary ?? null,
				finalMessage: finalText,
				hookEventName: "agent_end",
				notificationType: previousHookActivity?.notificationType ?? null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(summary);
		if (this.shouldCaptureReviewCheckpoint(previousSummary, summary)) {
			this.captureReviewCheckpoint(taskId, summary);
		}
	}

	private async waitForRuntimeBinding(taskId: string): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (this.sessionRuntime.getTaskSessionId(taskId)) {
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}

	private async restorePersistedTaskSessionEntry(
		taskId: string,
		existingEntry: ClineTaskSessionEntry | null,
	): Promise<ClineTaskSessionEntry | null> {
		const snapshot = await this.sessionRuntime.resumeTaskSession(taskId);
		if (!snapshot) {
			return null;
		}
		const startedAt = Date.parse(snapshot.record.startedAt);
		const updatedAt = Date.parse(snapshot.record.updatedAt || snapshot.record.startedAt);
		const persistedCwd = typeof snapshot.record.cwd === "string" ? snapshot.record.cwd.trim() : "";
		const persistedWorkspaceRoot =
			typeof snapshot.record.workspaceRoot === "string" ? snapshot.record.workspaceRoot.trim() : "";
		const reboundState = existingEntry?.summary.state === "failed" ? "failed" : "awaiting_review";
		const reboundReviewReason = existingEntry?.summary.state === "failed" ? "error" : "attention";
		const entry = createTaskEntryFromPersistedSession(taskId, snapshot.messages, {
			agentId: "cline",
			state: reboundState,
			mode: existingEntry?.summary.mode ?? null,
			reviewReason: reboundReviewReason,
			workspacePath: existingEntry?.summary.workspacePath ?? (persistedCwd || persistedWorkspaceRoot || null),
			startedAt: Number.isFinite(startedAt) ? startedAt : null,
			lastOutputAt: Number.isFinite(updatedAt) ? updatedAt : null,
			warningMessage: existingEntry?.summary.warningMessage ?? null,
			latestHookActivity: existingEntry?.summary.latestHookActivity ?? null,
			latestTurnCheckpoint: existingEntry?.summary.latestTurnCheckpoint ?? null,
			previousTurnCheckpoint: existingEntry?.summary.previousTurnCheckpoint ?? null,
		});
		this.messageRepository.setTaskEntry(taskId, entry);
		return entry;
	}

	private async ensureTaskEntryAndBinding(
		taskId: string,
		options: { allowFailed?: boolean } = {},
	): Promise<ClineTaskSessionEntry | null> {
		let entry = this.messageRepository.getTaskEntry(taskId);
		const allowFailed = options.allowFailed ?? false;
		const needsRebind =
			!entry || (isTaskEntryRebindCandidate(entry, allowFailed) && !this.sessionRuntime.getTaskSessionId(taskId));
		if (!needsRebind) {
			return entry;
		}
		const restoredEntry = await this.restorePersistedTaskSessionEntry(taskId, entry ?? null);
		return restoredEntry ?? (allowFailed ? entry : null);
	}

	private async retryAfterContextOverflow(input: {
		taskId: string;
		prompt: string;
		mode: RuntimeTaskSessionMode;
		images?: RuntimeTaskImage[];
		error: unknown;
	}): Promise<{ result: unknown; warnings?: string[] } | null> {
		if (!isContextOverflowError(input.error)) {
			return null;
		}

		const persistedSnapshot = await this.sessionRuntime.readPersistedTaskSession(input.taskId).catch(() => null);
		const compactedMessages = compactPersistedMessagesForContextOverflow(persistedSnapshot?.messages ?? []);
		if (!compactedMessages) {
			return null;
		}

		await this.sessionRuntime.stopTaskSession(input.taskId).catch(() => null);
		const restartedSession = await this.sessionRuntime.restartTaskSession({
			taskId: input.taskId,
			prompt: input.prompt,
			mode: input.mode,
			images: input.images,
			initialMessages: compactedMessages,
		});
		return {
			result: restartedSession.result,
			warnings: restartedSession.warnings,
		};
	}

	async startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const existing = this.messageRepository.getTaskEntry(request.taskId);
		if (existing && (existing.summary.state === "running" || existing.summary.state === "awaiting_review")) {
			return cloneSummary(existing.summary);
		}

		const providerId = request.providerId?.trim().toLowerCase() || SDK_DEFAULT_PROVIDER_ID;
		const modelId = request.modelId?.trim() || SDK_DEFAULT_MODEL_ID;
		this.providerContextByTaskId.set(request.taskId, { providerId, modelId });
		const resolvedMode: RuntimeTaskSessionMode = request.mode ?? "act";
		const generation = this.nextTaskGeneration(request.taskId);
		const persistedResumeSnapshot = request.resumeFromTrash
			? await this.sessionRuntime.readPersistedTaskSession(request.taskId).catch(() => null)
			: null;

		const entry =
			request.resumeFromTrash && persistedResumeSnapshot
				? createTaskEntryFromPersistedSession(request.taskId, persistedResumeSnapshot.messages, {
						state: "awaiting_review",
						mode: resolvedMode,
						workspacePath: request.cwd,
						startedAt: now(),
						lastOutputAt: now(),
						reviewReason: "attention",
					})
				: ({
						summary: {
							...createDefaultSummary(request.taskId),
							state: request.resumeFromTrash ? "awaiting_review" : "running",
							mode: resolvedMode,
							workspacePath: request.cwd,
							startedAt: now(),
							lastOutputAt: now(),
							reviewReason: request.resumeFromTrash ? "attention" : null,
						},
						messages: [],
						activeAssistantMessageId: null,
						activeReasoningMessageId: null,
						toolMessageIdByToolCallId: new Map<string, string>(),
						toolInputByToolCallId: new Map<string, unknown>(),
					} satisfies ClineTaskSessionEntry);
		this.messageRepository.setTaskEntry(request.taskId, entry);
		this.pendingTurnCancelTaskIds.delete(request.taskId);

		const normalizedPrompt = request.prompt.trim();
		const hasRequestImages = Boolean(request.images && request.images.length > 0);

		if (!request.resumeFromTrash && (normalizedPrompt.length > 0 || hasRequestImages)) {
			const message = createMessage(request.taskId, "user", normalizedPrompt, request.images);
			entry.messages.push(message);
			this.emitMessage(request.taskId, message);
			const runningSummary = updateSummary(entry, {
				state: "running",
				reviewReason: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(runningSummary);
		}
		this.emitSummary(entry.summary);
		const returnSummary = cloneSummary(entry.summary);

		void (async () => {
			const assistantCountBeforeStart = entry.messages.filter((message) => message.role === "assistant").length;
			try {
				const runtimeSetup = await this.ensureRuntimeSetup(request.cwd);
				if (!this.isCurrentTaskOperation(request.taskId, entry, generation)) {
					return;
				}
				const runtimePrompt = runtimeSetup.resolvePrompt(request.prompt);
				let systemPrompt =
					request.systemPrompt?.trim() ||
					(await resolveClineSdkSystemPrompt({
						cwd: request.cwd,
						providerId,
						rules: runtimeSetup.loadRules(),
					}));
				const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(request.taskId);
				if (appendedSystemPrompt) {
					systemPrompt = `${systemPrompt}\n\n${appendedSystemPrompt}`;
				}

				const startResult = await this.sessionRuntime.startTaskSession({
					taskId: request.taskId,
					cwd: request.cwd,
					prompt: runtimePrompt,
					initialMessages: request.resumeFromTrash ? persistedResumeSnapshot?.messages : request.initialMessages,
					images: request.images,
					providerId,
					modelId,
					mode: resolvedMode,
					apiKey: request.apiKey,
					baseUrl: request.baseUrl,
					reasoningEffort: request.reasoningEffort,
					systemPrompt,
					userInstructionWatcher: runtimeSetup.watcher,
					requestToolApproval: runtimeSetup.requestToolApproval,
				});
				if (!this.isCurrentTaskOperation(request.taskId, entry, generation)) {
					await this.clearStaleRuntimeBinding(request.taskId, startResult.sessionId);
					return;
				}
				const warningMessage = formatStartWarnings(startResult.warnings);
				if (warningMessage) {
					this.emitSummary(
						updateSummary(entry, {
							warningMessage,
						}),
					);
				}

				const initialAgentText = readAgentResultText(startResult.result);
				if (initialAgentText) {
					this.settleTaskWithFinalResultText(request.taskId, entry, initialAgentText, assistantCountBeforeStart, generation);
				}
			} catch (error) {
				this.emitTaskFailure(request.taskId, entry, "start", error, generation);
			}
		})();

		await this.waitForRuntimeBinding(request.taskId);
		return returnSummary;
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const generation = this.nextTaskGeneration(taskId);
		const entry = await this.ensureTaskEntryAndBinding(taskId);
		if (!entry) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		if (entry.summary.state === "idle" || entry.summary.state === "interrupted" || entry.summary.state === "failed") {
			return cloneSummary(entry.summary);
		}
		const stopResult = await this.sessionRuntime.stopTaskSession(taskId).catch(() => null);
		if (!this.isCurrentTaskOperation(taskId, entry, generation)) {
			return cloneSummary(this.messageRepository.getTaskEntry(taskId)?.summary ?? entry.summary);
		}
		if (!stopResult || stopResult.status !== "controlled") {
			return null;
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}
	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const generation = this.nextTaskGeneration(taskId);
		const entry = await this.ensureTaskEntryAndBinding(taskId);
		if (!entry) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		if (entry.summary.state === "idle" || entry.summary.state === "interrupted" || entry.summary.state === "failed") {
			return cloneSummary(entry.summary);
		}
		const abortResult = await this.sessionRuntime.abortTaskSession(taskId).catch(() => null);
		if (!this.isCurrentTaskOperation(taskId, entry, generation)) {
			return cloneSummary(this.messageRepository.getTaskEntry(taskId)?.summary ?? entry.summary);
		}
		if (!abortResult || abortResult.status !== "controlled") {
			return null;
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}
	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const generation = this.nextTaskGeneration(taskId);
		const entry = await this.ensureTaskEntryAndBinding(taskId);
		if (!entry) {
			return null;
		}
		if (entry.summary.state !== "running" && entry.summary.state !== "awaiting_review") {
			return null;
		}
		this.pendingTurnCancelTaskIds.add(taskId);
		const abortResult = await this.sessionRuntime.abortTaskSession(taskId).catch(() => null);
		if (!this.isCurrentTaskOperation(taskId, entry, generation)) {
			return cloneSummary(this.messageRepository.getTaskEntry(taskId)?.summary ?? entry.summary);
		}
		if (!abortResult || abortResult.status !== "controlled") {
			this.pendingTurnCancelTaskIds.delete(taskId);
			return null;
		}
		clearActiveTurnState(entry);
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			exitCode: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(summary);
		return summary;
	}
	async sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		const hadRuntimeBindingBeforeEnsure = Boolean(this.sessionRuntime.getTaskSessionId(taskId));
		let entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			entry = await this.ensureTaskEntryAndBinding(taskId, { allowFailed: true });
		}
		if (!entry) {
			return null;
		}
		if (
			entry.summary.state !== "running" &&
			entry.summary.state !== "awaiting_review" &&
			entry.summary.state !== "idle" &&
			entry.summary.state !== "failed"
		) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		const normalized = text.trim();
		const hasImages = Boolean(images && images.length > 0);
		const effectiveMode: RuntimeTaskSessionMode = mode ?? entry.summary.mode ?? "act";
		if (normalized.length === 0 && !hasImages) {
			return null;
		}
		const generation = this.nextTaskGeneration(taskId);
		{
			const message = createMessage(taskId, "user", normalized, images);
			entry.messages.push(message);
			this.emitMessage(taskId, message);
			clearActiveTurnState(entry);
			const forceRestart = entry.summary.state === "failed" || entry.summary.reviewReason === "error";
			const queueDelivery = entry.summary.state === "running" && !forceRestart;
			const waitingSummary = updateSummary(entry, {
				state: "running",
				mode: effectiveMode,
				reviewReason: null,
				warningMessage: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(waitingSummary);
			const assistantCountBeforeSend = entry.messages.filter((message) => message.role === "assistant").length;
			void this.ensureRuntimeSetup(entry.summary.workspacePath ?? "")
				.then(async (runtimeSetup) => {
					if (this.messageRepository.getTaskEntry(taskId) !== entry) {
						return null;
					}
					const resolvedPrompt = runtimeSetup.resolvePrompt(normalized);
					try {
						return await this.dispatchResolvedTaskInput({
							taskId,
							prompt: resolvedPrompt,
							mode: effectiveMode,
							images,
							delivery: queueDelivery ? "queue" : undefined,
							forceRestart: forceRestart || !hadRuntimeBindingBeforeEnsure,
						});
					} catch (error) {
						const recovered = await this.retryAfterContextOverflow({
							taskId,
							prompt: resolvedPrompt,
							mode: effectiveMode,
							images,
							error,
						});
						if (recovered) {
							return recovered;
						}
						throw error;
					}
				})
				.then((dispatchResult) => {
					if (dispatchResult === null || !this.isCurrentTaskOperation(taskId, entry, generation)) {
						return;
					}
					const result = dispatchResult.result;
					const warnings = dispatchResult.warnings;
					const warningMessage = formatStartWarnings(warnings);
					if (warningMessage) {
						this.emitSummary(
							updateSummary(entry, {
								warningMessage,
							}),
						);
					}
					const agentText = readAgentResultText(result);
					if (agentText) {
						this.settleTaskWithFinalResultText(taskId, entry, agentText, assistantCountBeforeSend, generation);
					}
				})
				.catch((error: unknown) => {
					this.emitTaskFailure(taskId, entry, "send", error, generation);
				});
		}
		const summary = updateSummary(entry, {
			state: "running",
			mode: effectiveMode,
			reviewReason: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const generation = this.nextTaskGeneration(taskId);
		const entry = await this.ensureTaskEntryAndBinding(taskId);
		if (!entry) {
			return null;
		}

		this.pendingTurnCancelTaskIds.delete(taskId);
		const stopResult = await this.sessionRuntime.stopTaskSession(taskId).catch(() => null);
		if (!stopResult || stopResult.status !== "controlled") {
			return null;
		}
		clearActiveTurnState(entry);

		const effectiveMode: RuntimeTaskSessionMode = entry.summary.mode ?? "act";
		try {
			const { warnings } = await this.dispatchResolvedTaskInput({
				taskId,
				prompt: "",
				mode: effectiveMode,
			});
			if (!this.isCurrentTaskOperation(taskId, entry, generation)) {
				return cloneSummary(this.messageRepository.getTaskEntry(taskId)?.summary ?? entry.summary);
			}
			const warningMessage = formatStartWarnings(warnings);
			const summary = updateSummary(entry, {
				state: "idle",
				mode: effectiveMode,
				reviewReason: null,
				warningMessage: warningMessage ?? null,
				lastOutputAt: now(),
			});
			this.emitSummary(summary);
			return cloneSummary(summary);
		} catch (error) {
			this.emitTaskFailure(taskId, entry, "start", error, generation);
			return cloneSummary(entry.summary);
		}
	}

	async clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		this.nextTaskGeneration(taskId);
		const existingEntry = this.messageRepository.getTaskEntry(taskId);
		this.providerContextByTaskId.delete(taskId);
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.sessionRuntime.clearTaskSessions(taskId).catch(() => undefined);
		if (!existingEntry) {
			return null;
		}

		const clearedEntry: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(taskId),
				mode: existingEntry.summary.mode,
				workspacePath: existingEntry.summary.workspacePath,
			},
			messages: [],
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map<string, string>(),
			toolInputByToolCallId: new Map<string, unknown>(),
		};
		this.messageRepository.setTaskEntry(taskId, clearedEntry);
		this.emitSummary(clearedEntry.summary);
		return cloneSummary(clearedEntry.summary);
	}

	async rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const existingEntry = this.messageRepository.getTaskEntry(taskId);
		if (existingEntry && existingEntry.summary.state !== "failed") {
			return cloneSummary(existingEntry.summary);
		}
		const entry = await this.restorePersistedTaskSessionEntry(taskId, existingEntry ?? null);
		if (!entry) {
			return existingEntry ? cloneSummary(existingEntry.summary) : null;
		}
		return cloneSummary(entry.summary);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.messageRepository.getSummary(taskId);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return this.messageRepository.listSummaries();
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		return this.messageRepository.listMessages(taskId);
	}

	async listSlashCommands(workspacePath: string): Promise<ClineSdkSlashCommand[]> {
		const runtimeSetup = await this.ensureRuntimeSetup(workspacePath);
		await runtimeSetup.watcher.refreshAll();
		return listClineSdkWorkflowSlashCommands(runtimeSetup.watcher);
	}

	async loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]> {
		return await this.messageRepository.hydrateTaskMessages(taskId, async () => {
			return await this.sessionRuntime.readPersistedTaskSession(taskId);
		});
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const summary = this.messageRepository.applyTurnCheckpoint(taskId, checkpoint);
		if (!summary) {
			return null;
		}
		this.emitSummary(summary);
		return summary;
	}

	async dispose(): Promise<void> {
		await this.sessionRuntime.dispose();
		this.pendingTurnCancelTaskIds.clear();
		this.taskGenerationByTaskId.clear();
		for (const leasePromise of this.runtimeSetupLeaseByWorkspacePath.values()) {
			try {
				const lease = await leasePromise;
				await lease.release();
			} catch {
				// Ignore runtime setup disposal failures.
			}
		}
		this.runtimeSetupLeaseByWorkspacePath.clear();
		this.messageRepository.dispose();
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		this.messageRepository.emitSummary(summary);
	}

	private emitMessage(taskId: string, message: ClineTaskMessage): void {
		this.messageRepository.emitMessage(taskId, message);
	}

	private shouldCaptureReviewCheckpoint(
		previousSummary: RuntimeTaskSessionSummary,
		nextSummary: RuntimeTaskSessionSummary | null,
	): nextSummary is RuntimeTaskSessionSummary {
		if (!nextSummary) {
			return false;
		}
		if (isHomeAgentSessionId(nextSummary.taskId) || !nextSummary.workspacePath) {
			return false;
		}
		return previousSummary.state !== "awaiting_review" && nextSummary.state === "awaiting_review";
	}

	private captureReviewCheckpoint(taskId: string, summary: RuntimeTaskSessionSummary): void {
		const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
		const staleRef = summary.previousTurnCheckpoint?.ref ?? null;
		void captureTaskTurnCheckpoint({
			cwd: summary.workspacePath ?? ".",
			taskId,
			turn: nextTurn,
		})
			.then((checkpoint) => {
				this.applyTurnCheckpoint(taskId, checkpoint);
				if (!staleRef) {
					return;
				}
				void deleteTaskTurnCheckpointRef({
					cwd: summary.workspacePath ?? ".",
					ref: staleRef,
				}).catch(() => {
					// Best effort cleanup only.
				});
			})
			.catch(() => {
				// Best effort checkpointing only.
			});
	}

	private async ensureRuntimeSetup(workspacePath: string): Promise<ClineRuntimeSetup> {
		const normalizedWorkspacePath = workspacePath.trim();
		let leasePromise = this.runtimeSetupLeaseByWorkspacePath.get(normalizedWorkspacePath);
		if (!leasePromise) {
			leasePromise = this.watcherRegistry.acquire(normalizedWorkspacePath);
			this.runtimeSetupLeaseByWorkspacePath.set(normalizedWorkspacePath, leasePromise);
		}
		const lease = await leasePromise;
		return lease.setup;
	}

	private shouldForceAbortFromTaskEvent(event: unknown): boolean {
		return isClineInsufficientBalanceError(extractAgentErrorMessageFromEvent(event));
	}

	private extractTaskEventSessionId(event: unknown): string | null {
		const eventRecord = asRecord(event);
		const payload = asRecord(eventRecord?.payload);
		return typeof payload?.sessionId === "string" ? payload.sessionId : null;
	}

	private handleTaskEvent(taskId: string, event: unknown): void {
		const eventSessionId = this.extractTaskEventSessionId(event);
		if (eventSessionId && this.sessionRuntime.getTaskSessionId(taskId) !== eventSessionId) {
			return;
		}
		const entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			return;
		}
		const previousSummary = cloneSummary(entry.summary);
		let latestSummary: RuntimeTaskSessionSummary | null = null;
		const providerContext = this.providerContextByTaskId.get(taskId);
		applyClineSessionEvent({
			event,
			taskId,
			entry,
			pendingTurnCancelTaskIds: this.pendingTurnCancelTaskIds,
			providerId: providerContext?.providerId,
			modelId: providerContext?.modelId,
			emitSummary: (summary: RuntimeTaskSessionSummary) => {
				latestSummary = summary;
				this.emitSummary(summary);
			},
			emitMessage: (taskIdFromEvent: string, message: ClineTaskMessage) => {
				this.emitMessage(taskIdFromEvent, message);
			},
		});
		if (this.shouldCaptureReviewCheckpoint(previousSummary, latestSummary)) {
			this.captureReviewCheckpoint(taskId, latestSummary);
		}
		if (this.shouldForceAbortFromTaskEvent(event)) {
			void this.sessionRuntime.abortTaskSession(taskId).catch(() => undefined);
		}
	}
}

export function createInMemoryClineTaskSessionService(
	options: CreateInMemoryClineTaskSessionServiceOptions = {},
): ClineTaskSessionService {
	return new InMemoryClineTaskSessionService(options);
}
