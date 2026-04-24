import { describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

describe('runCli', () => {
  it('returns 0 for --version', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['node', 'kagura', '--version']);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/@innei\/kagura v/);
    } finally {
      process.stdout.write = write;
    }
  });

  it('returns 0 for --help', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['node', 'kagura', '--help']);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/Usage: kagura/);
    } finally {
      process.stdout.write = write;
    }
  });
});
