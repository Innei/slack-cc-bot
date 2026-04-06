import fs from 'node:fs';
import path from 'node:path';

import type { AppLogger } from '~/logger/index.js';

interface SlackManifestSlashCommand {
  command: string;
  description: string;
  should_escape?: boolean;
  url?: string;
  usage_hint?: string;
}

interface SlackManifestShortcut {
  callback_id: string;
  description: string;
  name: string;
  type: 'global' | 'message';
}

interface SlackManifestBotUser {
  [key: string]: unknown;
  always_online?: boolean;
  display_name?: string;
}

interface SlackManifestAppHome {
  home_tab_enabled?: boolean;
  messages_tab_enabled?: boolean;
  messages_tab_read_only_enabled?: boolean;
}

interface SlackManifestEventSubscriptions {
  [key: string]: unknown;
  bot_events?: string[];
}

interface SlackManifest {
  [key: string]: unknown;
  features?: {
    app_home?: SlackManifestAppHome;
    bot_user?: SlackManifestBotUser;
    shortcuts?: SlackManifestShortcut[];
    slash_commands?: SlackManifestSlashCommand[];
    [key: string]: unknown;
  };
  settings?: {
    event_subscriptions?: SlackManifestEventSubscriptions;
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
  {
    command: '/provider',
    description: 'View or switch the AI provider for this thread',
    usage_hint: '[list|reset|<provider-id>]',
  },
  {
    command: '/version',
    description: 'Show the current bot deployment version (git commit hash)',
    usage_hint: ' ',
  },
];

const DESIRED_SHORTCUTS: SlackManifestShortcut[] = [
  {
    name: 'Stop Reply',
    type: 'message',
    callback_id: 'stop_reply_action',
    description: "Stop the bot's in-progress reply in this thread",
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
  const missingCommands = DESIRED_COMMANDS.filter((c) => !existingNames.has(c.command));

  const existingShortcuts = currentManifest.features?.shortcuts ?? [];
  const existingCallbackIds = new Set(existingShortcuts.map((s) => s.callback_id));
  const missingShortcuts = DESIRED_SHORTCUTS.filter((s) => !existingCallbackIds.has(s.callback_id));

  // Ensure bot_user.always_online is true (required for Socket Mode presence)
  const botUser = currentManifest.features?.bot_user;
  const needsAlwaysOnline = !botUser?.always_online;

  // Ensure home tab is enabled (required for Home tab to render)
  const appHome = currentManifest.features?.app_home;
  const needsHomeTab = !appHome?.home_tab_enabled;

  // Ensure app_home_opened event is subscribed
  const existingBotEvents = currentManifest.settings?.event_subscriptions?.bot_events ?? [];
  const needsHomeEvent = !existingBotEvents.includes('app_home_opened');

  // Remove /stop if still present in manifest (replaced by reaction + shortcut)
  const commandsToKeep = (
    missingCommands.length > 0 ? [...existingCommands, ...missingCommands] : existingCommands
  ).filter((c) => c.command !== '/stop');
  const commandsChanged =
    missingCommands.length > 0 || commandsToKeep.length !== existingCommands.length;

  if (
    !commandsChanged &&
    missingShortcuts.length === 0 &&
    !needsAlwaysOnline &&
    !needsHomeTab &&
    !needsHomeEvent
  ) {
    logger.info(
      'All %d slash commands and %d shortcuts already registered, bot always_online and home_tab are enabled',
      DESIRED_COMMANDS.length,
      DESIRED_SHORTCUTS.length,
    );
    return;
  }

  if (missingCommands.length > 0) {
    logger.info(
      'Registering %d missing slash commands: %s',
      missingCommands.length,
      missingCommands.map((c) => c.command).join(', '),
    );
  }
  if (missingShortcuts.length > 0) {
    logger.info(
      'Registering %d missing shortcuts: %s',
      missingShortcuts.length,
      missingShortcuts.map((s) => s.name).join(', '),
    );
  }
  if (needsAlwaysOnline) {
    logger.info('Enabling bot_user.always_online for Socket Mode presence');
  }
  if (needsHomeTab) {
    logger.info('Enabling app_home.home_tab_enabled for Home tab');
  }
  if (needsHomeEvent) {
    logger.info('Adding app_home_opened to bot_events for Home tab updates');
  }

  // Build updated bot_events list if needed
  const updatedBotEvents = needsHomeEvent
    ? [...existingBotEvents, 'app_home_opened']
    : existingBotEvents;

  const updatedManifest: SlackManifest = {
    ...currentManifest,
    features: {
      ...currentManifest.features,
      app_home: {
        ...currentManifest.features?.app_home,
        home_tab_enabled: true,
      },
      bot_user: {
        ...currentManifest.features?.bot_user,
        always_online: true,
      },
      slash_commands: commandsToKeep,
      shortcuts: [...existingShortcuts, ...missingShortcuts],
    },
    settings: {
      ...currentManifest.settings,
      event_subscriptions: {
        ...currentManifest.settings?.event_subscriptions,
        bot_events: updatedBotEvents,
      },
    },
  };

  const success = await updateManifest(appId, accessToken, updatedManifest);
  if (success) {
    logger.info('Manifest updated successfully');
  } else {
    logger.error('Failed to update app manifest');
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
  const currentConfigToken = stored?.accessToken ?? options.configToken;
  if (refreshToken && currentConfigToken) {
    logger.info('Rotating config token via refresh token...');
    const rotated = await rotateToken(currentConfigToken, refreshToken);
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
      const fallback = await rotateToken(currentConfigToken, options.refreshToken);
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

export async function rotateToken(
  configToken: string,
  refreshToken: string,
): Promise<TokenRotateResponse | undefined> {
  try {
    const body = new URLSearchParams({
      token: configToken,
      refresh_token: refreshToken,
    });
    const response = await fetch('https://slack.com/api/tooling.tokens.rotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
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
