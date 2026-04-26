import { describe, expect, it } from "vitest";

import { buildKanbanCommandParts, resolveKanbanCommandParts } from "../../../src/core/kanban-command";

describe("kanban command resolution", () => {
	it("resolves the source entrypoint when running under tsx watch", () => {
		const command = resolveKanbanCommandParts({
			execPath: "C:\\Program Files\\nodejs\\node.exe",
			execArgv: [
				"--require",
				"C:\\repo\\node_modules\\tsx\\dist\\preflight.cjs",
				"--import",
				"file:///C:/repo/node_modules/tsx/dist/loader.mjs",
			],
			argv: ["node", "watch", "src\\cli.ts", "--port", "3484"],
		});

		expect(command).toEqual([
			"C:\\Program Files\\nodejs\\node.exe",
			"--require",
			"C:\\repo\\node_modules\\tsx\\dist\\preflight.cjs",
			"--import",
			"file:///C:/repo/node_modules/tsx/dist/loader.mjs",
			"src\\cli.ts",
		]);
	});

	it("builds hook commands against the resolved source entrypoint", () => {
		const command = buildKanbanCommandParts(["hooks", "codex-wrapper"], {
			execPath: "node",
			execArgv: ["--import", "file:///C:/repo/node_modules/tsx/dist/loader.mjs"],
			argv: ["node", "watch", "src/cli.ts"],
		});

		expect(command).toEqual([
			"node",
			"--import",
			"file:///C:/repo/node_modules/tsx/dist/loader.mjs",
			"src/cli.ts",
			"hooks",
			"codex-wrapper",
		]);
	});
});
