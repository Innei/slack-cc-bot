import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '~/logger/index.js';
import { PresenceKeeper } from '~/slack/presence-keeper.js';

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function createMockWebClient() {
  return {
    users: {
      setPresence: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe('PresenceKeeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls setPresence("auto") on start', async () => {
    const client = createMockWebClient();
    const logger = createTestLogger();
    const keeper = new PresenceKeeper({
      client: client as any,
      logger,
    });

    await keeper.start();

    expect(client.users.setPresence).toHaveBeenCalledWith({ presence: 'auto' });
    expect(client.users.setPresence).toHaveBeenCalledTimes(1);

    await keeper.stop();
  });

  it('sends heartbeat at the configured interval', async () => {
    const client = createMockWebClient();
    const logger = createTestLogger();
    const keeper = new PresenceKeeper({
      client: client as any,
      logger,
      heartbeatIntervalMs: 1000,
    });

    await keeper.start();
    expect(client.users.setPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.users.setPresence).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(client.users.setPresence).toHaveBeenCalledTimes(3);

    for (const call of client.users.setPresence.mock.calls) {
      expect(call[0]).toEqual({ presence: 'auto' });
    }

    await keeper.stop();
  });

  it('calls setPresence("away") on stop and clears the timer', async () => {
    const client = createMockWebClient();
    const logger = createTestLogger();
    const keeper = new PresenceKeeper({
      client: client as any,
      logger,
      heartbeatIntervalMs: 1000,
    });

    await keeper.start();
    client.users.setPresence.mockClear();

    await keeper.stop();

    expect(client.users.setPresence).toHaveBeenCalledWith({ presence: 'away' });
    expect(client.users.setPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.users.setPresence).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when setPresence fails but does not throw', async () => {
    const client = createMockWebClient();
    client.users.setPresence.mockRejectedValue(new Error('network error'));
    const logger = createTestLogger();
    const keeper = new PresenceKeeper({
      client: client as any,
      logger,
    });

    await expect(keeper.start()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set presence'),
      'auto',
      'network error',
    );

    await keeper.stop();
  });

  it('defaults to 5-minute heartbeat interval', async () => {
    const client = createMockWebClient();
    const logger = createTestLogger();
    const keeper = new PresenceKeeper({
      client: client as any,
      logger,
    });

    await keeper.start();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('heartbeat every'), 300);

    await keeper.stop();
  });
});
