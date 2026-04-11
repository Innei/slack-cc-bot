# Slack Image Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Slack thread image support so the bot can read image attachments from thread history and upload locally generated image files back into the same Slack thread.

**Architecture:** Extend Slack thread normalization to retain image metadata, then hydrate downloadable image bytes in `SlackThreadContextLoader`. Keep the current text prompt path for text-only conversations, but switch the Claude adapter to `AsyncIterable<SDKUserMessage>` when thread images exist. Capture Claude `files_persisted` events as generated-image artifacts, then upload those files with Slack `filesUploadV2` and render them as image blocks after the text reply.

**Tech Stack:** TypeScript strict mode, Slack Bolt, Claude Agent SDK, Node `fetch`/`Buffer`, Vitest, live Slack E2E harness

---

## File Map

- Create: `src/slack/context/slack-image-downloader.ts`
- Create: `src/agent/providers/claude-code/multimodal-prompt.ts`
- Create: `tests/slack-message-normalizer.test.ts`
- Create: `tests/thread-context-loader.test.ts`
- Create: `tests/claude-multimodal-prompt.test.ts`
- Create: `tests/claude-sdk-messages.test.ts`
- Create: `tests/slack-renderer.test.ts`
- Create: `src/e2e/live/run-slack-image-support.ts`
- Modify: `src/schemas/slack/message.ts`
- Modify: `src/slack/context/message-normalizer.ts`
- Modify: `src/slack/context/thread-context-loader.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/providers/claude-code/adapter.ts`
- Modify: `src/agent/providers/claude-code/messages.ts`
- Modify: `src/agent/providers/claude-code/types.ts`
- Modify: `src/slack/types.ts`
- Modify: `src/slack/render/slack-renderer.ts`
- Modify: `src/slack/ingress/activity-sink.ts`
- Modify: `tests/activity-sink.test.ts`
- Modify: `src/e2e/live/slack-api-client.ts`

---

### Task 1: Model Slack image files in the thread normalizer

**Files:**

- Create: `tests/slack-message-normalizer.test.ts`
- Modify: `src/schemas/slack/message.ts`
- Modify: `src/slack/context/message-normalizer.ts`
- **Step 1: Write the failing normalizer tests**

Create `tests/slack-message-normalizer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { normalizeThreadMessages } from '~/slack/context/message-normalizer.js';

describe('normalizeThreadMessages', () => {
  it('keeps image-only messages and extracts supported image metadata', () => {
    const normalized = normalizeThreadMessages([
      {
        ts: '1712345678.000100',
        user: 'U123',
        files: [
          {
            id: 'F123',
            mimetype: 'image/png',
            name: 'diagram.png',
            title: 'Architecture Diagram',
            url_private: 'https://files.slack.com/files-pri/T1-F123/diagram.png',
          },
        ],
      },
    ]);

    expect(normalized).toEqual([
      {
        authorId: 'U123',
        images: [
          {
            authorId: 'U123',
            fileId: 'F123',
            fileName: 'diagram.png',
            messageTs: '1712345678.000100',
            mimeType: 'image/png',
            slackUrl: 'https://files.slack.com/files-pri/T1-F123/diagram.png',
            title: 'Architecture Diagram',
          },
        ],
        rawText: '',
        text: '',
        threadTs: '1712345678.000100',
        ts: '1712345678.000100',
      },
    ]);
  });

  it('drops messages that contain neither text nor supported images', () => {
    const normalized = normalizeThreadMessages([
      {
        ts: '1712345678.000101',
        user: 'U123',
        files: [
          {
            id: 'F124',
            mimetype: 'application/pdf',
            name: 'spec.pdf',
            url_private: 'https://files.slack.com/files-pri/T1-F124/spec.pdf',
          },
        ],
      },
    ]);

    expect(normalized).toEqual([]);
  });
});
```

- **Step 2: Run the normalizer test to verify it fails**

Run: `pnpm exec vitest run tests/slack-message-normalizer.test.ts`

Expected: FAIL because `NormalizedThreadMessage` does not have `images`, `SlackMessageSchema` does not parse `files`, and image-only messages are currently dropped.

- **Step 3: Extend the Slack schema and normalizer**

Update `src/schemas/slack/message.ts`:

```typescript
const SlackFileSchema = z.looseObject({
  id: z.string().min(1),
  mimetype: z.string().min(1).optional(),
  filetype: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  url_private: z.string().url().optional(),
});

export const SlackMessageSchema = z.looseObject({
  channel: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  text: z.string().default(''),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  blocks: z.array(z.union([SlackSectionBlockSchema, SlackGenericBlockSchema])).optional(),
  files: z.array(SlackFileSchema).optional(),
});
```

Update `src/slack/context/message-normalizer.ts`:

