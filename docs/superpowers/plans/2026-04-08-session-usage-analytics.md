# Session Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-conversation usage metrics (cost, tokens, cache hit rate, model, duration, user) into a new `session_analytics` SQLite table.

**Architecture:** New `session_analytics` table (own UUID PK, FK to `sessions.thread_ts`). New `src/analytics/` module with types + SQLite store. `ActivitySink` persists analytics on `finalize()` after execution completes. Fire-and-forget write pattern — errors logged but never block the main flow.

**Tech Stack:** TypeScript, Drizzle ORM, SQLite (better-sqlite3), Vitest

---

## File Structure

| Action | File                                      | Responsibility                                                                 |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Modify | `src/db/schema.ts`                        | Drizzle table definition for `session_analytics`                               |
| Modify | `src/db/index.ts`                         | CREATE TABLE IF NOT EXISTS + idempotent migration                              |
| Create | `src/analytics/types.ts`                  | `SessionAnalyticsRecord` + `SessionAnalyticsStore` interfaces                  |
| Create | `src/analytics/sqlite-analytics-store.ts` | SQLite implementation                                                          |
| Create | `tests/analytics-store.test.ts`           | Unit tests for the store                                                       |
| Modify | `src/slack/ingress/types.ts`              | Add `analyticsStore` to `SlackIngressDependencies`                             |
| Modify | `src/slack/ingress/activity-sink.ts`      | Accept + call analytics store on finalize                                      |
| Modify | `src/slack/app.ts`                        | Add `analyticsStore` to `SlackApplicationDependencies`, wire into ingress deps |
| Modify | `src/application.ts`                      | Instantiate `SqliteAnalyticsStore`, inject                                     |
| Modify | `tests/activity-sink.test.ts`             | Add test for analytics persistence on finalize                                 |

---

### Task 1: Schema + Migration

**Files:**

