import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

describe('kagura config path', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...origEnv };
    process.env.KAGURA_HOME = '/tmp/kagura-test-home';
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('prints configDir', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(['node', 'kagura', 'config', 'path']);
      expect(out.join('').trim()).toBe('/tmp/kagura-test-home');
    } finally {
      process.stdout.write = write;
    }
  });

  it('prints JSON blob with --json', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(['node', 'kagura', 'config', 'path', '--json']);
      const parsed = JSON.parse(out.join(''));
      expect(parsed.configDir).toBe('/tmp/kagura-test-home');
      expect(parsed.envFile).toMatch(/\.env$/);
    } finally {
      process.stdout.write = write;
    }
  });
});
