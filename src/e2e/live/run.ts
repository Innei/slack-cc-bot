import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

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
  crossSessionReplyText?: string;
  crossSessionReplyTs?: string;
  failureMessage?: string;
  matched: {
    clearCallObserved: boolean;
    crossSessionRecallObserved: boolean;
    finalReplyObserved: boolean;
    memorySaved: boolean;
    streamDetailLoadingMessage: boolean;
    summaryLikeLoadingMessage: boolean;
    toolStatus: boolean;
    workspaceBindingObserved: boolean;
  };
  passed: boolean;
  probePath: string;
  probeRecords: Awaited<ReturnType<typeof readSlackStatusProbeFile>>;
  recallMarker: string;
  rootMessageTs?: string;
  runId: string;
  secondRootMessageTs?: string;
  targetFile: string;
  targetRepo: string;
  triggerUserId: string;
  workspaceRepoId?: string;
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
  const recallMarker = `CROSS_SESSION_MEMORY_MARKER ${runId}`;
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || 'slack-cc-bot';
  const targetFile =
    process.env.SLACK_E2E_TARGET_FILE?.trim() || 'src/slack/render/slack-renderer.ts';
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
      crossSessionRecallObserved: false,
      finalReplyObserved: false,
      memorySaved: false,
      streamDetailLoadingMessage: false,
      summaryLikeLoadingMessage: false,
      toolStatus: false,
      workspaceBindingObserved: false,
    },
    passed: false,
    probePath: env.SLACK_E2E_STATUS_PROBE_PATH,
    probeRecords: [],
    recallMarker,
    runId,
    targetFile,
    targetRepo,
    triggerUserId: triggerIdentity.user_id,
  };

  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);
    await runPhaseOne({
      botClient,
      botUserId: botIdentity.user_id,
      result,
      targetFile,
      targetRepo,
      triggerClient,
    });
    await writeLiveE2EResult(result);
    assertLiveE2EResult(result);

    await runPhaseTwo({
      botClient,
      botUserId: botIdentity.user_id,
      recallMarker,
      result,
      runId,
      targetRepo,
      triggerClient,
    });
    assertCrossSessionRecall(result);
    result.passed = true;
    await writeLiveE2EResult(result);

    console.info('Live Slack E2E passed.');
    console.info(`Root thread: ${result.rootMessageTs}`);
    console.info(`Assistant reply: ${result.assistantReplyTs}`);
    console.info(`Result saved to ${path.resolve(process.cwd(), env.SLACK_E2E_RESULT_PATH)}`);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeLiveE2EResult(result).catch((error) => {
      console.error('Failed to persist live E2E result:', error);
    });
    await application.stop().catch((error) => {
      console.error('Failed to stop application cleanly:', error);
    });
  }

  if (caughtError) {
    throw caughtError;
  }
}

async function runPhaseOne(input: {
  botClient: SlackApiClient;
  botUserId: string;
  result: LiveE2EResult;
  targetFile: string;
  targetRepo: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const prompt = createLiveE2EPrompt(
    input.botUserId,
    input.result.runId,
    input.targetRepo,
    input.targetFile,
  );
  const rootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.rootMessageTs = rootMessage.ts;

  const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: rootMessage.ts,
    });
    const probeRecords = await readSlackStatusProbeFile(env.SLACK_E2E_STATUS_PROBE_PATH);
    input.result.probeRecords = probeRecords.filter((record) => record.threadTs === rootMessage.ts);

    const assistantReply = findAssistantReply(
      replies,
      rootMessage,
      input.botUserId,
      input.result.runId,
    );
    if (assistantReply) {
      input.result.assistantReplyText = assistantReply.text;
      input.result.assistantReplyTs = assistantReply.ts;
      input.result.matched.finalReplyObserved = true;
      if (assistantReply.text.includes(`WORKSPACE_OK ${input.targetRepo}`)) {
        input.result.matched.workspaceBindingObserved = true;
      }
    }

    for (const record of input.result.probeRecords) {
      if (isToolStatus(record.status)) {
        input.result.matched.toolStatus = true;
      }

      if (record.clear) {
        input.result.matched.clearCallObserved = true;
      }

      for (const message of record.loadingMessages ?? []) {
        if (isStreamDetailLoadingMessage(message)) {
          input.result.matched.streamDetailLoadingMessage = true;
        }

        if (isSummaryLikeLoadingMessage(message)) {
          input.result.matched.summaryLikeLoadingMessage = true;
        }
      }
    }

    if (rootMessage.ts) {
      const workspaceRepoId = readWorkspaceRepoIdForThread(rootMessage.ts);
      if (workspaceRepoId) {
        input.result.workspaceRepoId = workspaceRepoId;
      }
      const matchingMemories = readThreadCompletionMemories({
        repoId: workspaceRepoId ?? input.targetRepo,
        threadTs: rootMessage.ts,
      });
      if (matchingMemories.length > 0) {
        input.result.matched.memorySaved = true;
      }
    }

    if (allAssertionsSatisfied(input.result)) {
      break;
    }

    await delay(2_500);
  }
}

