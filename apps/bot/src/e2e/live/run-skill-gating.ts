import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

const SKILL_NAME = 'e2e-skill-gating-probe';
const BASH_PROBE_RELATIVE_PATH = '.claude/e2e-skill-gating-bash.txt';

interface SkillGatingResult {
  askUserQuestionObserved: boolean;
  autoReplyPosted: boolean;
  bashProbeFileContent?: string;
  bashProbeFileCreated: boolean;
  botUserId: string;
  channelId: string;
  classification: 'bridge_works' | 'bridge_bypassed' | 'inconclusive';
  failureMessage?: string;
  finalReplyText?: string;
  finalReplyTs?: string;
  passed: boolean;
  permissionMode: string;
  questionMessageTs?: string;
  repoName: string;
  rootMessageTs?: string;
  runId: string;
  skillName: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the skill-gating live E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const repoPath = process.cwd();
  const repoName = path.basename(repoPath);
  const runId = randomUUID();
  const skillDir = path.join(repoPath, '.claude', 'skills', SKILL_NAME);
  const skillFile = path.join(skillDir, 'SKILL.md');
  const bashProbeFile = path.join(repoPath, BASH_PROBE_RELATIVE_PATH);

  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: SkillGatingResult = {
    askUserQuestionObserved: false,
    autoReplyPosted: false,
    bashProbeFileCreated: false,
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    classification: 'inconclusive',
    passed: false,
    permissionMode: env.CLAUDE_PERMISSION_MODE,
    repoName,
    runId,
    skillName: SKILL_NAME,
  };

  await fs.mkdir(path.dirname(bashProbeFile), { recursive: true });
  await fs.rm(bashProbeFile, { force: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(skillFile, buildSkillMarkdown(), 'utf8');

  const application = createApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> SKILL_GATING_LIVE_E2E ${runId}.`,
      `Use workspace ${repoPath}.`,
      `Invoke /${SKILL_NAME} exactly once and follow it exactly.`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted skill-gating root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 100,
        ts: rootMessage.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        const text = typeof message.text === 'string' ? message.text : '';

        if (
          !result.askUserQuestionObserved &&
          (text.includes('Skill 需要你的输入') || text.includes('Choose the probe option.'))
        ) {
          result.askUserQuestionObserved = true;
          result.questionMessageTs = message.ts;
        }

        if (
          !result.finalReplyText &&
          text.includes('SKILL_GATING_PROBE_DONE') &&
          message.user === botIdentity.user_id
        ) {
          result.finalReplyText = text;
          result.finalReplyTs = message.ts;
        }
      }

      if (result.askUserQuestionObserved && !result.autoReplyPosted) {
        await triggerClient.postMessage({
          channel: env.SLACK_E2E_CHANNEL_ID,
          text: '1',
          thread_ts: rootMessage.ts,
          unfurl_links: false,
          unfurl_media: false,
        });
        result.autoReplyPosted = true;
      }

      if (result.finalReplyText) {
        break;
      }

      await delay(2_500);
    }

    result.bashProbeFileCreated = await fileExists(bashProbeFile);
    if (result.bashProbeFileCreated) {
      result.bashProbeFileContent = await fs.readFile(bashProbeFile, 'utf8');
    }

    result.classification = classifyResult(result);
    result.passed = result.classification !== 'inconclusive';
    await writeResult(result);

    if (!result.passed) {
      throw new Error(
        [
          'Skill gating live E2E was inconclusive.',
          `askUserQuestionObserved=${result.askUserQuestionObserved}`,
          `autoReplyPosted=${result.autoReplyPosted}`,
          `bashProbeFileCreated=${result.bashProbeFileCreated}`,
          `finalReplyObserved=${Boolean(result.finalReplyText)}`,
        ].join(' '),
      );
    }

    console.info('Skill gating live E2E completed.');
    console.info('classification=%s', result.classification);
    console.info('root=%s final=%s', result.rootMessageTs, result.finalReplyTs ?? 'n/a');
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist skill-gating result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
    await fs.rm(skillDir, { force: true, recursive: true }).catch(() => undefined);
    await fs.rm(bashProbeFile, { force: true }).catch(() => undefined);
  }

  if (caughtError) {
    throw caughtError;
  }
}

function buildSkillMarkdown(): string {
  return `# E2E Skill Gating Probe

Use this skill only for the live Slack E2E that tests skill tool gating.

When invoked, do exactly the following in order:

1. Call Bash once with this exact command:
\`printf 'SKILL_GATING_BASH_EXECUTED \${CLAUDE_SESSION_ID}\\n' >> ${BASH_PROBE_RELATIVE_PATH}\`
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

function classifyResult(result: SkillGatingResult): SkillGatingResult['classification'] {
  if (
    result.askUserQuestionObserved &&
    result.autoReplyPosted &&
    Boolean(result.finalReplyText) &&
    !result.bashProbeFileCreated
  ) {
    return 'bridge_works';
  }

  if (result.bashProbeFileCreated && !result.askUserQuestionObserved) {
    return 'bridge_bypassed';
  }

  return 'inconclusive';
}

async function writeResult(result: SkillGatingResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(/result\.json$/, 'skill-gating-result.json');
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'skill-gating',
  title: 'Skill Gating Under bypassPermissions',
  description:
    'Create a temporary project skill that attempts Bash + AskUserQuestion, then verify ' +
    'whether Slack AskUserQuestion bridging and non-skill tool gating actually work under bypassPermissions.',
  keywords: ['skills', 'askuserquestion', 'bypasspermissions', 'permission', 'gating', 'slack'],
  run: main,
};

runDirectly(scenario);
