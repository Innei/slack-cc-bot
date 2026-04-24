import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const clack = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@clack/prompts', () => clack);
const openMock = vi.hoisted(() => vi.fn());
vi.mock('open', () => ({ default: openMock }));

describe('runInit · end-to-end', () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-e2e-'));
    fetchMock.mockReset();
    openMock.mockReset();
    for (const k of Object.keys(clack) as Array<keyof typeof clack>) {
      const v = clack[k];
      if (typeof v === 'function') (v as ReturnType<typeof vi.fn>).mockReset();
      else if (v && typeof v === 'object') {
        for (const sub of Object.values(v as Record<string, unknown>)) {
          if (typeof sub === 'function') (sub as ReturnType<typeof vi.fn>).mockReset();
        }
      }
    }
    clack.isCancel.mockReturnValue(false);
    process.env = { ...origEnv, KAGURA_HOME: tmp };
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('provider+slack-skip+repo-root writes config.json with skipStart=true', async () => {
    clack.select
      .mockResolvedValueOnce('claude-code') // provider
      .mockResolvedValueOnce('skip') // slack
      .mockResolvedValueOnce('oauth'); // claude auth branch
    clack.text.mockResolvedValueOnce('/tmp/my-repos');

    const code = await runInit({ skipStart: true });
    expect(code).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    expect(cfg.defaultProviderId).toBe('claude-code');
    expect(cfg.repoRootDir).toBe('/tmp/my-repos');

    // Slack skip → .env contains only commented-out placeholders, no real values
    const envRaw = fs.readFileSync(path.join(tmp, '.env'), 'utf8');
    expect(envRaw).toContain('# SLACK_BOT_TOKEN=');
    expect(envRaw).not.toMatch(/^SLACK_BOT_TOKEN=/m);
    expect(openMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
