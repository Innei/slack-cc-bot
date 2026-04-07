import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/server/index.ts',
  outDir: 'dist/server',
  platform: 'node',
  format: 'esm',
  clean: false,
  tsconfig: 'tsconfig.server.json',
});
