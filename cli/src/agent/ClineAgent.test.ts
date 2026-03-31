import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { openAiCodexDefaultModelId, openAiCodexModels } from "@/shared/api"
import { ClineAgent } from "./ClineAgent"

describe("ClineAgent session model state", () => {
	let clineDir: string

	beforeEach(async () => {
		clineDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-agent-test-"))
	})

	afterEach(async () => {
		const stateManager = (StateManager as any).instance
		if (stateManager) {
			stateManager.dispose()
			;(StateManager as any).instance = null
		}

		if (clineDir) {
			await fs.rm(clineDir, { recursive: true, force: true })
		}
	})

	it("includes OpenAI Codex models for ACP clients when the provider is selected", async () => {
		const agent = new ClineAgent({ clineDir })
		const storageContext = (agent as any).ctx.storageContext
		const stateManager = await StateManager.initialize(storageContext)

		stateManager.setGlobalState("actModeApiProvider", "openai-codex")
		stateManager.setGlobalState("planModeApiProvider", "openai-codex")
		stateManager.setGlobalState("actModeApiModelId", openAiCodexDefaultModelId)
		stateManager.setGlobalState("planModeApiModelId", openAiCodexDefaultModelId)

		const modelState = await (agent as any).getSessionModelState("act")

		expect(modelState.currentModelId).toBe(`openai-codex/${openAiCodexDefaultModelId}`)
		expect(modelState.availableModels).toHaveLength(Object.keys(openAiCodexModels).length)
		expect(modelState.availableModels).toContainEqual({
			modelId: `openai-codex/${openAiCodexDefaultModelId}`,
			name: openAiCodexDefaultModelId,
		})
	})
})
