import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../src/commands/init.js';

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

describe('runInit orchestration', () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-init-'));
    process.env = { ...origEnv, KAGURA_HOME: tmp };
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
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes config.json with provider and repoRootDir when skipStart=true', async () => {
    clack.select
      .mockResolvedValueOnce('claude-code') // provider
      .mockResolvedValueOnce('oauth'); // claude branch
    clack.text.mockResolvedValueOnce('/tmp/my-repos'); // REPO_ROOT_DIR

    const code = await runInit({ skipStart: true });
    expect(code).toBe(0);

    const cfgRaw = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8');
    const cfg = JSON.parse(cfgRaw);
    expect(cfg.defaultProviderId).toBe('claude-code');
    expect(cfg.repoRootDir).toBe('/tmp/my-repos');
  });
});
