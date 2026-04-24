#!/usr/bin/env node
import { runCli } from '@kagura/cli';

async function startApp(): Promise<void> {
  const mod = await import('./start-app.js');
  await mod.startApp();
}

runCli(process.argv, { startApp }).then(
  (code) => process.exit(code),
  (err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(message);
    process.exit(1);
  },
);
