#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")

function run(command, args, options = {}) {
	let resolvedCommand = command
	let resolvedArgs = args

	if (command === "npm") {
		const npmExecPath = process.env.npm_execpath
		if (!npmExecPath) {
			throw new Error("npm_execpath is not set; cannot invoke npm reliably from the unit test runner.")
		}
		resolvedCommand = process.execPath
		resolvedArgs = [npmExecPath, ...args]
	} else if (command === "node") {
		resolvedCommand = process.execPath
	}

	const result = spawnSync(resolvedCommand, resolvedArgs, {
		cwd: repoRoot,
		stdio: "inherit",
		shell: false,
		...options,
	})

	if (result.error) {
		throw result.error
	}

	if ((result.status ?? 0) !== 0) {
		process.exit(result.status ?? 1)
	}
}

function mapSpecArg(arg) {
	const normalized = arg.replace(/\\/g, "/")
	if (!normalized.startsWith("src/") || !normalized.endsWith(".ts")) {
		return arg
	}

	return path.join("out", normalized).replace(/\.ts$/, ".js")
}

const passthroughArgs = process.argv.slice(2)
const optionsWithValues = new Set([
	"--grep",
	"-g",
	"--fgrep",
	"-f",
	"--file",
	"--reporter",
	"-R",
	"--ui",
	"-u",
	"--timeout",
	"-t",
	"--slow",
	"-s",
	"--retries",
	"--extension",
	"--require",
	"-r",
	"--spec",
	"--watch-files",
	"--watch-ignore",
])

let hasExplicitSpec = false
let previousOptionTakesValue = false
const mappedArgs = passthroughArgs.map((arg) => {
	if (previousOptionTakesValue) {
		previousOptionTakesValue = false
		return arg
	}

	if (optionsWithValues.has(arg)) {
		previousOptionTakesValue = true
		return arg
	}

	if (arg.startsWith("-")) {
		return arg
	}

	hasExplicitSpec = true
	return mapSpecArg(arg)
})

run("npm", ["run", "compile-tests"])

const mochaArgs = [
	"--no-config",
	"--require",
	"ts-node/register",
	"--require",
	"tsconfig-paths/register",
	"--require",
	"./src/test/requires.ts",
	"--extension",
	"js",
	"--exit",
]

if (hasExplicitSpec) {
	mochaArgs.push(...mappedArgs)
} else {
	mochaArgs.push("out/src/**/*.test.js", "out/src/**/__tests__/**/*.js", ...mappedArgs)
}

run("node", ["./node_modules/mocha/bin/_mocha", ...mochaArgs], {
	env: {
		...process.env,
		TS_NODE_PROJECT: process.env.TS_NODE_PROJECT || "./tsconfig.unit-test.json",
	},
})
