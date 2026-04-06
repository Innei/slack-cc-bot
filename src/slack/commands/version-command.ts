import { execSync } from 'node:child_process';

import type { SlashCommandResponse } from './types.js';

interface VersionInfo {
  commitDate: string;
  hash: string;
}

const deployedAt = new Date().toISOString();
let cached: VersionInfo | undefined;

function getVersionInfo(): VersionInfo {
  if (cached) return cached;
  try {
    const hash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    const commitDate = execSync('git log -1 --format=%cI HEAD', { encoding: 'utf-8' }).trim();
    cached = { hash, commitDate };
  } catch {
    cached = { hash: 'unknown', commitDate: 'unknown' };
  }
  return cached;
}

export function handleVersionCommand(): SlashCommandResponse {
  const { hash, commitDate } = getVersionInfo();
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