- Modify: `src/db/schema.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: Add `sessionAnalytics` table to `src/db/schema.ts`**

Append after the `memories` table definition:

```typescript
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessionAnalytics = sqliteTable('session_analytics', {
  id: text('id').primaryKey(),
  threadTs: text('thread_ts').notNull(),
  userId: text('user_id'),
  totalCostUSD: real('total_cost_usd'),
  durationMs: integer('duration_ms'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadInputTokens: integer('cache_read_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  modelUsageJson: text('model_usage_json'),
  createdAt: text('created_at').notNull(),
});
```

Note: the import line at the top of the file must also add `integer` and `real`:

```typescript
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
```

- [ ] **Step 2: Add CREATE TABLE IF NOT EXISTS to `src/db/index.ts`**

After the existing `CREATE TABLE IF NOT EXISTS memories` block (around line 39), add:

```typescript
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS session_analytics (
    id TEXT PRIMARY KEY,
    thread_ts TEXT NOT NULL,
    user_id TEXT,
    total_cost_usd REAL,
    duration_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    model_usage_json TEXT,
    created_at TEXT NOT NULL
  )
`);
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/index.ts
git commit -m "feat: add session_analytics table schema and migration"
```

---

### Task 2: Analytics Types

**Files:**

- Create: `src/analytics/types.ts`

- [ ] **Step 1: Create `src/analytics/types.ts`**

```typescript
import type { SessionUsageInfo } from '~/agent/types.js';

export interface SessionAnalyticsRecord {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  createdAt: string;
  durationMs: number;
  id: string;
  inputTokens: number;
  modelUsageJson: string;
  outputTokens: number;
  threadTs: string;
  totalCostUSD: number;
  userId?: string;
}

export interface SessionAnalyticsStore {
  upsert: (threadTs: string, userId: string | undefined, usage: SessionUsageInfo) => void;
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/analytics/types.ts
git commit -m "feat: add SessionAnalyticsStore interface"
```

---

### Task 3: SQLite Analytics Store

**Files:**

- Create: `src/analytics/sqlite-analytics-store.ts`

- [ ] **Step 1: Create `src/analytics/sqlite-analytics-store.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { SessionUsageInfo } from '~/agent/types.js';
import type { AppDatabase } from '~/db/index.js';
import { sessionAnalytics } from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import type { SessionAnalyticsStore } from './types.js';

export class SqliteAnalyticsStore implements SessionAnalyticsStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  upsert(threadTs: string, userId: string | undefined, usage: SessionUsageInfo): void {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadInputTokens = 0;
    let totalCacheCreationInputTokens = 0;

    for (const model of usage.modelUsage) {
      totalInputTokens += model.inputTokens;
      totalOutputTokens += model.outputTokens;
      totalCacheReadInputTokens += model.cacheReadInputTokens;
      totalCacheCreationInputTokens += model.cacheCreationInputTokens;
    }

    const modelUsageJson = JSON.stringify(usage.modelUsage);
    const now = new Date().toISOString();

    const existing = this.db
      .select()
      .from(sessionAnalytics)
      .where(eq(sessionAnalytics.threadTs, threadTs))
      .get();

    if (existing) {
      this.db
        .update(sessionAnalytics)
        .set({
          userId: userId ?? null,
          totalCostUSD: usage.totalCostUSD,
          durationMs: usage.durationMs,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: totalCacheReadInputTokens,
          cacheCreationInputTokens: totalCacheCreationInputTokens,
          modelUsageJson,
        })
        .where(eq(sessionAnalytics.id, existing.id))
        .run();
      this.logger.debug('Updated analytics for thread %s', threadTs);
      return;
    }

    this.db
      .insert(sessionAnalytics)
      .values({
        id: randomUUID(),
        threadTs,
        userId: userId ?? null,
        totalCostUSD: usage.totalCostUSD,
        durationMs: usage.durationMs,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadInputTokens,
        cacheCreationInputTokens: totalCacheCreationInputTokens,
        modelUsageJson,
        createdAt: now,
      })
      .run();
    this.logger.debug('Inserted analytics for thread %s', threadTs);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add src/analytics/sqlite-analytics-store.ts
git commit -m "feat: add SqliteAnalyticsStore implementation"
```

---

### Task 4: Analytics Store Tests

**Files:**

- Create: `tests/analytics-store.test.ts`

- [ ] **Step 1: Write tests in `tests/analytics-store.test.ts`**

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '~/db/index.js';
import * as schema from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import type { SessionUsageInfo } from '~/agent/types.js';

function createTestDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      thread_ts TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      root_message_ts TEXT NOT NULL,
      bootstrap_message_ts TEXT,
      stream_message_ts TEXT,
      claude_session_id TEXT,
      workspace_repo_id TEXT,
      workspace_repo_path TEXT,
      workspace_path TEXT,
      workspace_label TEXT,
      workspace_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_analytics (
      id TEXT PRIMARY KEY,
      thread_ts TEXT NOT NULL,
      user_id TEXT,
      total_cost_usd REAL,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      model_usage_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  // Insert a dummy session so FK is satisfied if needed
  sqlite.exec(`
    INSERT INTO sessions (thread_ts, channel_id, root_message_ts, created_at, updated_at)
    VALUES ('ts1', 'C123', 'root1', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')
  `);
  return drizzle(sqlite, { schema });
}

function createTestLogger(): AppLogger {
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

const sampleUsage: SessionUsageInfo = {
  totalCostUSD: 0.0142,
  durationMs: 12500,
  modelUsage: [
    {
      model: 'claude-sonnet-4-20250514',
      inputTokens: 15200,
      outputTokens: 3400,
      cacheReadInputTokens: 28000,
      cacheCreationInputTokens: 5000,
      cacheHitRate: 64.8,
      costUSD: 0.0142,
    },
  ],
};

describe('SqliteAnalyticsStore', () => {
  it('inserts a new analytics record', () => {
    const db = createTestDb();
    const store = new SqliteAnalyticsStore(db, createTestLogger());

    store.upsert('ts1', 'U123', sampleUsage);

    const rows = db.select().from(schema.sessionAnalytics).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.threadTs).toBe('ts1');
    expect(row.userId).toBe('U123');
    expect(row.totalCostUSD).toBe(0.0142);
    expect(row.durationMs).toBe(12500);
    expect(row.inputTokens).toBe(15200);
    expect(row.outputTokens).toBe(3400);
    expect(row.cacheReadInputTokens).toBe(28000);
    expect(row.cacheCreationInputTokens).toBe(5000);
    expect(JSON.parse(row.modelUsageJson!)).toEqual(sampleUsage.modelUsage);
  });

  it('updates an existing record on second upsert', () => {
    const db = createTestDb();
    const store = new SqliteAnalyticsStore(db, createTestLogger());

    store.upsert('ts1', 'U123', sampleUsage);

    const updatedUsage: SessionUsageInfo = {
      totalCostUSD: 0.05,
      durationMs: 20000,
      modelUsage: [
        {
          model: 'claude-sonnet-4-20250514',
          inputTokens: 30000,
          outputTokens: 6000,
          cacheReadInputTokens: 50000,
          cacheCreationInputTokens: 8000,
          cacheHitRate: 70.0,
          costUSD: 0.05,
        },
      ],
    };
    store.upsert('ts1', 'U123', updatedUsage);

    const rows = db.select().from(schema.sessionAnalytics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.totalCostUSD).toBe(0.05);
    expect(rows[0]!.inputTokens).toBe(30000);
  });

  it('handles undefined userId', () => {
    const db = createTestDb();
    const store = new SqliteAnalyticsStore(db, createTestLogger());

    store.upsert('ts1', undefined, sampleUsage);

    const rows = db.select().from(schema.sessionAnalytics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
  });

  it('aggregates tokens across multiple models', () => {
    const db = createTestDb();
    const store = new SqliteAnalyticsStore(db, createTestLogger());

    const multiModelUsage: SessionUsageInfo = {
      totalCostUSD: 0.03,
      durationMs: 15000,
      modelUsage: [
        {
          model: 'claude-sonnet-4-20250514',
          inputTokens: 10000,
          outputTokens: 2000,
          cacheReadInputTokens: 15000,
          cacheCreationInputTokens: 3000,
          cacheHitRate: 60.0,
          costUSD: 0.02,
        },
        {
          model: 'claude-haiku-4-20250514',
          inputTokens: 5000,
          outputTokens: 1000,
          cacheReadInputTokens: 8000,
          cacheCreationInputTokens: 2000,
          cacheHitRate: 61.5,
          costUSD: 0.01,
        },
      ],
    };

    store.upsert('ts1', 'U123', multiModelUsage);

    const rows = db.select().from(schema.sessionAnalytics).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(15000);
    expect(rows[0]!.outputTokens).toBe(3000);
    expect(rows[0]!.cacheReadInputTokens).toBe(23000);
    expect(rows[0]!.cacheCreationInputTokens).toBe(5000);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- tests/analytics-store.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/analytics-store.test.ts
git commit -m "test: add unit tests for SqliteAnalyticsStore"
```

---

### Task 5: Wire Analytics Store into DI Graph

**Files:**

- Modify: `src/slack/ingress/types.ts`
- Modify: `src/slack/app.ts`
- Modify: `src/application.ts`

- [ ] **Step 1: Add `analyticsStore` to `SlackIngressDependencies` in `src/slack/ingress/types.ts`**

Add the import at the top:

```typescript
import type { SessionAnalyticsStore } from '~/analytics/types.js';
```

Add to the `SlackIngressDependencies` interface:

```typescript
analyticsStore: SessionAnalyticsStore;
```

- [ ] **Step 2: Add `analyticsStore` to `SlackApplicationDependencies` in `src/slack/app.ts`**

Add the import:

```typescript
import type { SessionAnalyticsStore } from '~/analytics/types.js';
```

Add to the `SlackApplicationDependencies` interface:

```typescript
analyticsStore: SessionAnalyticsStore;
```

In the `createSlackApp` function, add to the `ingressDeps` object:

```typescript
analyticsStore: deps.analyticsStore,
```

- [ ] **Step 3: Instantiate and inject in `src/application.ts`**

Add the import:

```typescript
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
```

After the `memoryStore` creation (around line 39), add:

```typescript
const analyticsStore = new SqliteAnalyticsStore(db, logger.withTag('analytics'));
```

Add `analyticsStore` to the `createSlackApp` call:

```typescript
const slackApp: App = createSlackApp({
  logger,
  memoryStore,
  sessionStore,
  analyticsStore,
  providerRegistry,
  threadExecutionRegistry,
  userInputBridge,
  workspaceResolver,
  ...(statusProbe ? { statusProbe } : {}),
});
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`
Expected: Compiles without errors.

- [ ] **Step 5: Commit**

```bash
git add src/slack/ingress/types.ts src/slack/app.ts src/application.ts
git commit -m "feat: wire analytics store into dependency injection graph"
```

---

### Task 6: ActivitySink Integration

**Files:**

- Modify: `src/slack/ingress/activity-sink.ts`
- Modify: `src/slack/ingress/conversation-pipeline.ts`

- [ ] **Step 1: Add `analyticsStore` to `ActivitySinkOptions` in `src/slack/ingress/activity-sink.ts`**

Add the import:

```typescript
import type { SessionAnalyticsStore } from '~/analytics/types.js';
```

Add to `ActivitySinkOptions`:

```typescript
analyticsStore?: SessionAnalyticsStore;
```

- [ ] **Step 2: Destructure `analyticsStore` from options in `createActivitySink`**

In the destructuring block (around line 53), add `analyticsStore`:

```typescript
const {
  analyticsStore,
  channel,
  client,
  logger,
  renderer,
  sessionStore,
  threadTs,
  userId,
  userInputBridge,
  workspaceLabel,
} = options;
```

- [ ] **Step 3: Persist analytics in the `finalize` method**

In the `finalize` method, after the existing `postSessionUsageInfo` block (around line 456), add:

```typescript
if (sessionUsageInfo && analyticsStore) {
  try {
    analyticsStore.upsert(threadTs, userId, sessionUsageInfo);
  } catch (err) {
    logger.warn('Failed to persist session analytics: %s', String(err));
  }
}
```

This runs for both completed and non-completed sessions — if `sessionUsageInfo` exists (e.g. a stopped session may have partial usage), we persist it.

- [ ] **Step 4: Pass `analyticsStore` in `src/slack/ingress/conversation-pipeline.ts`**

In the `executeAgent` function, update the `createActivitySink` call (around line 235) to include:

```typescript
const sink = createActivitySink({
  analyticsStore: deps.analyticsStore,
  channel: message.channel,
  client,
  logger: deps.logger,
  renderer: deps.renderer,
  sessionStore: deps.sessionStore,
  threadTs,
  userId: message.user,
  userInputBridge: deps.userInputBridge,
  ...(workspace ? { workspaceLabel: workspace.workspaceLabel } : {}),
});
```

- [ ] **Step 5: Verify build**

Run: `pnpm build`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add src/slack/ingress/activity-sink.ts src/slack/ingress/conversation-pipeline.ts
git commit -m "feat: persist session analytics on ActivitySink finalize"
```

---

### Task 7: ActivitySink Analytics Tests

**Files:**

- Modify: `tests/activity-sink.test.ts`

- [ ] **Step 1: Add tests for analytics persistence**

At the top of `tests/activity-sink.test.ts`, add the import:

```typescript
import type { SessionAnalyticsStore } from '~/analytics/types.js';
```

Add a helper function after `createMockSessionStore`:

```typescript
function createMockAnalyticsStore(): SessionAnalyticsStore {
  return {
    upsert: vi.fn(),
  };
}
```

Add these test cases at the end of the `describe('createActivitySink', ...)` block, before the closing `});`:

```typescript
it('persists analytics on finalize when lifecycle completed and usage info available', async () => {
  const analyticsStore = createMockAnalyticsStore();
  const sink = createActivitySink({
    analyticsStore,
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer: createRendererStub(),
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
    userId: 'U999',
  });

  const usage = {
    totalCostUSD: 0.01,
    durationMs: 5000,
    modelUsage: [
      {
        model: 'claude-sonnet-4',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 100,
        cacheHitRate: 66.7,
        costUSD: 0.01,
      },
    ],
  };

  await sink.onEvent({ type: 'usage-info', usage });
  await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
  await sink.finalize();

  expect(analyticsStore.upsert).toHaveBeenCalledWith('ts1', 'U999', usage);
});

it('does not persist analytics when no analyticsStore provided', async () => {
  const sink = createActivitySink({
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer: createRendererStub(),
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
    userId: 'U999',
  });

  const usage = {
    totalCostUSD: 0.01,
    durationMs: 5000,
    modelUsage: [
      {
        model: 'claude-sonnet-4',
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 100,
        cacheHitRate: 66.7,
        costUSD: 0.01,
      },
    ],
  };

  await sink.onEvent({ type: 'usage-info', usage });
  await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
  await sink.finalize();
  // Should not throw
});

it('does not persist analytics when no usage info available', async () => {
  const analyticsStore = createMockAnalyticsStore();
  const sink = createActivitySink({
    analyticsStore,
    channel: 'C123',
    client: createMockClient(),
    logger: createTestLogger(),
    renderer: createRendererStub(),
    sessionStore: createMockSessionStore(),
    threadTs: 'ts1',
    userId: 'U999',
  });

  await sink.onEvent({ type: 'lifecycle', phase: 'completed' });
  await sink.finalize();

  expect(analyticsStore.upsert).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- tests/activity-sink.test.ts`
Expected: All tests PASS (existing + 3 new).

- [ ] **Step 3: Commit**

```bash
git add tests/activity-sink.test.ts
git commit -m "test: add activity-sink analytics persistence tests"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full build**

Run: `pnpm build`
Expected: No errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Lint changed files only**

Run: `pnpm typecheck`
Expected: No type errors.
