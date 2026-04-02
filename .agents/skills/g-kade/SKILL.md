---
name: g-kade
description: KADE-structured session orchestrator for gstack. Combines KADE's ADHD-friendly session structure, handoff logging, and user-profile context with gstack's execution skills (/ship, /review, /qa, /investigate, etc.). Invoke when starting a work session that needs both personal context-awareness and gstack task power. Also handles /g-kade install to scaffold KADE files into any project.
---

# /g-kade

Bridges the KADE collaboration framework with gstack task execution. KADE owns the *how* (session structure, user profile, handoff logs). gstack owns the *what* (ship, review, QA, design, browser automation).

---

## Install

When the user runs `/g-kade install` (or says "install g-kade in this project"), scaffold KADE context files into the current repo with minimal footprint.

### Step I-1: Detect project root

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
echo "PROJECT_ROOT=$PROJECT_ROOT"
```

### Step I-2: Check what already exists

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
echo "=== Global KADE context ==="
[ -f "$HOME/.kade/HUMAN.md" ] && echo "HUMAN.md: EXISTS" || echo "HUMAN.md: MISSING"
echo "=== Project KADE files ==="
[ -d "$PROJECT_ROOT/kade" ] && echo "kade/: EXISTS" || echo "kade/: MISSING"
[ -f "$PROJECT_ROOT/kade/AGENTS.md" ] && echo "kade/AGENTS.md: EXISTS" || echo "kade/AGENTS.md: MISSING"
[ -f "$PROJECT_ROOT/kade/KADE.md" ] && echo "kade/KADE.md: EXISTS" || echo "kade/KADE.md: MISSING"
echo "=== Skill link ==="
[ -d "$PROJECT_ROOT/.agents/skills/g-kade" ] && echo "skill: EXISTS" || echo "skill: MISSING"
[ -d "$PROJECT_ROOT/.claude/skills/g-kade" ] && echo "claude-skill: EXISTS" || echo "claude-skill: MISSING"
```

### Step I-3: Install skill into project

Link the g-kade skill into whichever skills directory the project uses:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SKILL_SRC="$HOME/.claude/skills/gstack/g-kade"

# Prefer .agents/skills if it exists, else .claude/skills
if [ -d "$PROJECT_ROOT/.agents/skills" ]; then
  SKILL_DEST="$PROJECT_ROOT/.agents/skills/g-kade"
elif [ -d "$PROJECT_ROOT/.claude/skills" ]; then
  SKILL_DEST="$PROJECT_ROOT/.claude/skills/g-kade"
else
  mkdir -p "$PROJECT_ROOT/.agents/skills"
  SKILL_DEST="$PROJECT_ROOT/.agents/skills/g-kade"
fi

if [ ! -e "$SKILL_DEST" ]; then
  ln -sf "$SKILL_SRC" "$SKILL_DEST" 2>/dev/null || cp -Rf "$SKILL_SRC" "$SKILL_DEST"
  echo "Installed g-kade skill at $SKILL_DEST"
else
  echo "Skill already present at $SKILL_DEST"
fi
```

### Step I-4: Scaffold global HUMAN.md if missing

If `~/.kade/HUMAN.md` does not exist, create it from the kade-hq template:

```bash
mkdir -p "$HOME/.kade"
HUMAN_SRC=""
# Try known kade-hq locations in order
for p in \
  "$HOME/.agents/skills/kade-hq/templates/HUMAN.md" \
  "$HOME/.agents/skills1/kade-hq/templates/HUMAN.md" \
  "$HOME/.claude/skills/kade-hq/templates/HUMAN.md"; do
  [ -f "$p" ] && HUMAN_SRC="$p" && break
done
if [ -n "$HUMAN_SRC" ]; then
  cp "$HUMAN_SRC" "$HOME/.kade/HUMAN.md"
  echo "Created ~/.kade/HUMAN.md from template"
else
  echo "HUMAN_SRC_NOT_FOUND"
fi
```

If `HUMAN_SRC_NOT_FOUND`, create `~/.kade/HUMAN.md` with this minimal content (fill in known details about the user from memory):

```markdown
# HUMAN.md — Agent's Guide to Working with Me

## Identity
- Working Name: Kade
- Username: prest
- Timezone: <!-- fill in -->

## Cognitive Profile
- Neurodivergence: ADHD — needs tight feedback loops, clear checkpoints, executive function support
- Optimal Session Length: 45-90 minutes

## Communication Preferences
- Default Tone: direct and concise
- Jargon Tolerance: minimal — plain language preferred
- Response Structure: Echo goal → Status → Next steps (3-6) → Checkpoint question

## Safety Boundaries
- Always ask before destructive or irreversible changes
- STOP before: deleting files, modifying production config, refactoring >100 lines or >3 files

## Executive Function Support (Always Active)
- Session start: clarify goal → restate → propose plan → get approval
- Execution: small steps → checkpoint → drift prevention
- Session close: summarize → single next action
```

Tell the user: "Created `~/.kade/HUMAN.md` with defaults. Edit it to personalize — the more detail you add, the better every session gets."

### Step I-5: Scaffold project kade/ files

If `kade/AGENTS.md` is missing, generate it. Use the project's CLAUDE.md and any README to fill in what you can infer — leave `<!-- fill in -->` for anything uncertain.

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$PROJECT_ROOT/kade"
```

If `kade/AGENTS.md` does not exist: read `CLAUDE.md` (if present) and `README.md` (if present), then write `kade/AGENTS.md` by filling in the template below with everything you can infer. Leave `<!-- fill in -->` for genuinely unknown fields. Do NOT AskUserQuestion — infer, mark unknowns, move on.

