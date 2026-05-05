# Cline session rebind/recovery edge-case audit

Task: `t_5438b3ae`

Scope audited:

- `src/cline-sdk/cline-task-session-service.ts`
- `src/cline-sdk/cline-session-runtime.ts`
- `src/cline-sdk/cline-event-adapter.ts`
- `src/trpc/runtime-api.ts`
- caller paths in `src/commands/task.ts`, `web-ui/src/hooks/use-cline-chat-session.ts`, `web-ui/src/hooks/use-cline-chat-panel-controller.ts`, and runtime action hooks.

## Relevant call paths

### Stop

- CLI board/trash/delete stop path: `src/commands/task.ts:290-299`, `src/commands/task.ts:661-663`, `src/commands/task.ts:858-860` call `runtime.stopTaskSession` when tasks leave live columns or are deleted.
- Runtime API first asks Cline, then falls back to terminal sessions only if Cline returns `null`: `src/trpc/runtime-api.ts:274-290`.
- Cline service stop has a rebind fallback only when the task entry is missing: `src/cline-sdk/cline-task-session-service.ts:443-470`.
- Runtime stop uses only `sessionIdByTaskId`; if no binding exists, it releases MCP resources and returns: `src/cline-sdk/cline-session-runtime.ts:280-289`.

### Abort / cancel

- UI chat cancel calls `cancelTaskChatTurn`: `web-ui/src/hooks/use-cline-chat-session.ts:127-147` -> runtime action -> `src/trpc/runtime-api.ts:421-445` -> `cancelTaskTurn`.
- Runtime abort endpoint calls `abortTaskSession`: `src/trpc/runtime-api.ts:396-419`.
- `abortTaskSession` and `cancelTaskTurn` require an in-memory task entry and do not rebind: `src/cline-sdk/cline-task-session-service.ts:472-518`.
- Both use `sessionRuntime.abortTaskSession`; runtime abort no-ops if no session binding exists: `src/cline-sdk/cline-session-runtime.ts:291-300`.

### Reload

- Runtime endpoint calls `reloadTaskSession`: `src/trpc/runtime-api.ts:371-395`.
- Like stop, reload only rebinds when the entry is missing, not when the entry exists but its runtime binding is stale: `src/cline-sdk/cline-task-session-service.ts:632-670`.
- Reload then calls `sessionRuntime.stopTaskSession`, clears active turn state, and dispatches an empty prompt via `dispatchResolvedTaskInput`.

### Clear

- UI sends `/clear` as a chat message; runtime intercepts it and calls `clearTaskSession`: `src/trpc/runtime-api.ts:495-506`.
- `clearTaskSession` calls `sessionRuntime.clearTaskSessions(taskId)` regardless of entry presence, but if no entry exists it returns `null` after deleting persisted/live matching sessions: `src/cline-sdk/cline-task-session-service.ts:672-695`.
- Runtime clear deletes records whose session id starts with the task prefix plus the active binding, aborting the active binding first: `src/cline-sdk/cline-session-runtime.ts:302-321`.

### Natural end / event handling

- Runtime host events are mapped to task ids by `taskIdBySessionId`: `src/cline-sdk/cline-session-runtime.ts:466-484`.
- `agent_event:done` transitions the summary to `awaiting_review` or `interrupted`: `src/cline-sdk/cline-event-adapter.ts:286-332`.
- SDK `ended` transitions to `awaiting_review` or `interrupted`: `src/cline-sdk/cline-event-adapter.ts:499-512`.
- Runtime clears the task/session binding only for top-level `ended` events after forwarding the event: `src/cline-sdk/cline-session-runtime.ts:475-483`.

## Findings

### 1. Existing in-memory entry can hide a missing/stale runtime binding

`stopTaskSession` and `reloadTaskSession` only call `rebindPersistedTaskSession` when `messageRepository.getTaskEntry(taskId)` returns no entry. If a runtime restart, failed start, clear race, or ended-event cleanup removes `sessionRuntime`'s task/session binding while the repository entry remains `running`, the service skips rebind and calls runtime stop/reload against a missing binding.

Observed behavior by operation:

- Stop: returns an `interrupted` Cline summary even if `sessionRuntime.stopTaskSession` no-oped because no session id was bound. Since runtime API treats any Cline summary as success, it will not fall back to terminal stop.
- Reload: `sessionRuntime.stopTaskSession` can no-op, then `dispatchResolvedTaskInput` may restart from persisted history. That works only if `lastStartRequestByTaskId` survived; after a process restart the real runtime does not reconstruct that start config in `resumeTaskSession`, so restart can fail with `No previous Cline session config is available...`.
- Abort/cancel: no rebind path at all; stale active persisted sessions cannot be aborted/canceled after an entry-only recovery. Cancel can mark the entry `idle` even when runtime abort no-ops.
- Clear: strongest deletion path because it scans persisted sessions by task prefix and active binding; however, it returns `null` if no entry exists, so API callers may report a null summary even though sessions were deleted.

Proposed fix:

- Introduce a shared helper such as `ensureTaskEntryAndBinding(taskId, { allowFailed?: boolean })` that checks both repository entry and `sessionRuntime.getTaskSessionId(taskId)`. If the entry is missing or the entry is live/reviewable but the binding is missing, call `rebindPersistedTaskSession` before stop/reload/abort/cancel/send.
- Extend `ClineSessionRuntime.resumeTaskSession` to reconstruct `lastStartRequestByTaskId` from `ClineSdkSessionRecord` when possible, matching the test fake's behavior. This makes reload/send restart viable after an actual runtime restart.
- For stop/abort/cancel, return a summary that distinguishes `interrupted` from `not_found` / `not_bound` when no persisted/live Cline session was actually controlled, so `runtime-api` can still fall back to terminal sessions when appropriate.

