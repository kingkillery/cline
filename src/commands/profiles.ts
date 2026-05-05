import type { Command } from "commander";

import { getWorkerProfiles } from "../core/worker-profiles";

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function registerProfilesCommand(program: Command): void {
	const profiles = program.command("profiles").description("Inspect worker profiles.");

	profiles
		.command("list")
		.description("List read-only built-in worker profiles.")
		.action(() => {
			printJson({
				ok: true,
				...getWorkerProfiles(),
			});
		});
}
