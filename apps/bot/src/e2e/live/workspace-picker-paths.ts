import os from 'node:os';
import path from 'node:path';

export interface WorkspacePickerTempRepoPaths {
  tempParentA: string;
  tempParentB: string;
  tempRepo1: string;
  tempRepo2: string;
  tempRepoName: string;
}

export function buildWorkspacePickerTempRepoPaths(
  repoRootDir: string,
  runId: string,
): WorkspacePickerTempRepoPaths {
  const resolvedRepoRootDir = expandHomeDirectory(repoRootDir);
  const suffix = runId.slice(0, 8);
  const tempRepoName = `e2e-picker-${suffix}`;
  const tempParentA = path.join(resolvedRepoRootDir, `__e2e_a_${suffix}__`);
  const tempParentB = path.join(resolvedRepoRootDir, `__e2e_b_${suffix}__`);

  return {
    tempParentA,
    tempParentB,
    tempRepo1: path.join(tempParentA, tempRepoName),
    tempRepo2: path.join(tempParentB, tempRepoName),
    tempRepoName,
  };
}

function expandHomeDirectory(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }

  return path.join(os.homedir(), value.slice(2));
}
