import type { Agent as HttpAgent } from 'node:http';
import https from 'node:https';

import type { AppLogger } from '~/logger/index.js';
import { sleep } from '~/util/sleep.js';

const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EPIPE',
]);

const TRANSIENT_NETWORK_MESSAGE_PATTERNS = [
  /client network socket disconnected before secure tls connection was established/i,
  /socket hang up/i,
  /read econnreset/i,
  /connect etimedout/i,
  /tls connection was established/i,
];

export interface SlackNetworkStartRetryOptions {
  baseDelayMs?: number;
  maxAttempts?: number;
  maxDelayMs?: number;
}

export interface SlackWebClientOptionsLike {
  agent?: HttpAgent;
  retryConfig?: {
    retries: number;
    factor: number;
    minTimeout: number;
    maxTimeout: number;
    randomize: boolean;
  };
  timeout?: number;
}

export function createSlackNetworkAgent(): https.Agent {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 10,
    scheduling: 'lifo',
    timeout: 30_000,
  });
}

export function createSlackWebClientOptions(agent: HttpAgent): SlackWebClientOptionsLike {
  return {
    agent,
    timeout: 30_000,
    retryConfig: {
      retries: 5,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 30_000,
      randomize: true,
    },
  };
}

export function isTransientSlackNetworkError(error: unknown, depth = 0): boolean {
  if (!error || depth > 3) {
    return false;
  }

  if (typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      original?: unknown;
      originalError?: unknown;
    };

    if (
      typeof candidate.code === 'string' &&
      TRANSIENT_NETWORK_ERROR_CODES.has(candidate.code.toUpperCase())
    ) {
      return true;
    }

    if (typeof candidate.message === 'string') {
      for (const pattern of TRANSIENT_NETWORK_MESSAGE_PATTERNS) {
        if (pattern.test(candidate.message)) {
          return true;
        }
      }
    }

    return [candidate.cause, candidate.original, candidate.originalError].some((nested) =>
      isTransientSlackNetworkError(nested, depth + 1),
    );
  }

  if (typeof error === 'string') {
    return TRANSIENT_NETWORK_MESSAGE_PATTERNS.some((pattern) => pattern.test(error));
  }

  return false;
}

export function getSlackNetworkErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  return String(error);
}

export function calculateSlackStartRetryDelayMs(
  attempt: number,
  options: Required<SlackNetworkStartRetryOptions>,
): number {
  return Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export async function startSlackAppWithRetry(
  start: () => Promise<unknown>,
  logger: AppLogger,
  options: SlackNetworkStartRetryOptions = {},
): Promise<void> {
  const resolvedOptions: Required<SlackNetworkStartRetryOptions> = {
    maxAttempts: Math.max(1, options.maxAttempts ?? 5),
    baseDelayMs: options.baseDelayMs ?? 1_000,
    maxDelayMs: options.maxDelayMs ?? 30_000,
  };

  for (let attempt = 1; attempt <= resolvedOptions.maxAttempts; attempt += 1) {
    try {
      await start();
      return;
    } catch (error) {
      const isTransient = isTransientSlackNetworkError(error);
      const isFinalAttempt = attempt >= resolvedOptions.maxAttempts;

      if (!isTransient || isFinalAttempt) {
        throw error;
      }

      const delayMs = calculateSlackStartRetryDelayMs(attempt, resolvedOptions);
      logger.warn(
        'Slack Socket Mode start failed with transient network error (attempt %d/%d): %s. Retrying in %dms.',
        attempt,
        resolvedOptions.maxAttempts,
        getSlackNetworkErrorMessage(error),
        delayMs,
      );
      await sleep(delayMs);
    }
  }
}
