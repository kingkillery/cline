# Non-Cline PTY regression risk audit

Date: 2026-05-05

## Scope reviewed

This audit covers the split introduced by the Cline-native lifecycle work: Cline task chat now routes through `src/cline-sdk/cline-task-session-service.ts` from TRPC, while command-driven agents and shell terminals remain PTY-backed through `src/terminal/session-manager.ts` and `src/terminal/agent-session-adapters.ts`.

Files/paths read:
- `src/trpc/runtime-api.ts` task start/stop/input/chat routing.
- `src/terminal/session-manager.ts` PTY process lifecycle, terminal protocol filtering, summary transitions, stale recovery, resize/input/stop, auto-restart.
- `src/terminal/agent-session-adapters.ts` Claude, Codex, Gemini, OpenCode, Factory Droid, and legacy Cline CLI adapter preparation.
- `src/terminal/agent-registry.ts` and `src/core/agent-catalog.ts` command discovery/launch support boundaries.
- `src/trpc/workspace-api.ts` and `src/server/workspace-registry.ts` summary selection and hydrated terminal-manager state.
- Focused runtime/terminal/Cline tests listed below.

Current catalog note: the runtime schema currently has `claude`, `codex`, `gemini`, `opencode`, `droid`, and `cline`. Factory is represented by `droid`. I did not find an active `pi` runtime agent id or adapter in this tree; if Pi is reintroduced, it should be treated as a PTY-backed non-Cline agent unless it gets its own native runtime service.

## Invariants that must remain true

1. Routing boundary stays agent-id based.
   - `runtime-api.startTaskSession` must use the Cline service only when the effective agent is `cline` or a resume-from-trash rebind finds a persisted Cline SDK session.
   - Non-Cline agents must continue through `resolveAgentCommand(...)` and `terminalManager.startTaskSession(...)` with their configured binary/args.
   - Non-Cline starts must not resolve Cline provider/OAuth credentials or fail because Cline credentials are missing.

2. Stop/input operations must remain two-phase without stealing non-Cline sessions.
   - `stopTaskSession` and `sendTaskSessionInput` try the Cline task service first, but must fall back to `TerminalSessionManager` when no Cline entry/binding exists.
   - A stale or unbound Cline SDK entry must not shadow an active PTY entry for the same task id.
   - PTY input must remain raw terminal bytes via `writeInput`, including Codex newline tracking for prompt-ready transitions.

3. PTY lifecycle state stays independent from Cline chat state.
   - `TerminalSessionManager` remains the owner of PTY pid, shell/task summary state, last output time, exit code, terminal restore snapshots, resize, pause/resume, and auto-restart.
   - `recoverStaleSession` must preserve `agentId` while clearing stale active state so resume can route terminal agents back to their original PTY adapter.
   - Workspace hydration must still merge persisted terminal sessions into runtime state; Cline summaries are selected separately where needed.

4. Agent adapters preserve per-agent launch semantics.
   - Claude: permission/autonomous/plan/resume args, `FORCE_HYPERLINK`, append-system-prompt, and hook settings injection remain PTY launch behavior.
   - Codex: autonomous/resume/developer-instructions config, wrapper-based hooks, deferred plan-mode bracketed paste, workspace-trust auto-confirm, and prompt-ready output detection remain PTY behavior.
   - Gemini: `--yolo`, `--resume latest`, `--approval-mode=plan`, `-i <prompt>`, and settings-hook env injection remain PTY behavior, even while launch support is currently disabled in the supported-agent list.
   - OpenCode: `--continue`, plan agent/env, plugin config, preferred model preservation, and `--prompt` behavior remain PTY behavior, even while launch support is currently disabled.
   - Factory Droid: settings-file autonomy mode, hook transitions, `--resume`, append prompt, and device-attribute query suppression remain PTY behavior.
   - Generic shell terminals: must bypass agent adapters entirely and use the resolved interactive shell command in `startShellSession`.

