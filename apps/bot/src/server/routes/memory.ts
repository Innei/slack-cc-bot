import { Hono } from 'hono';

import { MEMORY_CATEGORIES } from '~/memory/types.js';

import type { HttpServerDeps } from '../types.js';

export function createMemoryRoutes(deps: HttpServerDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    const repoId = c.req.query('repoId') || undefined;
    const q = c.req.query('q') || undefined;
    const category = c.req.query('category');
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 200);

    const options: {
      category?: (typeof MEMORY_CATEGORIES)[number];
      limit: number;
      query?: string;
    } = { limit };
    if (q) options.query = q;
    if (category && (MEMORY_CATEGORIES as readonly string[]).includes(category)) {
      options.category = category as (typeof MEMORY_CATEGORIES)[number];
    }

    const rows = deps.memoryStore.search(repoId, options);
    return c.json({
      rows,
      total: deps.memoryStore.countAll(repoId),
    });
  });

  app.get('/context', (c) => {
    const repoId = c.req.query('repoId') || undefined;
    const globalLimitRaw = c.req.query('globalLimit');
    const workspaceLimitRaw = c.req.query('workspaceLimit');

    const limits: { global?: number; workspace?: number } = {};
    if (globalLimitRaw) limits.global = Math.max(1, Number(globalLimitRaw) || 5);
    if (workspaceLimitRaw) limits.workspace = Math.max(1, Number(workspaceLimitRaw) || 10);

    const context = deps.memoryStore.listForContext(repoId, limits);
    return c.json(context);
  });

  app.get('/recent', (c) => {
    const repoId = c.req.query('repoId') || undefined;
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(Number(limitRaw ?? 20) || 20, 1), 100);
    const rows = deps.memoryStore.listRecent(repoId, limit);
    return c.json({ rows });
  });

  return app;
}
