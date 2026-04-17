import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach,describe, expect, it } from 'vitest';

import { SqliteChannelPreferenceStore } from '~/channel-preference/sqlite-channel-preference-store.js';
import * as schema from '~/db/schema.js';
import { createRootLogger } from '~/logger/index.js';

describe('SqliteChannelPreferenceStore', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;
  let store: SqliteChannelPreferenceStore;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE channel_preferences (
        channel_id TEXT PRIMARY KEY,
        default_workspace_input TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db = drizzle(sqlite, { schema });
    store = new SqliteChannelPreferenceStore(db, createRootLogger().withTag('test'));
  });

  it('returns undefined when no preference exists', () => {
    expect(store.get('C123')).toBeUndefined();
  });

  it('upserts and retrieves a preference', () => {
    const record = store.upsert('C123', 'my-repo');
    expect(record.channelId).toBe('C123');
    expect(record.defaultWorkspaceInput).toBe('my-repo');

    const retrieved = store.get('C123');
    expect(retrieved?.channelId).toBe('C123');
    expect(retrieved?.defaultWorkspaceInput).toBe('my-repo');
  });

  it('updates an existing preference', () => {
    store.upsert('C123', 'repo-a');
    const updated = store.upsert('C123', 'repo-b');
    expect(updated.defaultWorkspaceInput).toBe('repo-b');

    const retrieved = store.get('C123');
    expect(retrieved?.defaultWorkspaceInput).toBe('repo-b');
  });

  it('allows clearing the preference by passing undefined', () => {
    store.upsert('C123', 'repo-a');
    const updated = store.upsert('C123', undefined);
    expect(updated.defaultWorkspaceInput).toBeUndefined();

    const retrieved = store.get('C123');
    expect(retrieved?.defaultWorkspaceInput).toBeUndefined();
  });
});
