import { buildProgram, type RunHooks } from './router.js';

export type { RunHooks } from './router.js';

export async function runCli(argv: string[], hooks: RunHooks = {}): Promise<number> {
  const program = buildProgram(hooks);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    const e = err as { exitCode?: number; code?: string };
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return 0;
    if (typeof e.exitCode === 'number') return e.exitCode;
    throw err;
  }
  const exitCode = process.exitCode;
  return typeof exitCode === 'number' ? exitCode : 0;
}
