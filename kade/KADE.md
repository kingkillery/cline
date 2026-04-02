# KADE.md - Project Manual & Handoff Log

## Project Overview
Cline is an open-source VS Code extension and companion CLI for agentic coding workflows. The repo includes the extension, CLI, webview UI, tests, docs, and supporting scripts for packaging, proto generation, and evaluation.

## Current Working Goal
Improve streaming and user feedback in the Kanban flow so users can quickly tell whether a task is actively progressing, slow, or likely stuck.

## Handoff Log

2026-04-02T07:30:00+00:00 - Discovered Kanban UI features need to be built in kanban repo, not pk-cline
Changed: Investigated the Kanban board architecture. The Kanban web UI is a separate package (github.com/cline/kanban) that orchestrates agent CLIs as subprocesses. Our pk-cline changes only affect the Cline VS Code extension webview and CLI agent, NOT the Kanban web UI. The "no output" issue in Kanban is a kanban package bug. Cloned kanban repo to C:\Dev\Desktop-Projects\kanban for next session.
Files: (no code changes, investigation only)
Why: User wants the 4 UI features (dynamic phases, metadata, plain mode, streaming) in the Kanban web UI, not just the VS Code extension.
Verified: Confirmed kanban config uses Claude Code agent, task 2d6a8 has no session entry despite being "In Progress"
Next: Switch to C:\Dev\Desktop-Projects\kanban repo and build the 4 UI features into the Kanban web UI source.

2026-04-02T05:50:00+00:00 - Implemented 4 UI/UX enhancement features
Changed: (1) Dynamic system feedback replacing static "Thinking..." with phased status labels (Analyzing request, Waiting for model, Drafting response, Running tools). (2) History card metadata with status dots, mode badges, provider info, cwd, and filter chips. (3) Plain Mode and Animation Toggle settings with CSS data-attribute gating. (4) Streaming UI polish with content slide-in animations and streaming shimmer indicator.
Files: src/shared/TaskPhase.ts (new), src/shared/ExtensionMessage.ts, src/shared/HistoryItem.ts, src/shared/storage/state-keys.ts, proto/cline/ui.proto, proto/cline/task.proto, proto/cline/state.proto, src/shared/proto-conversions/cline-message.ts, src/core/task/index.ts, src/core/task/message-state.ts, src/core/controller/index.ts, src/core/controller/state/updateSettings.ts, src/core/controller/task/getTaskHistory.ts, webview-ui/src/App.tsx, webview-ui/src/theme.css, webview-ui/src/context/ExtensionStateContext.tsx, webview-ui/src/components/chat/ChatRow.tsx, webview-ui/src/components/chat/RequestStartRow.tsx, webview-ui/src/components/chat/chat-view/components/layout/MessagesArea.tsx, webview-ui/src/components/history/HistoryView.tsx, webview-ui/src/components/history/HistoryViewItem.tsx, webview-ui/src/components/settings/sections/FeatureSettingsSection.tsx
Why: Users had no visibility into what the system was doing during long processing. History cards lacked context. No way to reduce UI noise.
Verified: npm run check-types passes all 3 packages (root, webview, CLI). npm run lint clean. Pre-existing test failures (144) unchanged.
Next: Test the 4 features end-to-end in a running VS Code instance. Validate phase labels cycle correctly during a real prompt. Check history card filters and Plain Mode toggle.

2026-04-01T22:09:58-06:00 - Added ACP heartbeats for Kanban-visible progress
Changed: Added low-noise ACP heartbeat updates during long silent processing windows so Kanban/ACP consumers can distinguish active waiting from likely-stalled work.
Files: cli/src/agent/ClineAgent.ts, cli/src/agent/ClineAgent.test.ts
Why: Kanban feedback was too quiet during long waits, making it hard to tell whether a run was alive or wasting time.
Verified: cli `npx tsc --noEmit --pretty false`; cli `npm run test:run -- src/agent/ClineAgent.test.ts -t "getProcessingHeartbeatSnapshot"`; full `ClineAgent.test.ts` still has a pre-existing HostProvider setup failure in an older test
Next: Validate the new ACP heartbeat text in a real Kanban run and decide whether to surface richer backend phases beyond model-vs-tool waiting.

<!-- Newest entries at the top. Format:
YYYY-MM-DDTHH:MM:SS+00:00 - Subject
Changed: [what changed]
Files: [file paths]
Why: [reasoning]
Verified: [tests/checks]
Next: [single next action]
-->

*Created by /g-kade install*
