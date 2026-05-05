# Cline SDK upgrade-surface audit

Date: 2026-05-05
Task: `t_676ff1ce`; related board task: `t_a3f474ad`.

## Recommendation

Pin the four Cline SDK packages to exact `0.0.24` now and wait on an upgrade until Kanban has a deliberate migration task for the newer runtime-host/compaction APIs. Do not keep `^0.0.24` for `@clinebot/core`, `@clinebot/agents`, `@clinebot/llms`, or `@clinebot/shared`: current lockfile state is safe, but a fresh lockfile resolution can select `0.0.37`, whose export map and host-facing session surface are incompatible with the code in this repo.

No dependency upgrade was performed for this audit.

## Current installed state

`npm ls @clinebot/core @clinebot/agents @clinebot/llms @clinebot/shared @factory/cli --depth=1` reports:

- `@clinebot/core@0.0.24`
- `@clinebot/agents@0.0.24`
- `@clinebot/llms@0.0.24`
- `@clinebot/shared@0.0.24`
- `@factory/cli@0.93.0`

`package.json` currently asks for `^0.0.24` for all four `@clinebot/*` packages. `package-lock.json` currently resolves and installs `0.0.24`, so the working tree's installed SDK is still the intended version.

## Current host-facing SDK surface Kanban uses

Kanban's active SDK boundary is concentrated in `src/cline-sdk/`:

- `src/cline-sdk/sdk-runtime-boundary.ts` imports from `@clinebot/core` and `@clinebot/shared/storage`.
- `src/cline-sdk/sdk-provider-boundary.ts` imports provider/auth/model helpers from `@clinebot/core/node`.
- `vitest.config.ts` aliases `@clinebot/agents` to `@clinebot/agents/node` and `@clinebot/llms` to `@clinebot/llms/node` for tests.

The installed `@clinebot/core@0.0.24` session host shape matches what Kanban currently wraps:

- `start(input)` / `send(input)`
- `abort(sessionId, reason?)` / `stop(sessionId)` / `dispose(reason?)`
- `get(sessionId)` / `list(limit?)` / `delete(sessionId)`
- `readMessages(sessionId)` / `readTranscript(sessionId, maxChars?)` / `readHooks(sessionId, limit?)`
- `subscribe(listener)`
- optional `updateSessionModel(sessionId, modelId)`

No host-facing built-in compaction configuration exists in `0.0.24`'s `CoreSessionConfig`; Kanban's current context-overflow handling remains a local fallback, not an SDK compaction hook.

## Newer package availability

`npm view` reports latest `0.0.37` for all four `@clinebot/*` packages, with recent nightlies also present. `@factory/cli` latest is `0.118.0`, while this repo has `@factory/cli@0.93.0` installed. `@factory/cli` is a separate direct dependency here; the inspected `@clinebot/*@0.0.24` and `0.0.37` package manifests do not show it as a dependency of the Cline SDK packages.

## Why `0.0.37` is not a safe implicit upgrade

An `npm pack` inspection of `@clinebot/*@0.0.37` shows multiple breaking surfaces relative to current Kanban code:

1. Export-map removals that would break current imports/tests:
   - `@clinebot/core@0.0.37` no longer exports `./node`.
   - `@clinebot/agents@0.0.37` no longer exports `./node` or `./browser`.
   - `@clinebot/llms@0.0.37` no longer exports `./node`, `./models`, `./providers`, `./providers/browser`, or `./runtime`.
   - Current Kanban code and test config still reference these removed subpaths.

2. Session host API changed from the older `SessionManager` export to a renamed `RuntimeHost` / `createRuntimeHost` surface. The compatibility alias `createSessionHost` still exists at the root export in `0.0.37`, but the input shape has moved:
   - `StartSessionInput.config` is now `RuntimeSessionConfig`.
   - host-local settings like hooks, logger, telemetry, extra tools, extensions, user-instruction watcher, and default executors are split into `localRuntime` / `configOverrides`.
   - new host methods include `pendingPrompts(...)`, `update(...)`, and `handleHookEvent(...)`.

3. Built-in compaction/checkpoint configuration is new in `0.0.37`:
   - `CoreSessionConfig.compaction?: CoreCompactionConfig`
   - `CoreCompactionConfig` supports `enabled`, `strategy: "basic" | "agentic"`, threshold/reserve/preserve token knobs, optional summarizer config, and a custom `compact(context)` callback.
   - `createContextCompactionPrepareTurn(...)` is exported from `@clinebot/core`.

This is promising for replacing parts of Kanban's local context-overflow fallback, but it is not a drop-in upgrade because the runtime host contract moved at the same time.

## Version policy

Use exact pins for the Cline SDK package family until the boundary is migrated and covered by type/tests against the target package version:

```json
"@clinebot/agents": "0.0.24",
"@clinebot/core": "0.0.24",
"@clinebot/llms": "0.0.24",
"@clinebot/shared": "0.0.24"
```

Reason: these packages are still `0.0.x`; npm caret ranges permit all later `0.0.*` patch versions for `^0.0.24`, and the observed `0.0.37` package has incompatible export and runtime-host changes. Exact pins avoid silent breakage if the lockfile is regenerated or dependency dedupe changes.

## Suggested follow-up migration scope

When upgrading intentionally, plan a dedicated SDK migration that:

1. Removes or rewrites imports of `@clinebot/core/node`, `@clinebot/agents/node`, and `@clinebot/llms/node`.
2. Reworks `sdk-runtime-boundary.ts` around `RuntimeHost` / `splitCoreSessionConfig` and the `localRuntime` split.
3. Evaluates whether SDK `CoreSessionConfig.compaction` can replace or simplify `src/cline-sdk/cline-context-overflow-compaction.ts`.
4. Adds an SDK-version smoke/typecheck that fails if required root exports or host methods disappear.
5. Only then updates package versions and lockfiles.

A concise board recommendation: pin exact `0.0.24` now, wait on the upgrade, and open an upstream issue only if the missing `./node` compatibility exports are expected to be maintained by Cline rather than migrated by Kanban.