### 2. Natural end can leave entries showing `running` in several non-`done` cases

The happy path is covered: `agent_event:done` and top-level `ended` set the entry to review/interrupted. But there are gaps:

- `status` events with a non-running SDK status clear active turn state but preserve `entry.summary.state` unchanged (`src/cline-sdk/cline-event-adapter.ts:515-527`). If the SDK emits `status: completed|idle|stopped` without a following `done`/`ended`, a `running` entry stays `running`.
- If `startTaskSession` resolves with a result text but the SDK never emits a `done`/`ended` event, the background start handler appends/sets assistant text but does not transition the summary out of `running` (`src/cline-sdk/cline-task-session-service.ts:424-434`).
- If `handleSessionEvent` receives an `ended` event after the task/session binding was cleared or overwritten by a concurrent restart/reload, it drops the event before `applyClineSessionEvent` can settle the old entry (`src/cline-sdk/cline-session-runtime.ts:471-473`). The entry can remain in the state last written by earlier streaming/status events.

Proposed fix:

- Treat non-running SDK status values as terminal-ish unless they are known transient states. At minimum, map `completed`, `idle`, `stopped`, `aborted`, and `failed` to `awaiting_review`/`interrupted`/`awaiting_review(error)` instead of preserving `running`.
- When `startTaskSession` or `sendTaskSessionInput` receives a final result text without any streamed assistant message, also emit a final summary transition (`awaiting_review`, `reviewReason: "hook"` or `"exit"`) unless the entry has since been superseded by a newer operation.
- Preserve enough session/task association to settle old entries after an `ended` event even if the active binding has moved. One option: include a per-task operation/session generation and have late events either ignored safely or applied to mark only the matching generation terminal.

### 3. Same-task operations are not serialized and can race

The task service has mutable per-task state (`entry`, active message ids, `pendingTurnCancelTaskIds`, runtime binding maps), but there is no per-task operation queue/mutex. Several operations start async work and return before that work completes.

Important races:

- Start vs stop/clear/reload: `startTaskSession` returns immediately while the SDK start continues in a detached async IIFE. A later stop or clear can update/replace the repository entry, then the start promise can still append final text or call `emitTaskFailure` against the old captured `entry` object.
- Stop vs natural end: `stopTaskSession` awaits runtime stop and then unconditionally writes `interrupted` unless the entry is already `idle`. If a `done`/`ended` event writes `awaiting_review` concurrently, last writer wins.
- Cancel vs late events: `cancelTaskTurn` sets `pendingTurnCancelTaskIds`, aborts, and immediately writes `idle`. If the abort no-ops due to a missing binding, the pending cancel marker can cause a later aborted event from a rebound/new session with the same task id to be interpreted as the canceled turn.
- Clear vs start/restart: `clearTaskSession` replaces the repository entry and runtime binding, but a pending start/restart can bind the task again after clear, or emit messages for a cleared chat.
- Concurrent sends: `sendTaskSessionInput` appends user messages synchronously but dispatches SDK sends asynchronously. Two sends can both observe `running`, both select `delivery: "queue"`, both mutate active message state, and their later result handlers can append/finalize assistant text out of order.
- Reload vs send: reload stops the runtime and dispatches an empty prompt, then writes `idle`; a concurrent send can restart/send and write `running`, with whichever async continuation finishes last determining the visible summary.

Proposed fix:

- Add a per-task operation queue or mutex around lifecycle operations that mutate task state or runtime bindings: start completion, stop, abort, cancel, reload, clear, and send dispatch setup. The SDK call itself can remain async, but state commits should be generation-checked.
- Add a monotonically increasing `turnGeneration` or `sessionGeneration` to each task entry. Capture it in detached async callbacks and event handlers; before mutating state, verify it still matches the current entry and session id. This prevents old starts/sends from writing into a cleared/reloaded task.
- Make stop/abort/cancel idempotent with explicit results: `controlled`, `already_terminal`, `not_found`, `not_bound`, `rebound`. Runtime API can use that to decide whether to return Cline summary or try terminal fallback.
- Add tests for the above races using deferred promises in `test/runtime/cline-sdk/cline-task-session-service.test.ts`; the suite already has good deferred utilities around lines 31-43 and existing start/send race coverage around lines 1213-1274.

## Recommended implementation plan

1. Add regression tests first:
   - stop rebinds when entry exists but runtime binding is missing.
   - abort/cancel rebind or report not-bound instead of silently succeeding/failing.
   - non-running status does not leave summary `running`.
   - result-only start completion settles the summary.
   - stale start/send callbacks after clear/reload do not emit messages or summaries for the cleared generation.
2. Implement shared rebind/binding helper in `InMemoryClineTaskSessionService` and use it for stop/reload/abort/cancel/send.
3. Teach real `InMemoryClineSessionRuntime.resumeTaskSession` to rebuild restart config from persisted records, not just bind the session id.
4. Add per-task generation checks around detached start/send continuations and event handling.
5. Consider returning richer lifecycle operation status internally so runtime API can avoid swallowing terminal fallback opportunities.

## Existing coverage that should be preserved

- Rebind-and-stop with no in-memory entry: `test/runtime/cline-sdk/cline-task-session-service.test.ts:1001-1034`.
- Rebind-and-send after restart: `test/runtime/cline-sdk/cline-task-session-service.test.ts:905-956`.
- Completed `done` moves to review and captures checkpoint: `test/runtime/cline-sdk/cline-task-session-service.test.ts:1175-1211`.
- Start creates entry/mapping before SDK start resolves: `test/runtime/cline-sdk/cline-task-session-service.test.ts:1213-1248`.
- Send returns before SDK send completion: `test/runtime/cline-sdk/cline-task-session-service.test.ts:1250-1274`.
