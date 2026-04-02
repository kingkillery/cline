---
name: ralph
description: "Ralph Wiggum loop - retry until completion with a fixed iteration cap."
---

# Ralph loop

Use a plan-first loop to finish multi-step work deterministically.
The loop should run with explicit state, measurable completion criteria, and explicit stop conditions.

Workflow:
1) Generate a comprehensive plan (JSON) with ordered steps and completion criteria.
2) If required inputs are missing, stop immediately and ask the user for them.
3) Execute one plan step per iteration, log outcomes, and validate each step against its completion criteria.
4) Re-plan only when needed, then continue until all steps complete or the iteration cap is reached.
5) On completion, return:
   - completed actions
   - changed files
   - residual risks and open decisions.
6) If max iterations are reached, stop and return:
   - what is done
   - what is blocked
   - a recommended next step list for the user.

Included script:
- scripts/ralph/ralph.sh (bash loop runner with PRD/state files)

Usage:
```
./scripts/ralph/ralph.sh 12
```

Recommended defaults:
- `--iterations`: 25
- `scripts/ralph/prompt.md`: keep one-story iteration algorithm and `<promise>COMPLETE</promise>` stop marker
- `scripts/ralph/prd.json`: required format `branchName` + `userStories[]`
- `scripts/ralph/progress.txt`: required for Codebase Patterns + iteration log

CLI behavior:
- Detects and uses available CLIs in this priority:
  - `codex`
  - `claude`
  - `amp`
  - `goose`
  - `droid`
- If not available in the current shell, falls back to Windows PowerShell command wrappers (when the wrapper executable is invokable).
- Detects wrapper executability before use to avoid stale/non-runnable Windows paths inside WSL.
- If PowerShell execution fails, retries with `wsl.exe`/`wsl` using the same CLI (`wsl <cli> ...`).
- If no CLI is available, returns a clear placeholder instruction and exits non-zero.
