import { encodeWorkspacePickerButtonValue } from '../interactions/workspace-picker-payload.js';
import type { SlackBlock, SlackWebClientLike } from '../types.js';
import type { SlackIngressDependencies } from './app-mention-handler.js';
import { handleThreadConversation, WORKSPACE_PICKER_ACTION_ID } from './app-mention-handler.js';

export const SLASH_COMMAND_NAME = '/claude';

interface SlashCommandPayload {
  channel_id: string;
  channel_name: string;
  command: string;
  team_id: string;
  text: string;
  trigger_id: string;
  user_id: string;
}

export function createSlashCommandHandler(deps: SlackIngressDependencies) {
  return async (args: {
    ack: (response?: string | Record<string, unknown>) => Promise<void>;
    body: unknown;
    client: unknown;
    command: unknown;
  }): Promise<void> => {
    const { ack, client } = args;
    const command = args.command as SlashCommandPayload;
    const promptText = command.text?.trim();

    if (!promptText) {
      await ack({
        response_type: 'ephemeral',
        text: `Usage: \`${SLASH_COMMAND_NAME} <your prompt>\`\nExample: \`${SLASH_COMMAND_NAME} explain the auth flow in this repo\``,
      });
      return;
    }

    await ack();

    const slackClient = client as SlackWebClientLike;

    const rootMessage = await slackClient.chat.postMessage({
      channel: command.channel_id,
      text: promptText,
      blocks: [
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<@${command.user_id}> via \`${SLASH_COMMAND_NAME}\``,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: promptText,
          },
        },
      ],
    });

    const rootTs = rootMessage.ts;
    if (!rootTs) {
      deps.logger.error('Slack did not return a timestamp for the slash command root message');
      return;
    }

    const resolution = deps.workspaceResolver.resolveFromText(promptText, 'auto');

    if (resolution.status === 'ambiguous') {
      deps.logger.warn('Slash command workspace resolution ambiguous for text: %s', promptText);

      const { blocks, text } = buildSlashWorkspaceBlocks(resolution, promptText);
      await slackClient.chat.postMessage({
        blocks,
        channel: command.channel_id,
        text,
        thread_ts: rootTs,
      });
      return;
    }

    await handleThreadConversation(
      slackClient,
      {
        channel: command.channel_id,
        team: command.team_id,
        text: promptText,
        ts: rootTs,
        user: command.user_id,
      },
      deps,
      {
        addAcknowledgementReaction: false,
        logLabel: 'slash command',
        rootMessageTs: rootTs,
        ...(resolution.status === 'unique' ? { workspaceOverride: resolution.workspace } : {}),
      },
    );
  };
}

function buildSlashWorkspaceBlocks(
  resolution: Extract<
    ReturnType<SlackIngressDependencies['workspaceResolver']['resolveFromText']>,
    { status: 'ambiguous' }
  >,
  originalText: string,
): { blocks: SlackBlock[]; text: string } {
  const labels = resolution.candidates
    .slice(0, 5)
    .map((c) => `\`${c.label}\``)
    .join(', ');
  const text = `I couldn't tell which repository to use — matched: ${labels}`;

  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: 'workspace_picker',
        elements: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text' as const, text: 'Choose Workspace' },
            type: 'button' as const,
            value: encodeWorkspacePickerButtonValue(originalText),
          },
        ],
      },
    ],
    text,
  };
}
