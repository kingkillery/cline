// Translates raw SDK session events into Kanban summary and message mutations.
// Keep protocol-specific parsing here so the runtime and repository can stay
// focused on lifecycle, storage, and task-facing orchestration.
import {
	runtimeTaskSessionHandoffSchema,
	type RuntimeTaskSessionHandoff,
	type RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	appendAssistantChunk,
	appendReasoningChunk,
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	canReturnToRunning,
	clearActiveTurnState,
	createAssistantMessage,
	createMessage,
	createReasoningMessage,
	finishToolCallMessage,
	isClineUserAttentionTool,
	latestAssistantMessageMatches,
	now,
	setOrCreateAssistantMessage,
	setOrCreateReasoningMessage,
	startToolCallMessage,
	updateSummary,
} from "./cline-session-state";
import { formatClineToolCallLabel, getClineToolCallDisplay } from "./cline-tool-call-display";
import type { ClineSdkAgentEvent, ClineSdkSessionEvent } from "./sdk-runtime-boundary";

function normalizePreviewText(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized || null;
}

function toPreviewText(value: string | null | undefined, maxLength = 160): string | null {
	const normalized = normalizePreviewText(value);
	if (!normalized) {
		return null;
	}
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}…` : normalized;
}

export interface ApplyClineSessionEventInput {
	event: unknown;
	taskId: string;
	entry: ClineTaskSessionEntry;
	pendingTurnCancelTaskIds: Set<string>;
	providerId?: string | null;
	modelId?: string | null;
	emitSummary: (summary: RuntimeTaskSessionSummary) => void;
	emitMessage: (taskId: string, message: ClineTaskMessage) => void;
}

type ClineSdkChunkEvent = Extract<ClineSdkSessionEvent, { type: "chunk" }>;
type ClineSdkHookEvent = Extract<ClineSdkSessionEvent, { type: "hook" }>;
type ClineSdkEndedEvent = Extract<ClineSdkSessionEvent, { type: "ended" }>;
type ClineSdkStatusEvent = Extract<ClineSdkSessionEvent, { type: "status" }>;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readAgentEvent(event: unknown): ClineSdkAgentEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "agent_event") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload) {
		return null;
	}
	const agentEvent = asRecord(payload.event);
	if (!agentEvent || typeof agentEvent.type !== "string") {
		return null;
	}
	return agentEvent as unknown as ClineSdkAgentEvent;
}

function readChunkEvent(event: unknown): ClineSdkChunkEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "chunk") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.chunk !== "string") {
		return null;
	}
	if (payload.stream !== "stdout" && payload.stream !== "stderr" && payload.stream !== "agent") {
		return null;
	}
	return { type: "chunk", payload: payload as ClineSdkChunkEvent["payload"] };
}

function readHookEvent(event: unknown): ClineSdkHookEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "hook") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string") {
		return null;
	}
	return { type: "hook", payload: payload as ClineSdkHookEvent["payload"] };
}

function readEndedEvent(event: unknown): ClineSdkEndedEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "ended") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.reason !== "string") {
		return null;
	}
	return { type: "ended", payload: payload as ClineSdkEndedEvent["payload"] };
}

function readStatusEvent(event: unknown): ClineSdkStatusEvent | null {
	const record = asRecord(event);
	if (!record || record.type !== "status") {
		return null;
	}
	const payload = asRecord(record.payload);
	if (!payload || typeof payload.sessionId !== "string" || typeof payload.status !== "string") {
		return null;
	}
	return { type: "status", payload: payload as ClineSdkStatusEvent["payload"] };
}

function readNestedHandoffCandidate(record: Record<string, unknown>): unknown {
	if (record.task_handoff !== undefined) {
		return record.task_handoff;
	}
	if (record.handoff !== undefined) {
		return record.handoff;
	}
	if (record.handoff_metadata !== undefined) {
		return record.handoff_metadata;
	}
	return record;
}

function candidateHasHandoffFields(record: Record<string, unknown>): boolean {
	return [
		"changed_files",
		"decisions",
		"tests_run",
		"errors",
		"benchmarks",
		"review_status",
		"merge_conflicts",
	].some((field) => record[field] !== undefined);
}

function readJsonCandidates(text: string): string[] {
	const candidates: string[] = [];
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
		const body = match[1]?.trim();
		if (body) {
			candidates.push(body);
		}
	}
	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.push(text.slice(firstBrace, lastBrace + 1));
	}
	return candidates;
}

function extractTaskSessionHandoff(finalText: string): RuntimeTaskSessionHandoff | null {
	for (const candidateText of readJsonCandidates(finalText)) {
		try {
			const parsed = JSON.parse(candidateText) as unknown;
			const parsedRecord = asRecord(parsed);
			if (!parsedRecord) {
				continue;
			}
			const candidate = readNestedHandoffCandidate(parsedRecord);
			const candidateRecord = asRecord(candidate);
			if (!candidateRecord || !candidateHasHandoffFields(candidateRecord)) {
				continue;
			}
			const parsedHandoff = runtimeTaskSessionHandoffSchema.safeParse(candidate);
			if (parsedHandoff.success) {
				return parsedHandoff.data;
			}
		} catch {
			// Ignore non-JSON snippets in natural-language final messages.
		}
	}
	return null;
}

function getRetainedClineToolActivity(entry: ClineTaskSessionEntry): {
	toolName: string | null;
	toolInputSummary: string | null;
} {
	const latestHookActivity = entry.summary.latestHookActivity;
	if (!latestHookActivity || latestHookActivity.source !== "cline-sdk" || !latestHookActivity.toolName) {
		return {
			toolName: null,
			toolInputSummary: null,
		};
	}

	return {
		toolName: latestHookActivity.toolName,
		toolInputSummary: latestHookActivity.toolInputSummary ?? null,
	};
}

function extractAgentErrorMessage(error: unknown): string | null {
	if (typeof error === "string") {
		const normalized = error.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (error instanceof Error) {
		const normalized = error.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		const normalized = error.message.trim();
		return normalized.length > 0 ? normalized : null;
	}
	return null;
}

export interface ClineProviderErrorRecovery {
	notificationType: string | null;
	message: string;
	isCreditLimit: boolean;
	isRecoverable: boolean;
}

export interface ClassifyClineProviderErrorOptions {
	providerId?: string | null;
	modelId?: string | null;
}

function includesAny(value: string, needles: readonly string[]): boolean {
	return needles.some((needle) => value.includes(needle));
}

function normalizeProviderId(providerId: string | null | undefined): string {
	return providerId?.trim().toLowerCase() ?? "";
}

export function isClineInsufficientBalanceError(errorMessage: string | null): boolean {
	return classifyClineProviderError(errorMessage).isCreditLimit;
}

export function classifyClineProviderError(
	errorMessage: string | null,
	options: ClassifyClineProviderErrorOptions = {},
): ClineProviderErrorRecovery {
	const rawMessage = errorMessage?.trim() || "Unknown agent error";
	const normalized = rawMessage.toLowerCase();
	const providerId = normalizeProviderId(options.providerId);
	const modelId = options.modelId?.trim().toLowerCase() ?? "";
	const mentionsCodex = providerId === "openai-codex" || includesAny(normalized, ["codex", "openai"]);
	const mentionsAnthropic =
		providerId === "anthropic" || includesAny(normalized, ["anthropic", "claude"]) || modelId.includes("claude");
	const mentionsCopilot = providerId === "copilot" || includesAny(normalized, ["copilot", "github"]);
	const isCreditLimit =
		normalized.includes("insufficient balance") ||
		normalized.includes("insufficient_credits") ||
		(normalized.includes("402") && normalized.includes("balance"));

	if (isCreditLimit) {
		return {
			notificationType: mentionsCodex ? "codex_credit_limit" : "credit_limit",
			message: mentionsCodex
				? "OpenAI Codex credits are exhausted. Add credits or switch providers before retrying this task."
				: "Cline credits are exhausted. Buy more credits or switch providers before retrying this task.",
			isCreditLimit: true,
			isRecoverable: false,
		};
	}

	if (mentionsCodex && includesAny(normalized, ["refresh token", "oauth", "401", "unauthorized", "invalid_grant"])) {
		return {
			notificationType: "codex_oauth_relogin",
			message: "OpenAI Codex authentication expired; reconnect OpenAI Codex in Cline settings, then retry the task.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (mentionsCodex && includesAny(normalized, ["429", "rate limit", "too many requests", "temporarily rate limited"])) {
		return {
			notificationType: "codex_rate_limit",
			message: "OpenAI Codex is rate-limiting requests. Wait for the retry window or switch providers before retrying.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (
		mentionsAnthropic &&
		includesAny(normalized, ["401", "unauthorized", "invalid x-api-key", "anthropic api key", "anthropic_api_key"])
	) {
		return {
			notificationType: "anthropic_auth",
			message: "Anthropic rejected the request. Check ANTHROPIC_API_KEY or reconnect the Anthropic provider before retrying.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (mentionsAnthropic && includesAny(normalized, ["429", "rate limit", "too many requests", "overloaded"])) {
		return {
			notificationType: "anthropic_rate_limit",
			message: "Anthropic is rate-limiting requests. Wait for the rate-limit window or choose a different model/provider.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (
		mentionsAnthropic &&
		includesAny(normalized, ["model", "claude-sonnet-4", "not found", "unavailable", "not accessible", "permission"])
	) {
		return {
			notificationType: "anthropic_model_unavailable",
			message: "The selected Claude model is not available for this Anthropic account. Choose an accessible Claude model, then retry.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (mentionsCopilot && includesAny(normalized, ["gh auth token", "token expired", "token returned empty", "unauthorized"])) {
		return {
			notificationType: "copilot_auth",
			message: "GitHub Copilot authentication is missing or expired. Run `gh auth login`, confirm `gh auth token` returns a token, then retry.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	if (mentionsCopilot && includesAny(normalized, ["daily", "quota", "request cap", "rate limit", "429"])) {
		return {
			notificationType: "copilot_rate_limit",
			message: "GitHub Copilot request limits were reached. Wait for quota reset or switch providers before retrying.",
			isCreditLimit: false,
			isRecoverable: false,
		};
	}

	return {
		notificationType: null,
		message: rawMessage,
		isCreditLimit: false,
		isRecoverable: true,
	};
}

export function extractClineSessionId(event: unknown): string | null {
	const record = asRecord(event);
	if (!record) {
		return null;
	}
	const payload = asRecord(record.payload);
	return payload && typeof payload.sessionId === "string" ? payload.sessionId : null;
}

// Translate raw SDK events into Kanban summary and chat mutations so the session service can stay focused on host ownership.
export function applyClineSessionEvent(input: ApplyClineSessionEventInput): void {
	const { entry, event, taskId } = input;
	const agentEvent = readAgentEvent(event);
	const chunkEvent = readChunkEvent(event);
	const hookEvent = readHookEvent(event);
	const endedEvent = readEndedEvent(event);
	const statusEvent = readStatusEvent(event);

	if (agentEvent?.type === "error") {
		const errorMessage = "error" in agentEvent ? extractAgentErrorMessage(agentEvent.error) : null;
		const recovery = classifyClineProviderError(errorMessage, {
			providerId: input.providerId,
			modelId: input.modelId,
		});
		const sdkRecoverable = typeof agentEvent.recoverable === "boolean" ? agentEvent.recoverable : false;
		const recoverable = sdkRecoverable && recovery.isRecoverable;
		const shouldShowWarningMessage = !recovery.isCreditLimit;
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		if (!recoverable) {
			clearActiveTurnState(entry);
		}
		if (recoverable && errorMessage) {
			const retryMsg = createMessage(taskId, "system", `Retrying: ${errorMessage}`);
			entry.messages.push(retryMsg);
			input.emitMessage(taskId, retryMsg);
		}
		emitSummary(input, {
			...(recoverable
				? {}
				: {
						state: "awaiting_review",
						reviewReason: "error",
						warningMessage: shouldShowWarningMessage ? recovery.message : null,
					}),
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: recoverable ? `Retrying after error: ${errorMessage ?? "Unknown agent error"}` : `Agent error: ${recovery.message}`,
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: recoverable ? null : recovery.message,
				hookEventName: "agent_error",
				notificationType: recovery.notificationType,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "text") {
		const accumulated = typeof agentEvent.accumulated === "string" ? agentEvent.accumulated : null;
		const text = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (typeof accumulated === "string") {
			const message =
				setOrCreateAssistantMessage(entry, taskId, accumulated) ??
				createAssistantMessage(entry, taskId, accumulated);
			input.emitMessage(taskId, message);
		} else if (typeof text === "string" && text.length > 0) {
			input.emitMessage(taskId, appendAssistantChunk(entry, taskId, text));
		}
		const fullPreviewText = normalizePreviewText(accumulated ?? text);
		const previewText = toPreviewText(fullPreviewText);
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		emitSummary(input, {
			state: "running",
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: previewText ?? "Agent active",
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: fullPreviewText,
				hookEventName: "assistant_delta",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (agentEvent?.type === "notice") {
		const message = typeof agentEvent.message === "string" ? agentEvent.message.trim() : "";
		if (isClineInsufficientBalanceError(message)) {
			return;
		}
		if (message) {
			const displayRole = typeof agentEvent.displayRole === "string" ? agentEvent.displayRole : "system";
			const reason = typeof agentEvent.reason === "string" ? agentEvent.reason : null;
			const noticeType = typeof agentEvent.noticeType === "string" ? agentEvent.noticeType : null;
			const normalizedRole = displayRole === "status" ? "status" : "system";
			const noticeMessage = createMessage(taskId, normalizedRole, message);
			noticeMessage.meta = {
				hookEventName: "agent_notice",
				messageKind: noticeType,
				displayRole,
				reason,
			};
			entry.messages.push(noticeMessage);
			input.emitMessage(taskId, noticeMessage);
		}
		return;
	}

	if (agentEvent?.type === "done") {
		const finalText = typeof agentEvent.text === "string" ? agentEvent.text.trim() : "";
		if (finalText) {
			const message = setOrCreateAssistantMessage(entry, taskId, finalText);
			if (message) {
				input.emitMessage(taskId, message);
			} else if (!latestAssistantMessageMatches(entry, finalText)) {
				const assistantMessage = createMessage(taskId, "assistant", finalText);
				entry.messages.push(assistantMessage);
				input.emitMessage(taskId, assistantMessage);
			}
		}

		const doneReason = typeof agentEvent.reason === "string" ? agentEvent.reason : "completed";
		if (doneReason === "aborted" && input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}

		const previousHookActivity = entry.summary.latestHookActivity;
		const handoff = finalText ? extractTaskSessionHandoff(finalText) : null;
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: finalText ? `Final: ${finalText}` : (previousHookActivity?.activityText ?? null),
				toolName: previousHookActivity?.toolName ?? null,
				toolInputSummary: previousHookActivity?.toolInputSummary ?? null,
				finalMessage: finalText || (previousHookActivity?.finalMessage ?? null),
				hookEventName: "agent_end",
				notificationType: previousHookActivity?.notificationType ?? null,
				source: "cline-sdk",
			},
			...(handoff ? { handoff } : {}),
		};
		if (doneReason === "aborted") {
			summaryPatch.state = "interrupted";
			summaryPatch.reviewReason = "interrupted";
		} else if (doneReason === "error") {
			summaryPatch.state = "awaiting_review";
			summaryPatch.reviewReason = "error";
		} else {
			summaryPatch.state = "awaiting_review";
			summaryPatch.reviewReason = "hook";
		}

		clearActiveTurnState(entry);
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "reasoning") {
		const reasoning = typeof agentEvent.reasoning === "string" ? agentEvent.reasoning : null;
		if (reasoning && reasoning.length > 0) {
			input.emitMessage(taskId, appendReasoningChunk(entry, taskId, reasoning));
			emitSummary(input, {
				state: "running",
				lastOutputAt: now(),
			});
		}
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "reasoning") {
		const reasoning = typeof agentEvent.reasoning === "string" ? agentEvent.reasoning : null;
		if (reasoning) {
			const message =
				setOrCreateReasoningMessage(entry, taskId, reasoning) ?? createReasoningMessage(entry, taskId, reasoning);
			input.emitMessage(taskId, message);
		}
		entry.activeReasoningMessageId = null;
		emitSummary(input, {
			lastOutputAt: now(),
		});
		return;
	}

	if (agentEvent?.type === "content_start" && agentEvent.contentType === "tool") {
		const toolName = typeof agentEvent.toolName === "string" ? agentEvent.toolName : null;
		const toolCallId = typeof agentEvent.toolCallId === "string" ? agentEvent.toolCallId : null;
		const toolInput = agentEvent.input;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const isUserAttentionTool = isClineUserAttentionTool(toolName);
		input.emitMessage(
			taskId,
			startToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				input: toolInput,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `Using ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: isUserAttentionTool ? "user_attention" : null,
				source: "cline-sdk",
			},
		};
		if (isUserAttentionTool && entry.summary.state === "running") {
			summaryPatch.state = "awaiting_review";
			summaryPatch.reviewReason = "hook";
		} else if (!isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.state = "running";
			summaryPatch.reviewReason = null;
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "tool") {
		const toolName = typeof agentEvent.toolName === "string" ? agentEvent.toolName : null;
		const toolCallId = typeof agentEvent.toolCallId === "string" ? agentEvent.toolCallId : null;
		const toolOutput = agentEvent.output;
		const toolError = typeof agentEvent.error === "string" ? agentEvent.error : null;
		const durationMs = typeof agentEvent.durationMs === "number" ? agentEvent.durationMs : null;
		const toolInput = toolCallId ? entry.toolInputByToolCallId.get(toolCallId) : undefined;
		const toolDisplay = getClineToolCallDisplay(toolName, toolInput);
		const isUserAttentionTool = isClineUserAttentionTool(toolName);
		input.emitMessage(
			taskId,
			finishToolCallMessage(entry, taskId, {
				toolName,
				toolCallId,
				output: toolOutput,
				error: toolError,
				durationMs,
			}),
		);
		const summaryPatch: Partial<RuntimeTaskSessionSummary> = {
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: `${toolError ? "Failed" : "Completed"} ${formatClineToolCallLabel(toolDisplay.toolName, toolDisplay.inputSummary)}`,
				toolName: toolDisplay.toolName,
				toolInputSummary: toolDisplay.inputSummary,
				finalMessage: null,
				hookEventName: "tool_result",
				notificationType: null,
				source: "cline-sdk",
			},
		};
		if (isUserAttentionTool && canReturnToRunning(entry.summary.reviewReason)) {
			summaryPatch.state = "running";
			summaryPatch.reviewReason = null;
		}
		emitSummary(input, summaryPatch);
		return;
	}

	if (agentEvent?.type === "content_end" && agentEvent.contentType === "text") {
		const text = typeof agentEvent.text === "string" ? agentEvent.text : null;
		if (text) {
			const message =
				setOrCreateAssistantMessage(entry, taskId, text) ?? createAssistantMessage(entry, taskId, text);
			input.emitMessage(taskId, message);
		}
		entry.activeAssistantMessageId = null;
		emitSummary(input, {
			lastOutputAt: now(),
		});
		return;
	}

	if (chunkEvent?.payload.stream === "agent") {
		const chunk = chunkEvent.payload.chunk;
		if (chunk.length === 0 || isLikelySerializedAgentEventChunk(chunk)) {
			return;
		}
		input.emitMessage(taskId, appendAssistantChunk(entry, taskId, chunk));
		const fullPreviewText = normalizePreviewText(chunk);
		const previewText = toPreviewText(fullPreviewText);
		const retainedToolActivity = getRetainedClineToolActivity(entry);
		emitSummary(input, {
			state: "running",
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: previewText ?? "Agent active",
				toolName: retainedToolActivity.toolName,
				toolInputSummary: retainedToolActivity.toolInputSummary,
				finalMessage: fullPreviewText,
				hookEventName: "assistant_delta",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (hookEvent) {
		const hookEventName =
			typeof hookEvent.payload.hookEventName === "string" ? hookEvent.payload.hookEventName : null;
		const toolName = typeof hookEvent.payload.toolName === "string" ? hookEvent.payload.toolName : null;
		const activityText = hookEventName && toolName ? `${hookEventName}: ${toolName}` : hookEventName;
		emitSummary(input, {
			lastHookAt: now(),
			latestHookActivity: {
				activityText,
				toolName,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName,
				notificationType: null,
				source: "cline-sdk",
			},
		});
		return;
	}

	if (endedEvent) {
		const interrupted =
			endedEvent.payload.reason.includes("abort") || endedEvent.payload.reason.includes("interrupt");
		if (interrupted && input.pendingTurnCancelTaskIds.has(taskId)) {
			emitTurnCanceled(input);
			return;
		}
		clearActiveTurnState(entry);
		emitSummary(input, {
			state: interrupted ? "interrupted" : "awaiting_review",
			reviewReason: interrupted ? "interrupted" : "exit",
			lastOutputAt: now(),
		});
		return;
	}

	if (statusEvent) {
		if (statusEvent.payload.status !== "running") {
			clearActiveTurnState(entry);
		}
		emitSummary(input, resolveStatusSummaryPatch(entry, statusEvent));
	}
}

function resolveStatusSummaryPatch(
	entry: ClineTaskSessionEntry,
	statusEvent: ClineSdkStatusEvent,
): Partial<RuntimeTaskSessionSummary> {
	const status = statusEvent.payload.status;
	if (status === "running") {
		return {
			state: entry.summary.state === "running" ? "running" : entry.summary.state,
			lastOutputAt: now(),
		};
	}
	if (status === "aborted" || status === "stopped") {
		return {
			state: "interrupted",
			reviewReason: "interrupted",
			lastOutputAt: now(),
		};
	}
	if (status === "failed") {
		return {
			state: "awaiting_review",
			reviewReason: "error",
			lastOutputAt: now(),
		};
	}
	return {
		state: "awaiting_review",
		reviewReason: "exit",
		lastOutputAt: now(),
	};
}

function emitSummary(input: ApplyClineSessionEventInput, patch: Partial<RuntimeTaskSessionSummary>): void {
	input.emitSummary(updateSummary(input.entry, patch));
}

function emitTurnCanceled(input: ApplyClineSessionEventInput): void {
	input.pendingTurnCancelTaskIds.delete(input.taskId);
	clearActiveTurnState(input.entry);
	emitSummary(input, {
		state: "idle",
		reviewReason: null,
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
}

function isLikelySerializedAgentEventChunk(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) {
		return false;
	}
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
		return false;
	}
	try {
		const parsed = JSON.parse(trimmed);
		return Boolean(parsed && typeof parsed === "object" && "type" in parsed);
	} catch {
		return false;
	}
}
