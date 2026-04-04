import { randomUUID } from 'node:crypto';

import { and, count, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/index.js';
import { memories } from '../db/schema.js';
import type { AppLogger } from '../logger/index.js';
import type { MemoryRecord, MemorySearchOptions, MemoryStore, SaveMemoryInput } from './types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

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
        repoId: input.repoId,
        threadTs: input.threadTs ?? null,
        category: input.category,
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        createdAt,
        expiresAt: input.expiresAt ?? null,
      })
      .run();

    this.logger.debug('Saved memory record %s for repo %s', id, input.repoId);

    return {
      id,
      repoId: input.repoId,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
      category: input.category,
      content: input.content,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
  }

  search(repoId: string, options: MemorySearchOptions = {}): MemoryRecord[] {
    const nowIso = new Date().toISOString();
    const safeLimit = normalizeLimit(options.limit);
    const query = options.query?.trim();
    const escapedQuery = query ? escapeLike(query.toLowerCase()) : undefined;

    const conditions: Array<Parameters<typeof and>[number]> = [
      eq(memories.repoId, repoId),
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

  listRecent(repoId: string, limit = DEFAULT_LIMIT): MemoryRecord[] {
    return this.search(repoId, { limit });
  }

  delete(id: string): boolean {
    const result = this.db.delete(memories).where(eq(memories.id, id)).run();
    return result.changes > 0;
  }

  prune(repoId: string): number {
    const nowIso = new Date().toISOString();
    const result = this.db
      .delete(memories)
      .where(and(eq(memories.repoId, repoId), lte(memories.expiresAt, nowIso)))
      .run();
    if (result.changes > 0) {
      this.logger.debug('Pruned %d expired memory records for repo %s', result.changes, repoId);
    }
    return result.changes;
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
    repoId: row.repoId,
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
