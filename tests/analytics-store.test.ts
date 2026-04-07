import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { SessionUsageInfo } from '~/agent/types.js';
import { SqliteAnalyticsStore } from '~/analytics/sqlite-analytics-store.js';
import type { AppDatabase } from '~/db/index.js';
import * as schema from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

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
          cacheHitRate: 70,
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
          cacheHitRate: 60,
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
