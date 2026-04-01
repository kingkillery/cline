import { spawn, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { KanbanRunCoordinator } from "./kanban-run-coordinator.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..", "..")
const ralphDir = path.join(repoRoot, "scripts", "ralph")
const runtimeDir = path.join(ralphDir, "runtime")
const worktreeRuntimeRoot = path.join(runtimeDir, "worktrees")
const prdPath = path.join(ralphDir, "prd.json")
const progressPath = path.join(ralphDir, "progress.txt")
const coordinatorStatePath = path.join(runtimeDir, "run-coordinator-state.json")

fs.mkdirSync(runtimeDir, { recursive: true })
fs.mkdirSync(worktreeRuntimeRoot, { recursive: true })

function parseArgs(argv) {
	const options = {
		maxIterations: 25,
		worker: "codex",
		outcome: "Stable kanban-controlled autonomous runtime",
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--max-iterations" && argv[i + 1]) {
			options.maxIterations = Number.parseInt(argv[++i], 10)
		} else if (arg === "--worker" && argv[i + 1]) {
			options.worker = argv[++i]
		} else if (arg === "--outcome" && argv[i + 1]) {
			options.outcome = argv[++i]
		}
	}

	return options
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex")
}

function fileHash(filePath) {
	return sha256(fs.readFileSync(filePath, "utf8"))
}

function toPosixRelative(filePath) {
	return filePath.split(path.sep).join("/")
}

