# Cline SDK Test Coverage Gap Audit

Date: 2026-05-05
Task: `t_94128933`
Scope: `src/cline-sdk/*` against focused coverage under `test/runtime/cline-sdk` plus Cline-related runtime API coverage in `test/runtime/trpc/runtime-api.test.ts`.

## Current coverage snapshot

Dedicated Cline SDK tests exist for:

- `cline-task-session-service.ts`
- `cline-session-runtime.ts`
- `cline-context-overflow-compaction.ts`
- `cline-event-adapter.ts`
- `cline-message-repository.ts`
- `cline-mcp-runtime-service.ts`

Cline-related tests also exist inside `test/runtime/trpc/runtime-api.test.ts` for native Cline routing, saved/env/OAuth credentials, remote-config access checks, OAuth login persistence, account profile happy path plus refresh retry, custom provider registration, and basic MCP settings load/save through the TRPC facade.

No dedicated service-level test files currently exist for:

- `src/cline-sdk/cline-provider-service.ts`
- `src/cline-sdk/cline-mcp-settings-service.ts`
- `src/cline-sdk/cline-runtime-setup.ts`
- `src/cline-sdk/cline-watcher-registry.ts`
- `src/cline-sdk/cline-mcp-runtime-service.ts` settings-integration edge cases beyond OAuth callback handling
- smaller pure helpers such as `cline-tool-call-display.ts`, `cline-session-state.ts`, `cline-slash-commands.ts`, and `cline-runtime-logger.ts`

## Highest-risk uncovered or under-covered paths

### 1. Provider launch resolution (`cline-provider-service.ts`)

Recommended file: `test/runtime/cline-sdk/cline-provider-service.test.ts`

Priority scenarios:

1. `resolveLaunchConfig` for managed `cline` provider with saved OAuth tokens:
   - refreshes credentials before launch when access/refresh tokens are present
   - strips/normalizes `workos:` only for the SDK refresh request
   - returns a launch `apiKey` with the expected provider-specific prefix behavior
   - persists refreshed auth only when auth values actually change
2. `resolveLaunchConfig` credential precedence:
   - OAuth resolution wins over visible `apiKey`
   - visible `apiKey` wins over env key when OAuth is absent
   - `CLINE_API_KEY` / `OCA_API_KEY` fallback works only for the matching managed provider
   - `openai-codex` produces a useful missing-credentials error because it has no env fallback keys
3. `resolveLaunchConfig` model/base/reasoning resolution:
   - selected model is preserved when present
   - provider catalog `defaultModelId` is used when no selected model exists
   - SDK default model is used for default `cline` provider when catalog lookup fails
   - non-default providers without selected/catalog defaults return `modelId: null`
   - `reasoning.effort: "none"` maps to `null`, while real efforts pass through
4. `resolveLaunchConfig` failure behavior:
   - empty provider id throws the Settings guidance error
   - invalid/failed refresh surfaces the re-run-OAuth error instead of silently falling back to stale tokens

Why this matters: every native Cline start and prompt send depends on this path. A regression here can either block all Cline tasks or launch with stale/wrong credentials.

### 2. OAuth refresh and retry/fallback behavior (`cline-provider-service.ts`)

Recommended file: `test/runtime/cline-sdk/cline-provider-service.test.ts` or a provider-service section extracted from `runtime-api.test.ts`.

Priority scenarios:

1. `getClineAccountProfile`:
   - direct fetch success does not refresh
   - first fetch 401/error refreshes once and retries with refreshed credentials
   - non-Cline providers return `{ profile: null }` without touching account APIs
   - missing access token returns `{ profile: null }` and does not refresh
   - failed refresh returns `{ profile: null, error }`
   - profile id falls back to stored `auth.accountId` when API response omits `id`
2. `getFeaturebaseToken`:
   - first failure refreshes once and retries
   - missing token / non-Cline provider errors are explicit
   - refreshed credentials are saved with `tokenSource: "oauth"`
3. `getClineKanbanAccess`:
   - malformed remote-config JSON fails open with an error message
   - non-enterprise orgs and disabled remote-config responses fail open
   - enterprise + `kanbanEnabled: false` blocks access

Why this matters: these paths intentionally mix fail-open product behavior with fail-closed credential behavior. Service-level tests would make that contract explicit without relying on the broader TRPC harness.

### 3. Provider catalog/model/settings behavior (`cline-provider-service.ts`)

Recommended file: `test/runtime/cline-sdk/cline-provider-service.test.ts`

Priority scenarios:

1. `getProviderCatalog`:
   - sorts `cline` first, then by display name
   - marks selected provider enabled
   - adds a synthetic selected provider when SDK catalog lookup omits it
   - falls back to `[]` when SDK catalog throws
