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

export function createThreadExecutionRegistry(): ThreadExecutionRegistry {
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
        return false;
      }

      rememberMessage(messageTs, threadTs);
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

      return () => {
        const b = byThread.get(execution.threadTs);
        if (!b) return;
        b.delete(execution.executionId);
        if (b.size === 0) {
          byThread.delete(execution.threadTs);
        }
      };
    },

    trackMessage(messageTs, threadTs) {
      rememberMessage(messageTs, threadTs);
    },

    async stopByMessage(messageTs, reason) {
      if (byThread.has(messageTs)) {
        return this.stopAll(messageTs, reason);
      }
      const threadTs = messageToThread.get(messageTs);
      if (threadTs) {
        return this.stopAll(threadTs, reason);
      }
      return { failed: 0, stopped: 0 };
    },

    async stopAll(threadTs, reason) {
      const inFlightStop = stoppingByThread.get(threadTs);
      if (inFlightStop) {
        return inFlightStop;
      }

      const stopPromise = (async () => {
        const bucket = byThread.get(threadTs);
        if (!bucket) {
          return { failed: 0, stopped: 0 };
        }
        if (bucket.size === 0) {
          byThread.delete(threadTs);
          return { failed: 0, stopped: 0 };
        }

        byThread.delete(threadTs);
        const executions = [...bucket.values()];

        let stopped = 0;
        let failed = 0;
        const failedExecutions: RegisteredThreadExecution[] = [];

        for (const execution of executions) {
          try {
            await execution.stop(reason);
            stopped += 1;
          } catch {
            failed += 1;
            failedExecutions.push(execution);
          }
        }

        // Wait for stopped executions to fully complete (flush lifecycle events, persist session)
        const completionPromises = executions
          .filter((e) => e.completionPromise && !failedExecutions.includes(e))
          .map((e) => e.completionPromise!.catch(() => {}));
        if (completionPromises.length > 0) {
          await Promise.allSettled(completionPromises);
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
        }

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
