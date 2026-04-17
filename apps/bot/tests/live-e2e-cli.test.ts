import { describe, expect, it } from 'vitest';

import { filterScenarios, parseArgs, resolveByIds } from '~/e2e/live/cli-utils.js';
import type { LiveE2EScenario } from '~/e2e/live/scenario.js';

function makeScenario(overrides: Partial<LiveE2EScenario> & { id: string }): LiveE2EScenario {
  return {
    title: overrides.id,
    description: '',
    keywords: [],
    run: async () => {},
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('returns defaults when no args are provided', () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      interactive: false,
      list: false,
      search: undefined,
      scenarioIds: [],
    });
  });

  it('parses --interactive / -i', () => {
    expect(parseArgs(['--interactive']).interactive).toBe(true);
    expect(parseArgs(['-i']).interactive).toBe(true);
  });

  it('parses --list / -l', () => {
    expect(parseArgs(['--list']).list).toBe(true);
    expect(parseArgs(['-l']).list).toBe(true);
  });

  it('parses --search with separate value', () => {
    expect(parseArgs(['--search', 'picker']).search).toBe('picker');
    expect(parseArgs(['-s', 'picker']).search).toBe('picker');
  });

  it('parses --search=value inline form', () => {
    expect(parseArgs(['--search=picker']).search).toBe('picker');
  });

  it('collects positional scenario ids', () => {
    expect(parseArgs(['full', 'slash-commands']).scenarioIds).toEqual(['full', 'slash-commands']);
  });

  it('handles mixed flags and positional args', () => {
    const result = parseArgs(['-i', '--search', 'ws', 'full', '-l']);
    expect(result.interactive).toBe(true);
    expect(result.list).toBe(true);
    expect(result.search).toBe('ws');
    expect(result.scenarioIds).toEqual(['full']);
  });
});

describe('filterScenarios', () => {
  const scenarios: LiveE2EScenario[] = [
    makeScenario({ id: 'full', title: 'Full Live E2E', keywords: ['mention', 'probe'] }),
    makeScenario({ id: 'workspace-picker', title: 'Workspace Picker', keywords: ['picker'] }),
    makeScenario({
      id: 'no-workspace-chat',
      title: 'No-Workspace Chat',
      description: 'General knowledge question',
      keywords: ['chat'],
    }),
  ];

  it('matches by id substring', () => {
    const result = filterScenarios(scenarios, 'workspace');
    expect(result.map((s) => s.id)).toEqual(['workspace-picker', 'no-workspace-chat']);
  });

  it('matches by title (case-insensitive)', () => {
    const result = filterScenarios(scenarios, 'PICKER');
    expect(result.map((s) => s.id)).toEqual(['workspace-picker']);
  });

  it('matches by keyword', () => {
    const result = filterScenarios(scenarios, 'probe');
    expect(result.map((s) => s.id)).toEqual(['full']);
  });

  it('matches by description', () => {
    const result = filterScenarios(scenarios, 'general knowledge');
    expect(result.map((s) => s.id)).toEqual(['no-workspace-chat']);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterScenarios(scenarios, 'zzz-no-match')).toEqual([]);
  });
});

describe('resolveByIds', () => {
  const scenarios: LiveE2EScenario[] = [
    makeScenario({ id: 'full', keywords: ['mention'] }),
    makeScenario({ id: 'slash-commands', keywords: ['commands'] }),
    makeScenario({ id: 'workspace-picker', keywords: ['picker'] }),
  ];

  it('resolves exact ids', () => {
    const result = resolveByIds(scenarios, ['full', 'slash-commands']);
    expect(result.map((s) => s.id)).toEqual(['full', 'slash-commands']);
  });

  it('resolves partial id match', () => {
    const result = resolveByIds(scenarios, ['slash']);
    expect(result.map((s) => s.id)).toEqual(['slash-commands']);
  });

  it('resolves by keyword', () => {
    const result = resolveByIds(scenarios, ['picker']);
    expect(result.map((s) => s.id)).toEqual(['workspace-picker']);
  });

  it('deduplicates when the same scenario matches multiple args', () => {
    const result = resolveByIds(scenarios, ['full', 'mention']);
    expect(result.map((s) => s.id)).toEqual(['full']);
  });

  it('throws for unresolvable id', () => {
    expect(() => resolveByIds(scenarios, ['nonexistent'])).toThrow(
      'No scenario matching "nonexistent"',
    );
  });
});
