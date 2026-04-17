import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildWorkspacePickerTempRepoPaths } from '~/e2e/live/workspace-picker-paths.js';

describe('workspace-picker live scenario paths', () => {
  it('builds temp repo paths under expanded repo root', () => {
    const result = buildWorkspacePickerTempRepoPaths('~/git', '12345678-aaaa-bbbb-cccc-dddd');

    const expandedRepoRoot = path.join(os.homedir(), 'git');

    expect(result.tempRepoName).toBe('e2e-picker-12345678');
    expect(result.tempParentA).toBe(path.join(expandedRepoRoot, '__e2e_a_12345678__'));
    expect(result.tempParentB).toBe(path.join(expandedRepoRoot, '__e2e_b_12345678__'));
    expect(result.tempRepo1).toBe(
      path.join(expandedRepoRoot, '__e2e_a_12345678__', 'e2e-picker-12345678'),
    );
    expect(result.tempRepo2).toBe(
      path.join(expandedRepoRoot, '__e2e_b_12345678__', 'e2e-picker-12345678'),
    );
  });
});
