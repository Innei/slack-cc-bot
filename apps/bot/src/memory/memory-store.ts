import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { AppDatabase } from '~/db/index.js';
import { memories } from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import type {
  ContextMemories,
  MemoryRecord,
  MemorySearchOptions,
  MemoryStore,
  SaveMemoryInput,
} from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_GLOBAL_LIMIT = 5;
const DEFAULT_WORKSPACE_LIMIT = 10;

export class SqliteMemoryStore implements MemoryStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  countAll(repoId?: string): number {
    if (repoId) {
      const row = this.db
        .select({ value: count() })
        .from(memories)
        .where(eq(memories.repoId, repoId))
        .get();
      return row?.value ?? 0;
    }
    const row = this.db.select({ value: count() }).from(memories).get();
    return row?.value ?? 0;
  }

  save(input: SaveMemoryInput): MemoryRecord {
    const createdAt = new Date().toISOString();
    const id = randomUUID();

    this.db
      .insert(memories)
      .values({
        id,
        repoId: input.repoId ?? null,
        threadTs: input.threadTs ?? null,
        category: input.category,
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
        expiresAt: input.expiresAt ?? null,
      })
      .run();

    const scope = input.repoId ? 'workspace' : 'global';
    this.logger.debug('Saved %s memory record %s (repo: %s)', scope, id, input.repoId ?? 'global');

    return {
      id,
      scope,
      ...(input.repoId ? { repoId: input.repoId } : {}),
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      category: input.category,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
  }

  saveWithDedup(input: SaveMemoryInput, supersedesId?: string): MemoryRecord {
    if (supersedesId) {
      const deleted = this.delete(supersedesId);
      if (deleted) {
        this.logger.debug('Dedup: deleted superseded memory %s', supersedesId);
      }
    }

    return this.save(input);
  }

  search(repoId: string | undefined, options: MemorySearchOptions = {}): MemoryRecord[] {
    const nowIso = new Date().toISOString();
    const safeLimit = normalizeLimit(options.limit);
    const query = options.query?.trim();
    const escapedQuery = query ? escapeLike(query.toLowerCase()) : undefined;

    const repoCondition = repoId ? eq(memories.repoId, repoId) : isNull(memories.repoId);

    const conditions: Array<Parameters<typeof and>[number]> = [
      repoCondition,
      or(isNull(memories.expiresAt), gt(memories.expiresAt, nowIso)),
      ...(options.category ? [eq(memories.category, options.category)] : []),
      ...(escapedQuery
        ? [sql`lower(${memories.content}) like ${`%${escapedQuery}%`} escape '\\'`]
        : []),
    ];

    const rows = this.db
      .select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.createdAt))
      .limit(safeLimit)
      .all();

    return rows.map((row) => rowToRecord(row));
  }

  listRecent(repoId: string | undefined, limit = DEFAULT_LIMIT): MemoryRecord[] {
    return this.search(repoId, { limit });
  }

  listForContext(
    repoId: string | undefined,
    limits?: { global?: number; workspace?: number },
  ): ContextMemories {
    const globalLimit = limits?.global ?? DEFAULT_GLOBAL_LIMIT;
    const workspaceLimit = limits?.workspace ?? DEFAULT_WORKSPACE_LIMIT;

    const globalPrefs = this.search(undefined, { category: 'preference', limit: MAX_LIMIT });
    const workspacePrefs = repoId
      ? this.search(repoId, { category: 'preference', limit: MAX_LIMIT })
      : [];
    const preferences = [...globalPrefs, ...workspacePrefs];

    const prefIds = new Set(preferences.map((p) => p.id));

    const global = this.search(undefined, { limit: globalLimit + preferences.length }).filter(
      (m) => !prefIds.has(m.id),
    );
    const workspace = repoId
      ? this.search(repoId, { limit: workspaceLimit + preferences.length }).filter(
          (m) => !prefIds.has(m.id),
        )
      : [];

    return {
      global: global.slice(0, globalLimit),
      workspace: workspace.slice(0, workspaceLimit),
      preferences,
    };
  }

  delete(id: string): boolean {
    const result = this.db.delete(memories).where(eq(memories.id, id)).run();
    return result.changes > 0;
  }

  deleteAll(repoId?: string | null): number {
    if (repoId === null) {
      const result = this.db.delete(memories).where(isNull(memories.repoId)).run();
      if (result.changes > 0) {
        this.logger.debug('Deleted %d global memory records', result.changes);
      }
      return result.changes;
    }

    if (repoId) {
      const result = this.db.delete(memories).where(eq(memories.repoId, repoId)).run();
      if (result.changes > 0) {
        this.logger.debug('Deleted %d memory records for repo %s', result.changes, repoId);
      }
      return result.changes;
    }

    const result = this.db.delete(memories).run();
    if (result.changes > 0) {
      this.logger.debug('Deleted all %d memory records', result.changes);
    }
    return result.changes;
  }

  prune(repoId?: string | null): number {
    const nowIso = new Date().toISOString();

    if (repoId === null) {
      const result = this.db
        .delete(memories)
        .where(and(isNull(memories.repoId), lte(memories.expiresAt, nowIso)))
        .run();
      return result.changes;
    }

    if (repoId) {
      const result = this.db
        .delete(memories)
        .where(and(eq(memories.repoId, repoId), lte(memories.expiresAt, nowIso)))
        .run();
      if (result.changes > 0) {
        this.logger.debug('Pruned %d expired memory records for repo %s', result.changes, repoId);
      }
      return result.changes;
    }

    return this.pruneAll();
  }

  pruneAll(): number {
    const nowIso = new Date().toISOString();
    const result = this.db.delete(memories).where(lte(memories.expiresAt, nowIso)).run();
    if (result.changes > 0) {
      this.logger.debug('Pruned %d expired memory records', result.changes);
    }
    return result.changes;
  }
}

function normalizeLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function rowToRecord(row: typeof memories.$inferSelect): MemoryRecord {
  const parsedMetadata = row.metadata ? parseMetadata(row.metadata) : undefined;
  return {
    id: row.id,
    scope: row.repoId ? 'workspace' : 'global',
    ...(row.repoId ? { repoId: row.repoId } : {}),
    ...(row.threadTs ? { threadTs: row.threadTs } : {}),
    category: row.category,
    content: row.content,
    ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
    createdAt: row.createdAt,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
  };
}

function parseMetadata(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