5. Terminal protocol handling remains attached to PTY sessions only.
   - OSC 10/11 startup query interception, terminal state mirror restore snapshots, listener fanout, backpressure pause/resume, and pixel-aware resize are PTY concerns and must not be removed because Cline chat is native.
   - The early OSC color-query filter must stay enabled until a live output listener attaches; non-output summary listeners alone must not disable it.

6. Auto-restart remains limited and terminal-only.
   - Attached task PTYs should restart after abnormal exits, not after clean exits or explicit stop.
   - Shell sessions should not auto-restart.
   - Auto-restart must preserve cloned restart requests/env/args/images and must not invoke Cline-native restart paths.

## Risk areas from the Cline-native split

- Resume routing: `previousTerminalAgentId` plus persisted Cline rebind is the key discriminator. Regressions here could route a trashed terminal task into native Cline, or a Cline task into a missing CLI command.
- Stop/input fallback: the Cline-first fallback is convenient but fragile if a Cline service returns a summary for a task without a live binding while a PTY is active.
- Summary merge precedence: `selectLastTurnSummary` favors active summaries, then latest `updatedAt`, then Cline on tie. This is correct for mixed history, but should stay covered so old terminal summaries do not hide active Cline state and vice versa.
- Adapter drift: Cline-native work may make the old `clineAdapter` look unused. It is still present in the adapter map and tests; if removed later, remove it deliberately with runtime schema/config migration rather than incidentally.
- Launch-supported list drift: `opencode` and `gemini` adapters exist but are commented out of `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`. Tests should distinguish "adapter still valid" from "currently launchable in Settings".
- Protocol filtering drift: PTY-only code can look unrelated to native chat but is required for Codex/OpenCode/Droid/shell terminal correctness.

## Must-pass focused tests

Validated on 2026-05-05:

```text
npx vitest run \
  test/runtime/terminal/session-manager.test.ts \
  test/runtime/terminal/session-manager-auto-restart.test.ts \
  test/runtime/terminal/agent-session-adapters.test.ts \
  test/runtime/terminal/pty-session.test.ts \
  test/runtime/trpc/runtime-api.test.ts
```

Result: 5 files passed, 78 tests passed.

These suites currently guard the most important non-Cline PTY invariants:
- `runtime-api.test.ts`: Cline vs non-Cline task routing, non-Cline starts not resolving Cline OAuth, Cline input/stop/chat routing.
- `agent-session-adapters.test.ts`: per-agent adapter args/env/hooks for Claude, Codex, Gemini, OpenCode, Droid, and legacy Cline CLI adapter behavior.
- `session-manager.test.ts`: stale recovery, hook activity, snapshots, resize, startup protocol filter listener behavior.
- `session-manager-auto-restart.test.ts`: abnormal-exit restart, clean/explicit-stop no-restart, Codex deferred startup input.
- `pty-session.test.ts`: cross-platform PTY launch quoting, env propagation, resize/write race handling.

## Missing coverage worth adding later

1. Runtime stop fallback guard: a test where Cline service returns null and a PTY task is stopped, plus a test where an unbound/stale Cline service does not shadow an active PTY task with the same id.
2. Runtime resume routing for terminal agents: explicit resume-from-trash cases for Claude/Codex/Droid summaries proving `previousTerminalAgentId` overrides a currently selected `cline` agent.
3. Workspace state merge: a focused `workspace-api` or registry test that terminal and Cline summaries for the same task id select active/latest summary as intended.
4. Shell-vs-agent separation: a test proving `startShellSession` never calls `prepareAgentLaunch`, never applies agent hooks, and never auto-restarts.
5. Re-enable path coverage: if Gemini/OpenCode are uncommented in `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`, add runtime-api launch tests for those agents before shipping.
6. Pi reintroduction guard: if a `pi` runtime agent id returns, add it to the adapter/test matrix and verify it stays on the PTY-backed path unless a native service is deliberately designed.

## Recommendation

Treat the Cline-native SDK path and the PTY path as two runtime services behind the TRPC boundary, not as interchangeable implementations. Future Cline work should update Cline service tests and runtime routing tests first, then run the focused PTY subset above to prove Claude/Codex/Droid/shell behavior did not regress.
