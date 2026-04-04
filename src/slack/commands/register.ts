import type { App } from '@slack/bolt';

import { handleMemoryCommand } from './memory-command.js';
import { handleSessionCommand } from './session-command.js';
import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';
import { handleUsageCommand } from './usage-command.js';
import { handleWorkspaceCommand } from './workspace-command.js';

interface CommandRegistration {
  handler: (text: string, deps: SlashCommandDependencies) => SlashCommandResponse;
  name: string;
}

const COMMANDS: CommandRegistration[] = [
  { name: '/usage', handler: handleUsageCommand },
  { name: '/workspace', handler: handleWorkspaceCommand },
  { name: '/memory', handler: handleMemoryCommand },
  { name: '/session', handler: handleSessionCommand },
];

export function registerSlashCommands(app: App, deps: SlashCommandDependencies): void {
  for (const registration of COMMANDS) {
    app.command(registration.name, async ({ ack, command }) => {
      deps.logger.info('Slash command %s invoked by %s', registration.name, command.user_id);

      try {
        const response = registration.handler(command.text ?? '', deps);
        await ack(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error('Slash command %s failed: %s', registration.name, message);
        await ack({
          response_type: 'ephemeral',
          text: `An error occurred while processing \`${registration.name}\`. Please try again.`,
        });
      }
    });
  }

  deps.logger.info(
    'Registered %d slash commands: %s',
    COMMANDS.length,
    COMMANDS.map((c) => c.name).join(', '),
  );
}
