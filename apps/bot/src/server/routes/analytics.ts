import { Hono } from 'hono';

import type { HttpServerDeps } from '../types.js';

export function createAnalyticsRoutes(deps: HttpServerDeps) {
  const app = new Hono();

  app.get('/overview', (c) => {
    const overview = deps.analyticsStore.getOverview();
    return c.json(overview);
  });

  app.get('/models', (c) => {
    const rows = deps.analyticsStore.getByModel();
    return c.json({ rows });
  });

  app.get('/sessions', (c) => {
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(Number(limitRaw ?? 20) || 20, 1), 200);
    const rows = deps.analyticsStore.getRecentSessions(limit);
    const mapped = rows.map((row) => ({
      ...row,
      modelUsage: safeParseJson(row.modelUsageJson) ?? [],
    }));
    return c.json({ rows: mapped });
  });

  return app;
}

function safeParseJson<T = unknown>(raw: string | null | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
