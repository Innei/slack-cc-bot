import { describe, expect, it, vi } from 'vitest';

import {
  calculateSlackStartRetryDelayMs,
  createSlackNetworkAgent,
  createSlackWebClientOptions,
  isTransientSlackNetworkError,
  startSlackAppWithRetry,
} from '~/slack/network-guard.js';

describe('slack network guard', () => {
  it('recognizes transient socket reset errors by code', () => {
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

    expect(isTransientSlackNetworkError(error)).toBe(true);
  });

  it('recognizes nested transient TLS disconnect errors', () => {
    const error = {
      original: new Error(
        'Client network socket disconnected before secure TLS connection was established',
      ),
    };

    expect(isTransientSlackNetworkError(error)).toBe(true);
  });

  it('builds keep-alive slack client options', () => {
    const agent = createSlackNetworkAgent();
    const options = createSlackWebClientOptions(agent);

    expect(options.agent).toBe(agent);
    expect(options.timeout).toBe(30_000);
    expect(options.retryConfig).toMatchObject({
      retries: 5,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 30_000,
      randomize: true,
    });
  });

  it('calculates exponential startup retry backoff', () => {
    expect(
      calculateSlackStartRetryDelayMs(1, {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
      }),
    ).toBe(1_000);
    expect(
      calculateSlackStartRetryDelayMs(3, {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 30_000,
      }),
    ).toBe(4_000);
  });

  it('retries transient startup failures and eventually succeeds', async () => {
    vi.useFakeTimers();

    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
          code: 'ECONNRESET',
        }),
      )
      .mockResolvedValueOnce();
    const logger = { warn: vi.fn() } as any;

    const promise = startSlackAppWithRetry(start, logger, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(start).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('enforces at least one startup attempt when maxAttempts is zero or negative', async () => {
    const zeroStart = vi.fn<() => Promise<void>>().mockResolvedValueOnce();
    const negativeStart = vi.fn<() => Promise<void>>().mockResolvedValueOnce();
    const logger = { warn: vi.fn() } as any;

    await expect(
      startSlackAppWithRetry(zeroStart, logger, {
        maxAttempts: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      startSlackAppWithRetry(negativeStart, logger, {
        maxAttempts: -3,
      }),
    ).resolves.toBeUndefined();

    expect(zeroStart).toHaveBeenCalledTimes(1);
    expect(negativeStart).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-transient startup failures', async () => {
    const start = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('invalid_auth'));
    const logger = { warn: vi.fn() } as any;

    await expect(startSlackAppWithRetry(start, logger)).rejects.toThrow('invalid_auth');
    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
