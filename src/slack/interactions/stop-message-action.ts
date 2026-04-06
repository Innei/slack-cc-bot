import type { AppLogger } from '~/logger/index.js';
import { zodParse } from '~/schemas/safe-parse.js';
import { SlackMessageActionShortcutSchema } from '~/schemas/slack/message-action-shortcut.js';

import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';
import type { SlackWebClientLike } from '../types.js';

export const STOP_MESSAGE_ACTION_CALLBACK_ID = 'stop_reply_action';

export interface StopMessageActionDependencies {
  logger: AppLogger;
  threadExecutionRegistry: ThreadExecutionRegistry;
}

export function createStopMessageActionHandler(deps: StopMessageActionDependencies) {
  return async (args: any): Promise<void> => {
    const { ack, client } = args;
    await ack();

    const parsed = zodParse(
      SlackMessageActionShortcutSchema,
      args.shortcut,
      'SlackMessageActionShortcut',
    );
    const threadTs = parsed.message.thread_ts ?? parsed.message.ts;
    const channelId = parsed.channel.id;

    const result = await deps.threadExecutionRegistry.stopByMessage(parsed.message.ts, 'user_stop');

    deps.logger.info(
      'Stop message action in channel %s thread %s: stopped=%d failed=%d',
      channelId,
      threadTs,
      result.stopped,
      result.failed,
    );

    const text =
      result.stopped > 0
        ? `Stopped ${result.stopped} in-progress ${result.stopped === 1 ? 'reply' : 'replies'}.`
        : 'No in-progress reply found in this thread.';

    const chat = (client as SlackWebClientLike).chat;
    if (!chat.postEphemeral) {
      throw new Error('Slack chat.postEphemeral is not available on the configured client');
    }

    await chat.postEphemeral({
      channel: channelId,
      user: parsed.user.id,
      thread_ts: threadTs,
      text,
    });
  };
}
