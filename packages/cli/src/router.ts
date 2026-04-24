import { Command } from 'commander';

import { buildConfigCommand } from './commands/config.js';
import { formatVersion } from './version.js';

export function buildProgram(): Command {
  const program = new Command('kagura');
  program
    .description('Slack-native Claude Agent — CLI')
    .version(formatVersion(), '-V, --version', 'output the version')
    .helpOption('-h, --help', 'display help')
    .showHelpAfterError('(use `kagura --help` for help)');

  program.addCommand(buildConfigCommand());

  program.action(async () => {
    program.outputHelp();
  });

  return program;
}
