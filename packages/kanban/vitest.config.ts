import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@clinebot\/agents$/,
				replacement: "@clinebot/agents/node",
			},
			{
				find: /^@clinebot\/llms$/,
				replacement: "@clinebot/llms/node",
			},
		],
	},
	test: {
		globals: true,
		environment: "node",
		exclude: ["apps/**", "web-ui/**", "third_party/**", "**/node_modules/**", "**/dist/**", ".worktrees/**"],
		testTimeout: 15_000,
		// Windows source-CLI integration tests spawn multiple Kanban subprocesses and
		// become flaky when Vitest schedules files in parallel.
		fileParallelism: process.platform !== "win32",
	},
});
