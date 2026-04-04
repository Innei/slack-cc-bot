import fs from 'node:fs';
import path from 'node:path';

import type { AppLogger } from '../../logger/index.js';

interface SlackManifestSlashCommand {
  command: string;
  description: string;
  should_escape?: boolean;
  url?: string;
  usage_hint?: string;
}

interface SlackManifest {
  [key: string]: unknown;
  features?: {
    slash_commands?: SlackManifestSlashCommand[];
    [key: string]: unknown;
  };
}

interface SlackApiResponse<T = unknown> {
  error?: string;
  manifest?: T;
  ok: boolean;
}

interface TokenRotateResponse {
  error?: string;
  exp?: number;
  iat?: number;
  ok: boolean;
  refresh_token?: string;
  token?: string;
}

interface PersistedTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  updatedAt: string;
}

const DESIRED_COMMANDS: SlackManifestSlashCommand[] = [
  {
    command: '/usage',
    description: 'Show bot usage stats (sessions, memories, repos, uptime)',
    usage_hint: ' ',
  },
  {
    command: '/workspace',
    description: 'List available workspaces or look up a specific one',
    usage_hint: '[repo-name]',
  },
  {
    command: '/memory',
    description: 'View or manage workspace memories',
    usage_hint: 'list|count|clear <repo>',
  },
  {
    command: '/session',
    description: 'View session overview or inspect a specific session',
    usage_hint: '[thread_ts]',
  },
];

export interface ManifestSyncOptions {
  appId: string;
  configToken?: string | undefined;
  logger: AppLogger;
  refreshToken?: string | undefined;
  tokenStorePath?: string | undefined;
}

export async function syncSlashCommands(options: ManifestSyncOptions): Promise<void> {
  const { appId, logger } = options;
  const tokenStorePath = options.tokenStorePath ?? './data/slack-config-tokens.json';

  logger.info('Checking slash command registration for app %s...', appId);

  const accessToken = await resolveAccessToken(options, tokenStorePath);
  if (!accessToken) {
    logger.error(
      'No valid config token available — set SLACK_CONFIG_TOKEN or SLACK_CONFIG_REFRESH_TOKEN',
    );
    return;
  }

  const currentManifest = await exportManifest(appId, accessToken);
  if (!currentManifest) {
    logger.error('Failed to export app manifest — skipping slash command sync');
    return;
  }

  const existingCommands = currentManifest.features?.slash_commands ?? [];
  const existingNames = new Set(existingCommands.map((c) => c.command));
  const missing = DESIRED_COMMANDS.filter((c) => !existingNames.has(c.command));

  if (missing.length === 0) {
    logger.info('All %d slash commands already registered', DESIRED_COMMANDS.length);
    return;
  }

  logger.info(
    'Registering %d missing slash commands: %s',
    missing.length,
    missing.map((c) => c.command).join(', '),
  );

  const updatedManifest: SlackManifest = {
    ...currentManifest,
    features: {
      ...currentManifest.features,
      slash_commands: [...existingCommands, ...missing],
    },
  };

  const success = await updateManifest(appId, accessToken, updatedManifest);
  if (success) {
    logger.info('Slash commands registered successfully');
  } else {
    logger.error('Failed to update app manifest with slash commands');
  }
}

async function resolveAccessToken(
  options: ManifestSyncOptions,
  tokenStorePath: string,
): Promise<string | undefined> {
  const { logger } = options;

  const stored = loadPersistedTokens(tokenStorePath);
  if (stored && stored.expiresAt > Date.now() / 1000 + 300) {
    logger.debug(
      'Using persisted config token (expires at %s)',
      new Date(stored.expiresAt * 1000).toISOString(),
    );
    return stored.accessToken;
  }

  const refreshToken = stored?.refreshToken ?? options.refreshToken;
  if (refreshToken) {
    logger.info('Rotating config token via refresh token...');
    const rotated = await rotateToken(refreshToken);
    if (rotated) {
      persistTokens(tokenStorePath, rotated, logger);
      logger.info(
        'Config token rotated successfully (expires at %s)',
        new Date((rotated.exp ?? 0) * 1000).toISOString(),
      );
      return rotated.token;
    }

    if (
      stored?.refreshToken &&
      options.refreshToken &&
      stored.refreshToken !== options.refreshToken
    ) {
      logger.info('Stored refresh token failed, trying env refresh token...');
      const fallback = await rotateToken(options.refreshToken);
      if (fallback) {
        persistTokens(tokenStorePath, fallback, logger);
        return fallback.token;
      }
    }

    logger.warn('Token rotation failed');
  }

  if (options.configToken) {
    logger.debug('Falling back to SLACK_CONFIG_TOKEN from env');
    return options.configToken;
  }

  return undefined;
}

export async function rotateToken(refreshToken: string): Promise<TokenRotateResponse | undefined> {
  try {
    const response = await fetch('https://slack.com/api/tooling.tokens.rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as TokenRotateResponse;
    if (!data.ok || !data.token || !data.refresh_token) {
      return undefined;
    }

    return data;
  } catch {
    return undefined;
  }
}

function loadPersistedTokens(tokenStorePath: string): PersistedTokens | undefined {
  const absolutePath = path.resolve(process.cwd(), tokenStorePath);
  try {
    const content = fs.readFileSync(absolutePath, 'utf8');
    const parsed = JSON.parse(content) as Partial<PersistedTokens>;
    if (
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return parsed as PersistedTokens;
    }
  } catch {
    // File doesn't exist or is invalid — will be created on first rotation.
  }
  return undefined;
}

function persistTokens(
  tokenStorePath: string,
  rotated: TokenRotateResponse,
  logger: AppLogger,
): void {
  if (!rotated.token || !rotated.refresh_token) {
    return;
  }

  const absolutePath = path.resolve(process.cwd(), tokenStorePath);
  const data: PersistedTokens = {
    accessToken: rotated.token,
    refreshToken: rotated.refresh_token,
    expiresAt: rotated.exp ?? Math.floor(Date.now() / 1000) + 43_200,
    updatedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    logger.debug('Persisted rotated tokens to %s', absolutePath);
  } catch (error) {
    logger.warn(
      'Failed to persist rotated tokens: %s',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function exportManifest(
  appId: string,
  configToken: string,
): Promise<SlackManifest | undefined> {
  try {
    const response = await fetch('https://slack.com/api/apps.manifest.export', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${configToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ app_id: appId }),
    });

    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as SlackApiResponse<SlackManifest>;
    if (!data.ok || !data.manifest) {
      return undefined;
    }

    return data.manifest;
  } catch {
    return undefined;
  }
}

async function updateManifest(
  appId: string,
  configToken: string,
  manifest: SlackManifest,
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/apps.manifest.update', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${configToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ app_id: appId, manifest }),
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as SlackApiResponse;
    return data.ok === true;
  } catch {
    return false;
  }
}
