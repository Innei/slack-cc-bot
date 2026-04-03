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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export type AppDatabase = ReturnType<typeof createDatabase>['db'];
