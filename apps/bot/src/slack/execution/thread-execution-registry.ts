import type { AppLogger } from '~/logger/index.js';

export type ThreadExecutionStopReason = 'superseded' | 'user_stop';

export interface RegisteredThreadExecution {
  channelId: string;
  completionPromise?: Promise<void>;
  executionId: string;
  providerId: string;
  startedAt: string;
  stop: (reason: ThreadExecutionStopReason) => Promise<void>;
  threadTs: string;
  userId: string;
}

export interface StopAllResult {
  failed: number;
  stopped: number;
}

export interface ThreadExecutionRegistry {
  claimMessage: (messageTs: string, threadTs: string) => boolean;
  listActive: (threadTs: string) => RegisteredThreadExecution[];
  register: (execution: RegisteredThreadExecution) => () => void;
  stopAll: (threadTs: string, reason: ThreadExecutionStopReason) => Promise<StopAllResult>;
  stopByMessage: (messageTs: string, reason: ThreadExecutionStopReason) => Promise<StopAllResult>;
  trackMessage: (messageTs: string, threadTs: string) => void;
}

export function createThreadExecutionRegistry(options?: {
  logger?: AppLogger | undefined;
}): ThreadExecutionRegistry {
  const logger = options?.logger;
  const byThread = new Map<string, Map<string, RegisteredThreadExecution>>();
  const stoppingByThread = new Map<string, Promise<StopAllResult>>();
  const messageToThread = new Map<string, string>();
  const threadToMessages = new Map<string, Set<string>>();
  const threadMessageOrder = new Map<string, string[]>();

  const MAX_TRACKED_MESSAGES_PER_THREAD = 128;

  function cleanupMessagesForThread(threadTs: string): void {
    const messages = threadToMessages.get(threadTs);
    if (!messages) return;
    for (const ts of messages) {
      messageToThread.delete(ts);
    }
    threadToMessages.delete(threadTs);
    threadMessageOrder.delete(threadTs);
  }

  function rememberMessage(messageTs: string, threadTs: string): void {
    const existingThreadTs = messageToThread.get(messageTs);
    if (existingThreadTs) {
      return;
    }

    messageToThread.set(messageTs, threadTs);

    let set = threadToMessages.get(threadTs);
    if (!set) {
      set = new Set();
      threadToMessages.set(threadTs, set);
    }
    set.add(messageTs);

    let order = threadMessageOrder.get(threadTs);
    if (!order) {
      order = [];
      threadMessageOrder.set(threadTs, order);
    }
    order.push(messageTs);

    while (order.length > MAX_TRACKED_MESSAGES_PER_THREAD) {
      const evicted = order.shift();
      if (!evicted) {
        break;
      }
      set.delete(evicted);
      messageToThread.delete(evicted);
    }

    if (set.size === 0) {
      cleanupMessagesForThread(threadTs);
    }
  }

  return {
    claimMessage(messageTs, threadTs) {
      if (messageToThread.has(messageTs)) {
        logger?.info(
          'Thread execution registry rejected duplicate claim for message %s in thread %s',
          messageTs,
          threadTs,
        );
        return false;
      }

      rememberMessage(messageTs, threadTs);
      logger?.info(
        'Thread execution registry claimed message %s for thread %s',
        messageTs,
        threadTs,
      );
      return true;
    },

    listActive(threadTs) {
      const bucket = byThread.get(threadTs);
      if (!bucket) return [];
      return [...bucket.values()];
    },

    register(execution) {
      let bucket = byThread.get(execution.threadTs);
      if (!bucket) {
        bucket = new Map();
        byThread.set(execution.threadTs, bucket);
      }
      bucket.set(execution.executionId, execution);
      logger?.info(
        'Thread execution registry registered execution %s for thread %s (provider=%s active=%d)',
        execution.executionId,
        execution.threadTs,
        execution.providerId,
        bucket.size,
      );

      return () => {
        const b = byThread.get(execution.threadTs);
        if (!b) return;
        b.delete(execution.executionId);
        logger?.info(
          'Thread execution registry released execution %s for thread %s (remaining=%d)',
          execution.executionId,
          execution.threadTs,
          b.size,
        );
        if (b.size === 0) {
          byThread.delete(execution.threadTs);
        }
      };
    },

    trackMessage(messageTs, threadTs) {
      rememberMessage(messageTs, threadTs);
      logger?.info(
        'Thread execution registry tracked message %s for thread %s',
        messageTs,
        threadTs,
      );
    },

    async stopByMessage(messageTs, reason) {
      if (byThread.has(messageTs)) {
        logger?.info(
          'Thread execution registry resolved stopByMessage directly to thread %s (reason=%s)',
          messageTs,
          reason,
        );
        return this.stopAll(messageTs, reason);
      }
      const threadTs = messageToThread.get(messageTs);
      if (threadTs) {
        logger?.info(
          'Thread execution registry resolved message %s to thread %s for stopByMessage (reason=%s)',
          messageTs,
          threadTs,
          reason,
        );
        return this.stopAll(threadTs, reason);
      }
      logger?.info(
        'Thread execution registry found no execution for message %s during stopByMessage (reason=%s)',
        messageTs,
        reason,
      );
      return { failed: 0, stopped: 0 };
    },

    async stopAll(threadTs, reason) {
      const inFlightStop = stoppingByThread.get(threadTs);
      if (inFlightStop) {
        logger?.info(
          'Thread execution registry joined in-flight stopAll for thread %s (reason=%s)',
          threadTs,
          reason,
        );
        return inFlightStop;
      }

      const stopPromise = (async () => {
        const bucket = byThread.get(threadTs);
        if (!bucket) {
          logger?.info(
            'Thread execution registry found no active executions for thread %s during stopAll (reason=%s)',
            threadTs,
            reason,
          );
          return { failed: 0, stopped: 0 };
        }
        if (bucket.size === 0) {
          byThread.delete(threadTs);
          logger?.info(
            'Thread execution registry removed empty bucket for thread %s during stopAll (reason=%s)',
            threadTs,
            reason,
          );
          return { failed: 0, stopped: 0 };
        }

        byThread.delete(threadTs);
        const executions = [...bucket.values()];
        logger?.info(
          'Thread execution registry stopAll started for thread %s with %d execution(s) (reason=%s)',
          threadTs,
          executions.length,
          reason,
        );

        let stopped = 0;
        let failed = 0;
        const failedExecutions: RegisteredThreadExecution[] = [];

        for (const execution of executions) {
          const stopStartedAt = Date.now();
          logger?.info(
            'Stopping execution %s for thread %s (provider=%s reason=%s)',
            execution.executionId,
            threadTs,
            execution.providerId,
            reason,
          );
          try {
            await execution.stop(reason);
            stopped += 1;
            logger?.info(
              'Stop signal completed for execution %s in thread %s in %dms',
              execution.executionId,
              threadTs,
              Date.now() - stopStartedAt,
            );
          } catch {
            failed += 1;
            failedExecutions.push(execution);
            logger?.warn(
              'Stop signal failed for execution %s in thread %s after %dms',
              execution.executionId,
              threadTs,
              Date.now() - stopStartedAt,
            );
          }
        }

        // Wait for stopped executions to fully complete (flush lifecycle events, persist session)
        const completionPromises = executions
          .filter((e) => e.completionPromise && !failedExecutions.includes(e))
          .map((e) => e.completionPromise!.catch(() => {}));
        if (completionPromises.length > 0) {
          const waitStartedAt = Date.now();
          logger?.info(
            'Waiting for %d completion promise(s) in thread %s after stopAll',
            completionPromises.length,
            threadTs,
          );
          await Promise.allSettled(completionPromises);
          logger?.info(
            'Completion promises settled for thread %s in %dms',
            threadTs,
            Date.now() - waitStartedAt,
          );
        }

        if (failedExecutions.length > 0) {
          let restoreBucket = byThread.get(threadTs);
          if (!restoreBucket) {
            restoreBucket = new Map();
            byThread.set(threadTs, restoreBucket);
          }
          for (const execution of failedExecutions) {
            restoreBucket.set(execution.executionId, execution);
          }
          logger?.warn(
            'Restored %d failed execution(s) back into registry for thread %s',
            failedExecutions.length,
            threadTs,
          );
        }

        logger?.info(
          'Thread execution registry stopAll completed for thread %s (reason=%s stopped=%d failed=%d)',
          threadTs,
          reason,
          stopped,
          failed,
        );
        return { failed, stopped };
      })().finally(() => {
        if (stoppingByThread.get(threadTs) === stopPromise) {
          stoppingByThread.delete(threadTs);
        }
      });

      stoppingByThread.set(threadTs, stopPromise);
      return stopPromise;
    },
  };
}
