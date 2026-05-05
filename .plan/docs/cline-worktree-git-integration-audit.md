# Cline Worktree/Git Integration Audit

Date: 2026-05-05
Task: `t_b15ed1e3`

## Scope reviewed

- `src/workspace/task-worktree.ts`
- `src/workspace/task-worktree-path.ts`
- `src/workspace/task-worktree-turbopack.ts`
- `src/workspace/turn-checkpoints.ts`
- `src/cline-sdk/cline-session-runtime.ts`
- `src/cline-sdk/cline-task-session-service.ts`
- related task command and workspace API paths in `src/commands/task.ts` and `src/trpc/workspace-api.ts`
- existing focused coverage in `test/integration/task-worktree.integration.test.ts` and `test/runtime/cline-sdk/cline-task-session-service.test.ts`

## Executive summary

The current worktree path and ignored-symlink behavior is stronger than earlier versions: stale Git registrations are pruned before add, existing worktrees are treated as authoritative, trashed-task patches preserve uncommitted changes, and symlinked ignored paths are re-ignored via `.git/info/exclude`.

The highest-risk remaining Cline-specific issue is persisted SDK session identity. Kanban maps Cline sessions back to tasks by testing whether persisted SDK session ids start with `buildSessionIdPrefix(taskId)`. That is unsafe for prefix-related task ids and can cause rebind, message hydration, or clear/delete behavior to select another task's Cline session.

## Findings and risks

### 1. Cline persisted session lookup can collide by task-id prefix

Relevant code:

- `src/cline-sdk/cline-session-state.ts` creates session ids as `${toSessionIdTaskPrefix(taskId)}-${timestamp}-${random}`.
- `buildSessionIdPrefix(taskId)` returns `${toSessionIdTaskPrefix(taskId)}-`.
- `src/cline-sdk/cline-session-runtime.ts` uses `record.sessionId.startsWith(sessionIdPrefix)` in `findPersistedTaskSessionRecord()` and `clearTaskSessions()`.

Risk:

- Task id `task` has prefix `task-`.
- Task id `task-a` creates session ids like `task-a-177...`.
- `task-a-177...` also starts with `task-`, so persisted lookup/clear for `task` can select/delete `task-a` sessions.

This is probably rare with generated ids, but it is exactly the kind of latent correctness bug that becomes severe if users import tasks, reuse custom ids, or if future id generation changes.

Targeted fix:

- Stop using ambiguous prefix matching as the source of truth.
- Prefer SDK session metadata if available, e.g. persist a structured `kanbanTaskId` in session config/metadata and match exactly.
- If metadata is not available, encode task id as a length-prefixed or base64url segment, e.g. `kanban-${base64url(taskId)}-${timestamp}-${random}`, and only match the fully encoded segment prefix.

Targeted tests:

- Unit test with persisted records for task ids `task` and `task-a`; assert `readPersistedTaskSession("task")` does not return `task-a`.
- Unit test `clearTaskSessions("task")` does not delete `task-a-*` sessions.
- Include a sanitized-character collision case if custom ids can include Windows-invalid characters, because `toSessionIdTaskPrefix()` maps those to `_`.

### 2. Worktree path identity can collide across repositories with the same leaf folder

Relevant code:

- `getTaskWorktreePath(repoPath, taskId)` stores worktrees at `~/.cline/worktrees/<taskId>/<workspaceFolderLabel>`.
- `workspaceFolderLabel` is only the final folder name of the repo path.

Risk:

Two repositories with the same leaf folder and the same task id will share a worktree path. Example:

- `/Users/a/client/kanban`, task `t_123`
- `/Users/a/fork/kanban`, task `t_123`
- both map to `~/.cline/worktrees/t_123/kanban`

This can cause one workspace to adopt, prune, delete, or patch-capture another workspace's worktree. The current `git rev-parse HEAD` existing-worktree check does not prove that the worktree belongs to the requested repo common dir.

Targeted fix:

- Include a stable repo identity segment in the worktree path, e.g. a short hash of canonical `repoPath` or Git common dir, not just the leaf folder.
- For backward compatibility, consider probing the legacy path only if it is registered to the same repo common dir; otherwise create a new hashed path.

Targeted tests:

- Two temp repos with same basename and same task id should produce different worktree paths.
- A stale directory at the legacy/colliding path for repo A should not be reused by repo B.

### 3. Symlinked `node_modules` can mutate the base workspace when Cline runs installs or native rebuilds

Relevant code:

- `syncIgnoredPathsIntoWorktree()` symlinks ignored paths into task worktrees.
- `listTurbopackNodeModulesSymlinkSkipPaths()` skips `node_modules` for detected Next/Turbopack-like package dirs.