Template for `kade/AGENTS.md`:
```markdown
# AGENTS.md — Machine-Readable Agent Instructions

> Read this BEFORE making changes to this project.

## Project Metadata
- **Name**: <!-- inferred from package.json / README -->
- **Description**: <!-- inferred -->
- **Goal**: <!-- inferred -->

## Stack
- **Language(s)**: <!-- inferred -->
- **Framework(s)**: <!-- inferred -->
- **Package Manager**: <!-- inferred -->

## Commands
<!-- Inferred from CLAUDE.md or package.json scripts -->

## Branch Strategy
<!-- Inferred from CLAUDE.md or git config -->

## Safety Boundaries
### Always ask before:
- Deleting files or data
- Modifying production config or secrets
- Destructive migrations
- Changing auth code
- Refactoring >100 lines or >3 files
- Installing new dependencies

*Generated by /g-kade install*
```

If `kade/KADE.md` does not exist, create it:
```markdown
# KADE.md — Project Manual & Handoff Log

## Project Overview
<!-- Inferred from README / CLAUDE.md -->

## Handoff Log

<!-- Newest entries at the top. Format:
📅 YYYY-MM-DDTHH:MM:SS±HH:MM — Subject
Changed: [what changed]
Files: [file paths]
Why: [reasoning]
Verified: ✓ [tests/checks]
Next: [single next action]
-->

*Created by /g-kade install*
```

### Step I-6: Report

Tell the user what was installed/created, then ask: "Want to fill in HUMAN.md now, or shall we start a session?"

If they want to fill in HUMAN.md — read it, walk through each `<!-- fill in -->` field as a focused AskUserQuestion, update the file.

---

## Session Mode

When invoked without `install`, run a KADE-structured session using gstack tools.

### Step 0: Load KADE context

```bash
[ -f "$HOME/.kade/HUMAN.md" ] && echo "=== HUMAN.md ===" && cat "$HOME/.kade/HUMAN.md" || echo "HUMAN_MISSING"
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
[ -f "$PROJECT_ROOT/kade/AGENTS.md" ] && echo "=== AGENTS.md ===" && cat "$PROJECT_ROOT/kade/AGENTS.md" || echo "AGENTS_MISSING"
[ -f "$PROJECT_ROOT/kade/KADE.md" ] && echo "=== KADE.md (last 40 lines) ===" && tail -40 "$PROJECT_ROOT/kade/KADE.md" || echo "KADE_MISSING"
```

- If `HUMAN_MISSING`: suggest running `/g-kade install` first. Offer to continue without it (applying KADE defaults for ADHD support).
- If `AGENTS_MISSING`: note that project context is limited — infer from CLAUDE.md if present.
- Apply the user profile from HUMAN.md to every response going forward (tone, format, ADHD support level, etc.).

### Step 1: Session opener

Read the current branch and recent git log:

```bash
git branch --show-current
git log --oneline -5
```

State (in one line each):
- Current branch
- Last action on this branch (from log)
- Latest entry in kade/KADE.md handoff log (if present)

Then: **Clarify the session goal.** Ask one focused question: *"What do you want to accomplish this session?"* Do not list options — let the user state it.

### Step 2: Plan

Once you understand the goal, map it to gstack skills and propose a 3-6 step plan. Be concrete:

| User goal | Likely gstack skill(s) |
|-----------|----------------------|
| Review / check code quality | `/review` |
| Ship a feature | `/ship` (includes `/review`) |
| QA test the app | `/qa` or `/qa-only` |
| Debug a bug | `/investigate` |
| Deploy to prod | `/land-and-deploy` |
| Design something | `/design-consultation`, `/design-shotgun`, `/design-html` |
| Security audit | `/cso` |
| Performance check | `/benchmark` |
| Post-ship docs | `/document-release` |
| Retrospective | `/retro` |
| General browser task | `/browse` |

Present the plan as numbered steps with skill names. Example:
> 1. Run `/review` on current diff — check for issues before shipping
> 2. Fix any blockers found
> 3. Run `/ship` — bump version, create PR
>
> Does this look right, or want to adjust?

Get explicit approval before proceeding.

### Step 3: Execute

Run each step. For each gstack skill invocation:
- **Before**: state what you're about to do in one sentence
- **After**: summarize what happened in 2-3 bullets
- **Checkpoint**: ask "Continue to next step?" or "Anything to adjust?"

Apply KADE drift prevention throughout:
- Off-topic question mid-task → "Should we finish [current step] first, or switch?"
- Stuck / uncertain → offer 2-3 concrete options with tradeoffs, give a recommendation
- User returns after silence → restate where we left off in one sentence

### Step 4: Handoff

At session close (user says done, or all steps complete), write a handoff entry to `kade/KADE.md`:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
KADE_LOG="$PROJECT_ROOT/kade/KADE.md"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S+00:00")
```

Append to `$KADE_LOG` (create the Handoff Log section if it doesn't exist):

```
📅 {TIMESTAMP} — {session subject, e.g. "Shipped feature X"}
Changed: {brief summary of what changed}
Files: {key files touched}
Why: {reason / goal}
Verified: ✓ {what was tested or confirmed}
Next: {single next action for Kade}
```

Then close the session with:
1. One-paragraph summary of what was accomplished
2. The single next action (from the handoff log)
3. Time estimate for the next action

---

## Quick Reference

```
/g-kade install    — scaffold KADE files into current project, link skill
/g-kade            — start a KADE-structured gstack session
```

KADE context files:
- `~/.kade/HUMAN.md` — your global user profile (edit to personalize)
- `[project]/kade/AGENTS.md` — project rules for agents
- `[project]/kade/KADE.md` — project manual + handoff log
