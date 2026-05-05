# Hermes Kanban Adoption Plan — Cline Kanban as Ultimate Orchestrator

Status: IN PROGRESS | Phase: 1/5 | Updated: 2026-05-05

## Goal

Adopt proven architectural patterns from [Hermes Agent Kanban](https://github.com/NousResearch/hermes-agent) 
(Nous Research, MIT-licensed) to make Cline Kanban the definitive multi-agent orchestrator that works 
seamlessly with Codex (OpenAI), Claude (Anthropic), and Copilot (GitHub).

## What Hermes Kanban Gets Right

| Pattern | Hermes Implementation | Status in Cline Kanban |
|---------|----------------------|------------------------|
| SQLite WAL + CAS claims | `kanban_db.py` — atomic claim_txn with `BEGIN IMMEDIATE` | ❌ No claim system — relies on workspace state locking |
| Claim TTL + heartbeat | 15min TTL, `heartbeat_claim()` renewal | ❌ No TTL — can't detect crashed workers |
| Per-board isolation | Separate DB/workspaces/logs per board slug | ❌ No multi-board concept |
| Worker context caps | `_CTX_MAX_*` constants bound prior attempts/comments | ❌ No bounds — unbounded message replay |
| Structured handoff | `summary` + `metadata` on `kanban_complete()` | ❌ Only hook-based state tracking |
| Multi-provider credential pools | `hermes auth add/list/reset` per provider | ⚠️ Only Cline SDK provider settings |
| Dispatcher in gateway | 60s tick, reclaim-stale, dependency promotion | ❌ No dispatcher — state-driven via hooks |

## Target Agent Matrix

| Agent | Binary | CLI Tool | Provider for Cline SDK | Status |
|-------|--------|----------|----------------------|--------|
| **Cline** | `cline` | Native Cline CLI | Built-in SDK host | ✅ Works |
| **Codex** | `codex` | OpenAI Codex CLI | `openai-codex` OAuth | ✅ Works |
| **Claude** | `claude` | Anthropic Claude Code CLI | `anthropic` API key | ✅ Works |
| **Copilot** | `copilot` (npx?) | GitHub Copilot CLI | `copilot` GH token | ❌ NOT ADDED |
| Droid | `droid` | Factory Droid CLI | N/A | ✅ Works |
| OpenCode | `opencode` | OpenCode CLI | N/A | ⚠️ Disabled |
| Gemini | `gemini` | Google Gemini CLI | N/A | ⚠️ Disabled |

## Phase 1: Copilot as First-Class Agent

### 1a. Agent catalog entry (`src/core/agent-catalog.ts`)

Add copilot to `RUNTIME_AGENT_CATALOG` and `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`.

```typescript
{
  id: "copilot",
  label: "GitHub Copilot",
  binary: "npx",  // or direct copilot binary
  baseArgs: ["@github/copilot-cli"],
  autonomousArgs: ["--auto-approve"],
  installUrl: "https://docs.github.com/en/copilot",
}
```

### 1b. Contract update (`src/core/api-contract.ts`)

Add `"copilot"` to `runtimeAgentIdSchema`.

### 1c. Agent session adapter (`src/terminal/agent-session-adapters.ts`)

Create `prepareCopilotLaunch` following the same pattern as codex/droid:
- Hook events: `to_in_progress` on tool execution, `to_review` on AskUser/Stop
- Command discovery: detect `copilot` or `npx @github/copilot-cli`

### 1d. Provider boundary (`src/cline-sdk/sdk-provider-boundary.ts`)

Add copilot provider support:
- Managed OAuth: `loginGitHubCopilot`, `getValidCopilotCredentials`
- Provider ID: `"copilot"` in `ManagedClineOauthProviderId`

## Phase 2: Unified Provider Abstraction Layer

### 2a. Provider catalog

Create `src/providers/provider-catalog.ts`:

```typescript
export interface ProviderConfig {
  id: string;
  name: string;
  agentIds: RuntimeAgentId[];
  authType: 'oauth' | 'api_key' | 'gh_token';
  envKeys: string[];
  defaultModelId: string;
  testCommand: string;
}

export const PROVIDER_CATALOG: ProviderConfig[] = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    agentIds: ["codex"],
    authType: "oauth",
    envKeys: [],
    defaultModelId: "gpt-5.5",
    testCommand: "hermes -p kanbancline chat -q OK --provider openai-codex -m gpt-5.5 -Q",
  },
  {
    id: "anthropic", 
    name: "Anthropic (Claude)",
    agentIds: ["claude"],
    authType: "api_key",
    envKeys: ["ANTHROPIC_API_KEY"],
    defaultModelId: "claude-sonnet-4",
    testCommand: "hermes -p kanbancline chat -q OK --provider openrouter -m anthropic/claude-sonnet-4 -Q",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    agentIds: ["copilot"],
    authType: "gh_token",
    envKeys: ["COPILOT_GITHUB_TOKEN"],
    defaultModelId: "copilot-default",
    testCommand: "hermes -p kanbancline auth list | grep copilot",
  },
];
```

### 2b. Provider health check

Add `src/providers/provider-health.ts`:
- Test each provider with a minimal completion
- Per-provider status: healthy / warning / exhausted
- Expose via `runtimeConfigResponse` so dashboard can show health

## Phase 3: Hermes-Style Task Dispatcher

### 3a. New file: `src/core/task-dispatcher.ts`

```typescript
const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface TaskClaim {
  taskId: string;
  assignee: string;
  lockId: string; // unique per claim attempt
  claimedAt: number;
  expiresAt: number;
  pid: number;
}

export class TaskDispatcher {
  // CAS claim: atomic compare-and-swap
  claimTask(taskId: string, assignee: string): TaskClaim | null;
  
  // Heartbeat: extend claim TTL
  heartbeat(taskId: string, lockId: string): boolean;
  
  // Reclaim stale: detect dead workers
  reclaimStale(): string[]; // returns taskIds that were reclaimed
  
  // Dependency promotion: move children to ready when parents complete
  promoteReady(tasks: RuntimeBoardData): RuntimeBoardData;
  
  // Tick: one full dispatcher pass
  async tick(): Promise<DispatcherTickResult>;
}
```

### 3b. Wire into runtime server

Modify `src/server/runtime-server.ts`:
- Start dispatcher loop on server startup
- Configurable tick interval (default 60s, matching Hermes)
- Watch for task state changes and claim ready tasks

### 3c. Worker heartbeat

Modify Cline session runtime to call heartbeat periodically:
- `src/cline-sdk/cline-session-runtime.ts`: add heartbeat interval
- `src/cline-sdk/cline-task-session-service.ts`: wire heartbeat to dispatcher

## Phase 4: Structured Handoff Metadata

### 4a. Extend task completion schema

Update `src/core/api-contract.ts` — add to `runtimeTaskSessionSummarySchema`:

```typescript
handoff: z.object({
  changedFiles: z.array(z.string()).optional(),
  testsRun: z.number().optional(),
  testsPassed: z.number().optional(),
  decisions: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
}).nullable().optional(),
```

### 4b. Extract metadata from Cline sessions

Modify `src/cline-sdk/cline-event-adapter.ts`:
- Parse tool call results for changed files
- Extract error/failure information
- Build structured handoff object

### 4c. Inject upstream metadata into worker context

Modify `src/cline-sdk/cline-task-session-service.ts`:
- When starting a task that depends on other tasks, read parent handoff metadata
- Inject into system prompt so workers know what upstream tasks did

## Phase 5: Worker Context Bounds

### 5a. Add bounds configuration

Modify `src/cline-sdk/cline-task-session-service.ts`:

```typescript
const CTX_MAX_PRIOR_ATTEMPTS = 10;
const CTX_MAX_COMMENTS = 30;
const CTX_MAX_SUMMARY_BYTES = 4096;
const CTX_MAX_BODY_BYTES = 8192;
```

### 5b. Implement truncation

- Prior run summaries truncated to `CTX_MAX_SUMMARY_BYTES`
- Comment threads capped at `CTX_MAX_COMMENTS` most recent
- Only `CTX_MAX_PRIOR_ATTEMPTS` prior runs shown in full

## Implementation Order

1. **Phase 1** (Copilot agent) — smallest change, highest visibility
2. **Phase 4** (Handoff metadata) — enables all downstream improvements
3. **Phase 3** (Dispatcher) — core architectual change, highest impact
4. **Phase 5** (Context bounds) — safety improvement
5. **Phase 2** (Provider catalog) — ties everything together with health monitoring

## Success Criteria

- [ ] `hermes -p kanbancline chat -q OK --provider openai-codex -m gpt-5.5 -Q` returns OK
- [ ] `hermes -p kanbancline chat -q OK --provider copilot -m copilot-default -Q` returns OK
- [ ] Cline Kanban can dispatch parallel tasks to Codex, Claude, and Copilot agents simultaneously
- [ ] Crashed worker tasks are reclaimed within 2 dispatcher ticks
- [ ] Provider health visible in dashboard (green/yellow/red per provider)
- [ ] Structured handoff metadata flows to dependent tasks
- [ ] Worker context stays bounded under 50K tokens even for deep chains
