# Cline Chat Panel UX Edge-Case Audit

Date: 2026-05-05
Scope: `web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx` plus the Cline chat composer/message/session/controller hooks.

## Risk ranking

1. Medium - scroll lock can miss non-message height changes while the user appears pinned to bottom.
2. Medium - imperative `sendText` can attempt sends during a running/blocked session and only surfaces a generic error path.
3. Low/Medium - credit-limit UI is visually distinguished, but the generic panel error can still duplicate or compete with it.
4. Low - image attachment render path is wired through to data URIs, with remaining risk around MIME/data validation and large payload UX.
5. Low - running/awaiting/interrupted indicators are mostly covered, but the resume/blocked copy should get explicit regression tests.

## Findings and suggested fixes

### 1) Scroll-to-bottom behavior

Current behavior:
- `BOTTOM_LOCK_THRESHOLD_PX = 24` and `isPinnedToBottom()` derive bottom lock from `scrollHeight - scrollTop - clientHeight`.
- `useLayoutEffect` sets `scrollTop = scrollHeight` when auto-scroll is enabled and any of `messages`, `showAgentProgressIndicator`, `showActionFooter`, `showReviewActions`, or `showCancelAutomaticAction` changes.
- Tests cover streaming a new message, disabling auto-scroll after a manual upward scroll, re-enabling near the bottom, and action footer appearance.

Risks:
- The dependencies cover React state changes but not late DOM height changes inside an existing message, such as image decode, Markdown/code rendering, font reflow, or expanding/collapsing a tool block. If the user is pinned before that height change, the panel can drift above bottom because no dependency changed.
- The 24px threshold is likely okay for normal wheel/touchpad rounding, but it is small for high-DPI trackpads or content that grows between scroll events. A user who is visually at bottom but 25-40px away after a layout shift will be treated as unlocked.
- Tool expansion while unlocked is good because it should not force-scroll; tool expansion while locked should keep bottom pinned, but today it depends on incidental state changes outside the scroll effect.

Suggested fixes/tests:
- Add a bottom sentinel with `scrollIntoView({ block: "end" })` or a `ResizeObserver` on the message list/content wrapper that only scrolls when `isAutoScrollEnabled` is true.
- Add focused tests for: (a) pinned + existing message grows -> stays at bottom, (b) unlocked + existing message grows -> preserves `scrollTop`, (c) pinned + tool block expands -> stays at bottom, (d) unlocked + tool block expands -> does not jump.
- Consider a slightly larger threshold (32-48px) or a sticky "new activity" affordance if the user is near, but not at, bottom.

### 2) State transitions and indicators

Current behavior:
- `running` shows `Thinking...` only when no visible assistant/reasoning/tool activity is present.
- Assistant/reasoning chunks suppress the shimmer for a short grace period; visible running tool rows suppress it longer.
- `awaiting_review` displays review actions only when the task is in the review column, callbacks exist, and workspace metadata reports changed files.
- `interrupted` does not show the running shimmer; credit-limit metadata can still show the credit notice.

Risks:
- `canSend` is derived from local send/load/cancel state, not `summary.state`, so the composer can remain enabled while the backend considers the task `running` unless the backend rejects queued/steered input intentionally. This may be desired for steering, but the UI does not make that distinction clear.
- `canCancel` is tied to `summary.state === "running"`; if the summary lags while a send is in flight, the send button can display the spinner/send path before it becomes a pause/cancel affordance.
- The task asked for resume prompt behavior; this panel does not appear to render a dedicated resume prompt for `interrupted`. If resume lives elsewhere, add a cross-surface test; if not, this is a UX gap.

Suggested fixes/tests:
- Add controller tests for `idle -> running -> awaiting_review -> interrupted` with assertions for `canSend`, `canCancel`, shimmer visibility, review footer, credit notice, and any intended resume affordance.
- Clarify whether running-session sends are allowed as steering. If not, gate `canSend` on `summary.state !== "running"`; if yes, update labels/copy to communicate "send follow-up/steer" vs "start turn".

### 3) Image attachment flow

