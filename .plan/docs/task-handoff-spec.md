# Structured Task Handoff Spec

## Goal

Make completed Kanban task sessions produce a small, structured handoff that downstream/reviewer tasks can read without parsing terminal logs or full chat transcripts.

This mirrors the Hermes Kanban `kanban_complete(summary=..., metadata=...)` pattern: the natural-language final message remains useful for humans, while a machine-readable metadata object captures what changed, what was decided, what was validated, and what still failed.

## Current audit findings

1. Cline Kanban persists task session state in the workspace session map (`RuntimeTaskSessionSummary`) and chat messages. Hook-driven agents mainly expose lifecycle state, latest hook activity, final message text, turn checkpoints, and logs. Before this spec, there was no durable, normalized handoff object equivalent to Hermes `metadata`.
2. Downstream linked tasks are auto-started when an upstream review task is moved to trash, but `task start` currently passes only the downstream task prompt to the runtime. A dependent reviewer can inspect board state and session summaries if it knows where to look, but the upstream findings are not automatically inserted into its worker context.
3. Cline SDK completion events already carry a final assistant text in the `agent_event: done` path. That is the lowest-risk extraction point because it is emitted once per completed turn and already drives `awaiting_review` state.

## Handoff shape

Store structured handoff data on `RuntimeTaskSessionSummary.handoff`.

Required fields, always present when a handoff object exists:

```json
{
  "changed_files": [],
  "decisions": [],
  "tests_run": [],
  "errors": []
}
```

Field meanings:

- `changed_files`: repository-relative file paths intentionally changed by the worker.
- `decisions`: durable implementation or product decisions made during the task.
- `tests_run`: exact verification commands or manual checks performed.
- `errors`: unresolved errors, failed checks, blocked validations, or known caveats.

Optional fields:

- `benchmarks`: object keyed by benchmark/check name for timing, count, or score outputs.
- `review_status`: one of `approved`, `changes_requested`, `blocked`, or `unknown`.
- `merge_conflicts`: repository-relative paths or short descriptions of known conflicts.

## Agent final-message contract

A Cline final response may include the handoff as either a top-level object or nested under one of these keys:

- `task_handoff`
- `handoff`
- `handoff_metadata`

Preferred format:

~~~markdown
Implemented the change and verified the focused test.

```json
{
  "task_handoff": {
    "changed_files": ["src/example.ts", "test/example.test.ts"],
    "decisions": ["Kept parsing strict so malformed handoffs are ignored instead of partially persisted."],
    "tests_run": ["npm test -- --run test/runtime/cline-sdk/cline-event-adapter.test.ts"],
    "errors": [],
    "review_status": "unknown"
  }
}
```
~~~

Extraction is intentionally conservative: natural-language JSON snippets are ignored unless they include recognized handoff fields.

## Persistence and runtime flow

1. Cline SDK emits `agent_event` with `type: "done"` and optional final `text`.
2. `applyClineSessionEvent` parses JSON snippets in the final text.
3. If a valid handoff object is found, it is stored on `RuntimeTaskSessionSummary.handoff` while the existing final message remains in `latestHookActivity.finalMessage` and chat history.
4. Workspace session persistence already serializes summaries through `runtimeTaskSessionSummarySchema`, so the handoff survives runtime reloads with the rest of the session summary.

## Downstream worker-context plan

The next implementation step should add dependency context when starting linked tasks:

1. In `startTask`, before `runtime.startTaskSession`, inspect `runtimeState.board.dependencies` for upstream tasks where `toTaskId === task.id`.
2. Resolve each upstream task's latest session summary from `runtimeState.sessions[upstreamTaskId]`.
3. Render a compact `## Upstream task handoffs` section containing:
   - upstream task id and prompt preview
   - final message preview from `latestHookActivity.finalMessage`
   - structured `handoff` JSON when present
4. Append that section to the prompt passed to the downstream runtime, not to the stored card prompt, so the board contract remains stable.
5. Add tests for manual starts and auto-starts from `trashTaskById` to verify downstream prompts include upstream handoff context.

## Validation rules

- Missing handoff is allowed; it means the worker did not provide structured metadata.
- Invalid handoff JSON must not block session completion.
- Unknown fields should be dropped by the schema unless a future version explicitly supports them.
- The schema should stay small and stable because web UI, auto-review, and reviewer agents may depend on it.
