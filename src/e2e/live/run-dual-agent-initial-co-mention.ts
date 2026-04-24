import './load-e2e-env.js';

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

interface DualAgentInitialCoMentionResult {
  appOneBotUserId: string;
  appOneFinalText?: string;
  appOneFinalTs?: string;
  appOneHandoffText?: string;
  appOneHandoffTs?: string;
  appOneReadyText?: string;
  appOneReadyTs?: string;
  appTwoBotUserId: string;
  appTwoReadyText?: string;
  appTwoReadyTs?: string;
  appTwoResponseText?: string;
  appTwoResponseTs?: string;
  assignmentMessageTs?: string;
  channelId: string;
  failureMessage?: string;
  matched: {
    appOneFinalObserved: boolean;
    appOneHandoffObserved: boolean;
    appOneReadyObserved: boolean;
    appTwoReadyObserved: boolean;
    appTwoResponseObserved: boolean;
    userAssignedAppOne: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
}

const CO_CODEWORD = 'VIOLET';

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error('Set SLACK_E2E_ENABLED=true before running the dual-agent E2E.');
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Dual-agent initial co-mention E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  if (!env.SLACK_BOT_2_TOKEN || !env.SLACK_APP_2_TOKEN || !env.SLACK_SIGNING_2_SECRET) {
    throw new Error(
      'Dual-agent initial co-mention E2E requires SLACK_BOT_2_TOKEN, SLACK_APP_2_TOKEN, and SLACK_SIGNING_2_SECRET.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const appOneClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const appTwoClient = new SlackApiClient(env.SLACK_BOT_2_TOKEN);
  const appOneIdentity = await appOneClient.authTest();
  const appTwoIdentity = await appTwoClient.authTest();

  const result: DualAgentInitialCoMentionResult = {
    appOneBotUserId: appOneIdentity.user_id,
    appTwoBotUserId: appTwoIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    matched: {
      appOneFinalObserved: false,
      appOneHandoffObserved: false,
      appOneReadyObserved: false,
      appTwoReadyObserved: false,
      appTwoResponseObserved: false,
      userAssignedAppOne: false,
    },
    passed: false,
    runId,
  };

  const appOne = createApplication({ instanceLabel: 'bootstrap:app1' });
  const appTwo = createApplication({
    executionProbePath: withPathSuffix(env.SLACK_E2E_EXECUTION_PROBE_PATH, 'app2'),
    instanceLabel: 'bootstrap:app2',
    sessionDbPath: withPathSuffix(env.SESSION_DB_PATH, 'app2'),
    skipManifestSync: true,
    slackCredentials: {
      appToken: env.SLACK_APP_2_TOKEN,
      botToken: env.SLACK_BOT_2_TOKEN,
      signingSecret: env.SLACK_SIGNING_2_SECRET,
    },
    statusProbePath: withPathSuffix(env.SLACK_E2E_STATUS_PROBE_PATH, 'app2'),
  });
  let caughtError: unknown;

  try {
    await appOne.start();
    await appTwo.start();
    await delay(3_000);

    const rootPrompt = [
      `<@${appOneIdentity.user_id}> <@${appTwoIdentity.user_id}> DUAL_AGENT_CO_MENTION ${runId}`,
      'This is a Slack routing test. Do not use code, file, memory, or interactive question tools.',
      `The host injects your current Slack app identity. If your identity is <@${appOneIdentity.user_id}>, reply exactly "DUAL_AGENT_APP1_READY ${runId}".`,
      `If your identity is <@${appTwoIdentity.user_id}>, reply exactly "DUAL_AGENT_APP2_READY ${runId}".`,
      `Later, when the user mentions <@${appOneIdentity.user_id}> with DUAL_AGENT_CO_ASSIGN ${runId}, app one must reply exactly "<@${appTwoIdentity.user_id}> DUAL_AGENT_CO_REQUEST ${runId}".`,
      `Later, when app two receives DUAL_AGENT_CO_REQUEST ${runId}, app two must reply exactly "<@${appOneIdentity.user_id}> DUAL_AGENT_CO_RESPONSE ${runId} ${CO_CODEWORD}".`,
      `Later, when app one receives DUAL_AGENT_CO_RESPONSE ${runId} ${CO_CODEWORD}, app one must reply exactly "DUAL_AGENT_CO_FINAL ${runId} ${CO_CODEWORD}".`,
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: rootPrompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted dual-agent initial co-mention root message: %s', rootMessage.ts);

    const appOneReady = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_APP1_READY ${runId}`,
    });
    result.appOneReadyText = appOneReady.text;
    result.appOneReadyTs = appOneReady.ts;
    result.matched.appOneReadyObserved = true;
    console.info('Observed app one ready reply: %s', appOneReady.ts);

    const appTwoReady = await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: rootMessage.ts,
      textIncludes: `DUAL_AGENT_APP2_READY ${runId}`,
    });
    result.appTwoReadyText = appTwoReady.text;
    result.appTwoReadyTs = appTwoReady.ts;
    result.matched.appTwoReadyObserved = true;
    console.info('Observed app two ready reply: %s', appTwoReady.ts);

    const assignmentMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: [
        `<@${appOneIdentity.user_id}> DUAL_AGENT_CO_ASSIGN ${runId}`,
        'Please perform the coordination step from the root instructions now.',
      ].join(' '),
      thread_ts: rootMessage.ts,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.assignmentMessageTs = assignmentMessage.ts;
    result.matched.userAssignedAppOne = true;
    console.info('Posted user assignment to app one: %s', assignmentMessage.ts);

    const appOneHandoff = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: assignmentMessage.ts,
      textIncludes: `DUAL_AGENT_CO_REQUEST ${runId}`,
    });
    result.appOneHandoffText = appOneHandoff.text;
    result.appOneHandoffTs = appOneHandoff.ts;
    result.matched.appOneHandoffObserved = true;
    console.info('Observed app one handoff to app two: %s', appOneHandoff.ts);

    const appTwoResponse = await waitForBotReply({
      botClient: appTwoClient,
      botUserId: appTwoIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: appOneHandoff.ts,
      textIncludes: `DUAL_AGENT_CO_RESPONSE ${runId} ${CO_CODEWORD}`,
    });
    result.appTwoResponseText = appTwoResponse.text;
    result.appTwoResponseTs = appTwoResponse.ts;
    result.matched.appTwoResponseObserved = true;
    console.info('Observed app two response to app one: %s', appTwoResponse.ts);

    const appOneFinal = await waitForBotReply({
      botClient: appOneClient,
      botUserId: appOneIdentity.user_id,
      channelId: env.SLACK_E2E_CHANNEL_ID,
      rootTs: rootMessage.ts,
      sinceTs: appTwoResponse.ts,
      textIncludes: `DUAL_AGENT_CO_FINAL ${runId} ${CO_CODEWORD}`,
    });
    result.appOneFinalText = appOneFinal.text;
    result.appOneFinalTs = appOneFinal.ts;
    result.matched.appOneFinalObserved = true;
    console.info('Observed app one final co-mention reply: %s', appOneFinal.ts);

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live dual-agent initial co-mention E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist dual-agent initial co-mention result:', error);
    });
    await Promise.allSettled([appTwo.stop(), appOne.stop()]);
  }

  if (caughtError) {
    throw caughtError;
  }
}

async function waitForBotReply(input: {
  botClient: SlackApiClient;
  botUserId: string;
  channelId: string;
  rootTs: string;
  sinceTs: string;
  textIncludes: string;
}): Promise<{ text: string; ts: string }> {
  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: input.channelId,
      inclusive: true,
      limit: 100,
      ts: input.rootTs,
    });

    const match = findBotMessageAfterTs(
      replies,
      input.botUserId,
      input.sinceTs,
      input.textIncludes,
    );
    if (match) {
      return match;
    }

    await delay(2_500);
  }

  throw new Error(`Timed out waiting for bot reply containing "${input.textIncludes}".`);
}

function findBotMessageAfterTs(
  replies: SlackConversationRepliesResponse,
  botUserId: string,
  sinceTs: string,
  textIncludes: string,
): { text: string; ts: string } | undefined {
  for (const message of replies.messages ?? []) {
    if (!message.ts || !isTsAfter(message.ts, sinceTs)) {
      continue;
    }
    if (message.user !== botUserId) {
      continue;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.includes(textIncludes)) {
      return { text, ts: message.ts };
    }
  }
  return undefined;
}

function isTsAfter(candidate: string, reference: string): boolean {
  return Number(candidate) > Number(reference);
}

function withPathSuffix(rawPath: string, suffix: string): string {
  const parsed = path.parse(rawPath);
  return path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
}

function assertResult(result: DualAgentInitialCoMentionResult): void {
  const failures: string[] = [];

  if (!result.matched.appOneReadyObserved) {
    failures.push('first app did not reply to the initial co-mention');
  }
  if (!result.matched.appTwoReadyObserved) {
    failures.push('second app did not reply to the initial co-mention');
  }
  if (!result.matched.userAssignedAppOne) {
    failures.push('user assignment to the first app was not posted');
  }
  if (!result.matched.appOneHandoffObserved) {
    failures.push('first app did not mention the second app after assignment');
  }
  if (!result.matched.appTwoResponseObserved) {
    failures.push('second app did not respond to the first app mention');
  }
  if (!result.matched.appOneFinalObserved) {
    failures.push('first app did not respond to the second app mention');
  }

  if (failures.length > 0) {
    throw new Error(`Live dual-agent initial co-mention E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: DualAgentInitialCoMentionResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'dual-agent-initial-co-mention-result.json',
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
  id: 'dual-agent-initial-co-mention',
  title: 'Dual Agent Initial Co-Mention',
  description:
    'Start two Slack apps from a root message that explicitly mentions both, then verify a user-assigned task can make them mention each other in the thread.',
  keywords: ['dual-agent', 'mention', 'co-mention', 'thread', 'bot', 'app'],
  run: main,
};

runDirectly(scenario);