Current protection:

- The `.git/info/exclude` block keeps symlinked ignored paths out of Git status.
- The Turbopack skip avoids one known class where symlinked `node_modules` is unsafe.

Remaining risk:

- For non-Next projects, `node_modules` can still be a symlink to the base workspace.
- If Cline runs `npm install`, `pnpm install`, `npm rebuild`, `node-gyp rebuild`, or any native postinstall in the task worktree, it can mutate the base repo's dependency tree through the symlink.
- This violates the mental model that task worktrees are isolated from the base checkout, even when tracked files remain isolated.

Targeted fix options:

1. Safer default: never symlink dependency directories (`node_modules`, `.pnpm-store`, virtualenvs, build caches with native artifacts); let the task worktree install its own dependencies.
2. Configurable fast path: keep symlinking but make it an opt-in per workspace with clear UI copy: "dependency installs in task worktrees may mutate the base dependency directory".
3. Guardrail prompt/tooling: inject an explicit warning into task prompts when a dependency directory is symlinked, and expose symlinked ignored paths in workspace info.

Targeted tests:

- Create a task worktree with symlinked `node_modules`, write through `worktree/node_modules/native.node`, and assert the base path changes; use this as a characterization test if the behavior remains intentional.
- Add a regression test for the chosen policy: either `node_modules` is not symlinked by default, or the UI/API reports it as shared state.

### 4. Trash/delete cleanup removes worktrees but not necessarily persisted Cline SDK sessions

Relevant code:

- `trashTaskById()` stops live sessions only for tasks previously in `in_progress` or `review`, then calls `deleteTaskWorkspace()`.
- `deleteTaskCommand()` also stops only live-session columns before deleting task worktrees.
- `stopTaskSession()` stops the active Cline session but does not delete persisted SDK session artifacts.
- `clearTaskSession()` calls `sessionRuntime.clearTaskSessions()` and deletes persisted matching sessions, but trash/delete paths do not call it.

Risk:

After a task is trashed or deleted, Cline SDK persisted history can remain. If the task id is reused or prefix-collides, later hydration/rebind can surface stale history from a deleted task. This combines with Finding 1.

Targeted fix:

- Add a task-session cleanup path for trash/delete that explicitly clears Cline persisted sessions for deleted task ids, not just live runtime bindings.
- Ensure cleanup runs after worktree patch capture, so deleting persisted session history does not affect preserving file changes.

Targeted tests:

- Simulate persisted Cline records for a task, delete/trash the task, and assert `sessionHost.delete()` is called for the exact task's sessions.
- Include a prefix-collision fixture to ensure deleting `task` does not delete `task-a`.

### 5. Turn checkpoint diffs are file-state checkpoints only; Cline conversation state is not rolled back

Relevant code:

- `captureTaskTurnCheckpoint()` creates Git refs from worktree file state.
- `ClineTaskSessionService.applyTurnCheckpoint()` only updates summary metadata.
- `loadChanges(last_turn)` diffs checkpoint commits; there is no code path that restores checkpoint file state or rewinds Cline persisted messages.

Risk:

This is mostly okay for today's UI if checkpoints are only used for diffing the last turn. But if a future "restore/revert to checkpoint" action is added, restoring files alone would leave Cline's persisted session history ahead of the filesystem. The next Cline send/rebind could continue from a conversation that has already seen and acted on files that no longer exist.

Targeted fix before adding restore:

- Define checkpoint scope explicitly: file diff marker only vs restorable turn snapshot.
- If restorable, pair each file checkpoint with a conversation checkpoint/session snapshot id and restore both together, or intentionally clear/restart Cline with a system note that files were restored.

Targeted tests:

- For current behavior: assert `last_turn` diffs use Cline summaries when fresher than terminal summaries.
- Before implementing restore: add an integration test that restores file state and verifies Cline session history is either rewound or explicitly cleared/restarted.

## Recommended follow-up order

1. Fix exact Cline persisted session identity and cleanup semantics first. This is correctness-critical and also de-risks task deletion/reuse.
2. Add repo-identity hashing to task worktree paths to prevent cross-repo collisions.
3. Decide product policy for symlinked dependency directories; either isolate by default or make shared dependency dirs explicit/opt-in.
4. Document checkpoint scope as diff-only unless/until a paired filesystem+conversation restore design exists.

## Validation run

Focused validation passed on 2026-05-05:

```text
npm test -- test/integration/task-worktree.integration.test.ts test/runtime/cline-sdk/cline-session-runtime.test.ts test/runtime/cline-sdk/cline-task-session-service.test.ts test/runtime/trpc/workspace-api.test.ts

Test Files  4 passed (4)
Tests       73 passed (73)
```
