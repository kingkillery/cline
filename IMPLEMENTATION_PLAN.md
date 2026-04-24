# Native Tool Implementation Plan

## Goal

Replace the current prompt-heavy sidebar task-authoring experience with a first-class native Kanban tool surface that can draft and apply connected task graphs, while tightening dependency semantics so blocked tasks only start when all prerequisites are satisfied.

## Phase 1: Tool Surface Scaffolding

Status: completed

Scope:
- Add a new `Tool` section to the left sidebar.
- Render a dedicated native tool panel for the current project.
- Keep the existing `Projects` and `Kanban Agent` sections intact.

Acceptance criteria:
- Users can switch into a `Tool` section from the left rail.
- The new panel renders inside the existing sidebar shell without breaking current layouts.

Validation:
- `npm --prefix web-ui run test -- project-navigation-panel.test.tsx`

Rollback:
- Remove the new section button and tool panel prop wiring.

## Phase 2: Draft Graph Authoring MVP

Status: completed

Scope:
- Add a goal composer.
- Generate an editable draft graph from user input.
- Add node selection and inspector editing.

Acceptance criteria:
- Users can enter a goal and produce a draft graph.
- Users can edit draft nodes and dependencies before applying.

Validation:
- `npm --prefix web-ui run test -- native-tool-panel.test.tsx`

Rollback:
- Remove draft graph component and return to empty tool state.

## Phase 3: Atomic Apply To Board

Status: completed

Scope:
- Convert a draft graph into real backlog tasks plus links in one apply action.
- Preserve base ref, plan mode, and auto-review defaults.
- Encode handoff packets into dependency metadata.

Acceptance criteria:
- Applying a graph creates the expected tasks and links on the board.
- No partial apply occurs when graph validation fails.

Validation:
- `npm --prefix web-ui run test -- native-tool-panel.test.tsx use-task-start-actions.test.ts board-state.test.ts`

Rollback:
- Disable apply action and keep the tool in draft-only mode.

## Phase 4: Dependency Semantics Hardening

Status: completed

Scope:
- Require all prerequisites to clear before a dependent backlog task becomes startable.
- Update unblock and manual-start logic accordingly.

Acceptance criteria:
- Multi-prerequisite tasks do not auto-start after only one prerequisite completes.
- Backlog “start all” respects remaining blockers.

Validation:
- `npm --prefix web-ui run test -- use-task-start-actions.test.ts board-state.test.ts`

Rollback:
- Restore previous unblock semantics in task-state helpers.

## Phase 5: Runtime Contract Follow-Through

Status: completed

Scope:
- Add additive contract fields for dependency handoff metadata.
- Ensure normalization and persistence tolerate the richer payload.

Acceptance criteria:
- Board state round-trips with optional handoff packets.
- Existing tasks continue to load unchanged.

Validation:
- `npm run typecheck`
- `npm run test`

Rollback:
- Remove additive metadata fields and keep draft-only handoff data in UI state.

## Phase 6: Atomic CLI Graph Contract

Status: completed

Scope:
- Add a shared task-graph application primitive.
- Expose `kanban task apply-graph` for atomic multi-task creation.
- Update the sidebar agent prompt to prefer graph application over iterative create/link calls.

Acceptance criteria:
- One graph payload can create tasks and dependency edges in a single command.
- The prompt contract teaches the stronger graph path to the sidebar agent.

Validation:
- `npm run test -- test/runtime/task-graph.test.ts test/runtime/task-board-mutations.test.ts`
- `npm --prefix web-ui run test -- src/components/native-tool/native-tool-graph.test.ts`

Rollback:
- Remove the command and return the sidebar prompt to create/link guidance only.
