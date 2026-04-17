import { Hono } from 'hono';

import type { BuildInfo, HttpServerDeps } from '../types.js';

declare const __GIT_HASH__: string;
declare const __GIT_COMMIT_DATE__: string;

export function createHealthRoutes(_deps: HttpServerDeps, info: BuildInfo) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/version', (c) =>
    c.json({
      commitDate: info.commitDate,
      gitHash: info.gitHash,
      nodeEnv: info.nodeEnv,
      version: info.version,
    }),
  );

  return app;
}