```typescript
export interface NormalizedThreadImage {
  authorId: string | null;
  fileId: string;
  fileName: string;
  messageTs: string;
  mimeType: string;
  slackUrl: string;
  title?: string;
}

export interface NormalizedThreadMessage {
  authorId: string | null;
  images: NormalizedThreadImage[];
  rawText: string;
  text: string;
  threadTs: string;
  ts: string;
}

const SUPPORTED_SLACK_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function normalizeThreadMessages(messages: unknown[]): NormalizedThreadMessage[] {
  return messages.flatMap((message) => {
    const parsed = SlackMessageSchema.safeParse(message);

    if (!parsed.success) {
      return [];
    }

    const normalized = normalizeThreadMessage(parsed.data);
    return normalized.text || normalized.images.length > 0 ? [normalized] : [];
  });
}

export function normalizeThreadMessage(message: SlackMessage): NormalizedThreadMessage {
  const threadTs = message.thread_ts ?? message.ts;
  const authorId = message.user ?? message.bot_id ?? null;
  const blockText = extractTextFromBlocks(message);
  const rawText = [message.text, blockText].filter(Boolean).join('\n').trim();

  return {
    ts: message.ts,
    threadTs,
    authorId,
    images: extractSupportedImages(message, authorId),
    text: dedupeLines(rawText),
    rawText,
  };
}

function extractSupportedImages(
  message: SlackMessage,
  authorId: string | null,
): NormalizedThreadImage[] {
  return (message.files ?? []).flatMap((file) => {
    const mimeType = file.mimetype?.toLowerCase();
    if (!mimeType || !SUPPORTED_SLACK_IMAGE_MIME_TYPES.has(mimeType) || !file.url_private) {
      return [];
    }

    return [
      {
        authorId,
        fileId: file.id,
        fileName: file.name ?? file.title ?? file.id,
        messageTs: message.ts,
        mimeType,
        slackUrl: file.url_private,
        ...(file.title ? { title: file.title } : {}),
      },
    ];
  });
}
```

- **Step 4: Re-run the normalizer test**

Run: `pnpm exec vitest run tests/slack-message-normalizer.test.ts`

Expected: PASS.

- **Step 5: Commit**

```bash
git add tests/slack-message-normalizer.test.ts src/schemas/slack/message.ts src/slack/context/message-normalizer.ts
git commit -m "feat: preserve Slack thread image metadata"
```

---

### Task 2: Download thread images and add them to the loaded thread context

**Files:**

- Create: `src/slack/context/slack-image-downloader.ts`
- Create: `tests/thread-context-loader.test.ts`
- Modify: `src/slack/context/thread-context-loader.ts`
- **Step 1: Write the failing thread-context loader tests**

Create `tests/thread-context-loader.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { SlackThreadContextLoader } from '~/slack/context/thread-context-loader.js';
import type { SlackWebClientLike } from '~/slack/types.js';

function createLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function createClient(messages: unknown[]): SlackWebClientLike {
  return {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages }) },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ files: [] }),
    },
    reactions: { add: vi.fn().mockResolvedValue({}) },
    views: { open: vi.fn().mockResolvedValue({}) },
  } as unknown as SlackWebClientLike;
}

describe('SlackThreadContextLoader', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('downloads supported thread images into loadedImages', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer,
    });

    const loader = new SlackThreadContextLoader(createLogger());
    const context = await loader.loadThread(
      createClient([
        {
          ts: '1712345678.000100',
          user: 'U123',
          text: 'Please inspect this image.',
          files: [
            {
              id: 'F123',
              mimetype: 'image/png',
              name: 'diagram.png',
              url_private: 'https://files.slack.com/files-pri/T1-F123/diagram.png',
            },
          ],
        },
      ]),
      'C123',
      '1712345678.000100',
    );

    expect(context.loadedImages).toEqual([
      expect.objectContaining({
        base64Data: Buffer.from([137, 80, 78, 71]).toString('base64'),
        fileId: 'F123',
        fileName: 'diagram.png',
        messageIndex: 1,
        mimeType: 'image/png',
      }),
    ]);
    expect(context.imageLoadFailures).toEqual([]);
  });

  it('records a per-image failure and keeps loading the thread', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    });

    const loader = new SlackThreadContextLoader(createLogger());
    const context = await loader.loadThread(
      createClient([
        {
          ts: '1712345678.000100',
          user: 'U123',
          files: [
            {
              id: 'F123',
              mimetype: 'image/png',
              name: 'diagram.png',
              url_private: 'https://files.slack.com/files-pri/T1-F123/diagram.png',
            },
          ],
        },
      ]),
      'C123',
      '1712345678.000100',
    );

    expect(context.loadedImages).toEqual([]);
    expect(context.imageLoadFailures).toEqual([expect.stringContaining('diagram.png')]);
  });
});
```

- **Step 2: Run the loader test to verify it fails**

Run: `pnpm exec vitest run tests/thread-context-loader.test.ts`

Expected: FAIL because `NormalizedThreadContext` does not have `loadedImages` or `imageLoadFailures`, and there is no image download helper yet.

- **Step 3: Implement Slack image downloading and hydrated thread context**

Create `src/slack/context/slack-image-downloader.ts`:

