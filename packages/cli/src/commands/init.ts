import fs from 'node:fs';

import * as p from '@clack/prompts';
import { Command } from 'commander';

import { loadConfigJson, loadEnvFile } from '../config/env-loader.js';
import { writeEnvFile } from '../config/env-writer.js';
import { writeConfigJson } from '../config/json-writer.js';
import { type KaguraPaths,resolveKaguraPaths } from '../config/paths.js';
import { getProvider, listProviders } from '../providers/registry.js';
import type { ProviderId, SetupPatch } from '../providers/types.js';
import type { RunHooks } from '../router.js';
import { bindClackCtx } from '../ui/prompts.js';
import { runSlackOnboarding } from './init-slack.js';

export interface InitOptions {
  full?: boolean;
  skipStart?: boolean;
}

export async function runInit(opts: InitOptions, hooks: RunHooks = {}): Promise<number> {
  const paths = resolveKaguraPaths();
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });

  loadEnvFile(paths);
  const existingConfig = loadConfigJson(paths);

  p.intro('kagura · onboarding');

  const providerId = await p.select({
    message: 'Select AI provider',
    options: listProviders().map((pr) => ({ value: pr.id, label: pr.label })),
    initialValue: (existingConfig.defaultProviderId ?? 'claude-code') as ProviderId,
  });
  if (p.isCancel(providerId)) {
    p.cancel('Cancelled.');
    return 1;
  }

  await runSlackOnboarding(paths, { allowSkip: true });

  const ctx = bindClackCtx();
  const providerPatch = await getProvider(providerId as ProviderId).prompt(ctx);
  applyPatch(paths, providerPatch);

  const repoRoot = await p.text({
    message: 'REPO_ROOT_DIR (path to your repos, e.g. ~/git)',
    placeholder: '~/git',
    initialValue: existingConfig.repoRootDir ?? '~/git',
  });
  if (p.isCancel(repoRoot)) {
    p.cancel('Cancelled.');
    return 1;
  }
  writeConfigJson(paths.configJsonFile, { repoRootDir: String(repoRoot) });

  p.outro(`Config written to ${paths.configDir}`);

  if (opts.skipStart) return 0;

  const go = await p.confirm({ message: 'Start kagura now?', initialValue: true });
  if (go === true && !p.isCancel(go) && hooks.startApp) {
    await hooks.startApp();
  }
  return 0;
}

export function applyPatch(paths: KaguraPaths, patch: SetupPatch): void {
  if (patch.env) writeEnvFile(paths.envFile, patch.env);
  if (patch.config) writeConfigJson(paths.configJsonFile, patch.config);
}

export function buildInitCommand(hooks: RunHooks): Command {
  const cmd = new Command('init');
  cmd
    .description('Run the onboarding wizard')
    .option('--full', 'ask advanced options too')
    .action(async (opts: InitOptions) => {
      const code = await runInit(opts, hooks);
      process.exitCode = code;
    });
  return cmd;
}
