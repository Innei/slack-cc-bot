import { getDeployedAt, resolveCommitDate, resolveGitHash } from '~/util/version.js';

import type { SlashCommandResponse } from './types.js';

export function handleVersionCommand(): SlashCommandResponse {
  const hash = resolveGitHash();
  const commitDate = resolveCommitDate();
  const deployedAt = getDeployedAt();
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
