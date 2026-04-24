import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsdown';

function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  outDir: 'dist',
  platform: 'node',
  format: 'esm',
  clean: true,
  tsconfig: 'tsconfig.json',
  fixedExtension: false,
  noExternal: [/.*/],
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  define: {
    __KAGURA_VERSION__: JSON.stringify(pkg.version),
    __GIT_HASH__: JSON.stringify(git('git rev-parse HEAD')),
    __GIT_COMMIT_DATE__: JSON.stringify(git('git log -1 --format=%cI HEAD')),
  },
});
