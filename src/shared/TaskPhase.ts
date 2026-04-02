export type TaskPhase = "preparing" | "sending" | "reasoning" | "generating" | "executing" | "idle"

export const PHASE_LABELS: Record<TaskPhase, string> = {
	preparing: "Analyzing request...",
	sending: "Waiting for model...",
	reasoning: "Thinking...",
	generating: "Drafting response...",
	executing: "Running tools...",
	idle: "",
}
