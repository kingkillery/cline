import { spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..", "..")
const ralphDir = path.join(repoRoot, "scripts", "ralph")
const runtimeDir = path.join(ralphDir, "runtime")
const prdPath = path.join(ralphDir, "prd.json")
const progressPath = path.join(ralphDir, "progress.txt")

fs.mkdirSync(runtimeDir, { recursive: true })

function parseArgs(argv) {
	const options = {
		maxIterations: 8,
		worker: "codex",
		outcome: "Full intended functionality",
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

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n")
}

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex")
}

function fileHash(filePath) {
	return sha256(fs.readFileSync(filePath, "utf8"))
}

function gitStatusShort() {
	const result = spawnSync("git", ["status", "--short"], {
		cwd: repoRoot,
		encoding: "utf8",
	})

	if (result.error) {
		return `git status failed: ${result.error.message}`
	}

	return (result.stdout || "").trim()
}

function getNextStory(prd) {
	return [...prd.userStories]
		.filter((story) => !story.passes)
		.sort((a, b) => a.priority - b.priority)[0]
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

function buildPrompt({ iteration, outcome, story, progressText, gitStatus }) {
	return [
		`You are Ralph iteration ${iteration}.`,
		`This is a fresh-context run. Re-read the repository state from disk and do not assume memory from any previous iteration.`,
		`Outcome: ${outcome}`,
		"",
		"Active story:",
		JSON.stringify(story, null, 2),
		"",
		"Rules:",
		"- Work only on the active story.",
		"- Make the smallest sufficient change set.",
		"- Do not revert unrelated user changes.",
		"- Do not create commits.",
		"- Update scripts/ralph/progress.txt with what you verified, changed, and learned.",
		"- Set scripts/ralph/prd.json story.passes=true only if every acceptance criterion is satisfied now.",
		"- If blocked, record the blocker in progress.txt and leave passes=false.",
		"",
		"Current git status:",
		gitStatus || "(clean)",
		"",
		"Current progress log:",
		progressText,
		"",
		"Before finishing, explicitly verify the active acceptance criteria using local repo evidence and lightweight commands where possible.",
	].join("\n")
}

function runWorker({ prompt, iteration, worker }) {
	const prefix = `iteration-${String(iteration).padStart(3, "0")}`
	const promptPath = path.join(runtimeDir, `${prefix}.prompt.txt`)
	const stdoutPath = path.join(runtimeDir, `${prefix}.stdout.log`)
	const stderrPath = path.join(runtimeDir, `${prefix}.stderr.log`)
	const lastMessagePath = path.join(runtimeDir, `${prefix}.last-message.txt`)

	fs.writeFileSync(promptPath, prompt)

	if (worker !== "codex") {
		throw new Error(`Unsupported worker '${worker}'. Only 'codex' is implemented.`)
	}

	const codex = getCodexCommand()
	const result = spawnSync(
		codex.command,
		[...codex.args, "exec", "--full-auto", "--ephemeral", "-C", repoRoot, "-o", lastMessagePath],
		{
			cwd: repoRoot,
			input: prompt,
			encoding: "utf8",
			maxBuffer: 1024 * 1024 * 20,
		},
	)

	fs.writeFileSync(stdoutPath, result.stdout || "")
	fs.writeFileSync(stderrPath, result.stderr || "")

	return {
		...result,
		promptPath,
		stdoutPath,
		stderrPath,
		lastMessagePath,
	}
}

function countIncompleteStories(prd) {
	return prd.userStories.filter((story) => !story.passes).length
}

function main() {
	const options = parseArgs(process.argv.slice(2))
	let prd = readJson(prdPath)

	console.log(`Starting fresh-context Ralph loop with worker=${options.worker}, maxIterations=${options.maxIterations}`)
	console.log(`Initial incomplete stories: ${countIncompleteStories(prd)}`)

	for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
		prd = readJson(prdPath)
		const nextStory = getNextStory(prd)

		if (!nextStory) {
			console.log("All stories are complete.")
			return
		}

		const before = {
			prdHash: fileHash(prdPath),
			progressHash: fileHash(progressPath),
			gitStatus: gitStatusShort(),
		}

		const progressText = fs.readFileSync(progressPath, "utf8")
		const prompt = buildPrompt({
			iteration,
			outcome: options.outcome,
			story: nextStory,
			progressText,
			gitStatus: before.gitStatus,
		})

		console.log(`\n[Iteration ${iteration}] Running story ${nextStory.id}: ${nextStory.title}`)
		const result = runWorker({ prompt, iteration, worker: options.worker })

		const afterPrd = readJson(prdPath)
		const afterStory = afterPrd.userStories.find((story) => story.id === nextStory.id)
		const after = {
			prdHash: fileHash(prdPath),
			progressHash: fileHash(progressPath),
			gitStatus: gitStatusShort(),
		}

		const changed =
			before.prdHash !== after.prdHash ||
			before.progressHash !== after.progressHash ||
			before.gitStatus !== after.gitStatus

		console.log(`Worker exit code: ${result.status ?? "null"}`)
		if (result.error) {
			console.log(`Worker spawn error: ${result.error.message}`)
		}
		console.log(`Story passed: ${afterStory?.passes === true ? "yes" : "no"}`)
		console.log(`State changed: ${changed ? "yes" : "no"}`)
		console.log(`Logs: ${path.relative(repoRoot, result.stdoutPath)}, ${path.relative(repoRoot, result.stderrPath)}`)

		if (afterStory?.passes) {
			continue
		}

		if (!changed) {
			console.error("No visible progress was made in this iteration. Stopping to avoid a blind loop.")
			process.exitCode = 1
			return
		}
	}

	const remaining = countIncompleteStories(readJson(prdPath))
	if (remaining > 0) {
		console.error(`Reached max iterations with ${remaining} incomplete stor${remaining === 1 ? "y" : "ies"} remaining.`)
		process.exitCode = 1
	}
}

main()
