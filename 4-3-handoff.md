# 4-3 Handoff

## Remaining Risks

1. The native tool still drafts graphs heuristically.
The shared graph contract now exists, but the tool panel does not yet call the selected agent to generate structured task graphs. That means decomposition quality is still bounded by local heuristics instead of repo-aware reasoning.

2. Existing dependency handoffs are not fully editable outside creation time.
Handoff packets can now be stored on dependency edges, but there is no dedicated CLI or board-edit flow for updating those packets after the graph is applied.

3. Blocked-task override is missing.
The system now correctly prevents blocked backlog tasks from starting until all prerequisites clear, but there is no explicit operator-facing force-start path for exceptional cases.

4. Task metadata split is additive, not fully normalized across all surfaces.
`title` and `summary` now exist, but many existing flows still treat `prompt` as the primary authored value. Some surfaces still infer presentation from prompt content when explicit metadata is absent.

5. The Cline sidebar path is improved, but still partially prompt-driven.
The sidebar prompt now prefers `task apply-graph`, which is materially better than repeated `create` plus `link`, but the sidebar still depends on appended prompt instructions instead of a dedicated native tool/API integration.

## Required Next Steps

1. Wire agent-backed graph generation into the native Tool panel.
Use the selected agent to return a validated JSON task graph matching the shared contract, then load that graph into the inspector before apply.

2. Add dependency and handoff editing commands at the CLI/runtime layer.
Introduce a contract for updating existing dependency edges, especially handoff packet fields, so the UI and sidebar agent can repair graphs after creation.

3. Add an explicit force-start flow.
Provide a guarded override for blocked tasks, ideally with clear UI copy and auditability, rather than forcing operators to mutate dependencies just to bypass them.

4. Normalize task display metadata across the app.
Continue moving display surfaces toward `title` and `summary` first, with `prompt` remaining the execution payload. Reduce prompt parsing and display inference over time.

5. Tighten the sidebar agent integration.
Move from “prompt tells agent how to manage Kanban” toward a stronger native operation path, where the agent invokes stable board actions instead of relying on long appended instructions.

6. Expand test coverage around the new contract.
Add tests for:
- `task apply-graph` command behavior
- invalid graph payload handling
- cycle rejection
- handoff editing once that surface exists
- title/summary display precedence across key task views

## Recommended Order

1. Agent-backed graph generation
2. Dependency/handoff edit contract
3. Force-start override
4. Metadata normalization across UI
5. Sidebar agent integration tightening
6. Expanded tests and cleanup
