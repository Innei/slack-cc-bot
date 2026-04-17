import { Hono } from 'hono';

import type { HttpServerDeps } from '../types.js';

export function createWorkspacesRoutes(deps: HttpServerDeps) {
  const app = new Hono();

  app.get('/', (c) => {
    const repos = deps.workspaceResolver.listRepos();
    return c.json({ rows: repos });
  });

  return app;
}