```typescript
import { env } from '~/env/server.js';

const MAX_THREAD_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DownloadedSlackImage {
  base64Data: string;
  mimeType: string;
}

export async function downloadSlackImage(url: string): Promise<DownloadedSlackImage> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Slack image download failed with HTTP ${response.status}`);
  }

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mimeType || !mimeType.startsWith('image/')) {
    throw new Error(
      `Slack image download returned non-image content type: ${mimeType ?? 'unknown'}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_THREAD_IMAGE_BYTES) {
    throw new Error(`Slack image exceeds ${MAX_THREAD_IMAGE_BYTES} bytes`);
  }

  return {
    base64Data: Buffer.from(arrayBuffer).toString('base64'),
    mimeType,
  };
}
```

Update `src/slack/context/thread-context-loader.ts`:

```typescript
import { downloadSlackImage } from './slack-image-downloader.js';
import { type NormalizedThreadImage, type NormalizedThreadMessage, normalizeThreadMessages } from './message-normalizer.js';

export interface LoadedThreadImage extends NormalizedThreadImage {
  base64Data: string;
  messageIndex: number;
}

export interface NormalizedThreadContext {
  channelId: string;
  imageLoadFailures: string[];
  loadedImages: LoadedThreadImage[];
  messages: NormalizedThreadMessage[];
  renderedPrompt: string;
  threadTs: string;
}

async loadThread(
  client: SlackWebClientLike,
  channelId: string,
  threadTs: string,
): Promise<NormalizedThreadContext> {
  const response = await client.conversations.replies({
    channel: channelId,
    ts: threadTs,
    inclusive: true,
    limit: 200,
  });

  const messages = normalizeThreadMessages(response.messages ?? []);
  const loadedImages: LoadedThreadImage[] = [];
  const imageLoadFailures: string[] = [];

  for (const [index, message] of messages.entries()) {
    for (const image of message.images) {
      try {
        const downloaded = await downloadSlackImage(image.slackUrl);
        loadedImages.push({
          ...image,
          base64Data: downloaded.base64Data,
          messageIndex: index + 1,
          mimeType: downloaded.mimeType,
        });
      } catch (error) {
        const failure = `${image.fileName}: ${error instanceof Error ? error.message : String(error)}`;
        imageLoadFailures.push(failure);
        this.logger.warn('Failed to load Slack thread image for %s: %s', threadTs, failure);
      }
    }
  }

  return {
    channelId,
    imageLoadFailures,
    loadedImages,
    threadTs,
    messages,
    renderedPrompt: renderThreadPrompt(messages),
  };
}
```

- **Step 4: Re-run the loader test**

Run: `pnpm exec vitest run tests/thread-context-loader.test.ts`

Expected: PASS.

- **Step 5: Commit**

```bash
git add src/slack/context/slack-image-downloader.ts src/slack/context/thread-context-loader.ts tests/thread-context-loader.test.ts
git commit -m "feat: load Slack thread images into context"
```

---

### Task 3: Build multimodal Claude input when thread images are present

**Files:**

- Create: `src/agent/providers/claude-code/multimodal-prompt.ts`
- Create: `tests/claude-multimodal-prompt.test.ts`
- Modify: `src/agent/providers/claude-code/adapter.ts`
- **Step 1: Write the failing multimodal prompt tests**

Create `tests/claude-multimodal-prompt.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildClaudePromptInput } from '~/agent/providers/claude-code/multimodal-prompt.js';
import type { AgentExecutionRequest } from '~/agent/types.js';

function createRequest(overrides?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
  return {
    channelId: 'C123',
    mentionText: 'What is in the image?',
    threadContext: {
      channelId: 'C123',
      imageLoadFailures: [],
      loadedImages: [],
      messages: [],
      renderedPrompt: 'Slack thread context:',
      threadTs: '1712345678.000100',
    },
    threadTs: '1712345678.000100',
    userId: 'U123',
    ...overrides,
  };
}

describe('buildClaudePromptInput', () => {
  it('returns a plain string for text-only requests', () => {
    const input = buildClaudePromptInput(createRequest());

    expect(typeof input).toBe('string');
    expect(input).toContain('<user_message>');
  });

  it('returns an async user-message stream when thread images exist', async () => {
    const input = buildClaudePromptInput(
      createRequest({
        threadContext: {
          channelId: 'C123',
          imageLoadFailures: ['broken.png: Slack image download failed with HTTP 403'],
          loadedImages: [
            {
              authorId: 'U123',
              base64Data: Buffer.from([1, 2, 3]).toString('base64'),
              fileId: 'F123',
              fileName: 'diagram.png',
              messageIndex: 2,
              messageTs: '1712345678.000101',
              mimeType: 'image/png',
              slackUrl: 'https://files.slack.com/files-pri/T1-F123/diagram.png',
            },
          ],
          messages: [],
          renderedPrompt:
            'Slack thread context:\nMessage 1 | ts=1712345678.000100 | author=U123\nLook at the image.',
          threadTs: '1712345678.000100',
        },
      }),
    );

    expect(typeof input).not.toBe('string');

    const messages: unknown[] = [];
    for await (const message of input as AsyncIterable<unknown>) {
      messages.push(message);
    }

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Some Slack thread images could not be loaded'),
        }),
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        type: 'user',
        message: expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('diagram.png') }),
            expect.objectContaining({
              type: 'image',
              source: expect.objectContaining({
                data: Buffer.from([1, 2, 3]).toString('base64'),
                media_type: 'image/png',
                type: 'base64',
              }),
            }),
          ]),
        }),
      }),
    );
  });
});
```

- **Step 2: Run the multimodal prompt test to verify it fails**

Run: `pnpm exec vitest run tests/claude-multimodal-prompt.test.ts`

Expected: FAIL because `buildClaudePromptInput()` does not exist and the adapter only supports `buildPrompt(request): string`.

- **Step 3: Implement the multimodal prompt helper and wire it into the adapter**

Create `src/agent/providers/claude-code/multimodal-prompt.ts`:

```typescript
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentExecutionRequest } from '~/agent/types.js';

import { buildPrompt } from './prompts.js';

export function buildClaudePromptInput(
  request: AgentExecutionRequest,
): string | AsyncIterable<SDKUserMessage> {
  if (request.threadContext.loadedImages.length === 0) {
    return buildPrompt(request);
  }

  return createMultimodalPrompt(request);
}

async function* createMultimodalPrompt(
  request: AgentExecutionRequest,
): AsyncIterable<SDKUserMessage> {
  const primarySections = [buildPrompt(request)];
  if (request.threadContext.imageLoadFailures.length > 0) {
    primarySections.push(
      `Some Slack thread images could not be loaded:\n${request.threadContext.imageLoadFailures
        .map((failure) => `- ${failure}`)
        .join('\n')}`,
    );
  }

  yield {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: primarySections.join('\n\n'),
    },
  };

  for (const image of request.threadContext.loadedImages) {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Image from Slack thread message ${image.messageIndex} (filename: ${image.fileName})`,
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: image.base64Data,
            },
          },
        ],
      },
    };
  }
}
```

Update `src/agent/providers/claude-code/adapter.ts`:

```typescript
import { buildClaudePromptInput } from './multimodal-prompt.js';

