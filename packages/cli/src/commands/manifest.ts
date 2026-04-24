import fs from 'node:fs';

import { Command } from 'commander';

import { loadEnvFile } from '../config/env-loader.js';
import { resolveKaguraPaths } from '../config/paths.js';
import {
  appsManifestExport,
  appsManifestUpdate,
  rotateToolingToken,
} from '../slack/config-token.js';
import { buildManifest } from '../slack/manifest-template.js';

export function buildManifestCommand(): Command {
  const cmd = new Command('manifest').description('Manifest utilities');

  cmd
    .command('print')
    .description('Print the Kagura-desired Slack manifest (no API call)')
    .option('--out <file>', 'write to file instead of stdout')
    .action((opts: { out?: string }) => {
      const manifest = buildManifest({ appName: 'Kagura', botDisplayName: 'kagura' });
      const json = JSON.stringify(manifest, null, 2);
      if (opts.out) {
        fs.writeFileSync(opts.out, json + '\n', 'utf8');
      } else {
        process.stdout.write(json + '\n');
      }
    });

  cmd
    .command('export')
    .description('Export the current Slack app manifest via config token')
    .option('--out <file>', 'write to file instead of stdout')
    .action(async (opts: { out?: string }) => {
      const paths = resolveKaguraPaths();
      loadEnvFile(paths);
      const appId = process.env.SLACK_APP_ID;
      if (!appId) {
        process.stderr.write('SLACK_APP_ID is not set\n');
        process.exitCode = 2;
        return;
      }
      const token = await ensureConfigToken();
      if (!token) {
        process.stderr.write(
          'No valid config token available (SLACK_CONFIG_TOKEN / REFRESH_TOKEN)\n',
        );
        process.exitCode = 2;
        return;
      }
      const res = await appsManifestExport(token, appId);
      if (!res.ok) {
        process.stderr.write(`Slack: ${res.error}\n`);
        process.exitCode = 2;
        return;
      }
      const json = JSON.stringify(res.manifest, null, 2);
      if (opts.out) fs.writeFileSync(opts.out, json + '\n', 'utf8');
      else process.stdout.write(json + '\n');
    });

  cmd
    .command('sync')
    .description('Sync the Kagura-desired manifest into the existing Slack app')
    .option('--dry-run', 'show what would change without writing')
    .action(async (opts: { dryRun?: boolean }) => {
      const paths = resolveKaguraPaths();
      loadEnvFile(paths);
      const appId = process.env.SLACK_APP_ID;
      if (!appId) {
        process.stderr.write('SLACK_APP_ID is not set\n');
        process.exitCode = 2;
        return;
      }
      const token = await ensureConfigToken();
      if (!token) {
        process.stderr.write('No valid config token available\n');
        process.exitCode = 2;
        return;
      }
      const desired = buildManifest({ appName: 'Kagura', botDisplayName: 'kagura' });
      if (opts.dryRun) {
        process.stdout.write(
          '[dry-run] would update manifest:\n' + JSON.stringify(desired, null, 2) + '\n',
        );
        return;
      }
      const res = await appsManifestUpdate(token, appId, desired);
      if (!res.ok) {
        process.stderr.write(`Slack: ${res.error}\n`);
        process.exitCode = 2;
        return;
      }
      process.stdout.write('Manifest updated.\n');
    });

  return cmd;
}

async function ensureConfigToken(): Promise<string | undefined> {
  const current = process.env.SLACK_CONFIG_TOKEN;
  const refresh = process.env.SLACK_CONFIG_REFRESH_TOKEN;
  if (current && refresh) {
    const rotated = await rotateToolingToken(current, refresh);
    if (rotated.ok) return rotated.token;
  }
  return current?.trim() || undefined;
}
