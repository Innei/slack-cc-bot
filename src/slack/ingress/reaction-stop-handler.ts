import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';

import type { AppLogger } from '~/logger/index.js';

import type { ThreadExecutionRegistry } from '../execution/thread-execution-registry.js';

const STOP_REACTIONS = new Set(['octagonal_sign', 'stop_sign']);

export interface ReactionStopDependencies {
  logger: AppLogger;
  threadExecutionRegistry: ThreadExecutionRegistry;
}

export function createReactionStopHandler(deps: ReactionStopDependencies) {
  return async ({
    event,
  }: AllMiddlewareArgs & SlackEventMiddlewareArgs<'reaction_added'>): Promise<void> => {
    if (event.item.type !== 'message') return;
    if (!STOP_REACTIONS.has(event.reaction)) return;

    const { channel, ts } = event.item;
    const result = await deps.threadExecutionRegistry.stopByMessage(ts, 'user_stop');

    if (result.stopped > 0 || result.failed > 0) {
      deps.logger.info(
        'Reaction stop in channel %s (message %s): stopped=%d failed=%d',
        channel,
        ts,
        result.stopped,
        result.failed,
      );
    }
  };
}
