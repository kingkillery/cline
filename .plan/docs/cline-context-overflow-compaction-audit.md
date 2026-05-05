# Cline context overflow compaction audit

Task: `t_ed1731dd`
Date: 2026-05-05

## Scope

Audit `src/cline-sdk/cline-context-overflow-compaction.ts`, which has a TODO to remove Kanban's inline fallback once SDK-side pluggable compaction policies are available. Checked the installed SDK packages in this workspace (`@clinebot/core`, `@clinebot/agents`, `@clinebot/llms` at v0.0.24) and the Kanban Cline boundary layer.

## SDK capability finding

`@clinebot/core@0.0.24` does not appear to expose SDK-side pluggable context compaction policies suitable for replacing Kanban's inline fallback yet.

Evidence:

- `node_modules/@clinebot/core/package.json` reports version `0.0.24`.
- `node_modules/@clinebot/core/src/types/config.ts` exposes `CoreSessionConfig.hooks?: AgentHooks`, but no compaction policy option.
- `node_modules/@clinebot/agents/src/types.ts` exposes `AgentConfig.hooks?: AgentHooks`, but `AgentHooks` has lifecycle hooks like `onSessionStart`, `onRunStart`, `onTurnStart`, `onToolCallStart`, `onToolCallEnd`, `onStopError`, etc. It has no `onPreCompact` hook and no host-provided message compaction callback.
- `node_modules/@clinebot/agents/src/hooks/subprocess.ts` has a `pre_compact` subprocess hook payload shape, but the public `AgentHooks` interface does not expose an equivalent pluggable compaction implementation hook, and searching the agents package found no actual context-compaction execution path that would rewrite messages before retrying.
- The current `SessionHost.start` path that Kanban calls accepts `initialMessages`, but not a compaction strategy object or policy callback.

Conclusion: keep the Kanban fallback for now. Do not remove `src/cline-sdk/cline-context-overflow-compaction.ts` until the SDK adds a real host-facing compaction policy API or a first-class SDK overflow recovery path that Kanban can configure.

## Current Kanban fallback behavior

Current implementation:

1. Detects context overflow by matching thrown `Error.message` against a local regex list.
2. Reads persisted SDK messages for the task.
3. Drops the first half of the message array.
4. Advances to the first retained message whose role is `user`.
5. Prepends a text notice to that retained user message containing a 300-character preview of the first removed user message.
6. Restarts the SDK session with `initialMessages: compactedMessages` and the current prompt/images.

This is a reasonable emergency fallback, but it is not safe for all SDK message shapes.

## Correctness audit by message type

### Plain text user/assistant messages

Mostly OK. String content is preserved; the prepended notice is safe for string or block-array content.

Risk: The fallback only preserves a tiny preview of the original first user message, not a real summary. Recovery quality may be poor, but the message shape remains valid.

### File blocks

Mostly OK for retained messages. The preview uses `block.path`, so it avoids copying potentially huge file content into the notice.

Risk: The retained conversation may reference prior file reads that were removed, so downstream reasoning can still be incomplete.

### Image blocks

Shape-preserving for retained images, but preview quality is poor. `readMessagePreview` falls through to `[image]` for any unknown block type, including actual `image` blocks, which is safe but not informative.

Risk: If the initial discarded request was image-only, the notice says only `[image]`; the restarted model cannot see the removed image.

### Thinking / redacted thinking blocks

Retained `thinking` and `redacted_thinking` blocks are preserved structurally because compaction only slices whole messages and prepends a user text block. Preview uses `thinking` text and `[redacted_thinking]` for the first removed user message, although thinking blocks normally occur in assistant messages.

Risk: Keeping assistant thinking blocks without the exact preceding provider context may be provider-sensitive. Some providers validate reasoning signatures or call IDs. Since compaction can remove earlier messages while retaining later signed thinking/tool-use sequences, provider-native replay may be invalid even when the local TypeScript shape is valid.

### Tool use / tool result blocks

This is the largest correctness issue.

The fallback starts at the first retained `user` message. In the SDK message model, user messages can contain `tool_result` blocks that respond to a preceding assistant `tool_use`. If the preceding assistant `tool_use` was in the discarded half, the compacted history starts with or contains orphaned `tool_result` blocks. Provider transforms map those to provider-native tool result messages (e.g. `role: tool` / `tool_call_id` for OpenAI-style providers), which usually require a matching previous assistant tool call. That can create invalid API requests or confusing model state.

Also, `readMessagePreview` handles `tool_result` as:

- string content: include the content;
- array content: return `[tool_result]`.

But `ToolResultContent.content` can be an array of text/image/file blocks. The preview therefore discards useful text/file-path information for non-string tool results.

## Recommended next steps

Do not remove the fallback in this task. Instead, harden it before depending on it operationally:

1. Add unit tests for `compactPersistedMessagesForContextOverflow` covering:
   - no messages / one message / no user message;
   - plain text messages;
   - array content with text, file, image, thinking, redacted thinking;
   - `tool_result.content` as an array;
   - a retained user message that starts with orphaned `tool_result`.
2. Change compaction to choose a safe restart boundary, not merely the first retained user message. At minimum, do not start with a user message whose content contains `tool_result` unless the corresponding assistant `tool_use` is also retained before it.
3. Consider stripping orphaned `tool_result` blocks from the first retained user message, with an explicit text note like `[Earlier tool result omitted during context compaction: <tool_use_id>]`, if keeping the paired assistant tool call would retain too much context.
4. Improve preview rendering for nested `tool_result.content` arrays by recursively summarizing text/file/image blocks.
5. Track the SDK issue/API surface to replace this with an SDK-native policy when a host-facing option exists. The likely integration point would be `CoreSessionConfig`/`AgentConfig`, not the current subprocess-only `pre_compact` event shape.

## Removal plan once SDK support exists

When SDK-side pluggable compaction is available:

1. Add a boundary-layer adapter in `src/cline-sdk/sdk-runtime-boundary.ts` that imports the SDK's compaction policy types/functions.
2. Wire the policy into `src/cline-sdk/cline-session-runtime.ts` where `sessionHost.start({ config, initialMessages, ... })` is called.
3. Replace `retryAfterContextOverflow` in `src/cline-sdk/cline-task-session-service.ts` with SDK-native retry/compaction behavior, preserving Kanban's user-facing recovery notice if the SDK does not emit an equivalent event.
4. Delete `src/cline-sdk/cline-context-overflow-compaction.ts` only after tests prove the SDK policy handles tool-use/tool-result pairing, reasoning blocks, file/image blocks, and metadata preservation.
5. Remove any tests that assert the inline fallback's exact slicing behavior; replace them with integration tests around the SDK policy adapter and restart flow.
