# Cline Native Chat Lifecycle Validation

Use this focused recipe when changing the native Cline chat/lifecycle surface. Run commands from the listed working directory; keep full-suite/typecheck runs for release gates or broad contract changes.

## Focused backend commands

Working directory: repo root.

### Cline SDK service coverage

Covers task/session lifecycle ownership, context-overflow recovery, message persistence, and MCP runtime service behavior.

```sh
npm test -- --run test/runtime/cline-sdk/cline-task-session-service.test.ts test/runtime/cline-sdk/cline-session-runtime.test.ts test/runtime/cline-sdk/cline-context-overflow-compaction.test.ts test/runtime/cline-sdk/cline-message-repository.test.ts test/runtime/cline-sdk/cline-mcp-runtime-service.test.ts
```

### Cline event adapter coverage

Covers SDK event-to-Kanban-message/status conversion, tool/result mapping, and event ordering assumptions.

```sh
npm test -- --run test/runtime/cline-sdk/cline-event-adapter.test.ts
```

### Runtime API coverage

Covers tRPC/runtime API behavior that starts, stops, reloads, sends to, and observes native Cline task sessions.

```sh
npm test -- --run test/runtime/trpc/runtime-api.test.ts
```

### Terminal adapter non-regression coverage

Covers non-Cline terminal/session-manager adapters so Cline native-chat changes do not regress PTY-backed agents or session auto-restart behavior.

```sh
npm test -- --run test/runtime/terminal/agent-session-adapters.test.ts test/runtime/terminal/agent-registry.test.ts test/runtime/terminal/session-manager.test.ts test/runtime/terminal/session-manager-auto-restart.test.ts
```

## Focused web-ui commands

Working directory: repo root. These invoke the web-ui Vitest config through `npm --prefix web-ui`.

### Cline chat hook/component coverage

Covers native-agent routing, task session hooks, Cline chat session/actions/controller hooks, runtime settings Cline controllers, home/sidebar Cline sessions, detail chat panel components, message/model helpers, add-provider dialog, and composer completion behavior.

```sh
npm --prefix web-ui run test -- --run src/runtime/native-agent.test.ts src/hooks/use-task-sessions.test.tsx src/hooks/use-cline-chat-session.test.tsx src/hooks/use-cline-chat-runtime-actions.test.tsx src/hooks/use-cline-chat-panel-controller.test.tsx src/hooks/use-runtime-settings-cline-controller.test.tsx src/hooks/use-runtime-settings-cline-mcp-controller.test.tsx src/hooks/use-home-sidebar-agent-panel.test.tsx src/hooks/use-home-agent-session.test.tsx src/components/detail-panels/cline-agent-chat-panel.test.tsx src/components/detail-panels/cline-chat-message-utils.test.ts src/components/detail-panels/cline-chat-model-selector.test.tsx src/components/detail-panels/cline-model-picker-options.test.ts src/components/detail-panels/cline-chat-composer-completion.test.ts src/components/shared/cline-add-provider-dialog.test.tsx
```

If debugging from `web-ui/` directly, drop the prefix and use the same file list:

```sh
npm run test -- --run src/runtime/native-agent.test.ts src/hooks/use-task-sessions.test.tsx src/hooks/use-cline-chat-session.test.tsx src/hooks/use-cline-chat-runtime-actions.test.tsx src/hooks/use-cline-chat-panel-controller.test.tsx src/hooks/use-runtime-settings-cline-controller.test.tsx src/hooks/use-runtime-settings-cline-mcp-controller.test.tsx src/hooks/use-home-sidebar-agent-panel.test.tsx src/hooks/use-home-agent-session.test.tsx src/components/detail-panels/cline-agent-chat-panel.test.tsx src/components/detail-panels/cline-chat-message-utils.test.ts src/components/detail-panels/cline-chat-model-selector.test.tsx src/components/detail-panels/cline-model-picker-options.test.ts src/components/detail-panels/cline-chat-composer-completion.test.ts src/components/shared/cline-add-provider-dialog.test.tsx
```

## Typecheck gates

Run `npm run typecheck` from the repo root when backend/runtime/shared TypeScript contracts changed, imports moved, Cline SDK boundary types changed, or before declaring a backend Cline lifecycle change ready.

Run `npm --prefix web-ui run typecheck` from the repo root when React hooks/components/runtime client types changed, shared API types changed, or before declaring a web Cline chat change ready.

Run both typechecks before release-candidate handoff, after cross-boundary changes, or after any edit that changes public/runtime API shapes used by web-ui.

## Smoke result

2026-05-05 smoke run from repo root:

```sh
npm test -- --run test/runtime/cline-sdk/cline-event-adapter.test.ts
```

Result: passed, 1 file / 16 tests, duration 12.53s.
