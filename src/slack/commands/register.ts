import type { App } from '@slack/bolt';

import { handleCancelCommand } from './cancel-command.js';
import { handleMemoryCommand } from './memory-command.js';
import { handleProviderCommand } from './provider-command.js';
import { handleSessionCommand } from './session-command.js';
import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';
import { handleUsageCommand } from './usage-command.js';
import { handleVersionCommand } from './version-command.js';
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
  { name: '/version', handler: () => handleVersionCommand() },
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

  app.command('/provider', async ({ ack, command }) => {
    deps.logger.info('Slash command /provider invoked by %s', command.user_id);
    try {
      const threadTs =
        typeof command.thread_ts === 'string' && command.thread_ts.trim()
          ? command.thread_ts.trim()
          : undefined;
      const response = handleProviderCommand(command.text ?? '', {
        ...deps,
        channelId: command.channel_id,
        threadTs,
      });
      await ack(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('Slash command /provider failed: %s', message);
      await ack({
        response_type: 'ephemeral',
        text: 'An error occurred while processing `/provider`. Please try again.',
      });
    }
  });

  app.command('/cancel', async ({ ack, command }) => {
    deps.logger.info('Slash command /cancel invoked by %s', command.user_id);
    try {
      const threadTs =
        typeof command.thread_ts === 'string' && command.thread_ts.trim()
          ? command.thread_ts.trim()
          : undefined;
      const response = await handleCancelCommand(command.text ?? '', {
        ...deps,
        channelId: command.channel_id,
        threadTs,
      });
      await ack(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('Slash command /cancel failed: %s', message);
      await ack({
        response_type: 'ephemeral',
        text: 'An error occurred while processing `/cancel`. Please try again.',
      });
    }
  });

  const allCommandNames = [...COMMANDS.map((c) => c.name), '/provider', '/cancel'];
  deps.logger.info(
    'Registered %d slash commands: %s',
    allCommandNames.length,
    allCommandNames.join(', '),
  );
}
