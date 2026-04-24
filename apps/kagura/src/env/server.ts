import fs from 'node:fs';
import path from 'node:path';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';
import { createEnv } from '@t3-oss/env-core';
import dotenv from 'dotenv';
import { z } from 'zod';

const kaguraPaths = resolveKaguraPaths();
if (fs.existsSync(kaguraPaths.envFile)) {
  dotenv.config({ path: kaguraPaths.envFile, override: false });
}
dotenv.config({ override: false }); // dev mode: also read cwd .env if present

const booleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalPositiveInteger = z.coerce.number().int().positive().optional();

const appConfigSchema = z
  .object({
    claude: z
      .object({
        enableSkills: z.boolean().optional(),
        model: z.string().optional(),
        permissionMode: z
          .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
          .optional(),
      })
      .optional(),
    codex: z
      .object({
        model: z.string().optional(),
        reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
        sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
      })
      .optional(),
    defaultProviderId: z.enum(['claude-code', 'codex-cli']).optional(),
    logDir: z.string().optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
    logToFile: z.boolean().optional(),
    repoRootDir: z.string().optional(),
    repoScanDepth: z.number().int().min(0).optional(),
    sessionDbPath: z.string().optional(),
  })
  .strict();

type AppConfig = z.infer<typeof appConfigSchema>;

function loadAppConfig(): AppConfig {
  const override = process.env.APP_CONFIG_PATH?.trim();
  const resolved = override ? path.resolve(process.cwd(), override) : kaguraPaths.configJsonFile;
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  return appConfigSchema.parse(parsed);
}

const appConfig = loadAppConfig();

