import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

describe('kagura manifest print', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-man-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('prints manifest JSON to stdout', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runCli(['node', 'kagura', 'manifest', 'print']);
      expect(code).toBe(0);
      const parsed = JSON.parse(out.join(''));
      expect(parsed.display_information.name).toBe('Kagura');
    } finally {
      process.stdout.write = write;
    }
  });

  it('writes manifest to --out path', async () => {
    const outFile = path.join(tmp, 'manifest.json');
    await runCli(['node', 'kagura', 'manifest', 'print', '--out', outFile]);
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(parsed.settings.socket_mode_enabled).toBe(true);
  });
});
