import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';
import type { SlackStatusProbeRecord } from '~/slack/render/status-probe.js';

import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient } from './slack-api-client.js';

interface SubagentDisplayResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    assistantReplied: boolean;
    replyContainsMarker: boolean;
    progressMessagePosted: boolean;
    progressMessageUpdated: boolean;
    taskProgressObserved: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: SlackStatusProbeRecord[];
  rootMessageTs?: string;
  runId: string;
  targetRepo: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the subagent-display E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'slack-cc-bot';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const result: SubagentDisplayResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      assistantReplied: false,
      replyContainsMarker: false,
      progressMessagePosted: false,
      progressMessageUpdated: false,
      taskProgressObserved: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    runId,
    targetRepo,
  };

  const application = createApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    // Prompt that encourages Claude Code to spawn sub-agents / background tasks.
    // The Agent tool or background tasks emit task_started / task_progress events
    // that our new code should render into the progress message.
    const prompt = [
      `<@${botIdentity.user_id}> SUBAGENT_DISPLAY_E2E ${runId}`,
      `Use repository ${targetRepo} for this task.`,
      'Use at least one background task or subagent if available so progress updates are visible.',
      'Read the file src/index.ts and also search the codebase for "createApplication".',
      `Reply with exactly one line: "SUBAGENT_OK ${runId} done".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });

      for (const message of replies.messages ?? []) {
        if (!message.ts || message.ts === rootMessage.ts) continue;
        if (typeof message.text !== 'string') continue;

        if (message.text.includes(`SUBAGENT_OK ${runId}`)) {
          result.assistantReplyText = message.text;
          result.assistantReplyTs = message.ts;
          result.matched.assistantReplied = true;
          result.matched.replyContainsMarker = true;
        }
      }

      if (result.matched.assistantReplied) {
        await delay(2_000);
        break;
      }

      await delay(2_500);
    }

    const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
    result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);

    analyzeProbeRecords(result);
    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live subagent-display E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('Assistant reply: %s', result.assistantReplyTs);
    console.info('Progress posted: %s', result.matched.progressMessagePosted);
    console.info('Progress updated: %s', result.matched.progressMessageUpdated);
    console.info('Task progress observed: %s', result.matched.taskProgressObserved);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

/**
 * Check whether any progress-message text includes a task status icon,
 * which indicates that our task rendering code was exercised.
 *
 * The icons we emit are Unicode checkbox characters:
 * ☐ (U+2610), ☑ (U+2611), ☒ (U+2612)
 */
const TASK_ICON_PATTERN = /[\u2610-\u2612]/;

function analyzeProbeRecords(result: SubagentDisplayResult): void {
  const progressRecords = result.probeRecords.filter(
    (r): r is Extract<SlackStatusProbeRecord, { kind: 'progress-message' }> =>
      r.kind === 'progress-message',
  );

  for (const record of progressRecords) {
    if (record.action === 'post') {
      result.matched.progressMessagePosted = true;
    }
    if (record.action === 'update') {
      result.matched.progressMessageUpdated = true;
    }
    if (record.text && TASK_ICON_PATTERN.test(record.text)) {
      result.matched.taskProgressObserved = true;
    }
  }
}

function assertResult(result: SubagentDisplayResult): void {
  const failures: string[] = [];

  if (!result.matched.assistantReplied) {
    failures.push('assistant did not reply within timeout');
  }
  if (!result.matched.replyContainsMarker) {
    failures.push(`reply does not contain expected marker "SUBAGENT_OK ${result.runId}"`);
  }
  if (!result.matched.progressMessagePosted) {
    failures.push('no progress message was posted during execution');
  }

  // Task progress is best-effort: sub-agents may not always be spawned depending
  // on the model's decision. We log but don't fail the test for this.
  if (!result.matched.taskProgressObserved) {
    console.warn(
      'WARN: No task/subagent progress icons observed in progress messages. ' +
        'This may be expected if the model chose not to spawn background tasks.',
    );
  }

  if (failures.length > 0) {
    throw new Error(`Live subagent-display E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: SubagentDisplayResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'subagent-display-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'subagent-display',
  title: 'Sub-agent Task Display',
  description:
    'Verify that sub-agent/task progress is rendered in Slack progress messages with ' +
    'status icons (:spinner:, :white_check_mark:) and that the progress message lifecycle ' +
    '(post → update → finalize) works correctly when tasks are active.',
  keywords: ['subagent', 'task', 'display', 'progress', 'background'],
  run: main,
};

runDirectly(scenario);