function configString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configBoolean(value: boolean | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function configNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function envOrConfig(envName: string, configValue: string | undefined): string | undefined {
  const raw = process.env[envName];
  if (raw === undefined) {
    return configValue;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? raw : configValue;
}

export const env = createEnv({
  server: {
    APP_CONFIG_PATH: z.string().min(1).optional(),
    AGENT_DEFAULT_PROVIDER: z.enum(['claude-code', 'codex-cli']).default('claude-code'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    SLACK_BOT_TOKEN: z.string().min(1),
    SLACK_APP_TOKEN: z.string().min(1),
    SLACK_APP_ID: z.string().min(1).optional(),
    SLACK_CONFIG_TOKEN: z.string().min(1).optional(),
    SLACK_CONFIG_REFRESH_TOKEN: z.string().min(1).optional(),
    SLACK_SIGNING_SECRET: z.string().min(1),
    SLACK_REACTION_NAME: z.string().min(1).default('eyes'),
    SLACK_REACTION_DONE_NAME: z.string().min(1).default('white_check_mark'),
    CLAUDE_MODEL: z.string().min(1).optional(),
    CLAUDE_PERMISSION_MODE: z
      .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
      .default('bypassPermissions'),
    CLAUDE_ENABLE_SKILLS: booleanStringSchema.default(false),
    CODEX_MODEL: z.string().min(1).optional(),
    CODEX_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    CODEX_CLI_SANDBOX: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .default('danger-full-access'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_TO_FILE: booleanStringSchema.default(false),
    LOG_DIR: z.string().min(1).default('./logs'),
    REPO_ROOT_DIR: z.string().min(1),
    REPO_SCAN_DEPTH: z.coerce.number().int().min(0).default(2),
    SESSION_DB_PATH: z.string().min(1).default('./data/sessions.db'),
    SLACK_E2E_ENABLED: booleanStringSchema.default(false),
    SLACK_E2E_CHANNEL_ID: z.string().min(1).optional(),
    SLACK_E2E_RESULT_PATH: z.string().min(1).default('./artifacts/slack-live-e2e/result.json'),
    SLACK_E2E_STATUS_PROBE_PATH: z
      .string()
      .min(1)
      .default('./artifacts/slack-live-e2e/status-probe.jsonl'),
    SLACK_E2E_EXECUTION_PROBE_PATH: z
      .string()
      .min(1)
      .default('./artifacts/slack-live-e2e/execution-probe.jsonl'),
    SLACK_E2E_TIMEOUT_MS: optionalPositiveInteger.default(180_000),
    SLACK_E2E_TRIGGER_USER_TOKEN: z.string().min(1).optional(),
  },
  runtimeEnvStrict: {
    APP_CONFIG_PATH: process.env.APP_CONFIG_PATH,
    AGENT_DEFAULT_PROVIDER: envOrConfig('AGENT_DEFAULT_PROVIDER', appConfig.defaultProviderId),
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
    SLACK_APP_ID: process.env.SLACK_APP_ID,
    SLACK_CONFIG_TOKEN: process.env.SLACK_CONFIG_TOKEN,
    SLACK_CONFIG_REFRESH_TOKEN: process.env.SLACK_CONFIG_REFRESH_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_REACTION_NAME: process.env.SLACK_REACTION_NAME,
    SLACK_REACTION_DONE_NAME: process.env.SLACK_REACTION_DONE_NAME,
    CLAUDE_MODEL: envOrConfig('CLAUDE_MODEL', configString(appConfig.claude?.model)),
    CLAUDE_PERMISSION_MODE: envOrConfig('CLAUDE_PERMISSION_MODE', appConfig.claude?.permissionMode),
    CLAUDE_ENABLE_SKILLS: envOrConfig(
      'CLAUDE_ENABLE_SKILLS',
      configBoolean(appConfig.claude?.enableSkills),
    ),
    CODEX_MODEL: envOrConfig('CODEX_MODEL', configString(appConfig.codex?.model)),
    CODEX_REASONING_EFFORT: envOrConfig('CODEX_REASONING_EFFORT', appConfig.codex?.reasoningEffort),
    CODEX_CLI_SANDBOX: envOrConfig('CODEX_CLI_SANDBOX', appConfig.codex?.sandbox),
    LOG_LEVEL: envOrConfig('LOG_LEVEL', appConfig.logLevel),
    LOG_TO_FILE: envOrConfig('LOG_TO_FILE', configBoolean(appConfig.logToFile)),
    LOG_DIR: envOrConfig('LOG_DIR', configString(appConfig.logDir)),
    REPO_ROOT_DIR: envOrConfig('REPO_ROOT_DIR', configString(appConfig.repoRootDir)),
    REPO_SCAN_DEPTH: envOrConfig('REPO_SCAN_DEPTH', configNumber(appConfig.repoScanDepth)),
    SESSION_DB_PATH: envOrConfig('SESSION_DB_PATH', configString(appConfig.sessionDbPath)),
    SLACK_E2E_ENABLED: process.env.SLACK_E2E_ENABLED,
    SLACK_E2E_CHANNEL_ID: process.env.SLACK_E2E_CHANNEL_ID,
    SLACK_E2E_RESULT_PATH: process.env.SLACK_E2E_RESULT_PATH,
    SLACK_E2E_STATUS_PROBE_PATH: process.env.SLACK_E2E_STATUS_PROBE_PATH,
    SLACK_E2E_EXECUTION_PROBE_PATH: process.env.SLACK_E2E_EXECUTION_PROBE_PATH,
    SLACK_E2E_TIMEOUT_MS: process.env.SLACK_E2E_TIMEOUT_MS,
    SLACK_E2E_TRIGGER_USER_TOKEN: process.env.SLACK_E2E_TRIGGER_USER_TOKEN,
  },
  emptyStringAsUndefined: true,
});

export type AppEnv = typeof env;

export function validateLiveE2EEnv(): void {
  if (!env.SLACK_E2E_ENABLED) {
    return;
  }

  const missing: string[] = [];
  if (!env.SLACK_E2E_CHANNEL_ID) missing.push('SLACK_E2E_CHANNEL_ID');
  if (!env.SLACK_E2E_TRIGGER_USER_TOKEN) missing.push('SLACK_E2E_TRIGGER_USER_TOKEN');

  if (missing.length > 0) {
    throw new Error(`Missing live E2E environment variables: ${missing.join(', ')}`);
  }
}