const prompt = buildClaudePromptInput(request);

session = query({
  prompt,
  options: {
    ...(env.CLAUDE_MODEL ? { model: env.CLAUDE_MODEL } : {}),
    agentProgressSummaries: true,
    includeHookEvents: true,
    includePartialMessages: true,
    ...(request.workspacePath ? { cwd: request.workspacePath } : {}),
    systemPrompt: buildSystemPrompt(request),
    mcpServers: {
      'slack-ui': mcpServer,
    },
    permissionMode: env.CLAUDE_PERMISSION_MODE,
    ...(env.CLAUDE_PERMISSION_MODE === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    persistSession: true,
    ...(request.resumeHandle ? { resume: request.resumeHandle } : {}),
  },
});
```

- **Step 4: Re-run the multimodal prompt test**

Run: `pnpm exec vitest run tests/claude-multimodal-prompt.test.ts`

Expected: PASS.

- **Step 5: Commit**

```bash
git add src/agent/providers/claude-code/multimodal-prompt.ts src/agent/providers/claude-code/adapter.ts tests/claude-multimodal-prompt.test.ts
git commit -m "feat: send Slack thread images to Claude"
```

---

### Task 4: Capture generated image files from Claude SDK events

**Files:**

- Create: `tests/claude-sdk-messages.test.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/providers/claude-code/messages.ts`
- Modify: `src/agent/providers/claude-code/types.ts`
- Modify: `src/agent/providers/claude-code/adapter.ts`
- **Step 1: Write the failing Claude message-handler tests**

Create `tests/claude-sdk-messages.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { handleClaudeSdkMessage } from '~/agent/providers/claude-code/messages.js';
import { createRuntimeUiStateTracker } from '~/agent/providers/claude-code/runtime-ui.js';
import type { MessageHandlers } from '~/agent/providers/claude-code/types.js';
import type { AppLogger } from '~/logger/index.js';

function createLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function createHandlers(): MessageHandlers {
  let sessionCwd: string | undefined;

  return {
    collectAssistantText: vi.fn(),
    getSessionCwd: () => sessionCwd,
    publishUiState: vi.fn().mockResolvedValue(undefined),
    runtimeUi: createRuntimeUiStateTracker(),
    setSessionCwd: (cwd: string) => {
      sessionCwd = cwd;
    },
    setSessionId: vi.fn(),
  };
}

describe('handleClaudeSdkMessage', () => {
  it('emits generated-images for persisted image files', async () => {
    const sink = { onEvent: vi.fn().mockResolvedValue(undefined) };
    const handlers = createHandlers();
    const logger = createLogger();

    await handleClaudeSdkMessage(
      logger,
      {
        type: 'system',
        subtype: 'init',
        cwd: '/tmp/repo',
        model: 'claude-sonnet-test',
        session_id: 'session-1',
      } as never,
      sink,
      handlers,
    );

    await handleClaudeSdkMessage(
      logger,
      {
        type: 'system',
        subtype: 'files_persisted',
        files: [
          { filename: 'artifacts/outbound-image.png', file_id: 'provider-file-1' },
          { filename: 'notes.txt', file_id: 'provider-file-2' },
        ],
        failed: [],
        processed_at: new Date().toISOString(),
        session_id: 'session-1',
        uuid: 'msg-1',
      } as never,
      sink,
      handlers,
    );

    expect(sink.onEvent).toHaveBeenCalledWith({
      type: 'generated-images',
      files: [
        {
          fileName: 'outbound-image.png',
          path: '/tmp/repo/artifacts/outbound-image.png',
          providerFileId: 'provider-file-1',
        },
      ],
    });
  });
});
```

- **Step 2: Run the Claude message-handler test to verify it fails**

Run: `pnpm exec vitest run tests/claude-sdk-messages.test.ts`

Expected: FAIL because `AgentExecutionEvent` does not have `generated-images`, `MessageHandlers` does not track session cwd, and `messages.ts` ignores `files_persisted`.

- **Step 3: Extend event types and handle `files_persisted`**

Update `src/agent/types.ts`:

```typescript
export interface GeneratedImageFile {
  fileName: string;
  path: string;
  providerFileId: string;
}

export type AgentExecutionEvent =
  | {
      type: 'assistant-message';
      text: string;
    }
  | {
      type: 'generated-images';
      files: GeneratedImageFile[];
    }
  | {
      type: 'activity-state';
      state: AgentActivityState;
    }
  | {
      type: 'task-update';
      taskId: string;
      title: string;
      status: 'pending' | 'in_progress' | 'complete' | 'error';
      details?: string;
      output?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'started';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'completed';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'stopped';
      reason: 'user_stop';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'failed';
      resumeHandle?: string;
      error: string;
    };
```

Update `src/agent/providers/claude-code/types.ts`:

```typescript
export interface MessageHandlers {
  collectAssistantText: (text: string) => void;
  getSessionCwd: () => string | undefined;
  publishUiState: () => Promise<void>;
  runtimeUi: RuntimeUiStateTracker;
  setSessionCwd: (cwd: string) => void;
  setSessionId: (id: string) => void;
}
```

Update `src/agent/providers/claude-code/adapter.ts`:

```typescript
let sessionCwd: string | undefined;
const handlers: MessageHandlers = {
  collectAssistantText: (text) => {
    collectedAssistantTexts.push(text);
  },
  getSessionCwd: () => sessionCwd,
  publishUiState: async () => {
    await this.publishRuntimeUiState(request.threadTs, sink, runtimeUi);
  },
  runtimeUi,
  setSessionCwd: (cwd) => {
    sessionCwd = cwd;
  },
  setSessionId: (id) => {
    sessionId = id;
  },
};
```

Update `src/agent/providers/claude-code/messages.ts`:

```typescript
import path from 'node:path';

import type { SDKFilesPersistedEvent } from '@anthropic-ai/claude-agent-sdk';

import type { GeneratedImageFile } from '~/agent/types.js';

function handleSystemInit(
  logger: AppLogger,
  message: SDKSystemMessage,
  handlers: MessageHandlers,
): void {
  handlers.setSessionId(message.session_id);
  handlers.setSessionCwd(message.cwd);
  logger.info(
    'Claude Code session init: id=%s model=%s cwd=%s',
    message.session_id,
    message.model,
    message.cwd,
  );
}

async function handleFilesPersistedMessage(
  message: SDKFilesPersistedEvent,
  sink: AgentExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const cwd = handlers.getSessionCwd() ?? process.cwd();
  const files: GeneratedImageFile[] = message.files.flatMap((file) => {
    const lower = file.filename.toLowerCase();
    if (
      !lower.endsWith('.gif') &&
      !lower.endsWith('.jpeg') &&
      !lower.endsWith('.jpg') &&
      !lower.endsWith('.png') &&
      !lower.endsWith('.webp')
    ) {
      return [];
    }

    return [
      {
        fileName: path.basename(file.filename),
        path: path.resolve(cwd, file.filename),
        providerFileId: file.file_id,
      },
    ];
  });

  if (files.length > 0) {
    await sink.onEvent({ type: 'generated-images', files });
  }
}

switch (message.subtype) {
  case 'files_persisted': {
    await handleFilesPersistedMessage(message as SDKFilesPersistedEvent, sink, handlers);
    return;
  }
}
```

- **Step 4: Re-run the Claude message-handler test**

Run: `pnpm exec vitest run tests/claude-sdk-messages.test.ts`

Expected: PASS.

- **Step 5: Commit**

```bash
git add src/agent/types.ts src/agent/providers/claude-code/types.ts src/agent/providers/claude-code/adapter.ts src/agent/providers/claude-code/messages.ts tests/claude-sdk-messages.test.ts
git commit -m "feat: capture generated image artifacts from Claude"
```

---

### Task 5: Upload generated images back to Slack and flush them from the activity sink

**Files:**

- Create: `tests/slack-renderer.test.ts`
- Modify: `src/slack/types.ts`
- Modify: `src/slack/render/slack-renderer.ts`
- Modify: `src/slack/ingress/activity-sink.ts`
- Modify: `tests/activity-sink.test.ts`
- **Step 1: Write the failing renderer and sink tests**

Create `tests/slack-renderer.test.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { SlackRenderer } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';

function createLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function createClient(): SlackWebClientLike {
  return {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: 'msg-ts' }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: {
      uploadV2: vi.fn().mockResolvedValue({
        files: [{ id: 'F_UPLOADED', name: 'outbound-image.png', title: 'outbound-image.png' }],
      }),
    },
    reactions: { add: vi.fn().mockResolvedValue({}) },
    views: { open: vi.fn().mockResolvedValue({}) },
  } as unknown as SlackWebClientLike;
}

