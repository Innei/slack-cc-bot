import type { LiveE2EScenario } from './scenario.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  interactive: boolean;
  list: boolean;
  scenarioIds: string[];
  search: string | undefined;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    interactive: false,
    list: false,
    search: undefined,
    scenarioIds: [],
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === '--interactive' || arg === '-i') {
      args.interactive = true;
    } else if (arg === '--list' || arg === '-l') {
      args.list = true;
    } else if (arg === '--search' || arg === '-s') {
      i += 1;
      args.search = argv[i];
    } else if (arg.startsWith('--search=')) {
      args.search = arg.slice('--search='.length);
    } else if (!arg.startsWith('-')) {
      args.scenarioIds.push(arg);
    }

    i += 1;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterScenarios(scenarios: LiveE2EScenario[], search: string): LiveE2EScenario[] {
  const needle = search.toLowerCase();
  return scenarios.filter(
    (s) =>
      s.id.toLowerCase().includes(needle) ||
      s.title.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle) ||
      s.keywords.some((k) => k.toLowerCase().includes(needle)),
  );
}

export function resolveByIds(scenarios: LiveE2EScenario[], ids: string[]): LiveE2EScenario[] {
  const resolved: LiveE2EScenario[] = [];
  for (const id of ids) {
    const needle = id.toLowerCase();
    const match = scenarios.find(
      (s) =>
        s.id.toLowerCase() === needle ||
        s.id.toLowerCase().includes(needle) ||
        s.keywords.some((k) => k.toLowerCase() === needle),
    );
    if (!match) {
      throw new Error(`No scenario matching "${id}". Use --list to see available scenarios.`);
    }
    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatScenarioList(scenarios: LiveE2EScenario[]): string {
  const lines: string[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]!;
    lines.push(`  ${String(i + 1).padStart(2)}. [${s.id}] ${s.title}`);
    lines.push(`      ${s.description}`);
  }
  return lines.join('\n');
}
