import fs from 'node:fs';
import path from 'node:path';

import type { LiveE2EScenario } from './types.js';

export async function discoverScenarios(liveDir: string): Promise<LiveE2EScenario[]> {
  const entries = fs.readdirSync(liveDir).sort();
  const scenarios: LiveE2EScenario[] = [];

  for (const entry of entries) {
    if (!entry.startsWith('run') || !entry.endsWith('.ts')) continue;
    if (entry === 'run.ts' || /^run-[\w-]+\.ts$/.test(entry)) {
      const modulePath = path.join(liveDir, entry);
      const mod = (await import(modulePath)) as { scenario?: LiveE2EScenario };
      if (mod.scenario && typeof mod.scenario.run === 'function') {
        scenarios.push(mod.scenario);
      }
    }
  }

  return scenarios;
}

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
    const match =
      scenarios.find((s) => s.id.toLowerCase() === needle) ??
      scenarios.find(
        (s) =>
          s.id.toLowerCase().includes(needle) || s.keywords.some((k) => k.toLowerCase() === needle),
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
