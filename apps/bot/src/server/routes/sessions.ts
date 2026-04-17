import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { sessions } from '~/db/schema.js';

import type { HttpServerDeps } from '../types.js';

export function createSessionsRoutes(deps: HttpServerDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    const limitRaw = c.req.query('limit');
    const limit = Math.min(Math.max(Number(limitRaw ?? 50) || 50, 1), 500);

    const rows = deps.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.updatedAt))
      .limit(limit)
      .all();

    return c.json({
      rows: rows.map((row) => ({
        agentProvider: row.agentProvider,
        bootstrapMessageTs: row.bootstrapMessageTs,
        channelId: row.channelId,
        createdAt: row.createdAt,
        providerSessionId: row.providerSessionId,
        rootMessageTs: row.rootMessageTs,
        streamMessageTs: row.streamMessageTs,
        threadTs: row.threadTs,
        updatedAt: row.updatedAt,
        workspaceLabel: row.workspaceLabel,
        workspacePath: row.workspacePath,
        workspaceRepoId: row.workspaceRepoId,
        workspaceRepoPath: row.workspaceRepoPath,
        workspaceSource: row.workspaceSource,
      })),
      total: deps.sessionStore.countAll(),
    });
  });

  app.get('/:threadTs', (c) => {
    const threadTs = c.req.param('threadTs');
    const row = deps.db.select().from(sessions).where(eq(sessions.threadTs, threadTs)).get();
    if (!row) {
      return c.json({ error: 'Not found' }, 404);
    }
    return c.json(row);
  });

  return app;
}
