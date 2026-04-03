# Unified PRD

## Intent

Capture the parts of HolyClaude that are worth adopting in Kanban without replacing Kanban's existing runtime, session, or worktree architecture.

Decision baseline:

- Keep Kanban's current backend and runtime model.
- Borrow infrastructure and packaging ideas only where they improve hosted, containerized, or remote usage.

## Current decision

Kanban already has stronger product-specific backend plumbing than HolyClaude:

- task-scoped runtime server and API
- websocket state fanout
- native Cline session orchestration
- PTY-backed multi-agent terminal sessions
- task worktree creation, patch capture, and resume flows

HolyClaude should be treated as a reference for container and workstation packaging, not as a backend replacement.

## Non-goals

- Do not replace Kanban's runtime server with CloudCLI.
- Do not replace Kanban's tRPC or websocket state model.
- Do not replace task worktree management with a generic container workspace model.
- Do not adopt HolyClaude's UI as the primary Kanban interface.
- Do not couple Kanban's product architecture to s6 or Docker-specific assumptions.

## Candidate items to take

### 1. Official Kanban workstation container

Build an official container image for remote or hosted Kanban usage that preinstalls:

- supported agent CLIs Kanban already launches
- Chromium plus Playwright-ready dependencies
- common dev utilities Kanban sessions benefit from
- GitHub CLI and other repo-facing tooling used by agents

Expected value:

- faster setup for remote demos, Codespaces-style usage, and self-hosting
- fewer "works on my machine" environment mismatches
- a reproducible baseline for browser automation and screenshots

### 2. First-boot bootstrap pattern

Adopt HolyClaude's sentinel-based first-boot setup pattern for containerized Kanban environments:

- run one-time initialization only on first boot
- seed default config and memory files once
- preserve user edits on subsequent boots
- allow manual re-bootstrap by deleting a sentinel file

Expected value:

- safer default provisioning
- fewer accidental overwrites of user-customized config

### 3. UID and GID remapping for host-mounted volumes

For Docker-based Kanban deployments, support host-matching UID and GID remapping so bind-mounted files are writable from both host and container.

Expected value:

- fewer permission failures on Linux, NAS, and WSL-backed setups

### 4. Fragile file pre-creation during startup

Pre-create known config files before bind mounts or startup logic depend on them, especially files that Docker can accidentally create as directories when mounts are mis-specified.

Examples to evaluate:

- Kanban runtime config files
- agent config files Kanban expects to exist as files
- browser or auth state files for hosted mode

Expected value:

- fewer bootstrap edge cases
- cleaner failure modes for hosted installs

### 5. Headless browser service defaults for hosted mode

Adopt HolyClaude's practical browser-hosting defaults for a Kanban container profile:

- Xvfb-backed display for Chromium
- documented shared memory requirements
- documented seccomp and capability requirements where unavoidable
- explicit browser environment variables in the image

Expected value:

- more reliable Playwright, screenshots, and browser-driven QA in remote environments

### 6. Hosted persistence layout

Define an official persistence model for hosted Kanban:

- persistent config and auth volume
- persistent workspace volume
- clear separation between durable user data and disposable runtime state

Expected value:

- easier upgrades
- easier backup and restore
- clearer operator mental model

### 7. Remote-filesystem and NAS compatibility guidance

Document and optionally support:

- polling-based file watching on SMB or CIFS mounts
- warnings around SQLite on network filesystems
- recommended local-only storage for lock-sensitive state

Expected value:

- fewer hard-to-diagnose remote deployment issues

### 8. Optional notification hooks for hosted sessions

Evaluate a Kanban-native notification layer for remote usage inspired by HolyClaude's stop and error hooks:

- task completed
- task entered review
- task failed
- long-running task stalled

Expected value:

- better unattended workflows
- better remote operations feedback

## Integration approach

Preferred approach:

- add these ideas as a new deployment and packaging lane around Kanban
- keep the existing runtime and UI contracts intact
- isolate Docker and supervisor concerns behind a dedicated container profile

Likely implementation slices:

1. Container image and compose profile for Kanban
2. First-boot bootstrap plus persistence conventions
3. Hosted browser runtime support
4. Remote deployment and troubleshooting docs
5. Optional notifications

## Proposed first increment

Start with the lowest-risk, highest-payoff packaging work:

1. Create a Kanban Docker image with Chromium, Playwright dependencies, and the supported agent CLIs.
2. Add first-boot bootstrap plus UID and GID remapping for bind-mounted volumes.
3. Document required volume layout, `shm_size`, and remote filesystem caveats.

This captures most of the value from HolyClaude without touching Kanban's core backend.

## Items not worth taking right now

- CloudCLI as the main web interface
- HolyClaude's application layer as a runtime abstraction
- any replacement of Kanban's task session model with a generic single-workspace shell model
- any migration that weakens task worktrees, checkpointing, or review-state semantics

## Open questions

- Which agent CLIs should an official Kanban image ship by default versus leave optional?
- Should hosted browser support be built into the main image or split into a heavier variant?
- Do we want Docker-only support, or also a devcontainer or Codespaces profile?
- Should notifications be runtime-native, hook-based, or both?

## Source references

- HolyClaude `README.md`
- HolyClaude `docs/architecture.md`
- HolyClaude `Dockerfile`
- HolyClaude `scripts/entrypoint.sh`
- HolyClaude `scripts/bootstrap.sh`
