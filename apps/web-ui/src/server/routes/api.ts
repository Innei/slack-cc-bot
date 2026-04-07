import { Hono } from 'hono';

import type { AppSettings, BotStatus, Session, Workspace } from './types.js';

export const apiRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------
apiRoutes.get('/status', (c) => {
  const status: BotStatus = {
    connected: false,
    uptime: null,
    activeSessionCount: 0,
    messagesToday: 0,
    avgResponseMs: null,
  };
  return c.json(status);
});

// ---------------------------------------------------------------------------
// GET /api/sessions
// ---------------------------------------------------------------------------
apiRoutes.get('/sessions', (c) => {
  const sessions: Session[] = [];
  return c.json(sessions);
});

// ---------------------------------------------------------------------------
// GET /api/workspaces
// ---------------------------------------------------------------------------
apiRoutes.get('/workspaces', (c) => {
  const workspaces: Workspace[] = [];
  return c.json(workspaces);
});

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------
apiRoutes.get('/settings', (c) => {
  const settings: AppSettings = {
    slackConnected: false,
    claudeModel: process.env.CLAUDE_MODEL ?? 'unknown',
    claudeMaxTurns: Number(process.env.CLAUDE_MAX_TURNS ?? 24),
    repoRootDir: process.env.REPO_ROOT_DIR ?? '~/git',
    repoScanDepth: Number(process.env.REPO_SCAN_DEPTH ?? 2),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
  return c.json(settings);
});
