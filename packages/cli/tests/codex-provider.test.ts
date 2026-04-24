import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexProvider } from '../src/providers/codex.js';
import type { PromptCtx, PromptOption } from '../src/providers/types.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: vi.fn() };
});

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function ctx(answers: Record<string, string | undefined>): PromptCtx {
  return {
    select: async <T extends string>(_m: string, options: PromptOption<T>[]): Promise<T> => {
      return (answers.select as T | undefined) ?? (options[0]?.value as T);
    },
    text: async (message: string) => answers[`text:${message}`],
    password: async (message: string) => answers[`pw:${message}`],
    note: () => {
      /* noop */
    },
  };
}

afterEach(() => {
  mockExec.mockReset();
});

describe('codexProvider', () => {
  it('detects codex CLI on PATH as ready', async () => {
    mockExec.mockReturnValue('codex 1.2.3');
    const res = await codexProvider.detect();
    expect(res.status).toBe('ready');
  });

  it('detects absent when codex not on PATH', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const res = await codexProvider.detect();
    expect(res.status).toBe('absent');
  });

  it('chatgpt-login branch writes defaultProviderId only', async () => {
    const patch = await codexProvider.prompt(ctx({ select: 'chatgpt-login' }));
    expect(patch.env).toEqual({});
    expect(patch.config?.defaultProviderId).toBe('codex-cli');
  });

  it('api-key branch writes OPENAI_API_KEY', async () => {
    const patch = await codexProvider.prompt(
      ctx({ 'select': 'api-key', 'pw:OPENAI_API_KEY': 'sk-1' }),
    );
    expect(patch.env?.OPENAI_API_KEY).toBe('sk-1');
  });
});
