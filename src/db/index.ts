import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export function createDatabase(dbPath: string) {
  const sqlite = new Database(dbPath);
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
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      repo_id TEXT,
      thread_ts TEXT,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
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

  migrateMemoriesRepoIdNullable(sqlite);

  ensureSessionsColumn(sqlite, 'workspace_repo_id', 'TEXT');
  ensureSessionsColumn(sqlite, 'workspace_repo_path', 'TEXT');
  ensureSessionsColumn(sqlite, 'workspace_path', 'TEXT');
  ensureSessionsColumn(sqlite, 'workspace_label', 'TEXT');
  ensureSessionsColumn(sqlite, 'workspace_source', 'TEXT');
  ensureSessionsColumn(sqlite, 'agent_provider', 'TEXT');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>['db'];

function ensureSessionsColumn(
  sqlite: Database.Database,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = sqlite.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${columnName} ${columnDefinition}`);
}

function migrateMemoriesRepoIdNullable(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info('memories')").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const repoIdCol = columns.find((c) => c.name === 'repo_id');
  if (!repoIdCol || repoIdCol.notnull === 0) {
    return;
  }

  sqlite.exec(`
    ALTER TABLE memories RENAME TO memories_old;
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      repo_id TEXT,
      thread_ts TEXT,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );
    INSERT INTO memories SELECT * FROM memories_old;
    DROP TABLE memories_old;
  `);
}
