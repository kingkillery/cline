import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_STATE = {
	version: 1,
	cleanupOwner: "kanban-run-coordinator",
	lastReconciliationAt: null,
	lastReconciliationSummary: null,
	runs: {},
}

const HUMAN_REVIEW_READY_STATUS = "human_review_ready"

function toIso(timestamp = Date.now()) {
	return new Date(timestamp).toISOString()
}

function fromIso(value) {
	if (!value) {
		return null
	}

	const timestamp = Date.parse(value)
	return Number.isNaN(timestamp) ? null : timestamp
}

function dedupePids(childPids = []) {
	return [...new Set(childPids.filter((pid) => Number.isInteger(pid) && pid > 0))]
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function killOwnedPid(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return {
			pid,
			status: "invalid",
		}
	}

	if (!isProcessAlive(pid)) {
		return {
			pid,
			status: "missing",
		}
	}

	try {
		process.kill(pid)
		return {
			pid,
			status: "terminated",
		}
	} catch (error) {
		return {
			pid,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		}
	}
}

export class KanbanRunCoordinator {
	constructor({ statePath, leaseMs = 60_000, retryDelayMs = 5_000, workspacePath, cleanupOwner = "kanban-run-coordinator" }) {
		this.statePath = statePath
		this.leaseMs = leaseMs
		this.retryDelayMs = retryDelayMs
		this.workspacePath = workspacePath
		this.cleanupOwner = cleanupOwner

		fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
		this.state = this.#load()
		this.state.cleanupOwner = this.cleanupOwner
		this.#flush()
	}

	#load() {
		if (!fs.existsSync(this.statePath)) {
			return structuredClone(DEFAULT_STATE)
		}

