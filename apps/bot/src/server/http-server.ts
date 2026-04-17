import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';

import { createAnalyticsRoutes } from './routes/analytics.js';
import { createHealthRoutes } from './routes/health.js';
import { createMemoryRoutes } from './routes/memory.js';
import { createSessionsRoutes } from './routes/sessions.js';
import { createWorkspacesRoutes } from './routes/workspaces.js';
import type { BuildInfo, HttpServerDeps } from './types.js';

export interface HttpServerHandle {
  stop: () => Promise<void>;
  readonly url: string;
}

export interface StartHttpServerOptions {
  buildInfo: BuildInfo;
  deps: HttpServerDeps;
  host?: string;
  port: number;
}

export function buildHttpApp(deps: HttpServerDeps, buildInfo: BuildInfo): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = Date.now();
    try {
      await next();
    } finally {
      deps.logger.debug(
        '%s %s %d (%dms)',
        c.req.method,
        c.req.path,
        c.res.status,
        Date.now() - started,
      );
    }
  });

  app.use('*', async (c, next) => {
    const origin = c.req.header('origin') ?? '*';
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204);
    }
    await next();
  });

  app.onError((err, c) => {
    deps.logger.error('HTTP error: %s', err instanceof Error ? err.stack : String(err));
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });

  const api = new Hono();
  api.route('/', createHealthRoutes(deps, buildInfo));
  api.route('/analytics', createAnalyticsRoutes(deps));
  api.route('/sessions', createSessionsRoutes(deps));
  api.route('/memory', createMemoryRoutes(deps));
  api.route('/workspaces', createWorkspacesRoutes(deps));

  app.route('/api', api);

  app.get('/', (c) =>
    c.json({
      name: '@kagura/bot',
      endpoints: [
        '/api/health',
        '/api/version',
        '/api/analytics/overview',
        '/api/analytics/models',
        '/api/analytics/sessions',
        '/api/sessions',
        '/api/sessions/:threadTs',
        '/api/memory',
        '/api/memory/context',
        '/api/memory/recent',
        '/api/workspaces',
      ],
    }),
  );

  return app;
}

export async function startHttpServer(options: StartHttpServerOptions): Promise<HttpServerHandle> {
  const { buildInfo, deps, host = '0.0.0.0', port } = options;
  const app = buildHttpApp(deps, buildInfo);

  let server: ServerType | undefined;
  const ready = new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: host, port }, () => {
      deps.logger.info('HTTP API listening on http://%s:%d', host, port);
      resolve();
    });
  });
  await ready;

  return {
    url: `http://${host}:${port}`,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        if (!server) return resolve();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
