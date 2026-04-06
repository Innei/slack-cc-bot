import { execSync } from 'node:child_process';

import type { SlashCommandResponse } from './types.js';

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

function resolveGitHash(): string {
   
  if (typeof __GIT_HASH__ !== 'undefined' && __GIT_HASH__) return __GIT_HASH__;
  return git('git rev-parse HEAD');
}

function resolveCommitDate(): string {
   
  if (typeof __GIT_COMMIT_DATE__ !== 'undefined' && __GIT_COMMIT_DATE__) return __GIT_COMMIT_DATE__;
  return git('git log -1 --format=%cI HEAD');
}

export function handleVersionCommand(): SlashCommandResponse {
  const hash = resolveGitHash();
  const commitDate = resolveCommitDate();
  const short = hash.length >= 7 ? hash.slice(0, 7) : hash;

  const lines = [
    '*Bot Version*',
    '',
    `• *Commit:* \`${short}\` (${hash})`,
    `• *Commit Date:* ${commitDate}`,
    `• *Deploy Date:* ${deployedAt}`,
  ];

  return {
    response_type: 'ephemeral',
    text: lines.join('\n'),
  };
}
