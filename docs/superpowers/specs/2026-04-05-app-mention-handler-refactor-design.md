# App Mention Handler Refactoring

Decompose `src/slack/ingress/app-mention-handler.ts` (906 lines) into focused modules with a pipeline-based orchestration pattern. Every extracted piece is independently unit-testable.

## Problem

`app-mention-handler.ts` has grown into a grab-bag of concerns:

- Handler factories for 4 Slack event types
- A 394-line `handleThreadConversation` orchestrator mixing session management, workspace resolution, activity tracking, and agent execution
- Bot message filtering and mention detection
- Workspace resolution and ambiguous-workspace UI
- Logging helpers
- Activity/progress state management with ~6 mutable variables in a single closure

The file is hard to test, hard to navigate, and hard to change safely.

## Approach: Pipeline pattern with full decomposition

Model `handleThreadConversation` as a pipeline of steps that enrich a shared context object. Each step is a standalone async function that either advances the pipeline or terminates it early. All supporting logic is extracted into focused single-concern modules.

## File structure

```
src/
├── logger/
│   └── runtime.ts                    # runtimeInfo / runtimeError / runtimeWarn (NEW)
└── slack/
    └── ingress/
        ├── app-mention-handler.ts    # Handler factories only (~100 lines)
        ├── conversation-pipeline.ts  # Pipeline runner + step definitions (NEW, ~120 lines)
        ├── activity-sink.ts          # createActivitySink() factory (NEW, ~180 lines)
        ├── message-filter.ts         # Bot/mention filtering + bot user ID resolver (NEW, ~100 lines)
        ├── session-manager.ts        # Session resolve/create/update (NEW, ~80 lines)
        ├── workspace-resolution.ts   # Workspace resolve + ambiguous UI blocks (NEW, ~100 lines)
        ├── slash-command-handler.ts   # (existing, updated imports only)
        └── types.ts                  # Shared ingress types (NEW, ~40 lines)
```

No single file exceeds ~180 lines. The original 906-line file becomes ~100 lines.

## Shared types (`ingress/types.ts`)

Extracted from the current file plus new pipeline types:

```typescript
// Re-exported existing interfaces (unchanged)
export interface SlackIngressDependencies {
  claudeExecutor: AgentExecutor;
  logger: AppLogger;
  memoryStore: MemoryStore;
  providerRegistry?: AgentProviderRegistry;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadContextLoader: SlackThreadContextLoader;
  workspaceResolver: WorkspaceResolver;
}

export interface ThreadConversationMessage {
  channel: string;
  team: string;
  text: string;
  thread_ts?: string | undefined;
  ts: string;
  user: string;
}

export interface ThreadConversationOptions {
  addAcknowledgementReaction: boolean;
  forceNewSession?: boolean;
  logLabel: string;
  rootMessageTs: string;
  workspaceOverride?: ResolvedWorkspace;
}

// Pipeline context — mutable, enriched by each step
export interface ConversationPipelineContext {
  client: SlackWebClientLike;
  deps: SlackIngressDependencies;
  message: ThreadConversationMessage;
  options: ThreadConversationOptions;
  threadTs: string;

  existingSession?: SessionRecord;
  workspace?: ResolvedWorkspace;
  resumeHandle?: string;
  threadContext?: NormalizedThreadContext;
  contextMemories?: ContextMemories;
  executor?: AgentExecutor;
}

// Step result — continue or terminate early
export type PipelineStepResult = { action: 'continue' } | { action: 'done'; reason: string };

export type PipelineStep = (ctx: ConversationPipelineContext) => Promise<PipelineStepResult>;
```

The context is mutable — each step enriches it in place. One context per conversation turn, never shared concurrently. Steps throw on real errors (caught at orchestrator level), so `PipelineStepResult` only models continue vs. early exit.

## Pipeline runner and steps (`conversation-pipeline.ts`)

### Runner

```typescript
export async function runConversationPipeline(
  ctx: ConversationPipelineContext,
  steps: PipelineStep[],
): Promise<void> {
  for (const step of steps) {
    const result = await step(ctx);
    if (result.action === 'done') return;
  }
}
```

### Default step sequence

```typescript
export const DEFAULT_CONVERSATION_STEPS: PipelineStep[] = [
  acknowledgeAndLog,
  resolveWorkspaceStep,
  resolveSessionStep,
  prepareThreadContext,
  executeAgent,
];
```

| Step                   | Responsibility                                                                       | Can early-exit? |
| ---------------------- | ------------------------------------------------------------------------------------ | --------------- |
| `acknowledgeAndLog`    | Log receipt, add reaction if needed, look up existing session                        | No              |
| `resolveWorkspaceStep` | Resolve workspace from text/session/override. If ambiguous → post picker UI → `done` | Yes             |
| `resolveSessionStep`   | Determine reset, create/patch session, set `ctx.resumeHandle`                        | No              |
| `prepareThreadContext` | Show thinking indicator, load thread context + memories                              | No              |
| `executeAgent`         | Resolve executor, create activity sink, run agent, finalize in `finally`             | No              |

### Backward compatibility wrapper

`conversation-pipeline.ts` also exports `handleThreadConversation(client, message, deps, options)` with the original signature. It constructs a `ConversationPipelineContext` and calls `runConversationPipeline(ctx, DEFAULT_CONVERSATION_STEPS)`. Existing call sites in `slash-command-handler.ts` and `workspace-message-action.ts` continue to work without changes.

