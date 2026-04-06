import type { AppLogger } from '~/logger/index.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (Slack auto-away is ~10 min)

export interface SlackPresenceClient {
  users: {
    setPresence: (args: { presence: 'auto' | 'away' }) => Promise<unknown>;
  };
}

export interface PresenceKeeperOptions {
  client: SlackPresenceClient;
  heartbeatIntervalMs?: number;
  logger: AppLogger;
}

/**
 * Keeps the bot's Slack presence set to "active" (green dot) by periodically
 * calling `users.setPresence({ presence: 'auto' })`.
 *
 * Slack marks a bot as "away" after ~10 minutes of inactivity, so we beat
 * that timeout with a 5-minute default heartbeat.
 *
 * On stop, explicitly sets presence to "away" for an honest offline signal.
 */
export class PresenceKeeper {
  private readonly client: SlackPresenceClient;
  private readonly logger: AppLogger;
  private readonly heartbeatIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: PresenceKeeperOptions) {
    this.client = opts.client;
    this.logger = opts.logger;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  async start(): Promise<void> {
    await this.setPresence('auto');
    this.timer = setInterval(() => {
      void this.setPresence('auto');
    }, this.heartbeatIntervalMs);
    this.timer.unref();
    this.logger.info(
      'Presence keeper started (heartbeat every %ds)',
      this.heartbeatIntervalMs / 1000,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.setPresence('away');
    this.logger.info('Presence keeper stopped, set to away.');
  }

  private async setPresence(presence: 'auto' | 'away'): Promise<void> {
    try {
      await this.client.users.setPresence({ presence });
    } catch (error) {
      this.logger.warn(
        'Failed to set presence to %s: %s',
        presence,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
