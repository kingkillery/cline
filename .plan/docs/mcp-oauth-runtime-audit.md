# MCP OAuth Runtime Audit

Date: 2026-05-05
Scope: `src/cline-sdk/cline-mcp-runtime-service.ts` OAuth/runtime lifecycle robustness.

## Summary

The current MCP OAuth flow is close to functional and uses high-entropy request IDs plus atomic settings writes, but it has several lifecycle/security hardening gaps before it should be considered robust under concurrent authorization attempts, replay, corrupted settings, or failed transport startup.

Highest-priority follow-ups:

1. Bind and validate the OAuth `state` value instead of accepting any callback that has a valid Kanban `requestId`.
2. Serialize or supersede concurrent `authorizeServer()` calls for the same MCP server name; the persisted per-server `codeVerifier`, `redirectUrl`, `clientInformation`, and discovery state are currently shared across overlapping flows.
3. Add parse/mid-write recovery behavior for `cline_mcp_oauth_settings.json` instead of letting one corrupt OAuth settings file break auth status reads and MCP tool loading.
4. Close auth-capable transports directly when OAuth fails before a `Client` owns the retry transport.

## Findings

### 1. Callback request IDs are high entropy and replay-limited, but not bound to OAuth `state`

Relevant code:

- `startOauthCallbackListener()` creates a `randomUUID()` request ID and stores the callback resolver in module-global `pendingOauthCallbacksByRequestId`.
- `buildMcpOauthCallbackUrl()` embeds that ID in the redirect URI as `?requestId=...`.
- `handleClineMcpOauthCallback()` consumes the pending request ID once, clears its timeout, and stores the final HTML response in `completedOauthCallbacksByRequestId` for 5 minutes so browser reloads are idempotent.

Assessment:

- This is good for accidental reloads and stale callback URLs: first use resolves/rejects the pending promise, replay during the 5-minute completed-retention window receives the same response, and later replay returns 410.
- The callback handler does not read or validate the OAuth `state` query parameter. The SDK generates `state` through `provider.state()` and places it on the authorization URL, but Kanban neither persists the expected value nor checks the callback value before calling `finishAuth(code)`.
- Because possession of the request ID is the only callback admission check, the flow relies on the unguessability and secrecy of the redirect URI request ID rather than the standard OAuth state binding.

Follow-up:

- Persist an `expectedState` per callback listener or per interactive server flow, return it from `provider.state()`, and require `requestUrl.searchParams.get("state") === expectedState` before resolving the authorization code.
- Add focused tests for missing, wrong, and correct `state`, including double-load behavior for a state-mismatch failure.

### 2. Module-global callback maps are process-scoped, not server-scoped; request IDs avoid cross-server collision but not same-server persistence races

Relevant code:

- `pendingOauthCallbacksByRequestId` and `completedOauthCallbacksByRequestId` are module-level maps shared by every runtime service instance in the Node process.
- Keys are UUID request IDs, so independent server instances should not collide by ordinary chance.
- `createOauthProviderContext()` persists OAuth state by `serverName` only in `cline_mcp_oauth_settings.json`.

Assessment:

- Cross-server callback routing is isolated by request ID, not by server name. That is acceptable for random UUID collisions, but the callback maps do not encode the intended server name, generation, or expected OAuth state for auditability.
- Overlapping `authorizeServer()` calls for the same `serverName` are unsafe. Each call runs `resetInteractiveState()`, writes a different `redirectUrl`, and later writes `codeVerifier`/discovery/client data to the same per-server persisted state. The first browser callback may exchange a code using the second flow's verifier or redirect URL, or a later failed flow may overwrite `lastError` for a successful flow.
- The settings update helpers use atomic writes with file locks, but `updateOauthServerState()` reads before acquiring the write lock through `writeOauthSettings()`. Two concurrent updates can therefore read the same old settings and lose each other's field changes.

Follow-up:

- Add a per-server in-flight guard: either reject a second `authorizeServer(serverName)` while one is pending, or supersede the old flow by closing its callback listener and marking its generation cancelled.
- Move OAuth settings read-modify-write inside a single `lockedFileSystem.withLock()` operation, or introduce a locked `updateJsonFileAtomic` helper.
- Include `{serverName, generation, expectedState}` in pending callback records and validate them before resolving.

### 3. SDK performs refresh before interactive reauthorization, but Kanban status is access-token-only and stale refresh failures surface late

Relevant code:

