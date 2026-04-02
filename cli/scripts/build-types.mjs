import { execSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync } from "node:fs"

try {
	execSync("npx tsc -p tsconfig.lib.json", { stdio: "inherit" })
} catch {
	// Preserve existing behavior: continue even if declaration emit reports non-fatal issues.
}

cpSync("dist/types/cli/src/exports.d.ts", "dist/lib.d.ts")

mkdirSync("dist/agent", { recursive: true })

for (const file of ["ClineAgent.d.ts", "ClineSessionEmitter.d.ts", "public-types.d.ts"]) {
	cpSync(`dist/types/cli/src/agent/${file}`, `dist/agent/${file}`)
}

rmSync("dist/types", { recursive: true, force: true })
