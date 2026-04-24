import { Command } from 'commander';

import { resolveKaguraPaths } from '../config/paths.js';

export function buildConfigCommand(): Command {
  const config = new Command('config').description('Configuration utilities');

  config
    .command('path')
    .description('Print the resolved configuration directory')
    .option('--json', 'emit JSON')
    .action((opts: { json?: boolean }) => {
      const p = resolveKaguraPaths();
      if (opts.json) {
        process.stdout.write(JSON.stringify(p, null, 2) + '\n');
      } else {
        process.stdout.write(p.configDir + '\n');
      }
    });

  return config;
}