function isRalphRuntimePath(relativePath) {
	const normalized = toPosixRelative(relativePath)
	return normalized === "scripts/ralph/runtime" || normalized.startsWith("scripts/ralph/runtime/")
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function gitStatusShort() {
	return gitStatusShortAt(repoRoot)
}

function gitStatusShortAt(cwd) {
	const result = spawnSync("git", ["status", "--short"], {
		cwd,
		encoding: "utf8",
	})

	if (result.error) {
		return `git status failed: ${result.error.message}`
	}

	return (result.stdout || "").trim()
}

function runGit(args, cwd, { allowFailure = false } = {}) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	})

	if (!allowFailure && result.status !== 0) {
		const stderr = (result.stderr || "").trim()
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`)
	}

	return {
		status: result.status ?? 0,
		stdout: (result.stdout || "").trim(),
		stderr: (result.stderr || "").trim(),
		error: result.error ?? null,
	}
}

function listDirtyRepoPaths(cwd) {
	const trackedResult = runGit(["diff", "--name-only", "HEAD", "--", "."], cwd, { allowFailure: true })
	const untrackedResult = runGit(["ls-files", "--others", "--exclude-standard", "--", "."], cwd, { allowFailure: true })
	return [
		...(trackedResult.stdout ? trackedResult.stdout.split(/\r?\n/).filter(Boolean) : []),
		...(untrackedResult.stdout ? untrackedResult.stdout.split(/\r?\n/).filter(Boolean) : []),
	].filter((relativePath) => !isRalphRuntimePath(relativePath))
}

function copyPath(sourceRoot, destRoot, relativePath) {
	const sourcePath = path.join(sourceRoot, relativePath)
	const destPath = path.join(destRoot, relativePath)

	if (!fs.existsSync(sourcePath)) {
		if (fs.existsSync(destPath)) {
			fs.rmSync(destPath, { recursive: true, force: true })
		}
		return
	}

	fs.mkdirSync(path.dirname(destPath), { recursive: true })
	fs.cpSync(sourcePath, destPath, { recursive: true, force: true })
}

function mirrorDirtyState(sourceRoot, destRoot) {
	const dirtyPaths = [...new Set(listDirtyRepoPaths(sourceRoot).map((relativePath) => relativePath.replace(/\\/g, path.sep)))]
	for (const relativePath of dirtyPaths) {
		copyPath(sourceRoot, destRoot, relativePath)
	}
	return dirtyPaths
}

function normalizeStory(story) {
	return {
		dependsOn: [],
		notes: "",
		...story,
	}
}

function getNextStory(prd, coordinator, now = Date.now()) {
	return [...prd.userStories]
		.map(normalizeStory)
		.filter((story) => !story.passes)
		.filter((story) =>
			story.dependsOn.every((storyId) => prd.userStories.some((candidate) => candidate.id === storyId && candidate.passes)),
		)
		.filter((story) => coordinator.canStartStory(story.id, now).allowed)
		.sort((a, b) => a.priority - b.priority)[0]
}

function getIncompleteStories(prd) {
	return prd.userStories.filter((story) => !story.passes)
}

function getBlockedStories(prd) {
	const incompleteIds = new Set(getIncompleteStories(prd).map((story) => story.id))
	return prd.userStories
		.map(normalizeStory)
		.filter((story) => !story.passes)
		.filter((story) => story.dependsOn.some((dependencyId) => incompleteIds.has(dependencyId)))
}

function getCodexCommand() {
	if (process.platform === "win32") {
		return {
			command: "cmd.exe",
			args: ["/d", "/s", "/c", "codex"],
		}
	}

	return {
		command: "codex",
		args: [],
	}
}

function buildPrompt({ iteration, outcome, story, progressText, gitStatus, remainingStories, blockedStories }) {
	const dependencyLine = story.dependsOn.length > 0 ? story.dependsOn.join(", ") : "none"
	const blockedSummary =
		blockedStories.length > 0
			? blockedStories.map((blocked) => `${blocked.id} (waiting on ${blocked.dependsOn.join(", ")})`).join("; ")
			: "none"

	return [
		`You are Ralph iteration ${iteration}.`,
		"This is a fresh-context run. Re-read the repository state from disk and do not assume memory from any previous iteration.",
		`Outcome: ${outcome}`,
		"",
		"Loop contract:",
		"- Work only on the active story.",
		"- Re-read relevant files from disk before deciding what is done.",
		"- Do not revert unrelated user changes.",
		"- Do not create commits.",
		"- Update scripts/ralph/progress.txt with proof commands, changed files, learnings, blockers, and an acceptance verdict for this story.",
		"- Set scripts/ralph/prd.json story.passes=true only if every acceptance criterion is satisfied now.",
		"- If any criterion is unmet or blocked, leave passes=false.",
		"- Use the smallest sufficient change set for the active story.",
		"",
		"Active story:",
		JSON.stringify(story, null, 2),
		"",
		"Story proof requirements:",
		"- Verify implementation with repo evidence before marking passes=true.",
		"- Run lightweight local commands when possible and record them in progress.txt.",
		"- If you change files, record exactly which files changed and why.",
		"- If blocked, record the blocker in progress.txt and stop after making the state explicit.",
		"",
		"Dependency status:",
		`- Active story dependencies: ${dependencyLine}`,
		`- Other blocked stories: ${blockedSummary}`,
		"",
		"Remaining stories after this one:",
		remainingStories
			.map((candidate) => `- ${candidate.id}: ${candidate.title}${candidate.passes ? " [passed]" : " [pending]"}`)
			.join("\n"),
		"",
		"Current git status:",
		gitStatus || "(clean)",
		"",
		"Current progress log:",
		progressText,
	].join("\n")
}

function safeReadText(filePath) {
	return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : ""
}

function parseIterationClassification(lastMessage, stderrText) {
	const haystack = `${lastMessage}\n${stderrText}`.toLowerCase()
	if (haystack.includes("blocked")) {
		return "blocked"
	}
	if (haystack.includes("acceptance") && haystack.includes("not met")) {
		return "criteria_not_met"
	}
	if (haystack.includes("error") || haystack.includes("failed")) {
		return "worker_error"
	}
	return "criteria_not_met"
}

function writeIterationMetadata(prefix, metadata) {
	const metadataPath = path.join(runtimeDir, `${prefix}.metadata.json`)
	fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n")
	return metadataPath
}

function createWorktreeSlug(cardId) {
	return cardId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

function ensureCleanDirectory(directoryPath) {
	if (fs.existsSync(directoryPath)) {
		fs.rmSync(directoryPath, { recursive: true, force: true })
	}
	fs.mkdirSync(path.dirname(directoryPath), { recursive: true })
}

function readRalphStateSnapshot(cwd) {
	return {
		prdHash: fileHash(path.join(cwd, "scripts", "ralph", "prd.json")),
		progressHash: fileHash(path.join(cwd, "scripts", "ralph", "progress.txt")),
		gitStatus: listDirtyRepoPaths(cwd)
			.map((relativePath) => relativePath.replace(/\\/g, "/"))
			.sort()
			.join("\n"),
	}
}

function prepareCardWorktree(story) {
	const slug = createWorktreeSlug(story.id)
	const worktreePath = path.join(worktreeRuntimeRoot, slug)
	const branchName = `ralph/${slug}`
	const relativeWorktreePath = path.relative(repoRoot, worktreePath)

	try {
		runGit(["worktree", "remove", "--force", worktreePath], repoRoot, { allowFailure: true })
	} catch {
		// Best-effort cleanup before recreating the isolated workspace.
	}

	try {
		runGit(["branch", "-D", branchName], repoRoot, { allowFailure: true })
	} catch {
		// The branch may not exist yet.
	}

	ensureCleanDirectory(worktreePath)
	runGit(["worktree", "add", "-b", branchName, worktreePath], repoRoot)
	mirrorDirtyState(repoRoot, worktreePath)

	return {
		worktreePath,
		relativeWorktreePath,
		branchName,
	}
}

function collectValidationEvidence({ worktreePath, branchName }) {
	const validationCommands = []

	const statusResult = runGit(["status", "--short"], worktreePath)
	validationCommands.push({
		command: "git status --short",
		cwd: path.relative(repoRoot, worktreePath),
		exitCode: statusResult.status,
		output: statusResult.stdout || "(clean)",
	})

	const changedFilesSummary = listDirtyRepoPaths(worktreePath).map((relativePath) => ({
		status: "dirty",
		path: relativePath.replace(/\\/g, "/"),
	}))

	const branchResult = runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, { allowFailure: true })
	validationCommands.push({
		command: "git rev-parse --abbrev-ref HEAD",
		cwd: path.relative(repoRoot, worktreePath),
		exitCode: branchResult.status,
		output: branchResult.stdout || branchResult.stderr || branchName,
	})

	const commitResult = runGit(["rev-parse", "HEAD"], worktreePath, { allowFailure: true })
	validationCommands.push({
		command: "git rev-parse HEAD",
		cwd: path.relative(repoRoot, worktreePath),
		exitCode: commitResult.status,
		output: commitResult.stdout || commitResult.stderr || "(missing)",
	})

	return {
		validationCommands,
		changedFilesSummary,
		currentBranch: branchResult.status === 0 ? branchResult.stdout : null,
		latestCommitSha: commitResult.status === 0 ? commitResult.stdout : null,
	}
}

async function runWorker({ prompt, iteration, worker, story, coordinator }) {
	const prefix = `iteration-${String(iteration).padStart(3, "0")}`
	const promptPath = path.join(runtimeDir, `${prefix}.prompt.txt`)
	const stdoutPath = path.join(runtimeDir, `${prefix}.stdout.log`)
	const stderrPath = path.join(runtimeDir, `${prefix}.stderr.log`)
	const lastMessagePath = path.join(runtimeDir, `${prefix}.last-message.txt`)
	const storyPath = path.join(runtimeDir, `${prefix}.story.json`)

	fs.writeFileSync(promptPath, prompt)
	fs.writeFileSync(storyPath, JSON.stringify(story, null, 2) + "\n")

	if (worker !== "codex") {
		throw new Error(`Unsupported worker '${worker}'. Only 'codex' is implemented.`)
	}

	const worktree = prepareCardWorktree(story)
	const before = readRalphStateSnapshot(worktree.worktreePath)
	const codex = getCodexCommand()
	const sessionId = `${worker}-${prefix}`
	const runRecord = coordinator.createRun({
		cardId: story.id,
		sessionId,
		workspacePath: worktree.worktreePath,
		metadata: {
			iteration,
			worker,
			branchName: worktree.branchName,
			runtimeRoot: path.relative(repoRoot, worktreeRuntimeRoot),
			worktreePath: worktree.relativeWorktreePath,
			promptPath: path.relative(repoRoot, promptPath),
			storyPath: path.relative(repoRoot, storyPath),
		},
	})

	const child = spawn(
		codex.command,
		[...codex.args, "exec", "--full-auto", "--ephemeral", "-C", worktree.worktreePath, "-o", lastMessagePath],
		{
			cwd: worktree.worktreePath,
			stdio: ["pipe", "pipe", "pipe"],
		},
	)
	const childPids = Number.isInteger(child.pid) ? [child.pid] : []
	const stdoutStream = fs.createWriteStream(stdoutPath)
	const stderrStream = fs.createWriteStream(stderrPath)

	coordinator.heartbeat(runRecord.runId, childPids)

	if (child.stdin) {
		child.stdin.end(prompt)
	}

	const heartbeatTimer = setInterval(() => {
		coordinator.heartbeat(runRecord.runId, childPids)
	}, 5_000)

	return await new Promise((resolve) => {
		let settled = false
		const finish = (payload) => {
			if (settled) {
				return
			}
			settled = true
			clearInterval(heartbeatTimer)
			stdoutStream.end()
			stderrStream.end()
			resolve(payload)
		}

		child.stdout?.on("data", (chunk) => {
			stdoutStream.write(chunk)
		})

		child.stderr?.on("data", (chunk) => {
			stderrStream.write(chunk)
		})

		child.on("error", (error) => {
			finish({
				error,
				status: null,
				signal: null,
				before,
				after: before,
				promptPath,
				stdoutPath,
				stderrPath,
				lastMessagePath,
				storyPath,
				prefix,
				runId: runRecord.runId,
				childPids,
				worktree,
			})
		})

		child.on("close", (status, signal) => {
			const after = readRalphStateSnapshot(worktree.worktreePath)
			mirrorDirtyState(worktree.worktreePath, repoRoot)
			finish({
				error: null,
				status,
				signal,
				before,
				after,
				promptPath,
				stdoutPath,
				stderrPath,
				lastMessagePath,
				storyPath,
				prefix,
				runId: runRecord.runId,
				childPids,
				worktree,
			})
		})
	})
}

function describeRemainingStories(prd) {
	return getIncompleteStories(prd).map((story) => `${story.id}: ${story.title}`)
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	let prd = readJson(prdPath)
	const noProgressCounts = new Map()
	const coordinator = new KanbanRunCoordinator({
		statePath: coordinatorStatePath,
		workspacePath: repoRoot,
	})

	console.log(`Starting fresh-context Ralph loop with worker=${options.worker}, maxIterations=${options.maxIterations}`)
	console.log(`Initial incomplete stories: ${getIncompleteStories(prd).length}`)
	const startupReconciliation = coordinator.reconcileStartup()
	console.log(
		`Startup reconciliation: requeued=${startupReconciliation.requeued.length}, cleaned=${startupReconciliation.cleaned.length}`,
	)

	for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
		prd = readJson(prdPath)
		coordinator.reconcileStartup()
		const nextStory = getNextStory(prd, coordinator)

		if (!nextStory) {
			const remainingStoryRecords = getIncompleteStories(prd)
			const remainingStories = describeRemainingStories(prd)
			if (remainingStoryRecords.length === 0) {
				console.log("All stories are complete.")
				return
			}

			const nextRetryDelay = coordinator.getNextRetryDelay(remainingStoryRecords.map((story) => story.id))
			if (nextRetryDelay !== null) {
				const waitMs = Math.min(nextRetryDelay, 1_000)
				console.log(`No story is runnable yet; waiting ${waitMs}ms for coordinator retry eligibility.`)
				await delay(waitMs)
				continue
			}

			console.error("No eligible story is ready to run. Remaining stories are blocked by unmet dependencies.")
			for (const story of getBlockedStories(prd)) {
				console.error(`- ${story.id}: waiting on ${story.dependsOn.join(", ")}`)
			}
			process.exitCode = 1
			return
		}

		const progressText = fs.readFileSync(progressPath, "utf8")
		const prompt = buildPrompt({
			iteration,
			outcome: options.outcome,
			story: nextStory,
			progressText,
			gitStatus: readRalphStateSnapshot(repoRoot).gitStatus,
			remainingStories: prd.userStories,
			blockedStories: getBlockedStories(prd),
		})

		console.log(`\n[Iteration ${iteration}] Running story ${nextStory.id}: ${nextStory.title}`)
		const result = await runWorker({ prompt, iteration, worker: options.worker, story: nextStory, coordinator })
		const before = result.before

		const afterPrd = readJson(path.join(result.worktree.worktreePath, "scripts", "ralph", "prd.json"))
		const afterStory = afterPrd.userStories.find((story) => story.id === nextStory.id)
		const after = result.after
		const validationEvidence = collectValidationEvidence({
			worktreePath: result.worktree.worktreePath,
			branchName: result.worktree.branchName,
		})

		const changed =
			before.prdHash !== after.prdHash || before.progressHash !== after.progressHash || before.gitStatus !== after.gitStatus
		const lastMessage = safeReadText(result.lastMessagePath)
		const stderrText = safeReadText(result.stderrPath)
		const classification = result.error
			? "worker_error"
			: !changed
				? "no_progress"
				: afterStory?.passes
					? "completed"
					: parseIterationClassification(lastMessage, stderrText)

		const proofBundle = {
			classification,
			outcome: afterStory?.passes === true ? "acceptance-criteria-met" : classification,
			storyPassed: afterStory?.passes === true,
			validationCommands: validationEvidence.validationCommands,
			changedFiles: {
				summary: validationEvidence.changedFilesSummary,
			},
			workspaceIdentity: {
				worktreePath: result.worktree.relativeWorktreePath,
				branch: validationEvidence.currentBranch || result.worktree.branchName,
			},
			latestCommitSha: validationEvidence.latestCommitSha,
			uiArtifactPath: null,
			artifacts: {
				promptPath: path.relative(repoRoot, result.promptPath),
				storyPath: path.relative(repoRoot, result.storyPath),
				stdoutPath: path.relative(repoRoot, result.stdoutPath),
				stderrPath: path.relative(repoRoot, result.stderrPath),
				lastMessagePath: path.relative(repoRoot, result.lastMessagePath),
			},
			before,
			after,
			stateChanged: changed,
			reconciliation: coordinator.getStateSnapshot().lastReconciliationSummary,
		}

		let finalStatus = afterStory?.passes ? "completed" : classification === "blocked" ? "failed" : "retry_due"
		let finalLastError = afterStory?.passes
			? null
			: (result.error?.message ??
				(lastMessage.trim() ||
					stderrText.trim() ||
					`Story ${nextStory.id} did not satisfy acceptance criteria in iteration ${iteration}.`))

		coordinator.finalizeRun(result.runId, {
			status: finalStatus,
			lastError: finalLastError,
			proofBundle,
			childPids: result.childPids,
		})

		const humanReviewGate =
			afterStory?.passes === true
				? coordinator.transitionToHumanReview(result.runId, proofBundle)
				: {
						allowed: false,
						reason: "story-not-passed",
						validationErrors: [],
					}

		if (afterStory?.passes === true && !humanReviewGate.allowed) {
			finalStatus = "retry_due"
			finalLastError = `Human Review gate blocked: ${humanReviewGate.validationErrors.join(", ")}`
		} else if (humanReviewGate.allowed) {
			finalStatus = humanReviewGate.reason
		}

		const metadataPath = writeIterationMetadata(result.prefix, {
			iteration,
			storyId: nextStory.id,
			storyTitle: nextStory.title,
			classification,
			worker: options.worker,
			workerExitCode: result.status ?? null,
			workerSignal: result.signal ?? null,
			spawnError: result.error?.message ?? null,
			before,
			after,
			changed,
			storyPassed: afterStory?.passes === true,
			humanReviewGate,
			finalRunStatus: finalStatus,
			finalLastError,
			workspacePath: result.worktree.relativeWorktreePath,
			branchName: result.worktree.branchName,
			artifacts: proofBundle.artifacts,
			runId: result.runId,
			coordinatorStatePath: path.relative(repoRoot, coordinatorStatePath),
		})

		console.log(`Worker exit code: ${result.status ?? "null"}`)
		if (result.error) {
			console.log(`Worker spawn error: ${result.error.message}`)
		}
		console.log(`Story passed: ${afterStory?.passes === true ? "yes" : "no"}`)
		console.log(`State changed: ${changed ? "yes" : "no"}`)
		console.log(`Classification: ${classification}`)
		console.log(`Human Review gate: ${humanReviewGate.allowed ? "ready" : `blocked (${humanReviewGate.reason})`}`)
		console.log(`Artifacts: ${path.relative(repoRoot, metadataPath)}`)

		if (afterStory?.passes) {
			noProgressCounts.delete(nextStory.id)
			continue
		}

		if (classification === "no_progress") {
			const nextCount = (noProgressCounts.get(nextStory.id) || 0) + 1
			noProgressCounts.set(nextStory.id, nextCount)
			if (nextCount >= 2) {
				console.error(
					`Story ${nextStory.id} made no visible progress in ${nextCount} consecutive iterations. Stopping to avoid a blind loop.`,
				)
				process.exitCode = 1
				return
			}
		} else {
			noProgressCounts.set(nextStory.id, 0)
		}
	}

	const finalPrd = readJson(prdPath)
	const remainingStories = describeRemainingStories(finalPrd)
	if (remainingStories.length > 0) {
		console.error(
			`Reached max iterations with ${remainingStories.length} incomplete stor${remainingStories.length === 1 ? "y" : "ies"} remaining.`,
		)
		console.error("Remaining stories:")
		for (const story of remainingStories) {
			console.error(`- ${story}`)
		}
		process.exitCode = 1
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : String(error))
	process.exitCode = 1
})
