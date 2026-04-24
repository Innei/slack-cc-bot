import { Command } from 'commander';

import { buildConfigCommand } from './commands/config.js';
import { buildDoctorCommand } from './commands/doctor.js';
import { buildManifestCommand } from './commands/manifest.js';
import { formatVersion } from './version.js';

export function buildProgram(): Command {
  const program = new Command('kagura');
  program
    .description('Slack-native Claude Agent — CLI')
    .version(formatVersion(), '-V, --version', 'output the version')
    .helpOption('-h, --help', 'display help')
    .showHelpAfterError('(use `kagura --help` for help)');

  program.addCommand(buildConfigCommand());
  program.addCommand(buildDoctorCommand());
  program.addCommand(buildManifestCommand());

  program.action(async () => {
    program.outputHelp();
  });

  return program;
}
