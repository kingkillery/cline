# Kanban Dirty Workspace Collision Snapshot

Date: 2026-05-05 06:24 -06:00
Task: t_b517e209
Workspace: `/mnt/c/dev/Desktop-Projects/kanban`

## Snapshot

`git status --short` currently reports 261 dirty entries after writing this note:

- 254 modified tracked entries
- 7 untracked entries
- no reset/stash/clean/commit was performed

High-level area counts:

| Area | Dirty entries | Notes |
| --- | ---: | --- |
| `web-ui/` other | 92 | Broad web app churn outside Cline chat paths. |
| `.plan/docs/` | 41 | Includes this snapshot note, the Cline cleanup handoff/plan, and many docs. |
| web-ui Cline chat/runtime paths | 21 | Detail-panel Cline chat UI, chat hooks, and runtime stream paths are already touched. |
| root/docs/scripts/config misc | 18 | Root docs plus biome/grit/scripts/manpage. |
| `src/` other | 17 | CLI, command, config, core, terminal, and server paths. |
| backend tests outside focused Cline/runtime set | 16 | Integration/runtime terminal/task tests already dirty. |
| repo dotfiles/config | 12 | Includes `.cline`, `.clinerules`, `.codex`, `.factory`, `.gitignore`, `.husky`, `.npmrc`, `.vscode`; untracked `.omc/` and `.pksweeper/`. |
| `src/cline-sdk/` | 11 | All current Cline SDK boundary/session/provider/message files are dirty. |
| `.plan/` other | 9 | Rename/terminal plans and demo HTML. |
| docs/root docs | 8 | Root docs and `docs/*`. |
| `.github/` | 7 | Workflows, CODEOWNERS, issue templates, changelog script. |
| focused backend Cline/runtime tests | 6 | Includes one untracked new Cline compaction test. |
| `src/trpc/` | 3 | Includes high-risk `src/trpc/runtime-api.ts`. |

## Highest-risk collision surfaces

These paths have already been touched by recent Cline lifecycle work and should be treated as occupied until an owner explicitly hands them off:

- `src/cline-sdk/*`
  - Dirty files include `cline-context-overflow-compaction.ts`, `cline-event-adapter.ts`, `cline-message-repository.ts`, `cline-provider-service.ts`, `cline-runtime-logger.ts`, `cline-session-runtime.ts`, `cline-session-state.ts`, `cline-task-session-service.ts`, `cline-tool-call-display.ts`, `sdk-provider-boundary.ts`, and `sdk-runtime-boundary.ts`.
  - Largest diffs by numstat include `cline-provider-service.ts` (772/772), `cline-session-state.ts` (395/395), `sdk-provider-boundary.ts` (391/391), `cline-message-repository.ts` (359/359), `sdk-runtime-boundary.ts` (275/275), `cline-task-session-service.ts` (232/80).
- `src/trpc/runtime-api.ts`
  - Dirty and large: 636 insertions / 636 deletions in current diff stat.
  - Collision risk is high because it sits between runtime state, Cline session operations, provider endpoints, and web-ui consumers.
- Focused tests
  - Dirty: `test/runtime/cline-sdk/cline-event-adapter.test.ts`, `cline-message-repository.test.ts`, `cline-session-runtime.test.ts`, `cline-task-session-service.test.ts`, `test/runtime/trpc/runtime-api.test.ts`.
  - Untracked: `test/runtime/cline-sdk/cline-context-overflow-compaction.test.ts`.
  - `test/runtime/trpc/runtime-api.test.ts` is especially collision-prone: 2144 insertions / 2144 deletions.
- Web-ui Cline chat paths
  - Dirty: `web-ui/src/components/detail-panels/cline-agent-chat-panel*`, `cline-chat-composer.tsx`, `cline-chat-message-item.tsx`, `cline-chat-message-utils*`, `cline-chat-model-selector*`, `cline-markdown-content.tsx`, `cline-model-picker-options*`, plus `web-ui/src/hooks/use-cline-chat-panel-controller*`, `use-cline-chat-session*`, and `web-ui/src/runtime/use-runtime-state-stream.ts`.
  - Large churn includes `cline-agent-chat-panel.test.tsx` (1086/1086), `cline-chat-composer.tsx` (603/603), `cline-agent-chat-panel.tsx` (518/518), and `use-runtime-state-stream.ts` (516/516).

## Recommended sequencing for next agents

1. Do not launch parallel agents against `src/cline-sdk/*`, `src/trpc/runtime-api.ts`, focused Cline tests, or web-ui Cline chat paths unless each agent owns disjoint files and has an explicit rebase/merge plan.
2. Prefer one backend Cline lifecycle owner at a time for `src/cline-sdk/*` plus `test/runtime/cline-sdk/*`.
3. Prefer one runtime API owner at a time for `src/trpc/runtime-api.ts` plus `test/runtime/trpc/runtime-api.test.ts`.
4. Prefer one web-ui Cline chat owner at a time for `web-ui/src/components/detail-panels/cline-*`, `web-ui/src/hooks/use-cline-chat-*`, and `web-ui/src/runtime/use-runtime-state-stream.ts`.
5. Before doing any follow-up implementation, rerun `git status --short` and inspect relevant `git diff -- <paths>`; this snapshot is a warning marker, not a lock.
6. Keep validation targeted unless changing code. Recent handoff notes in `.plan/docs/cline-sdk-kanban-architecture-cleanup-handoff.md` say focused Cline/backend/web checks and typechecks were green, while full backend/web suites still had documented broader failures or timeouts.

## Immediate warnings

- The workspace is heavily dirty; preserving unrelated changes is more important than tidying.
- Untracked `.omc/`, `.pksweeper/`, `.plan/docs/cline-context-overflow-compaction-audit.md`, `.plan/docs/cline-native-chat-lifecycle-validation.md`, `.plan/docs/cline-session-rebind-recovery-edge-cases.md`, this snapshot note, and `test/runtime/cline-sdk/cline-context-overflow-compaction.test.ts` are present.
- This note intentionally does not include a full file dump; use `git status --short` for the authoritative live list.
