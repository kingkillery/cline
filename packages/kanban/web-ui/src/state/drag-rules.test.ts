import { describe, expect, it } from "vitest";

import { isCardDropDisabled, type ProgrammaticCardMoveInFlight } from "@/state/drag-rules";

describe("drag rules", () => {
	it("keeps manual in-progress to review drops disabled", () => {
		expect(isCardDropDisabled("review", "in_progress")).toBe(true);
	});

	it("allows the matching programmatic in-progress to review drop", () => {
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "in_progress",
			toColumnId: "review",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
		expect(
			isCardDropDisabled("review", "in_progress", {
				activeDragTaskId: "task-2",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(true);
	});

	it("allows review to in-progress drops for retry workflows", () => {
		expect(isCardDropDisabled("in_progress", "review")).toBe(false);

		// Also allowed when a programmatic move is in flight (manual drag still works)
		const move: ProgrammaticCardMoveInFlight = {
			taskId: "task-1",
			fromColumnId: "review",
			toColumnId: "in_progress",
			insertAtTop: true,
		};

		expect(
			isCardDropDisabled("in_progress", "review", {
				activeDragTaskId: "task-1",
				programmaticCardMoveInFlight: move,
			}),
		).toBe(false);
	});

	it("allows manual trash to review drops", () => {
		expect(isCardDropDisabled("review", "trash")).toBe(false);
	});
});