describe('SlackRenderer.postGeneratedImages', () => {
  it('uploads each image and posts a Slack image block referencing the uploaded file id', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-renderer-'));
    const imagePath = path.join(tempDir, 'outbound-image.png');
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));

    const client = createClient();
    const renderer = new SlackRenderer(createLogger());

    await renderer.postGeneratedImages(client, 'C123', '1712345678.000100', [
      {
        fileName: 'outbound-image.png',
        path: imagePath,
        providerFileId: 'provider-file-1',
      },
    ]);

    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        filename: 'outbound-image.png',
        thread_ts: '1712345678.000100',
      }),
    );
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            alt_text: 'Generated image: outbound-image.png',
            slack_file: { id: 'F_UPLOADED' },
            type: 'image',
          }),
        ],
        channel: 'C123',
        thread_ts: '1712345678.000100',
      }),
    );
  });
});
```

Add this test to `tests/activity-sink.test.ts`:

```typescript
it('flushes generated images after the assistant reply posts', async () => {
  const renderer = createRendererStub();
  (renderer as unknown as { postGeneratedImages: ReturnType<typeof vi.fn> }).postGeneratedImages =
    vi.fn().mockResolvedValue(undefined);

  const sink = createActivitySink({
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer,
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
  });

  await sink.onEvent({
    type: 'generated-images',
    files: [
      { fileName: 'outbound-image.png', path: '/tmp/outbound-image.png', providerFileId: 'p1' },
    ],
  });
  await sink.onEvent({ type: 'assistant-message', text: 'Here is the generated image.' });

  expect(
    (renderer as unknown as { postGeneratedImages: ReturnType<typeof vi.fn> }).postGeneratedImages,
  ).toHaveBeenCalledWith(expect.anything(), 'C123', 'ts1', [
    { fileName: 'outbound-image.png', path: '/tmp/outbound-image.png', providerFileId: 'p1' },
  ]);
});
```

- **Step 2: Run the renderer and sink tests to verify they fail**

Run: `pnpm exec vitest run tests/slack-renderer.test.ts tests/activity-sink.test.ts`

Expected: FAIL because `SlackWebClientLike` has no `files.uploadV2`, `SlackBlock` has no `image` block type, `SlackRenderer` has no `postGeneratedImages()`, and `createActivitySink()` ignores `generated-images`.

- **Step 3: Implement Slack file upload and sink flushing**

Update `src/slack/types.ts`:

```typescript
export interface SlackImageBlock {
  alt_text: string;
  slack_file: {
    id: string;
  };
  title?: SlackPlainTextObject;
  type: 'image';
}

