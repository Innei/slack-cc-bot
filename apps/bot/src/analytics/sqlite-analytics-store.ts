import { randomUUID } from 'node:crypto';

import { desc, eq, sql } from 'drizzle-orm';

import type { ModelUsageInfo, SessionUsageInfo } from '~/agent/types.js';
import type { AppDatabase } from '~/db/index.js';
import { sessionAnalytics } from '~/db/schema.js';
import type { AppLogger } from '~/logger/index.js';

import type { AnalyticsOverview, ModelAnalyticsRow, SessionAnalyticsStore } from './types.js';

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

  getOverview(): AnalyticsOverview {
    const row = this.db
      .select({
        totalSessions: sql<number>`count(*)`,
        totalCostUSD: sql<number>`coalesce(sum(total_cost_usd), 0)`,
        totalInputTokens: sql<number>`coalesce(sum(input_tokens), 0)`,
        totalOutputTokens: sql<number>`coalesce(sum(output_tokens), 0)`,
        totalCacheReadTokens: sql<number>`coalesce(sum(cache_read_input_tokens), 0)`,
        totalCacheCreationTokens: sql<number>`coalesce(sum(cache_creation_input_tokens), 0)`,
        avgDurationMs: sql<number>`coalesce(avg(duration_ms), 0)`,
      })
      .from(sessionAnalytics)
      .get();

    const totalInput = row?.totalInputTokens ?? 0;
    const cacheRead = row?.totalCacheReadTokens ?? 0;
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

    return {
      totalSessions: row?.totalSessions ?? 0,
      totalCostUSD: row?.totalCostUSD ?? 0,
      totalInputTokens: totalInput,
      totalOutputTokens: row?.totalOutputTokens ?? 0,
      totalCacheReadTokens: cacheRead,
      totalCacheCreationTokens: row?.totalCacheCreationTokens ?? 0,
      avgDurationMs: Math.round(row?.avgDurationMs ?? 0),
      cacheHitRate,
    };
  }

  getByModel(): ModelAnalyticsRow[] {
    const records = this.db
      .select({ modelUsageJson: sessionAnalytics.modelUsageJson })
      .from(sessionAnalytics)
      .all();

    const modelMap = new Map<
      string,
      {
        sessions: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        totalCostUSD: number;
      }
    >();

    for (const record of records) {
      if (!record.modelUsageJson) continue;
      let models: ModelUsageInfo[];
      try {
        models = JSON.parse(record.modelUsageJson);
      } catch {
        continue;
      }
      for (const m of models) {
        const existing = modelMap.get(m.model) ?? {
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalCostUSD: 0,
        };
        existing.sessions++;
        existing.inputTokens += m.inputTokens;
        existing.outputTokens += m.outputTokens;
        existing.cacheReadTokens += m.cacheReadInputTokens;
        existing.totalCostUSD += m.costUSD;
        modelMap.set(m.model, existing);
      }
    }

    return Array.from(modelMap.entries())
      .map(([model, data]) => ({
        model,
        sessions: data.sessions,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cacheReadTokens: data.cacheReadTokens,
        totalCostUSD: data.totalCostUSD,
        cacheHitRate: data.inputTokens > 0 ? data.cacheReadTokens / data.inputTokens : 0,
      }))
      .sort((a, b) => b.totalCostUSD - a.totalCostUSD);
  }

  getRecentSessions(limit: number): import('./types.js').SessionAnalyticsRecord[] {
    return this.db
      .select()
      .from(sessionAnalytics)
      .orderBy(desc(sessionAnalytics.createdAt))
      .limit(limit)
      .all() as import('./types.js').SessionAnalyticsRecord[];
  }
}