## Activity sink factory (`activity-sink.ts`)

```typescript
export interface ActivitySinkOptions {
  channel: string;
  client: SlackWebClientLike;
  logger: AppLogger;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadTs: string;
  workspaceLabel?: string;
}

export interface ActivitySink {
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
  finalize: () => Promise<void>;
  readonly toolHistory: Map<string, number>;
}

export function createActivitySink(options: ActivitySinkOptions): ActivitySink { ... }
```

Encapsulates all mutable progress state (`progressMessageTs`, `progressMessageActive`, `toolHistory`, `seenActivities`, `lastStateKey`). Internal helpers (`isMeaningfulActivityState`, `toRendererState`, `updateInFlightIndicator`, `activateProgressMessage`, `collectToolActivity`, `createDefaultThinkingState`, `TOOL_VERB_PATTERN`) become module-private.

The `executeAgent` pipeline step creates the sink and calls `sink.finalize()` in its `finally` block, keeping the lifecycle contained.

## Executor resolution

The existing `resolveExecutor` function (~8 lines, picks the right `AgentExecutor` from the provider registry or falls back to `claudeExecutor`) becomes a module-private helper in `conversation-pipeline.ts`, used only by the `executeAgent` step.

## Message filter (`message-filter.ts`)

Exports:

- `createBotUserIdResolver(logger)` — returns `(client) => Promise<string | undefined>` (cached)
- `shouldSkipBotAuthoredMessage(logger, logLabel, threadTs, message, botUserId)` — `boolean`
- `shouldSkipMessageForForeignMention(logger, logLabel, threadTs, messageText, botUserId)` — `boolean`

Module-private: `resolveBotUserId`, `getForeignMentionedUserId`, `mentionsUser`, `SLACK_USER_MENTION_PATTERN`.

Pure functions (except the cached resolver). Testable with no Slack API mocking beyond `auth.test`.

## Session manager (`session-manager.ts`)

```typescript
export interface SessionResolution {
  resumeHandle: string | undefined;
  session: SessionRecord;
}

export function resolveAndPersistSession(
  threadTs: string,
  channelId: string,
  rootMessageTs: string,
  workspace: ResolvedWorkspace | undefined,
  forceNewSession: boolean,
  sessionStore: SessionStore,
): SessionResolution { ... }
```

Encapsulates: existing session lookup, workspace-change reset detection, patch vs. upsert branching. Returns the session record and resume handle.

## Workspace resolution (`workspace-resolution.ts`)

Exports:

- `resolveWorkspaceForConversation(messageText, existingSession, workspaceResolver, workspaceOverride?)` — `WorkspaceResolution`
- `buildWorkspaceResolutionBlocks(resolution, originalMessageText)` — `{ blocks: SlackBlock[]; text: string }`
- `WORKSPACE_PICKER_ACTION_ID` — constant

Already pure functions, just extracted from the wrong file.

## Runtime logging (`logger/runtime.ts`)

```typescript
export function runtimeInfo(logger: AppLogger, message: string, ...args: unknown[]): void;
export function runtimeError(logger: AppLogger, message: string, ...args: unknown[]): void;
export function runtimeWarn(logger: AppLogger, message: string, ...args: unknown[]): void;
```

Dual-write to structured logger + console. Moved to `src/logger/` so any module can use them.

## Slimmed handler file (`app-mention-handler.ts`)

Contains only:

- Handler factories: `createAppMentionHandler`, `createThreadReplyHandler`, `createAssistantThreadStartedHandler`, `createAssistantUserMessageHandler`
- `DEFAULT_ASSISTANT_PROMPTS` constant
- Re-exports for backward compatibility: `SlackIngressDependencies`, `ThreadConversationMessage`, `handleThreadConversation`, `WORKSPACE_PICKER_ACTION_ID`

Each factory does input validation/filtering via `message-filter.ts` helpers and delegates to `runConversationPipeline`. ~100 lines total.

## Backward compatibility

All current public exports are preserved via re-exports from `app-mention-handler.ts`. No consumer needs to change import paths:

- `slash-command-handler.ts` — imports `SlackIngressDependencies`, `handleThreadConversation`, `WORKSPACE_PICKER_ACTION_ID`
- `workspace-message-action.ts` — imports `handleThreadConversation`, `SlackIngressDependencies`
- `workspace-picker-action.ts` — imports `SlackIngressDependencies`, `WORKSPACE_PICKER_ACTION_ID`
- Test files — import `createAppMentionHandler`, `createThreadReplyHandler`, `WORKSPACE_PICKER_ACTION_ID`

## Testing strategy

Each extracted module can be tested in isolation:

- **Pipeline runner**: stub steps that assert call order and early-exit behavior
- **Activity sink**: construct with mock renderer, fire events, assert renderer calls
- **Message filter**: pure function tests with various message shapes
- **Session manager**: test reset detection, patch vs. upsert with in-memory session store
- **Workspace resolution**: already pure, test with mock workspace resolver
- **Pipeline steps**: construct a `ConversationPipelineContext` with mocked deps, call the step, assert context mutations and side effects

Existing tests (`slack-loading-status.test.ts`, `thread-reply-ingress.test.ts`, `workspace-picker-action.test.ts`) continue to work since the public API is unchanged.