		try {
			const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"))
			return {
				...structuredClone(DEFAULT_STATE),
				...parsed,
				runs: parsed?.runs ?? {},
			}
		} catch {
			return structuredClone(DEFAULT_STATE)
		}
	}

	#flush() {
		const tmpPath = `${this.statePath}.tmp`
		fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2) + "\n")
		fs.renameSync(tmpPath, this.statePath)
	}

	#sortedRuns() {
		return Object.values(this.state.runs).sort((left, right) => {
			const leftUpdatedAt = fromIso(left.updatedAt) ?? 0
			const rightUpdatedAt = fromIso(right.updatedAt) ?? 0
			if (leftUpdatedAt !== rightUpdatedAt) {
				return rightUpdatedAt - leftUpdatedAt
			}
			return (right.attempt ?? 0) - (left.attempt ?? 0)
		})
	}

	getLatestRunForCard(cardId) {
		return this.#sortedRuns().find((run) => run.cardId === cardId) ?? null
	}

	reconcileStartup(now = Date.now()) {
		const summary = {
			requeued: [],
			expired: [],
			cleaned: [],
		}

		for (const run of this.#sortedRuns()) {
			if (run.status !== "running") {
				continue
			}

			const leaseExpiresAt = fromIso(run.leaseExpiresAt)
			if (leaseExpiresAt !== null && leaseExpiresAt > now) {
				continue
			}

			const cleanup = dedupePids(run.childPids).map((pid) => killOwnedPid(pid))
			const reconciliationAt = toIso(now)
			run.status = "retry_due"
			run.heartbeatAt = reconciliationAt
			run.leaseExpiresAt = reconciliationAt
			run.retryDueAt = reconciliationAt
			run.lastError = run.lastError || "Coordinator reconciled a stale run after its lease expired."
			run.updatedAt = reconciliationAt
			run.cleanupOwner = this.cleanupOwner
			run.proofBundle = {
				...(run.proofBundle ?? {}),
				reconciliation: {
					at: reconciliationAt,
					reason: "stale-lease",
					cleanup,
				},
			}

			summary.requeued.push(run.runId)
			summary.expired.push(run.runId)
			summary.cleaned.push(...cleanup)
		}

		this.state.lastReconciliationAt = toIso(now)
		this.state.lastReconciliationSummary = summary
		this.#flush()
		return summary
	}

	canStartStory(cardId, now = Date.now()) {
		const latestRun = this.getLatestRunForCard(cardId)
		if (!latestRun) {
			return {
				allowed: true,
				reason: "new-story",
				waitMs: 0,
			}
		}

		if (latestRun.status === "running") {
			const leaseExpiresAt = fromIso(latestRun.leaseExpiresAt)
			if (leaseExpiresAt !== null && leaseExpiresAt > now) {
				return {
					allowed: false,
					reason: "active-lease",
					waitMs: leaseExpiresAt - now,
				}
			}
		}

		if (latestRun.status === "retry_due") {
			const retryDueAt = fromIso(latestRun.retryDueAt)
			if (retryDueAt !== null && retryDueAt > now) {
				return {
					allowed: false,
					reason: "retry-backoff",
					waitMs: retryDueAt - now,
				}
			}
		}

		return {
			allowed: true,
			reason: latestRun.status === "retry_due" ? "retry-ready" : "available",
			waitMs: 0,
		}
	}

	getNextRetryDelay(cardIds, now = Date.now()) {
		const waits = cardIds
			.map((cardId) => this.canStartStory(cardId, now))
			.filter((result) => !result.allowed && result.waitMs > 0)
			.map((result) => result.waitMs)

		if (waits.length === 0) {
			return null
		}

		return Math.min(...waits)
	}

	createRun({ cardId, sessionId, workspacePath, metadata = {} }) {
		const previousRun = this.getLatestRunForCard(cardId)
		const attempt = (previousRun?.attempt ?? 0) + 1
		const now = Date.now()
		const runId = `${cardId}-${crypto.randomUUID()}`
		const run = {
			runId,
			cardId,
			sessionId,
			workspacePath,
			status: "running",
			attempt,
			leaseExpiresAt: toIso(now + this.leaseMs),
			heartbeatAt: toIso(now),
			retryDueAt: null,
			childPids: [],
			lastError: null,
			proofBundle: null,
			cleanupOwner: this.cleanupOwner,
			createdAt: toIso(now),
			updatedAt: toIso(now),
			metadata,
		}

		this.state.runs[runId] = run
		this.#flush()
		return run
	}

	heartbeat(runId, childPids = []) {
		const run = this.state.runs[runId]
		if (!run) {
			return null
		}

		const now = Date.now()
		run.heartbeatAt = toIso(now)
		run.leaseExpiresAt = toIso(now + this.leaseMs)
		run.childPids = dedupePids([...run.childPids, ...childPids])
		run.updatedAt = toIso(now)
		run.cleanupOwner = this.cleanupOwner
		this.#flush()
		return run
	}

	finalizeRun(runId, { status, lastError = null, proofBundle = null, retryDelayMs = this.retryDelayMs, childPids = [] }) {
		const run = this.state.runs[runId]
		if (!run) {
			return null
		}

		const now = Date.now()
		run.status = status
		run.lastError = lastError
		run.proofBundle = proofBundle
		run.childPids = dedupePids([...run.childPids, ...childPids])
		run.heartbeatAt = toIso(now)
		run.leaseExpiresAt = toIso(now)
		run.retryDueAt = status === "retry_due" ? toIso(now + retryDelayMs) : null
		run.updatedAt = toIso(now)
		run.cleanupOwner = this.cleanupOwner
		this.#flush()
		return run
	}

	validateProofBundle(proofBundle) {
		const validationErrors = []
		const validationCommands = Array.isArray(proofBundle?.validationCommands) ? proofBundle.validationCommands : []
		if (validationCommands.length === 0) {
			validationErrors.push("validationCommands")
		}

		if (!proofBundle?.outcome) {
			validationErrors.push("outcome")
		}

		const changedFiles = proofBundle?.changedFiles
		if (!changedFiles || !Array.isArray(changedFiles.summary)) {
			validationErrors.push("changedFiles.summary")
		}

		const workspaceIdentity = proofBundle?.workspaceIdentity
		if (!workspaceIdentity?.worktreePath && !workspaceIdentity?.branch) {
			validationErrors.push("workspaceIdentity")
		}

		if (
			"uiArtifactPath" in (proofBundle ?? {}) &&
			proofBundle.uiArtifactPath !== null &&
			typeof proofBundle.uiArtifactPath !== "string"
		) {
			validationErrors.push("uiArtifactPath")
		}

		return {
			valid: validationErrors.length === 0,
			validationErrors,
		}
	}

	transitionToHumanReview(runId, proofBundle) {
		const run = this.state.runs[runId]
		if (!run) {
			return {
				allowed: false,
				reason: "missing-run",
				validationErrors: ["runId"],
			}
		}

		const validation = this.validateProofBundle(proofBundle)
		const now = Date.now()
		run.proofBundle = proofBundle
		run.updatedAt = toIso(now)
		run.heartbeatAt = toIso(now)
		run.leaseExpiresAt = toIso(now)
		run.cleanupOwner = this.cleanupOwner

		if (!validation.valid) {
			run.status = "retry_due"
			run.retryDueAt = toIso(now + this.retryDelayMs)
			run.lastError = `Human Review proof validation failed: ${validation.validationErrors.join(", ")}`
			this.#flush()
			return {
				allowed: false,
				reason: "invalid-proof-bundle",
				validationErrors: validation.validationErrors,
			}
		}

		run.status = HUMAN_REVIEW_READY_STATUS
		run.retryDueAt = null
		run.lastError = null
		this.#flush()
		return {
			allowed: true,
			reason: HUMAN_REVIEW_READY_STATUS,
			validationErrors: [],
		}
	}

	getStateSnapshot() {
		return structuredClone(this.state)
	}
}
