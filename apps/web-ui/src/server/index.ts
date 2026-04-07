import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { createApp } from './app.js';

const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? (isProd ? 3100 : 3101));
const app = createApp();

if (isProd) {
  app.use('/*', serveStatic({ root: './dist/client' }));
  // SPA fallback
  app.get('/*', serveStatic({ root: './dist/client', path: 'index.html' }));
}

serve({ fetch: app.fetch, port }, () => {
  console.info(`Web UI server listening on http://localhost:${port}`);
});
