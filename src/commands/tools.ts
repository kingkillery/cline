import type { Command } from "commander";

import { detectRuntimeTools } from "../core/tool-detection";

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function registerToolsCommand(program: Command): void {
	const tools = program.command("tools").description("Inspect runtime tool and auth readiness.");

	tools
		.command("doctor")
		.description("Read-only check of installed CLIs and known auth states.")
		.action(() => {
			printJson({
				ok: true,
				...detectRuntimeTools(),
			});
		});

	tools
		.command("list")
		.description("Alias for tools doctor.")
		.action(() => {
			printJson({
				ok: true,
				...detectRuntimeTools(),
			});
		});
}
