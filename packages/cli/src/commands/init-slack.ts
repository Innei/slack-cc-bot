import fs from 'node:fs';
import path from 'node:path';

import * as p from '@clack/prompts';
import open from 'open';

import { writeEnvFile } from '../config/env-writer.js';
import type { KaguraPaths } from '../config/paths.js';
import { appsManifestCreate, rotateToolingToken, type SlackResult } from '../slack/config-token.js';
import { buildManifest } from '../slack/manifest-template.js';
import { buildPrefillUrl } from '../slack/prefill-url.js';

const SLACK_AUTH_TEST = 'https://slack.com/api/auth.test';

const SLACK_REQUIRED_KEYS = [
  'SLACK_APP_ID',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
] as const;

function ensureEnvSkeleton(envFile: string): void {
  if (fs.existsSync(envFile)) return;
  const header = [
    '# Slack secrets — fill these in, then run `kagura` again.',
    '# See https://api.slack.com/apps for where to find them.',
    ...SLACK_REQUIRED_KEYS.map((k) => `# ${k}=`),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, header, 'utf8');
}

function noteSkipped(envFile: string): void {
  ensureEnvSkeleton(envFile);
  p.note(
    `Slack tokens are still required before kagura can start.\n` +
      `Re-run \`kagura init\` to fill them in,\n` +
      `or edit ${envFile} directly (placeholders added).`,
    'Slack setup skipped',
  );
}

export interface SlackOnboardingOptions {
  allowSkip: boolean;
}

export async function runSlackOnboarding(
  paths: KaguraPaths,
  opts: SlackOnboardingOptions,
): Promise<void> {
  const options = [
    { value: 'new' as const, label: 'Create a new Slack app' },
    { value: 'reuse' as const, label: 'Reuse an existing Slack app' },
    ...(opts.allowSkip ? [{ value: 'skip' as const, label: 'Skip (dev / come back later)' }] : []),
  ];
  const mode = await p.select({ message: 'Slack app', options });
  if (p.isCancel(mode) || mode === 'skip') {
    noteSkipped(paths.envFile);
    return;
  }

  if (mode === 'new') {
    await handleNewApp(paths);
  } else {
    await handleReuseApp(paths);
  }
}

async function handleNewApp(paths: KaguraPaths): Promise<void> {
  const manifest = buildManifest({ appName: 'Kagura', botDisplayName: 'kagura' });
  const configToken = await ensureConfigToken();

  if (configToken) {
    const created = await appsManifestCreate(configToken, manifest);
    if (!created.ok) {
      p.log.error(`Slack apps.manifest.create failed: ${created.error}`);
      return;
    }
    writeEnvFile(paths.envFile, {
      SLACK_APP_ID: created.app_id,
      SLACK_SIGNING_SECRET: created.credentials.signing_secret,
    });
    p.log.info(`App created: ${created.app_id}`);
    const installUrl = `https://api.slack.com/apps/${created.app_id}/install-on-team`;
    await open(installUrl);
    p.note(
      `Install URL: ${installUrl}\n` +
        '1. Click "Install to Workspace"\n' +
        '2. Copy the Bot User OAuth Token (xoxb-)\n' +
        '3. Back to terminal, paste it below',
    );
  } else {
    const prefill = buildPrefillUrl(manifest);
    if (prefill.kind === 'url') {
      await open(prefill.url);
      p.note(
        `Browser opened to: ${prefill.url}\n` +
          '1. Click "Create" → "Install to Workspace"\n' +
          '2. Gather: App ID, Signing Secret, Bot Token (xoxb-), App-Level Token (xapp-)',
      );
    } else {
      const manifestPath = path.join(paths.configDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      await open('https://api.slack.com/apps?new_app=1');
      p.note(
        `Manifest too large for prefill URL.\nWritten to: ${manifestPath}\nPaste it into the "From manifest" flow.`,
      );
    }
    const appId = await p.text({ message: 'SLACK_APP_ID' });
    if (p.isCancel(appId)) {
      noteSkipped(paths.envFile);
      return;
    }
    const signingSecret = await p.password({ message: 'SLACK_SIGNING_SECRET' });
    if (p.isCancel(signingSecret)) {
      noteSkipped(paths.envFile);
      return;
    }
    writeEnvFile(paths.envFile, {
      SLACK_APP_ID: String(appId),
      SLACK_SIGNING_SECRET: String(signingSecret),
    });
  }

  const botToken = await promptAndVerifyToken('SLACK_BOT_TOKEN (xoxb-)', 'bot', paths.envFile);
  if (botToken === undefined) return;
  const appToken = await promptAndVerifyToken('SLACK_APP_TOKEN (xapp-)', 'app', paths.envFile);
  if (appToken === undefined) return;
  writeEnvFile(paths.envFile, { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken });
}

async function handleReuseApp(paths: KaguraPaths): Promise<void> {
  const appId = await p.text({ message: 'SLACK_APP_ID' });
  if (p.isCancel(appId)) {
    noteSkipped(paths.envFile);
    return;
  }
  const signingSecret = await p.password({ message: 'SLACK_SIGNING_SECRET' });
  if (p.isCancel(signingSecret)) {
    noteSkipped(paths.envFile);
    return;
  }
  writeEnvFile(paths.envFile, {
    SLACK_APP_ID: String(appId),
    SLACK_SIGNING_SECRET: String(signingSecret),
  });

  const botToken = await promptAndVerifyToken('SLACK_BOT_TOKEN (xoxb-)', 'bot', paths.envFile);
  if (botToken === undefined) return;
  const appToken = await promptAndVerifyToken('SLACK_APP_TOKEN (xapp-)', 'app', paths.envFile);
  if (appToken === undefined) return;
  writeEnvFile(paths.envFile, { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken });
}

async function ensureConfigToken(): Promise<string | undefined> {
  const current = process.env.SLACK_CONFIG_TOKEN?.trim();
  const refresh = process.env.SLACK_CONFIG_REFRESH_TOKEN?.trim();
  if (!current) return undefined;
  if (refresh) {
    const rotated = await rotateToolingToken(current, refresh);
    if (rotated.ok) return rotated.token;
  }
  return current;
}

async function promptAndVerifyToken(
  message: string,
  kind: 'bot' | 'app',
  envFile: string,
): Promise<string | undefined> {
  for (;;) {
    const raw = await p.password({ message });
    if (p.isCancel(raw)) {
      noteSkipped(envFile);
      return undefined;
    }
    const token = String(raw).trim();
    if (await verifyToken(token, kind)) return token;
    p.log.error('Token rejected by Slack — please retry.');
  }
}

async function verifyToken(token: string, kind: 'bot' | 'app'): Promise<boolean> {
  if (kind === 'bot' && !token.startsWith('xoxb-')) return false;
  if (kind === 'app' && !token.startsWith('xapp-')) return false;
  const res = await fetch(SLACK_AUTH_TEST, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: '',
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { ok: boolean };
  return data.ok === true;
}

export type { SlackResult };
