import type { SlashCommandDependencies, SlashCommandResponse } from './types.js';

export interface CancelCommandDependencies extends SlashCommandDependencies {
  channelId?: string | undefined;
  threadTs?: string | undefined;
}

export async function handleCancelCommand(
  _text: string,
  deps: CancelCommandDependencies,
): Promise<SlashCommandResponse> {
  const { threadTs, logger, threadExecutionRegistry, channelId } = deps;

  if (!threadTs) {
    return {
      response_type: 'ephemeral',
      text: "Use `/cancel` inside a thread to stop the bot's in-progress reply.",
    };
  }

  const result = await threadExecutionRegistry.stopAll(threadTs, 'user_stop');

  logger.info(
    'Slash /cancel in channel %s thread %s: stopped=%d failed=%d',
    channelId ?? 'unknown',
    threadTs,
    result.stopped,
    result.failed,
  );

  if (result.stopped === 0 && result.failed === 0) {
    return {
      response_type: 'ephemeral',
      text: 'No in-progress reply found in this thread.',
    };
  }

  const parts: string[] = [];
  if (result.stopped > 0) {
    parts.push(
      `Stopped ${result.stopped} in-progress ${result.stopped === 1 ? 'reply' : 'replies'}`,
    );
  }
  if (result.failed > 0) {
    parts.push(`${result.failed} failed to stop`);
  }

  return {
    response_type: 'ephemeral',
    text: `${parts.join(', ')}.`,
  };
}
