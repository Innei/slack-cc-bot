import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface ReactionStopResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    botStartedReplying: boolean;
    stoppedMessageAppeared: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the reaction-stop E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error('Live E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.');
  }

  const runId = randomUUID();
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'kagura';
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();

  const result: ReactionStopResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      botStartedReplying: false,
      stoppedMessageAppeared: false,
    },
    passed: false,
    runId,
  };

  const application = createApplication();
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const mentionText = `<@${botIdentity.user_id}> [e2e:${runId}] ${targetRepo} — list all files in the project root and describe what each one does in detail`;
    const posted = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: mentionText,
    });
    result.rootMessageTs = posted.ts;
    console.info('[e2e] Posted trigger message: %s', posted.ts);

    // Wait for the bot to post a meaningful reply (progress message with tool activity)
    // This ensures the execution is registered before we try to stop it
    let botStarted = false;
    for (let i = 0; i < 30; i++) {
      await delay(2_000);
      const replies = await pollReplies(triggerClient, env.SLACK_E2E_CHANNEL_ID, posted.ts);
      const botMessages = (replies.messages ?? []).filter(
        (m) => (m.user === botIdentity.user_id || m.bot_id) && m.ts !== posted.ts,
      );
      if (botMessages.length > 0) {
        botStarted = true;
        result.matched.botStartedReplying = true;
        console.info(
          '[e2e] Bot posted %d message(s) in thread, waiting 3s for execution to stabilize...',
          botMessages.length,
        );
        // Extra delay to ensure the Claude executor is running and registered
        await delay(3_000);
        break;
      }
    }

    if (!botStarted) {
      result.failureMessage = 'Bot did not start replying within timeout';
      return;
    }

    // Add octagonal_sign reaction to the trigger message
    await triggerClient.addReaction({
      channel: env.SLACK_E2E_CHANNEL_ID,
      name: 'octagonal_sign',
      timestamp: posted.ts,
    });
    console.info('[e2e] Added octagonal_sign reaction to trigger message');

    // Poll for the "Stopped by user" message
    for (let i = 0; i < 15; i++) {
      await delay(2_000);
      const replies = await pollReplies(triggerClient, env.SLACK_E2E_CHANNEL_ID, posted.ts);
      const allText = (replies.messages ?? []).map((m) => m.text ?? '').join('\n');
      if (allText.includes('Stopped by user') || allText.includes('stopped')) {
        result.matched.stoppedMessageAppeared = true;
        console.info('[e2e] Stopped message appeared in thread');
        break;
      }
    }

    result.passed = result.matched.botStartedReplying && result.matched.stoppedMessageAppeared;

    if (!result.passed && !result.failureMessage) {
      result.failureMessage = 'Stop message did not appear after reaction';
    }
  } catch (error) {
    caughtError = error;
    result.failureMessage = error instanceof Error ? error.message : String(error);
  } finally {
    await application.stop().catch(() => {});
  }

  const outputPath = path.resolve('data', 'reaction-stop-result.json');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.info('[e2e] Result written to %s', outputPath);
  console.info('[e2e] Passed: %s', result.passed);

  if (caughtError) {
    throw caughtError;
  }

  if (!result.passed) {
    throw new Error(`E2E failed: ${result.failureMessage ?? 'unknown reason'}`);
  }
}

async function pollReplies(
  client: SlackApiClient,
  channel: string,
  ts: string,
): Promise<SlackConversationRepliesResponse> {
  return client.conversationReplies({ channel, ts, limit: 50 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const scenario: LiveE2EScenario = {
  id: 'reaction-stop',
  title: 'Reaction Stop',
  description:
    'Triggers a bot reply, adds a 🛑 reaction to the trigger message, and asserts the reply is stopped.',
  keywords: ['stop', 'reaction', 'abort', 'cancel'],
  run: main,
};

runDirectly(scenario);
