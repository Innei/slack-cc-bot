#!/usr/bin/env node
import { runCli } from '@kagura/cli';

import { startApp } from './start-app.js';

runCli(process.argv, { startApp }).then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(message);
    process.exit(1);
  },
);
