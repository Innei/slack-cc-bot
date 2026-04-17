import path from 'node:path';

import { type ConsolaInstance, createLoggerConsola } from '@innei/pretty-logger-core';

import { env } from '~/env/server.js';

import { createRedactor } from './redact.js';

export function createRootLogger() {
  process.env.CONSOLA_LEVEL = env.LOG_LEVEL;

  return createLoggerConsola(
    env.LOG_TO_FILE
      ? {
          writeToFile: {
            loggerDir: path.resolve(process.cwd(), env.LOG_DIR),
          },
        }
      : {},
  );
}

export const redact = createRedactor([
  env.SLACK_BOT_TOKEN,
  env.SLACK_APP_TOKEN,
  env.SLACK_SIGNING_SECRET,
]);

export type AppLogger = ConsolaInstance;
