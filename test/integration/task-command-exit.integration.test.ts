import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(process: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Cline Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (process.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			process.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		process.once("exit", handleExit);
	});
}

async function requestGracefulShutdown(process: ChildProcess): Promise<void> {
	if (typeof process.send !== "function" || !process.connected) {
		process.kill("SIGINT");
		return;
	}

	await new Promise<void>((resolveSend) => {
		process.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 8_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

function isWindowsTsxShutdownCrash(exitCode: number | null): boolean {
	return process.platform === "win32" && exitCode === 0xc0000409;
}

function expectSuccessfulCliJsonResult(result: {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	didExit: boolean;
}): void {
	expect(result.didExit, `command did not exit in time.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(
		true,
	);
	if (!isWindowsTsxShutdownCrash(result.exitCode)) {
		expect(result.exitCode).toBe(0);
	}
	expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ ok: true }));
}

describe("source task commands", () => {
	it("exits after creating a task when the runtime server is already running", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const commandProcess = spawnSourceCli(
					[
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					{
						cwd: projectPath,
						env,
					},
				);

				let stdout = "";
				let stderr = "";
				commandProcess.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				commandProcess.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const didExit = await waitForExit(commandProcess, 8_000);
				if (!didExit) {
					commandProcess.kill("SIGKILL");
				}

				expect(didExit, `task create did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
				if (!isWindowsTsxShutdownCrash(commandProcess.exitCode)) {
					expect(commandProcess.exitCode).toBe(0);
				}
				expect(JSON.parse(stdout)).toEqual(expect.objectContaining({ ok: true }));
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		if (process.platform === "win32") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-root-launch-open-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const [args, expectedOpenCount] of [
					[[], 1],
					[["task", "list", "--project-path", projectPath], 1],
					[["--agent", "codex"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("applies a task graph atomically and lists the created dependencies", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-apply-graph-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-apply-graph-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Apply Graph Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const graphPayload = Buffer.from(
					JSON.stringify({
						tasks: [
							{
								clientId: "map-scope",
								title: "Map scope",
								summary: "Understand the current flow.",
								prompt: "Inspect the current flow and capture the existing constraints.",
							},
							{
								clientId: "ship-change",
								title: "Ship change",
								summary: "Implement the requested update.",
								prompt: "Implement the requested change after the scope work is complete.",
							},
						],
						dependencies: [
							{
								dependentId: "ship-change",
								prerequisiteId: "map-scope",
								handoff: {
									context: "Use the scope notes from the first task.",
									outputExpected: "Working implementation with verification notes.",
								},
							},
						],
						defaults: {
							baseRef: "main",
							startInPlanMode: true,
						},
					}),
					"utf8",
				).toString("base64");

				const applied = await runCliCommandAndCollectOutput({
					args: ["task", "apply-graph", "--graph-base64", graphPayload, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(applied);

				const appliedPayload = JSON.parse(applied.stdout) as {
					ok?: boolean;
					createdTasks?: Array<{ id?: string; title?: string | null }>;
					dependencies?: Array<{ dependentTaskId?: string; prerequisiteTaskId?: string }>;
					taskIdByClientId?: Record<string, string>;
				};
				expect(appliedPayload.ok).toBe(true);
				expect(appliedPayload.createdTasks).toHaveLength(2);
				expect(appliedPayload.taskIdByClientId?.["map-scope"]).toBeTruthy();
				expect(appliedPayload.taskIdByClientId?.["ship-change"]).toBeTruthy();
				expect(appliedPayload.dependencies).toEqual([
					expect.objectContaining({
						dependentTaskId: appliedPayload.taskIdByClientId?.["ship-change"],
						prerequisiteTaskId: appliedPayload.taskIdByClientId?.["map-scope"],
					}),
				]);

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(listed);

				const listedPayload = JSON.parse(listed.stdout) as {
					ok?: boolean;
					count?: number;
					tasks?: Array<{ title?: string | null }>;
					dependencies?: Array<{ dependentTaskId?: string; prerequisiteTaskId?: string }>;
				};
				expect(listedPayload.ok).toBe(true);
				expect(listedPayload.count).toBe(2);
				expect(listedPayload.tasks?.map((task) => task.title)).toEqual(["Ship change", "Map scope"]);
				expect(listedPayload.dependencies).toHaveLength(1);
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("rejects invalid task graphs before mutating workspace state", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-apply-graph-invalid-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-apply-graph-invalid-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Invalid Task Apply Graph Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const invalidGraphPayload = Buffer.from(
					JSON.stringify({
						tasks: [
							{ clientId: "task-a", prompt: "Task A" },
							{ clientId: "task-b", prompt: "Task B" },
						],
						dependencies: [
							{ dependentId: "task-a", prerequisiteId: "task-b" },
							{ dependentId: "task-b", prerequisiteId: "task-a" },
						],
					}),
					"utf8",
				).toString("base64");

				const applied = await runCliCommandAndCollectOutput({
					args: ["task", "apply-graph", "--graph-base64", invalidGraphPayload, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					applied.didExit,
					`task apply-graph did not exit in time.\nstdout:\n${applied.stdout}\nstderr:\n${applied.stderr}`,
				).toBe(true);
				expect(applied.exitCode).toBe(1);
				expect(applied.stdout).toContain("Task graph contains a dependency cycle.");

				const duplicateClientIdPayload = Buffer.from(
					JSON.stringify({
						tasks: [
							{ clientId: "task-a", prompt: "Task A" },
							{ clientId: "task-a", prompt: "Task B" },
						],
						dependencies: [],
					}),
					"utf8",
				).toString("base64");

				const duplicate = await runCliCommandAndCollectOutput({
					args: ["task", "apply-graph", "--graph-base64", duplicateClientIdPayload, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					duplicate.didExit,
					`task apply-graph duplicate-id case did not exit in time.\nstdout:\n${duplicate.stdout}\nstderr:\n${duplicate.stderr}`,
				).toBe(true);
				expect(duplicate.exitCode).toBe(1);
				expect((JSON.parse(duplicate.stdout) as { error?: string }).error).toContain(
					'Task graph contains duplicate clientId "task-a".',
				);

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(listed);
				expect((JSON.parse(listed.stdout) as { count?: number }).count).toBe(0);
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("supports trashing and deleting tasks by column", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-trash-delete-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-trash-delete-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Trash Delete Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const prompt of [
					"Create a temporary task for trash and delete",
					"Create another temporary task for trash and delete",
				]) {
					const created = await runCliCommandAndCollectOutput({
						args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expectSuccessfulCliJsonResult(created);

					const createdPayload = JSON.parse(created.stdout) as {
						ok?: boolean;
						task?: { id?: string };
					};
					expect(createdPayload.ok).toBe(true);
					expect(typeof createdPayload.task?.id).toBe("string");
				}

				const trashed = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(trashed);
				expect(trashed.stdout).toContain('"column": "backlog"');
				expect(trashed.stdout).toContain('"count": 2');

				const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(listedTrashBeforeDelete);
				expect(listedTrashBeforeDelete.stdout).toContain('"count": 2');

				const deletedTrash = await runCliCommandAndCollectOutput({
					args: ["task", "delete", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(deletedTrash);
				expect(deletedTrash.stdout).toContain('"column": "trash"');
				expect(deletedTrash.stdout).toContain('"count": 2');

				const listedTrash = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expectSuccessfulCliJsonResult(listedTrash);
				expect(listedTrash.stdout).toContain('"count": 0');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
