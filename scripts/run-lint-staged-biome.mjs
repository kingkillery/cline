import { spawnSync } from "node:child_process"
import path from "node:path"

const repoRoot = process.cwd()
const stagedFiles = process.argv
	.slice(2)
	.map((file) => {
		const normalizedFile = path.normalize(file)
		return path.isAbsolute(normalizedFile) ? path.relative(repoRoot, normalizedFile) : normalizedFile
	})
	.filter((file) => file.length > 0)

if (stagedFiles.length === 0) {
	process.exit(0)
}

const kanbanPrefix = `${path.normalize("packages/kanban")}${path.sep}`
const kanbanFiles = []
const rootFiles = []

for (const file of stagedFiles) {
	if (file.startsWith(kanbanPrefix)) {
		kanbanFiles.push(path.relative(path.normalize("packages/kanban"), file))
		continue
	}
	rootFiles.push(file)
}

function runCheckedCommand(command, args, cwd) {
	const result =
		process.platform === "win32"
			? spawnSync(buildWindowsCommandLine(command, args), {
					cwd,
					stdio: "inherit",
					shell: true,
				})
			: spawnSync(command, args, {
					cwd,
					stdio: "inherit",
				})
	if (typeof result.status === "number" && result.status !== 0) {
		process.exit(result.status)
	}
	if (result.error) {
		throw result.error
	}
}

function quoteWindowsShellArg(value) {
	return `"${String(value).replaceAll('"', '\\"')}"`
}

function buildWindowsCommandLine(command, args) {
	return [command, ...args].map(quoteWindowsShellArg).join(" ")
}

function resolveBiomeRunner() {
	return process.platform === "win32" ? ".\\node_modules\\.bin\\biome.cmd" : "./node_modules/.bin/biome"
}

if (rootFiles.length > 0) {
	runCheckedCommand(
		resolveBiomeRunner(),
		["check", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...rootFiles],
		repoRoot,
	)
}

if (kanbanFiles.length > 0) {
	const kanbanRoot = path.join(repoRoot, "packages/kanban")
	runCheckedCommand(
		resolveBiomeRunner(),
		["check", "--write", "--no-errors-on-unmatched", "--files-ignore-unknown=true", ...kanbanFiles],
		kanbanRoot,
	)
}
