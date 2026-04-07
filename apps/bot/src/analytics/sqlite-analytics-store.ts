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
