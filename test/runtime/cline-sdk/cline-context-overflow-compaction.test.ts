import { describe, expect, it } from "vitest";

import {
	compactPersistedMessagesForContextOverflow,
	isContextOverflowError,
} from "../../../src/cline-sdk/cline-context-overflow-compaction";
import type { ClineSdkPersistedMessage } from "../../../src/cline-sdk/sdk-runtime-boundary";

function message(
	role: ClineSdkPersistedMessage["role"],
	content: ClineSdkPersistedMessage["content"],
): ClineSdkPersistedMessage {
	return { role, content };
}

function firstTextBlock(message: ClineSdkPersistedMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	const firstBlock = message.content[0];
	return firstBlock?.type === "text" ? firstBlock.text : "";
}

describe("isContextOverflowError", () => {
	it("detects common context overflow errors", () => {
		expect(isContextOverflowError(new Error("input tokens exceed model context window"))).toBe(true);
		expect(isContextOverflowError(new Error("network unavailable"))).toBe(false);
		expect(isContextOverflowError("context length exceeded")).toBe(false);
	});
});

describe("compactPersistedMessagesForContextOverflow", () => {
	it("returns null for empty, single-message, and no-user histories", () => {
		expect(compactPersistedMessagesForContextOverflow([])).toBeNull();
		expect(compactPersistedMessagesForContextOverflow([message("user", "only prompt")])).toBeNull();
		expect(
			compactPersistedMessagesForContextOverflow([
				message("assistant", "first response"),
				message("assistant", "second response"),
			]),
		).toBeNull();
	});

	it("compacts plain text history from the first retained user message", () => {
		const compacted = compactPersistedMessagesForContextOverflow([
			message("user", "original request"),
			message("assistant", "old answer"),
			message("user", "continue from here"),
			message("assistant", "new answer"),
		]);

		expect(compacted).toEqual([
			message("user", expect.stringContaining("First user message from the removed history: original request")),
			message("assistant", "new answer"),
		]);
		expect(compacted?.[0]?.content).toContain("continue from here");
	});

	it("preserves array content while previewing text, file, image, thinking, and redacted thinking blocks", () => {
		const compacted = compactPersistedMessagesForContextOverflow([
			message("user", [
				{ type: "text", text: "read this" },
				{ type: "file", path: "/tmp/app.ts", content: "const value = 1;" },
				{ type: "image", data: "base64", mediaType: "image/png" },
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "redacted_thinking", data: "encrypted" },
			]),
			message("assistant", "old answer"),
			message("user", [{ type: "text", text: "retained prompt" }]),
			message("assistant", "retained answer"),
		]);

		expect(compacted?.[0]?.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining(
					"First user message from the removed history: read this /tmp/app.ts [image] private reasoning [redacted_thinking]",
				),
			},
			{ type: "text", text: "retained prompt" },
		]);
	});

	it("previews nested tool result content arrays with useful text, file path, and image notes", () => {
		const compacted = compactPersistedMessagesForContextOverflow([
			message("user", [
				{
					type: "tool_result",
					tool_use_id: "read-1",
					content: [
						{ type: "text", text: "tool said hello" },
						{ type: "file", path: "/tmp/result.txt", content: "hello" },
						{ type: "image", data: "base64", mediaType: "image/png" },
					],
				},
			]),
			message("assistant", "old answer"),
			message("user", "retained prompt"),
			message("assistant", "retained answer"),
		]);

		expect(firstTextBlock(compacted?.[0] ?? message("user", ""))).toContain(
			"First user message from the removed history: tool said hello /tmp/result.txt [image]",
		);
	});

	it("does not start compacted history with orphaned retained tool result blocks", () => {
		const compacted = compactPersistedMessagesForContextOverflow([
			message("user", "original request"),
			message("assistant", [
				{ type: "tool_use", id: "discarded-tool", name: "read_file", input: { path: "old.ts" } },
			]),
			message("user", [
				{ type: "tool_result", tool_use_id: "discarded-tool", content: "old file" },
				{ type: "text", text: "please continue" },
			]),
			message("assistant", "retained answer"),
		]);

		expect(compacted?.[0]?.role).toBe("user");
		expect(compacted?.[0]?.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining("First user message from the removed history: original request"),
			},
			{
				type: "text",
				text: "[Earlier tool result omitted during context compaction: discarded-tool]",
			},
			{ type: "text", text: "please continue" },
		]);
	});
});