async function runPhaseTwo(input: {
  botClient: SlackApiClient;
  botUserId: string;
  recallMarker: string;
  result: LiveE2EResult;
  runId: string;
  targetRepo: string;
  triggerClient: SlackApiClient;
}): Promise<void> {
  const workspaceRepoId = input.result.workspaceRepoId ?? input.targetRepo;
  insertExplicitRecallMarkerMemory({
    marker: input.recallMarker,
    repoId: workspaceRepoId,
    ...(input.result.rootMessageTs ? { threadTs: input.result.rootMessageTs } : {}),
  });

  const recallPrompt = createCrossSessionRecallPrompt(
    input.botUserId,
    input.runId,
    workspaceRepoId,
  );
  const secondRootMessage = await input.triggerClient.postMessage({
    channel: env.SLACK_E2E_CHANNEL_ID!,
    text: recallPrompt,
    unfurl_links: false,
    unfurl_media: false,
  });
  input.result.secondRootMessageTs = secondRootMessage.ts;

  const secondDeadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
  while (Date.now() < secondDeadline) {
    const replies = await input.botClient.conversationReplies({
      channel: env.SLACK_E2E_CHANNEL_ID!,
      inclusive: true,
      limit: 50,
      ts: secondRootMessage.ts,
    });
    const recallReply = findCrossSessionReply(
      replies,
      secondRootMessage,
      input.runId,
      input.recallMarker,
    );
    if (recallReply) {
      input.result.crossSessionReplyText = recallReply.text;
      input.result.crossSessionReplyTs = recallReply.ts;
      input.result.matched.crossSessionRecallObserved = true;
      break;
    }
    await delay(2_500);
  }
}

function createLiveE2EPrompt(
  botUserId: string,
  runId: string,
  targetRepo: string,
  targetFile: string,
): string {
  return [
    `<@${botUserId}> LIVE_E2E_RUN ${runId}`,
    `Use repository ${targetRepo} for this task.`,
    `Please inspect ${targetFile} in repo ${targetRepo}.`,
    'Use file-reading tools instead of guessing.',
    'Use at least one background task or subagent if available so progress updates are visible.',
    'Reply with exactly two bullet points.',
    `The first bullet must start with "LIVE_E2E_OK ${runId}".`,
    `The second bullet must start with "WORKSPACE_OK ${targetRepo}" and briefly describe what you found.`,
  ].join(' ');
}

function createCrossSessionRecallPrompt(
  botUserId: string,
  runId: string,
  workspaceRepoId: string,
): string {
  return [
    `<@${botUserId}> LIVE_E2E_RECALL ${runId}`,
    `Use repository ${workspaceRepoId} for this task.`,
    'Use the recall_memory tool to retrieve previous workspace memories.',
    'Find the most recent memory marker and return it exactly.',
    'Reply with exactly one bullet point.',
    `The bullet must start with "CROSS_SESSION_OK ${runId}" and include the exact marker text.`,
  ].join(' ');
}

function findAssistantReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  _botUserId: string,
  runId: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts) {
      return false;
    }

    return typeof message.text === 'string' && message.text.includes(`LIVE_E2E_OK ${runId}`);
  }) as { text: string; ts: string } | undefined;
}

