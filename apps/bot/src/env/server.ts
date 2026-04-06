import 'dotenv/config';

import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const booleanStringSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const optionalPositiveInteger = z.coerce.number().int().positive().optional();

export const env = createEnv({
  server: {
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
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
    CLAUDE_PERMISSION_MODE: process.env.CLAUDE_PERMISSION_MODE,
    CLAUDE_ENABLE_SKILLS: process.env.CLAUDE_ENABLE_SKILLS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    LOG_TO_FILE: process.env.LOG_TO_FILE,
    LOG_DIR: process.env.LOG_DIR,
    REPO_ROOT_DIR: process.env.REPO_ROOT_DIR,
    REPO_SCAN_DEPTH: process.env.REPO_SCAN_DEPTH,
    SESSION_DB_PATH: process.env.SESSION_DB_PATH,
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
