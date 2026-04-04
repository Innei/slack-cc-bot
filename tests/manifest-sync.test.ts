import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../src/logger/index.js';
import { rotateToken, syncSlashCommands } from '../src/slack/commands/manifest-sync.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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

function slackOk<T>(data: T): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slackError(error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('rotateToken', () => {
  it('returns new tokens on success', async () => {
    fetchMock.mockResolvedValueOnce(
      slackOk({
        token: 'xoxe.xoxp-new-access',
        refresh_token: 'xoxe-new-refresh',
        exp: 1700000000,
        iat: 1699956800,
      }),
    );

    const result = await rotateToken('xoxe-old-refresh');

    expect(result).toBeDefined();
    expect(result!.token).toBe('xoxe.xoxp-new-access');
    expect(result!.refresh_token).toBe('xoxe-new-refresh');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/tooling.tokens.rotate');
    expect(JSON.parse(init.body as string)).toEqual({ refresh_token: 'xoxe-old-refresh' });
  });

  it('returns undefined on invalid refresh token', async () => {
    fetchMock.mockResolvedValueOnce(slackError('invalid_refresh_token'));

    const result = await rotateToken('xoxe-bad-token');
    expect(result).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network error'));

    const result = await rotateToken('xoxe-refresh');
    expect(result).toBeUndefined();
  });
});

describe('syncSlashCommands with token rotation', () => {
  it('uses persisted token if not expired', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');
    const futureExp = Math.floor(Date.now() / 1000) + 3600;

    fs.writeFileSync(
      tokenStorePath,
      JSON.stringify({
        accessToken: 'xoxe.xoxp-persisted',
        refreshToken: 'xoxe-persisted-refresh',
        expiresAt: futureExp,
        updatedAt: new Date().toISOString(),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      slackOk({
        manifest: {
          features: {
            slash_commands: [
              { command: '/usage', description: 'test' },
              { command: '/workspace', description: 'test' },
              { command: '/memory', description: 'test' },
              { command: '/session', description: 'test' },
            ],
          },
        },
      }),
    );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer xoxe.xoxp-persisted');
  });

  it('rotates token when persisted token is expired', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-expired-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');
    const pastExp = Math.floor(Date.now() / 1000) - 100;

    fs.writeFileSync(
      tokenStorePath,
      JSON.stringify({
        accessToken: 'xoxe.xoxp-expired',
        refreshToken: 'xoxe-stored-refresh',
        expiresAt: pastExp,
        updatedAt: new Date().toISOString(),
      }),
    );

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          token: 'xoxe.xoxp-rotated',
          refresh_token: 'xoxe-rotated-refresh',
          exp: Math.floor(Date.now() / 1000) + 43200,
        }),
      )
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              slash_commands: [
                { command: '/usage', description: 'test' },
                { command: '/workspace', description: 'test' },
                { command: '/memory', description: 'test' },
                { command: '/session', description: 'test' },
              ],
            },
          },
        }),
      );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [rotateUrl] = fetchMock.mock.calls[0];
    expect(rotateUrl).toBe('https://slack.com/api/tooling.tokens.rotate');

    const [, manifestInit] = fetchMock.mock.calls[1];
    expect(manifestInit.headers.Authorization).toBe('Bearer xoxe.xoxp-rotated');

    const updated = JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
    expect(updated.accessToken).toBe('xoxe.xoxp-rotated');
    expect(updated.refreshToken).toBe('xoxe-rotated-refresh');
  });

  it('registers missing commands via manifest update', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-register-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock
      .mockResolvedValueOnce(
        slackOk({
          manifest: {
            features: {
              slash_commands: [{ command: '/usage', description: 'existing' }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(slackOk({}));

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-direct',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [updateUrl, updateInit] = fetchMock.mock.calls[1];
    expect(updateUrl).toBe('https://slack.com/api/apps.manifest.update');

    const body = JSON.parse(updateInit.body as string);
    const commands = body.manifest.features.slash_commands;
    expect(commands).toHaveLength(4);
    expect(commands.map((c: { command: string }) => c.command)).toEqual(
      expect.arrayContaining(['/usage', '/workspace', '/memory', '/session']),
    );
  });

  it('skips update when all commands exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-noop-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    fetchMock.mockResolvedValueOnce(
      slackOk({
        manifest: {
          features: {
            slash_commands: [
              { command: '/usage', description: 'x' },
              { command: '/workspace', description: 'x' },
              { command: '/memory', description: 'x' },
              { command: '/session', description: 'x' },
            ],
          },
        },
      }),
    );

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      configToken: 'xoxe.xoxp-token',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('logs error when no tokens available', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-sync-notoken-'));
    const tokenStorePath = path.join(tmpDir, 'tokens.json');

    const logger = createTestLogger();
    await syncSlashCommands({
      appId: 'A123',
      logger,
      tokenStorePath,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No valid config token'));
  });
});