export interface SlackFilesApi {
  uploadV2: (args: {
    alt_txt?: string;
    channel: string;
    file: Buffer;
    filename: string;
    thread_ts?: string;
    title?: string;
  }) => Promise<{
    files?: Array<{
      id?: string;
      name?: string;
      title?: string;
    }>;
  }>;
}

export type SlackBlock =
  | SlackActionsBlock
  | SlackContextBlock
  | SlackImageBlock
  | SlackSectionBlock;

export interface SlackWebClientLike {
  assistant: SlackAssistantApi;
  auth?: SlackAuthApi;
  chat: SlackChatApi;
  conversations: SlackConversationsApi;
  files: SlackFilesApi;
  reactions: SlackReactionsApi;
  views: SlackViewsApi;
}
```

Update `src/slack/render/slack-renderer.ts`:

```typescript
import { readFile } from 'node:fs/promises';

import type { GeneratedImageFile } from '~/agent/types.js';

async postGeneratedImages(
  client: SlackWebClientLike,
  channelId: string,
  threadTs: string,
  files: GeneratedImageFile[],
): Promise<void> {
  for (const image of files) {
    const bytes = await readFile(image.path);
    const upload = await client.files.uploadV2({
      channel: channelId,
      thread_ts: threadTs,
      filename: image.fileName,
      file: bytes,
      title: image.fileName,
      alt_txt: `Generated image: ${image.fileName}`,
    });

    const fileId = upload.files?.[0]?.id;
    if (!fileId) {
      this.logger.warn('Slack image upload returned no file id for %s', image.path);
      continue;
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: image.fileName,
      blocks: [
        {
          type: 'image',
          slack_file: { id: fileId },
          alt_text: `Generated image: ${image.fileName}`,
          title: { type: 'plain_text', text: image.fileName },
        },
      ],
    });
  }
}
```

Update `src/slack/ingress/activity-sink.ts`:

```typescript
import type { GeneratedImageFile } from '~/agent/types.js';

