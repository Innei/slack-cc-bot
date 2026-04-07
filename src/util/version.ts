import { execSync } from 'node:child_process';

declare const __GIT_HASH__: string;
declare const __GIT_COMMIT_DATE__: string;

const deployedAt = new Date().toISOString();

function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function resolveGitHash(): string {
  if (typeof __GIT_HASH__ !== 'undefined' && __GIT_HASH__) return __GIT_HASH__;
  return git('git rev-parse HEAD');
}

export function resolveCommitDate(): string {
  if (typeof __GIT_COMMIT_DATE__ !== 'undefined' && __GIT_COMMIT_DATE__) return __GIT_COMMIT_DATE__;
  return git('git log -1 --format=%cI HEAD');
}

export function getDeployedAt(): string {
  return deployedAt;
}
