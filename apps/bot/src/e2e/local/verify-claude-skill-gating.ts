import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

interface ObservedToolCall {
  description?: string;
  input: unknown;
  title?: string;
  toolName: string;
}

interface VerificationResult {
  errorMessage?: string;
  finalResultText?: string;
  observedToolCalls: ObservedToolCall[];
  probeFileContent?: string;
  probeFileCreated: boolean;
  repoPath: string;
}

const SKILL_NAME = 'e2e-skill-gating-probe';
const PROBE_FILE_RELATIVE_PATH = '.claude/e2e-skill-gating-bash.txt';

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skill-gating-'));
  const repoPath = path.join(tempRoot, 'repo');
  const skillDir = path.join(repoPath, '.claude', 'skills', SKILL_NAME);
  const probeFilePath = path.join(repoPath, PROBE_FILE_RELATIVE_PATH);

  const result: VerificationResult = {
    observedToolCalls: [],
    probeFileCreated: false,
    repoPath,
  };

  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(path.join(repoPath, '.git'), { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), buildSkillMarkdown(), 'utf8');

  try {
    const session = query({
      prompt: `Use /${SKILL_NAME} exactly once and follow it exactly. Do not do anything else.`,
      options: {
        allowDangerouslySkipPermissions: true,
        allowedTools: ['Skill'],
        canUseTool: async (toolName, input, options) => {
          result.observedToolCalls.push({
            ...(typeof options.description === 'string'
              ? { description: options.description }
              : {}),
            input,
            ...(typeof options.title === 'string' ? { title: options.title } : {}),
            toolName,
          });

          if (toolName === 'Skill') {
            return { behavior: 'allow', updatedInput: input };
          }

          if (toolName === 'AskUserQuestion') {
            return {
              behavior: 'allow',
              updatedInput: {
                ...(input as Record<string, unknown>),
                answers: { 'Choose the probe option.': 'Option A' },
              },
            };
          }

          return {
            behavior: 'deny',
            message: `Denied ${toolName} during skill gating verification`,
          };
        },
        cwd: repoPath,
        maxTurns: 12,
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
      },
    });

    for await (const message of session) {
      if (
        message.type === 'result' &&
        message.subtype === 'success' &&
        message.result.includes('SKILL_GATING_PROBE_DONE')
      ) {
        result.finalResultText = message.result;
      }
    }
  } catch (error) {
    result.errorMessage = error instanceof Error ? error.message : String(error);
  }

  try {
    result.probeFileContent = await fs.readFile(probeFilePath, 'utf8');
    result.probeFileCreated = true;
  } catch {
    result.probeFileCreated = false;
  }

  console.info(JSON.stringify(result, null, 2));

  assertVerification(result);
}

function assertVerification(result: VerificationResult): void {
  const toolNames = result.observedToolCalls.map((call) => call.toolName);

  if (result.errorMessage) {
    throw new Error(`Claude skill gating verification failed: ${result.errorMessage}`);
  }

  if (!toolNames.includes('AskUserQuestion')) {
    throw new Error('Expected AskUserQuestion to reach canUseTool, but it was never observed.');
  }

  if (!toolNames.includes('Bash')) {
    throw new Error('Expected Bash to reach canUseTool, but it was never observed.');
  }

  if (result.probeFileCreated) {
    throw new Error(
      'Bash probe file was created, which means the gating callback did not block Bash.',
    );
  }

  if (!result.finalResultText?.includes('SKILL_GATING_PROBE_DONE answer=Option A')) {
    throw new Error('Claude did not finish the probe with the injected AskUserQuestion answer.');
  }
}

function buildSkillMarkdown(): string {
  return `# E2E Skill Gating Probe

When invoked, do exactly the following in order:

1. Call Bash once with this exact command:
\`printf 'SKILL_GATING_BASH_EXECUTED\\n' >> ${PROBE_FILE_RELATIVE_PATH}\`
2. Immediately call AskUserQuestion with exactly one single-select question:
   - header: \`Probe\`
   - question: \`Choose the probe option.\`
   - options:
     - \`Option A\`
     - \`Option B\`
3. After the user answers, reply with exactly:
\`SKILL_GATING_PROBE_DONE answer=<selected label>\`

Do not use any additional tools or add extra text.
`;
}

await main();