let pendingGeneratedImages: GeneratedImageFile[] = [];

const flushGeneratedImages = async (): Promise<void> => {
  if (pendingGeneratedImages.length === 0) {
    return;
  }

  const images = pendingGeneratedImages;
  pendingGeneratedImages = [];
  await renderer.postGeneratedImages(client, channel, threadTs, images);
};

const handleAssistantMessage = async (text: string): Promise<void> => {
  await renderer.postThreadReply(client, channel, threadTs, text, {
    ...(workspaceLabel ? { workspaceLabel } : {}),
    ...(toolHistory.size > 0 ? { toolHistory } : {}),
  });
  await flushGeneratedImages().catch((error) => {
    logger.warn('Failed to upload generated images after assistant reply: %s', String(error));
  });
  if (progressMessageActive && progressMessageTs) {
    await renderer
      .deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs)
      .catch((error) => {
        logger.warn(
          'Failed to delete thread progress message after assistant reply: %s',
          String(error),
        );
      });
    progressMessageTs = undefined;
    progressMessageActive = false;
  }
  lastStateKey = undefined;
  toolHistory.clear();
  seenActivities.clear();
  await renderer.clearUiState(client, channel, threadTs).catch((error) => {
    logger.warn('Failed to clear UI state after assistant reply: %s', String(error));
  });
};

async onEvent(event: AgentExecutionEvent): Promise<void> {
  if (event.type === 'assistant-message') {
    await handleAssistantMessage(event.text);
    return;
  }
  if (event.type === 'generated-images') {
    pendingGeneratedImages = [...pendingGeneratedImages, ...event.files];
    return;
  }
  if (event.type === 'activity-state') {
    await handleActivityState(event.state);
    return;
  }
  if (event.type === 'task-update') return;
  await handleLifecycleEvent(event as Extract<AgentExecutionEvent, { type: 'lifecycle' }>);
}

async finalize(): Promise<void> {
  await renderer.clearUiState(client, channel, threadTs).catch((err) => {
    logger.warn('Failed to clear UI state: %s', String(err));
  });
  if (terminalPhase === 'completed') {
    await flushGeneratedImages().catch((err) => {
      logger.warn('Failed to upload generated images during finalize: %s', String(err));
    });
  }
  if (progressMessageTs) {
    if (terminalPhase === 'stopped') {
      await renderer
        .finalizeThreadProgressMessageStopped(
          client,
          channel,
          threadTs,
          progressMessageTs,
          toolHistory,
        )
        .catch((err) => {
          logger.warn('Failed to finalize stopped progress message: %s', String(err));
        });
    } else {
      await renderer
        .finalizeThreadProgressMessage(client, channel, threadTs, progressMessageTs, toolHistory)
        .catch((err) => {
          logger.warn('Failed to finalize progress message: %s', String(err));
        });
    }
  }
}
```

- **Step 4: Re-run the renderer and sink tests**

Run: `pnpm exec vitest run tests/slack-renderer.test.ts tests/activity-sink.test.ts`

Expected: PASS.

- **Step 5: Commit**

```bash
git add src/slack/types.ts src/slack/render/slack-renderer.ts src/slack/ingress/activity-sink.ts tests/slack-renderer.test.ts tests/activity-sink.test.ts
git commit -m "feat: upload generated images back to Slack"
```

---

### Task 6: Add a live Slack E2E scenario for inbound and outbound image support

**Files:**

- Create: `src/e2e/live/run-slack-image-support.ts`
- Modify: `src/e2e/live/slack-api-client.ts`
- **Step 1: Write the E2E helper changes first**

Update `src/e2e/live/slack-api-client.ts` to support v2 file upload and richer reply inspection:

```typescript
export interface SlackUploadedFileResponse {
  files?: Array<{
    id?: string;
    mimetype?: string;
    name?: string;
    title?: string;
  }>;
}

export interface SlackConversationRepliesResponse {
  has_more?: boolean;
  messages?: Array<{
    blocks?: Array<{
      alt_text?: string;
      block_id?: string;
      elements?: Array<Record<string, unknown>>;
      slack_file?: {
        id?: string;
      };
      type?: string;
    }>;
    bot_id?: string;
    files?: Array<{
      id?: string;
      mimetype?: string;
      name?: string;
      title?: string;
    }>;
    bot_profile?: {
      app_id?: string;
    };
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  }>;
}

