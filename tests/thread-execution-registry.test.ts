import { describe, expect, it, vi } from 'vitest';

import {
  createThreadExecutionRegistry,
  type RegisteredThreadExecution,
  type ThreadExecutionStopReason,
} from '~/slack/execution/thread-execution-registry.js';

function baseExecution(
  partial: Pick<RegisteredThreadExecution, 'executionId' | 'threadTs'> & {
    stop?: RegisteredThreadExecution['stop'];
  },
): RegisteredThreadExecution {
  return {
    channelId: 'C1',
    userId: 'U1',
    providerId: 'claude',
    startedAt: '2026-04-06T00:00:00.000Z',
    stop: partial.stop ?? vi.fn().mockResolvedValue(undefined),
    ...partial,
  };
}

describe('createThreadExecutionRegistry', () => {
  it('register adds an execution and the cleanup removes it', () => {
    const registry = createThreadExecutionRegistry();
    const exec = baseExecution({ executionId: 'e1', threadTs: 't1' });

    const cleanup = registry.register(exec);
    expect(registry.listActive('t1')).toEqual([exec]);

    cleanup();
    expect(registry.listActive('t1')).toEqual([]);
  });

  it('stopAll stops every active execution in the target thread only', async () => {
    const registry = createThreadExecutionRegistry();
    const stop1 = vi.fn().mockResolvedValue(undefined);
    const stop2 = vi.fn().mockResolvedValue(undefined);
    const exec1 = baseExecution({ executionId: 'e1', threadTs: 't1', stop: stop1 });
    const exec2 = baseExecution({ executionId: 'e2', threadTs: 't2', stop: stop2 });

    registry.register(exec1);
    registry.register(exec2);

    const reason: ThreadExecutionStopReason = 'user_stop';
    await registry.stopAll('t1', reason);

    expect(stop1).toHaveBeenCalledWith(reason);
    expect(stop2).not.toHaveBeenCalled();
    expect(registry.listActive('t2').map((e) => e.executionId)).toEqual(['e2']);
  });

  it('stopAll on an empty or unknown thread returns zero counts', async () => {
    const registry = createThreadExecutionRegistry();

    await expect(registry.stopAll('unknown-thread', 'user_stop')).resolves.toEqual({
      stopped: 0,
      failed: 0,
    });

    const cleanup = registry.register(baseExecution({ executionId: 'e1', threadTs: 't1' }));
    cleanup();

    await expect(registry.stopAll('t1', 'user_stop')).resolves.toEqual({
      stopped: 0,
      failed: 0,
    });
  });

  it('stopAll returns partial failure counts when one stop throws', async () => {
    const registry = createThreadExecutionRegistry();
    const stopOk = vi.fn().mockResolvedValue(undefined);
    const stopFail = vi.fn().mockRejectedValue(new Error('stop failed'));

    registry.register(baseExecution({ executionId: 'a', threadTs: 't1', stop: stopOk }));
    registry.register(baseExecution({ executionId: 'b', threadTs: 't1', stop: stopFail }));
    registry.register(baseExecution({ executionId: 'c', threadTs: 't1', stop: stopOk }));

    const result = await registry.stopAll('t1', 'user_stop');

    expect(stopOk).toHaveBeenCalledTimes(2);
    expect(stopFail).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stopped: 2, failed: 1 });
  });

  it('concurrent stopAll for the same thread sees an empty bucket on the second call', async () => {
    const registry = createThreadExecutionRegistry();
    let unblockStop: () => void;
    const stopBlocked = new Promise<void>((resolve) => {
      unblockStop = resolve;
    });
    const stop = vi.fn(async (_reason: ThreadExecutionStopReason) => {
      await stopBlocked;
    });
    registry.register(baseExecution({ executionId: 'e1', threadTs: 't1', stop }));

    const first = registry.stopAll('t1', 'user_stop');
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledTimes(1);
    });

    await expect(registry.stopAll('t1', 'user_stop')).resolves.toEqual({
      stopped: 0,
      failed: 0,
    });

    unblockStop!();
    await expect(first).resolves.toEqual({ stopped: 1, failed: 0 });
    expect(registry.listActive('t1')).toEqual([]);
  });

  it('restores executions whose stop threw so a later stopAll can retry', async () => {
    const registry = createThreadExecutionRegistry();
    const stop = vi
      .fn()
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);
    registry.register(baseExecution({ executionId: 'e1', threadTs: 't1', stop }));

    await expect(registry.stopAll('t1', 'user_stop')).resolves.toEqual({
      stopped: 0,
      failed: 1,
    });
    expect(registry.listActive('t1').map((e) => e.executionId)).toEqual(['e1']);

    await expect(registry.stopAll('t1', 'user_stop')).resolves.toEqual({
      stopped: 1,
      failed: 0,
    });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(registry.listActive('t1')).toEqual([]);
  });

  describe('trackMessage and stopByMessage', () => {
    it('stopByMessage stops via tracked message ts', async () => {
      const registry = createThreadExecutionRegistry();
      const stop = vi.fn().mockResolvedValue(undefined);
      registry.register(baseExecution({ executionId: 'e1', threadTs: 't1', stop }));
      registry.trackMessage('user-msg-ts', 't1');

      const result = await registry.stopByMessage('user-msg-ts', 'user_stop');

      expect(stop).toHaveBeenCalledWith('user_stop');
      expect(result).toEqual({ stopped: 1, failed: 0 });
    });

    it('stopByMessage falls through to stopAll when messageTs is a threadTs', async () => {
      const registry = createThreadExecutionRegistry();
      const stop = vi.fn().mockResolvedValue(undefined);
      registry.register(baseExecution({ executionId: 'e1', threadTs: 't1', stop }));

      const result = await registry.stopByMessage('t1', 'user_stop');

      expect(stop).toHaveBeenCalledWith('user_stop');
      expect(result).toEqual({ stopped: 1, failed: 0 });
    });

    it('stopByMessage returns zero counts for unknown message ts', async () => {
      const registry = createThreadExecutionRegistry();
      registry.register(baseExecution({ executionId: 'e1', threadTs: 't1' }));

      const result = await registry.stopByMessage('unknown-ts', 'user_stop');

      expect(result).toEqual({ stopped: 0, failed: 0 });
    });

    it('tracked messages are cleaned up when last execution in thread is unregistered', async () => {
      const registry = createThreadExecutionRegistry();
      const cleanup = registry.register(baseExecution({ executionId: 'e1', threadTs: 't1' }));
      registry.trackMessage('msg1', 't1');
      registry.trackMessage('msg2', 't1');

      cleanup();

      const result = await registry.stopByMessage('msg1', 'user_stop');
      expect(result).toEqual({ stopped: 0, failed: 0 });
    });

    it('tracked messages survive when other executions remain in thread', async () => {
      const registry = createThreadExecutionRegistry();
      const stop = vi.fn().mockResolvedValue(undefined);
      const cleanup1 = registry.register(baseExecution({ executionId: 'e1', threadTs: 't1' }));
      registry.register(baseExecution({ executionId: 'e2', threadTs: 't1', stop }));
      registry.trackMessage('msg1', 't1');

      cleanup1();

      const result = await registry.stopByMessage('msg1', 'user_stop');
      expect(result.stopped).toBe(1);
    });
  });
});
