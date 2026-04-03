import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '../../application.js';
import { env } from '../../env/server.js';
import { readSlackStatusProbeFile, resetSlackStatusProbeFile } from './file-slack-status-probe.js';
import {
  SlackApiClient,
  type SlackConversationRepliesResponse,
  type SlackPostedMessageResponse,
} from './slack-api-client.js';

interface LiveE2EResult {
  assistantReplyText?: string;
  assistantReplyTs?: string;
  botUserId: string;
  channelId: string;
  matched: {
    clearCallObserved: boolean;
    finalReplyObserved: boolean;
    streamDetailLoadingMessage: boolean;
    summaryLikeLoadingMessage: boolean;
    toolStatus: boolean;
  };
  probePath: string;
  probeRecords: Awaited<ReturnType<typeof readSlackStatusProbeFile>>;
  rootMessageTs?: string;
  runId: string;
  triggerUserId: string;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the live Slack E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live Slack E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);

  await resetSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);

  const application = createApplication();
  const botIdentity = await botClient.authTest();
  const triggerIdentity = await triggerClient.authTest();
  const result: LiveE2EResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      clearCallObserved: false,
      finalReplyObserved: false,
      streamDetailLoadingMessage: false,
      summaryLikeLoadingMessage: false,
      toolStatus: false,
    },
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    runId,
    triggerUserId: triggerIdentity.user_id,
  };

  try {
    await application.start();
    await delay(3_000);

    const prompt = createLiveE2EPrompt(botIdentity.user_id, runId);
    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });

    result.rootMessageTs = rootMessage.ts;

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 50,
        ts: rootMessage.ts,
      });
      const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
      result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);

      const assistantReply = findAssistantReply(replies, rootMessage, botIdentity.user_id, runId);
      if (assistantReply) {
        result.assistantReplyText = assistantReply.text;
        result.assistantReplyTs = assistantReply.ts;
        result.matched.finalReplyObserved = true;
      }

      for (const record of result.probeRecords) {
        if (isToolStatus(record.status)) {
          result.matched.toolStatus = true;
        }

        if (record.clear) {
          result.matched.clearCallObserved = true;
        }

        for (const message of record.loadingMessages ?? []) {
          if (isStreamDetailLoadingMessage(message)) {
            result.matched.streamDetailLoadingMessage = true;
          }

          if (isSummaryLikeLoadingMessage(message)) {
            result.matched.summaryLikeLoadingMessage = true;
          }
        }
      }

      if (allAssertionsSatisfied(result)) {
        break;
      }

      await delay(2_500);
    }

    await writeLiveE2EResult(result);
    assertLiveE2EResult(result);

    console.info('Live Slack E2E passed.');
    console.info(`Root thread: ${result.rootMessageTs}`);
    console.info(`Assistant reply: ${result.assistantReplyTs}`);
    console.info(`Result saved to ${path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH)}`);
  } finally {
    await application.stop().catch((error) => {
      console.error('Failed to stop application cleanly:', error);
    });
  }
}

function createLiveE2EPrompt(botUserId: string, runId: string): string {
  return [
    `<@${botUserId}> LIVE_E2E_RUN ${runId}`,
    'Please inspect src/slack/render/slack-renderer.ts in this repository.',
    'Use file-reading tools instead of guessing.',
    'Use at least one background task or subagent if available so progress updates are visible.',
    'Reply with exactly two bullet points.',
    `The first bullet must start with "LIVE_E2E_OK ${runId}".`,
    'The second bullet should briefly describe how loading messages are produced.',
  ].join(' ');
}

function findAssistantReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  botUserId: string,
  runId: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) {
      return false;
    }

    if (message.user !== botUserId) {
      return false;
    }

    return typeof message.text === 'string' && message.text.includes(`LIVE_E2E_OK ${runId}`);
  }) as { text: string; ts: string } | undefined;
}

function isToolStatus(status: string): boolean {
  return /^Running .+\.\.\.$/.test(status) || /^Running .+ \(\d+\.\d+s\)\.\.\.$/.test(status);
}

function isStreamDetailLoadingMessage(message: string): boolean {
  return /^(?:Reading|Searching|Finding|Fetching|Calling) /.test(message);
}

function isSummaryLikeLoadingMessage(message: string): boolean {
  if (
    [
      'Reading the thread context...',
      'Planning the next steps...',
      'Generating a response...',
      'Thinking...',
      'Authenticating Claude...',
      'Compacting conversation context...',
      'Retrying Claude API request...',
      'Waiting for permission approval...',
      'Awaiting permission...',
    ].includes(message)
  ) {
    return false;
  }

  return /\b(?:inspecting|analyzing|investigating|reviewing|exploring|summarizing|checking|understanding|tracing)\b/i.test(
    message,
  );
}

function allAssertionsSatisfied(result: LiveE2EResult): boolean {
  return (
    result.matched.finalReplyObserved &&
    result.matched.toolStatus &&
    result.matched.streamDetailLoadingMessage &&
    result.matched.summaryLikeLoadingMessage &&
    result.matched.clearCallObserved
  );
}

function assertLiveE2EResult(result: LiveE2EResult): void {
  const failures: string[] = [];
  if (!result.matched.finalReplyObserved) failures.push('final assistant reply not observed');
  if (!result.matched.toolStatus) failures.push('tool-derived status not observed');
  if (!result.matched.streamDetailLoadingMessage) {
    failures.push('stream-event-derived loading message not observed');
  }
  if (!result.matched.summaryLikeLoadingMessage) {
    failures.push('summary-like loading message not observed');
  }
  if (!result.matched.clearCallObserved) failures.push('final clear status call not observed');

  if (failures.length > 0) {
    throw new Error(`Live Slack E2E failed: ${failures.join('; ')}`);
  }
}

async function writeLiveE2EResult(result: LiveE2EResult): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

await main();