Current behavior:
- Composer paste/drop reads image files into `TaskImage[]` and clears `draftImages` after a successful draft send.
- `useClineChatSession.sendMessage()` allows image-only messages and forwards images to the runtime action.
- Backend conversion sends SDK images as `data:${mimeType};base64,${data}`.
- User messages render `TaskImageStrip`, which uses the same data URI form for previews.

Risks:
- Rendering trusts `mimeType` and `data` from persisted/runtime messages. The schema only requires strings. Browser `<img>` limits script execution for normal image MIME types, but malformed MIME/data values can still create broken previews or very large DOM payloads.
- The imperative `sendText` handle cannot include images; that is probably correct for review comments, but callers should not assume it sends the current draft attachments.
- If an image send fails, `draftImages` are preserved because they only clear on `sent === true`, which is good.

Suggested fixes/tests:
- Add a component test that asserts the rendered image `src` equals `data:image/png;base64,abc123`, not just that an `<img>` exists.
- Consider validating/normalizing MIME types at ingest to `image/*` and adding size/count guard UX beyond the existing file count.

### 4) Imperative handle: `appendToDraft` and `sendText`

Current behavior:
- `appendToDraft` appends trimmed text to the draft regardless of task state; it ignores empty input and preserves existing draft content.
- `sendText` persists unsaved model settings, then calls `handleSendText(text, mode)` without touching the visible draft.
- Existing tests cover draft preservation and mode propagation in idle state.

Risks:
- `sendText` does not check `canSend`, so diff review comments can be dispatched while the composer is disabled/running/loading. The hook-level `sendMessage` only checks for a callback and non-empty text/images; it does not check `isSending`, `isLoading`, `isCanceling`, or `summary.state`.
- Double-clicks or multiple diff comments can race because `isSending` state is not consulted inside `sendMessage`; concurrent calls may both reach `onSendMessage` before React state disables UI.
- `appendToDraft` while the composer is disabled is probably safe, but it does not focus or reveal the composer after diff collapse.

Suggested fixes/tests:
- Gate `sendMessage` or `handleSendComposerText` with the same effective `canSend` policy used by the composer, especially `isSending/isLoading/isCanceling`.
- Add tests for `sendText` during `running`, while `onLoadMessages` is pending, and after a failed send to confirm expected no-op/error behavior.
- If running steering is intentional, add a separate `canSteer` concept and use that in the imperative path.

### 5) Credit-limit notice behavior

Current behavior:
- `ClineCreditLimitNotice` appears when `summary.latestHookActivity.notificationType === "credit_limit"` and resets on task changes.
- The notice is distinct from generic `panelError`, links to `https://app.cline.bot/`, and persists across `awaiting_review`/`interrupted` when metadata persists.

Risks:
- If the send action also returns an error message for the same credit-limit event, the red panel error can appear with the orange credit notice, producing duplicated or conflicting messaging.
- The notice relies solely on `latestHookActivity.notificationType`; older persisted messages or runtime failures without that metadata fall back to generic errors.

Suggested fixes/tests:
- If runtime action errors can identify credit limits, return a typed action error or notification type and suppress the generic red error when the orange notice is shown.
- Add tests for non-credit errors to verify they do not show the credit notice, and credit-limit send failures to verify the notice wins over generic error text.

## Focused validation to keep

Run from repo root:

```sh
npm --prefix web-ui run test -- --run src/components/detail-panels/cline-agent-chat-panel.test.tsx src/hooks/use-cline-chat-panel-controller.test.tsx src/hooks/use-cline-chat-session.test.tsx
```

If the default Vitest forks pool cannot start workers in the local WSL/Windows workspace, rerun with:

```sh
npm --prefix web-ui run test -- --run --pool=vmThreads src/components/detail-panels/cline-agent-chat-panel.test.tsx src/hooks/use-cline-chat-panel-controller.test.tsx src/hooks/use-cline-chat-session.test.tsx
```

2026-05-05 validation:
- Default pool: failed before tests with `[vitest-pool-runner]: Timeout waiting for worker to respond`.
- `--pool=vmThreads`: passed, 3 files / 35 tests, duration 364.40s.
- Re-run in repo workspace: `--pool=vmThreads` passed, 3 files / 35 tests, duration 156.09s.

Add the new focused cases above to the same files before changing scroll lock, running/steering send policy, or credit-limit error typing.