async filesUploadV2(args: {
  channel_id: string;
  file: Blob;
  filename: string;
  initial_comment?: string;
  thread_ts?: string;
  title?: string;
}): Promise<SlackUploadedFileResponse> {
  const body = new FormData();
  body.set('channel_id', args.channel_id);
  body.set('filename', args.filename);
  body.set('file', args.file, args.filename);
  if (args.initial_comment) body.set('initial_comment', args.initial_comment);
  if (args.thread_ts) body.set('thread_ts', args.thread_ts);
  if (args.title) body.set('title', args.title);

  const response = await this.fetchWithRetry('https://slack.com/api/files.uploadV2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${this.token}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Slack API files.uploadV2 failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as SlackUploadedFileResponse & { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API files.uploadV2 error: ${data.error ?? 'unknown'}`);
  }

  return data;
}
```

- **Step 2: Write the new live E2E scenario**

Create `src/e2e/live/run-slack-image-support.ts`:

```typescript
import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nXn0AAAAASUVORK5CYII=';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the Slack image support E2E.');
  }
  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Slack image support E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const application = createApplication();
  await application.start();
  await delay(3_000);

  try {
    const root = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: `SLACK_IMAGE_E2E ${runId} root`,
      unfurl_links: false,
      unfurl_media: false,
    });

    await triggerClient.filesUploadV2({
      channel_id: env.SLACK_E2E_CHANNEL_ID,
      thread_ts: root.ts,
      filename: `tiny-${runId}.png`,
      file: new Blob([Buffer.from(TINY_PNG_BASE64, 'base64')], { type: 'image/png' }),
      initial_comment: 'Thread image for image-read check',
      title: `tiny-${runId}.png`,
    });

    await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      thread_ts: root.ts,
      text: [
        `<@${botIdentity.user_id}>`,
        `Reply with exactly "INBOUND_OK ${runId}" if the attached image in this thread is a single-color square.`,
        `Then generate one small png image that visually contains the text "OUTBOUND_OK ${runId}".`,
      ].join(' '),
      unfurl_links: false,
      unfurl_media: false,
    });

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    let sawInboundText = false;
    let sawOutboundImage = false;

    while (Date.now() < deadline && (!sawInboundText || !sawOutboundImage)) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 100,
        ts: root.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === root.ts) continue;

        if (typeof message.text === 'string' && message.text.includes(`INBOUND_OK ${runId}`)) {
          sawInboundText = true;
        }

        if (
          (message.blocks ?? []).some((block) => block.type === 'image') ||
          (message.files ?? []).some((file) => file.mimetype?.startsWith('image/'))
        ) {
          sawOutboundImage = true;
        }
      }

      if (!sawInboundText || !sawOutboundImage) {
        await delay(2_500);
      }
    }

    if (!sawInboundText) {
      throw new Error('assistant never confirmed the inbound thread image');
    }
    if (!sawOutboundImage) {
      throw new Error('assistant never produced a Slack-hosted outbound image');
    }
  } finally {
    await application.stop();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'slack-image-support',
  title: 'Slack Image Support',
  description:
    'Upload an image into a Slack thread, verify the bot can read it, and then verify a generated image is uploaded back into the same thread.',
  keywords: ['image', 'slack', 'thread', 'multimodal', 'upload', 'generated-image'],
  run: main,
};

runDirectly(scenario);
```

- **Step 3: Run the focused automated tests before the live scenario**

Run: `pnpm exec vitest run tests/slack-message-normalizer.test.ts tests/thread-context-loader.test.ts tests/claude-multimodal-prompt.test.ts tests/claude-sdk-messages.test.ts tests/slack-renderer.test.ts tests/activity-sink.test.ts`

Expected: PASS.

- **Step 4: Run the live scenario**

Run: `pnpm e2e -- slack-image-support`

Expected: PASS with a thread that contains a text confirmation for inbound image reading and a Slack-hosted outbound image reply.

- **Step 5: Commit**

```bash
git add src/e2e/live/slack-api-client.ts src/e2e/live/run-slack-image-support.ts
git commit -m "test: add Slack image support live coverage"
```

---

### Task 7: Full verification and cleanup

**Files:**

- Verify only: `src/`
- Verify only: `tests/`
- Verify only: `src/e2e/live/`
- **Step 1: Run the full unit test suite**

Run: `pnpm test`

Expected: PASS.

- **Step 2: Run the type check**

Run: `pnpm typecheck`

Expected: PASS.

- **Step 3: Run the production build**

Run: `pnpm build`

Expected: PASS.

- **Step 4: Re-run the focused live scenario**

Run: `pnpm e2e -- slack-image-support`

Expected: PASS.

- **Step 5: Commit the final integration batch**

```bash
git add src tests docs/superpowers/specs/2026-04-06-slack-image-support-design.md docs/superpowers/plans/2026-04-06-slack-image-support.md
git commit -m "feat: add Slack image input and output support"
```