2. `getProviderModels`:
   - maps `images` to `supportsVision` and `supportsAttachments`
   - maps `files` to `supportsAttachments`
   - maps SDK thinking support to `supportsReasoningEffort`
   - falls back to the configured model when model listing fails or is empty
3. `saveProviderSettings`:
   - trims and deletes empty model/apiKey/baseUrl fields
   - removes empty reasoning object after clearing effort
   - strips `auth` for non-managed providers
   - preserves `auth` for managed providers

Why this matters: catalog/model regressions break settings UI affordances and can produce launch configs that look valid but are not runnable.

### 4. MCP settings parser/saver (`cline-mcp-settings-service.ts`)

Recommended file: `test/runtime/cline-sdk/cline-mcp-settings-service.test.ts`

Priority scenarios:

1. `resolveMcpSettingsPath`:
   - uses `CLINE_MCP_SETTINGS_PATH` when set and resolves relative paths
   - falls back to the Cline default under `homedir()` when unset
2. `loadSettings` / parser:
   - missing file returns an empty server list
   - invalid JSON includes the file path and parse details in the error
   - schema errors include actionable zod paths
   - stdio servers preserve `command`, `args`, `cwd`, `env`, and `disabled`
   - URL servers infer `sse` by default, infer `streamableHttp` from `transportType: "http"`, and respect explicit `type`
   - output is sorted by server name
3. `saveSettings`:
   - trims names, commands, args, cwd, URLs, headers, and env records
   - drops empty optional records/arrays
   - omits `disabled` unless true
   - writes with `lockedFileSystem.writeJsonFileAtomic` using a file lock

Why this matters: malformed MCP settings can prevent Cline MCP startup, and save normalization is currently only lightly covered through the runtime API facade.

### 5. Runtime setup and watcher lifecycle (`cline-runtime-setup.ts` / `cline-watcher-registry.ts`)

Recommended files:

- `test/runtime/cline-sdk/cline-runtime-setup.test.ts`
- `test/runtime/cline-sdk/cline-watcher-registry.test.ts`

Priority scenarios:

1. `createClineRuntimeSetup`:
   - starts the SDK watcher for the provided workspace path
   - swallows watcher `start()` failures and still returns a setup object
   - `resolvePrompt` delegates to workflow slash-command resolver with the same watcher
   - `loadRules` delegates to SDK rule loader with the same watcher
   - `requestToolApproval` always approves and includes the tool name in the reason
   - `dispose` calls `watcher.stop()` and swallows stop failures
2. `createClineWatcherRegistry`:
   - reuses one setup per workspace path
   - reference-counts multiple acquires and disposes only after final release
   - `bumpContextVersion` increments the shared entry version
   - setup creation failure removes the pending entry so later acquire can retry

Why this matters: watcher setup is intentionally tolerant; tests should lock that down so future cleanup does not reintroduce task startup failures from watcher/rules side effects.

## Recommended implementation order

1. Add `test/runtime/cline-sdk/cline-provider-service.test.ts` with hoisted Vitest mocks for `sdk-provider-boundary.js` and `server/browser.js`.
2. Start with `resolveLaunchConfig` cases because they protect task startup and cover the shared refresh helper indirectly.
3. Add provider-service account/Featurebase retry tests next, using direct service calls rather than the broader TRPC API harness.
4. Add `cline-mcp-settings-service.test.ts` with temp-file based load/save cases and a mocked `lockedFileSystem.writeJsonFileAtomic` for write-contract assertions.
5. Add `cline-runtime-setup.test.ts` and `cline-watcher-registry.test.ts` after provider/MCP tests because they are smaller and lower risk.

## Suggested focused validation commands

```bash
npm test -- --run test/runtime/cline-sdk/cline-provider-service.test.ts
npm test -- --run test/runtime/cline-sdk/cline-mcp-settings-service.test.ts
npm test -- --run test/runtime/cline-sdk/cline-runtime-setup.test.ts test/runtime/cline-sdk/cline-watcher-registry.test.ts
npm run typecheck
```

## Notes for test authors

- Keep the new tests service-level where possible; `test/runtime/trpc/runtime-api.test.ts` is already large and covers integration routing.
- Use hoisted Vitest mocks for SDK boundary modules to avoid booting the real Cline SDK host.
- Preserve existing environment variables in `afterEach`; provider launch tests need to manipulate `CLINE_API_KEY` and `OCA_API_KEY`.
- Do not add broad full-suite validation for this audit task. The documented Node 22 hanging-test risks still apply to full backend/web suites.