- The MCP SDK `auth()` path tries `refreshAuthorization()` when `provider.tokens()` returns a `refresh_token`; invalid grants invalidate tokens and retry into a new authorization redirect.
- Kanban's `createOauthClientMetadata()` advertises `grant_types: ["authorization_code", "refresh_token"]`.
- `getAuthStatuses()` reports `oauthConfigured` using only `hasAccessToken(authState?.tokens)`.

Assessment:

- Refresh is primarily SDK-owned, not separately implemented by Kanban. On 401 during connection/send, the SDK can refresh stored refresh tokens and call Kanban's `saveTokens()`.
- If the refresh token is expired or revoked, SDK invalidates tokens and starts a fresh authorization flow. In non-interactive tool loading, this becomes an UnauthorizedError with an authorization URL and Kanban records a reauthorization message in `lastError`.
- `oauthConfigured` can be misleading because it only checks for a non-empty `access_token`; it does not consider token expiry, refresh-token presence, or a known `lastError` that requires user action.

Follow-up:

- Split auth status into clearer fields such as `hasAccessToken`, `hasRefreshToken`, `requiresReauthorization`, and optional `expiresAt` when available.
- Add tests that simulate invalid-grant refresh behavior and assert tokens are cleared and status indicates reauthorization instead of simply configured/unconfigured.

### 4. Corrupt OAuth settings file is a single point of failure; atomic writes help mid-write safety but there is no recovery path

Relevant code:

- `parseOauthSettings()` throws on malformed JSON or schema errors.
- `collectAuthStatuses()`, `createAuthProviderContext()`, and runtime MCP client connection paths call `parseOauthSettings()` without local recovery.
- `writeOauthSettings()` uses `lockedFileSystem.writeJsonFileAtomic()` with a file lock and temp-file rename.

Assessment:

- Atomic temp-file + rename lowers the chance of mid-write corruption from Kanban writes.
- If the file is externally edited, truncated, or manually corrupted, auth status reads and MCP tool loading can fail hard instead of returning a degraded status with a repair path.
- Because `parseOauthSettings()` uses synchronous reads outside the lock, it can also observe an externally written partial file.

Follow-up:

- Add safe parsing with backup/quarantine behavior, for example rename the unreadable file to `cline_mcp_oauth_settings.json.corrupt.<timestamp>` and continue with `{servers:{}}` while surfacing a warning/status error.
- Consider acquiring the same file lock during reads, at least in update/read-modify-write paths.
- Add a focused test for malformed OAuth settings JSON and schema-invalid settings.

### 5. Transport cleanup is partial when OAuth fails during connection

Relevant code:

- `authorizeServer()` creates `transport`, then `client.connect(transport)`; finally it closes `client`, optional `retryClient`, and the callback listener.
- After `finishAuth()`, it creates `retryTransport` and then `retryClient.connect(retryTransport)`.
- There is no local variable cleanup for `transport.close()` or `retryTransport.close()` if failure occurs before the corresponding `Client` owns/fully closes the transport.

Assessment:

- Closing `client` and `retryClient` probably closes transports after successful `connect()`, but failures before or during `connect()` may leave auth-capable transport resources open until process cleanup.
- SSE transports can create `EventSource`/abort-controller state during auth/connection attempts; streamable HTTP transports can create abort controllers and reconnection timers. Explicit direct transport close is safer in failure paths.

Follow-up:

- Track both auth transports in local variables and call `await transport.close().catch(() => undefined)` in `finally` before/after client close as appropriate, or wrap connect attempts in a helper that guarantees direct transport cleanup if `client.connect()` fails.
- Add focused transport mock tests that make `connect()` fail after transport start and assert cleanup is called.

## Concrete follow-up task list

- `security`: Add OAuth state persistence/validation for MCP callback handling.
- `lifecycle`: Add same-server OAuth in-flight guard or generation supersession.
- `persistence`: Make OAuth settings read-modify-write lock-covered and add corrupt-file quarantine/degraded status behavior.
- `status`: Refine MCP auth status fields so expired/revoked refresh-token cases do not look simply configured.
- `cleanup`: Ensure auth transports are closed on all failed authorize/connect paths.
- `tests`: Expand `test/runtime/cline-sdk/cline-mcp-runtime-service.test.ts` for state mismatch, concurrent same-server auth, corrupt settings, and transport cleanup.

## Validation

No code or tests were changed in this audit pass. Focused tests were not run because the task requested audit/plan output only.