function findCrossSessionReply(
  replies: SlackConversationRepliesResponse,
  rootMessage: SlackPostedMessageResponse,
  runId: string,
  recallMarker: string,
): { text: string; ts: string } | undefined {
  return replies.messages?.find((message) => {
    if (!message.ts || message.ts === rootMessage.ts || typeof message.text !== 'string') {
      return false;
    }
    return (
      message.text.includes(`CROSS_SESSION_OK ${runId}`) && message.text.includes(recallMarker)
    );
  }) as { text: string; ts: string } | undefined;
}

function isToolStatus(status: string): boolean {
  return /^Running .+\.\.\.$/.test(status) || /^Running .+ \(\d+\.\d+s\)\.\.\.$/.test(status);
}

function isStreamDetailLoadingMessage(message: string): boolean {
  return /^(?:Reading|Searching|Finding|Fetching|Calling) /.test(message);
}

function isSummaryLikeLoadingMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  const defaultMessages = new Set([
    'Reading the thread context...',
    'Planning the next steps...',
    'Generating a response...',
    'Thinking...',
    'Authenticating Claude...',
    'Compacting conversation context...',
    'Retrying Claude API request...',
    'Waiting for permission approval...',
    'Awaiting permission...',
  ]);
  if (defaultMessages.has(normalized)) {
    return false;
  }

  if (isStreamDetailLoadingMessage(normalized)) {
    return false;
  }

  return normalized.length >= 16;
}

function allAssertionsSatisfied(result: LiveE2EResult): boolean {
  return (
    result.matched.finalReplyObserved &&
    result.matched.toolStatus &&
    result.matched.streamDetailLoadingMessage &&
    result.matched.summaryLikeLoadingMessage &&
    result.matched.clearCallObserved &&
    result.matched.workspaceBindingObserved &&
    result.matched.memorySaved
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
  if (!result.matched.workspaceBindingObserved)
    failures.push('workspace-binding reply marker not observed');
  if (!result.matched.memorySaved)
    failures.push('completion memory was not saved for this thread/repo');

  if (failures.length > 0) {
    throw new Error(`Live Slack E2E failed: ${failures.join('; ')}`);
  }
}

function assertCrossSessionRecall(result: LiveE2EResult): void {
  if (!result.matched.crossSessionRecallObserved) {
    throw new Error('Live Slack E2E failed: cross-session recall marker not observed');
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

function readThreadCompletionMemories(input: {
  repoId: string;
  threadTs: string;
}): Array<{ id: string }> {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const statement = sqlite.prepare(`
      SELECT id
      FROM memories
      WHERE repo_id = @repoId
        AND thread_ts = @threadTs
        AND category = 'task_completed'
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const rows = statement.all({
      repoId: input.repoId,
      threadTs: input.threadTs,
    }) as Array<{ id: string }>;
    return rows;
  } catch {
    return [];
  } finally {
    sqlite.close();
  }
}

function readWorkspaceRepoIdForThread(threadTs: string): string | undefined {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const statement = sqlite.prepare(`
      SELECT workspace_repo_id
      FROM sessions
      WHERE thread_ts = @threadTs
      LIMIT 1
    `);
    const row = statement.get({ threadTs }) as { workspace_repo_id?: string } | undefined;
    const value = row?.workspace_repo_id?.trim();
    return value || undefined;
  } catch {
    return undefined;
  } finally {
    sqlite.close();
  }
}

function insertExplicitRecallMarkerMemory(input: {
  marker: string;
  repoId: string;
  threadTs?: string | undefined;
}): void {
  const dbPath = path.resolve(process.cwd(), env.SESSION_DB_PATH);
  const sqlite = new Database(dbPath);
  try {
    const statement = sqlite.prepare(`
      INSERT INTO memories (id, repo_id, thread_ts, category, content, metadata, created_at, expires_at)
      VALUES (@id, @repoId, @threadTs, 'decision', @content, NULL, @createdAt, NULL)
    `);
    statement.run({
      id: randomUUID(),
      repoId: input.repoId,
      threadTs: input.threadTs ?? null,
      content: input.marker,
      createdAt: new Date().toISOString(),
    });
  } finally {
    sqlite.close();
  }
}

await main();
