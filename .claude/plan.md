# Plan: Channel Default Workspace Fallback

## Problem

When a user tells AI "this channel's default workspace is X", it gets saved as a preference memory. However, the host-level `resolveWorkspaceStep` only looks at:

1. `workspaceOverride`
2. existing session history
3. message text matching against `WorkspaceResolver`

The preference memory is never consulted by the system, so new threads in that channel get `workspace: undefined` and no `_Working in ..._` context block appears.

## Solution

Add a structured `ChannelPreferenceStore` and a new MCP tool so the AI can explicitly set a channel default workspace, and the conversation pipeline can fallback to it when workspace resolution is `missing`.

## Implementation Steps

### 1. Database & Store Layer

- **File**: `src/db/schema.ts`
  - Add `channelPreferences` table: `channel_id TEXT PRIMARY KEY`, `default_workspace_input TEXT`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`.
- **File**: `src/db/index.ts`
  - Add `CREATE TABLE IF NOT EXISTS channel_preferences (...)` raw SQL.
- **File**: `src/channel-preference/types.ts` (new)
  - Define `ChannelPreferenceRecord` and `ChannelPreferenceStore` interface (`get`, `upsert`).
- **File**: `src/channel-preference/sqlite-channel-preference-store.ts` (new)
  - Implement `SqliteChannelPreferenceStore` following existing store patterns.

### 2. Dependency Injection

- **File**: `src/application.ts`
  - Instantiate `SqliteChannelPreferenceStore` and pass to `createSlackApp`.
- **File**: `src/slack/app.ts`
  - Add `channelPreferenceStore` to `SlackApplicationDependencies` and forward via `ingressDeps`.
- **File**: `src/slack/ingress/types.ts`
  - Add `channelPreferenceStore` to `SlackIngressDependencies`.

### 3. Pipeline Integration

- **File**: `src/slack/ingress/workspace-resolution.ts`
  - Update `resolveWorkspaceForConversation` signature to accept `channelPreferenceStore`.
  - When resolution is `missing` and there is no existing session workspace, call `channelPreferenceStore.get(channelId)`.
  - If a `default_workspace_input` exists, run it through `workspaceResolver.resolveManualInput(...)` and use that result.
- **File**: `src/slack/ingress/conversation-pipeline.ts`
  - Update `resolveWorkspaceStep` to pass `deps.channelPreferenceStore` and `message.channel` into the resolution function.

### 4. MCP Tool for AI

- **File**: `src/agent/providers/claude-code/schemas/channel-preference-tools.ts` (new)
  - Define Zod schema for `SetChannelDefaultWorkspaceToolInput`.
- **File**: `src/agent/providers/claude-code/mcp-server.ts`
  - Register the new tool; on invocation, write to `channelPreferenceStore` via the request context.
- **File**: `src/agent/slack-runtime-tools.ts`
  - Add tool name constant and description if needed.

### 5. Testing

- **File**: `tests/workspace-resolution.test.ts` (new or existing)
  - Unit test the fallback logic: when `missing`, it reads the store and resolves the saved input.
- **File**: `src/e2e/live/run-channel-default-workspace.ts` (new)
  - Live E2E: set default workspace via slash command or message, start a new thread without mentioning a repo, assert that the first reply contains the `Working in ...` context block.

## Trade-offs

- **Structured store vs memory parsing**: We avoid brittle NLP parsing of preference memories. The AI explicitly calls a tool (or we could add a slash command `/channel_workspace <path>`) to set the default.
- **Scope**: This only affects workspace _fallback_ for new threads; per-thread session overrides and message text matches still take precedence.
