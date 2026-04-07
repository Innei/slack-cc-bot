import type {
  AgentActivityState,
  AgentExecutionEvent,
  AgentUserInputQuestion,
  AgentUserInputRequest,
  AgentUserInputResponse,
  GeneratedImageFile,
  GeneratedOutputFile,
  SessionUsageInfo,
} from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { runtimeError } from '~/logger/runtime.js';
import type { SessionStore } from '~/session/types.js';

import type { SlackUserInputBridge } from '../interaction/user-input-bridge.js';
import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackWebClientLike } from '../types.js';

export interface ActivitySinkOptions {
  channel: string;
  client: SlackWebClientLike;
  logger: AppLogger;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadTs: string;
  userId?: string;
  userInputBridge?: SlackUserInputBridge;
  workspaceLabel?: string;
}

export interface ActivitySink {
  finalize: () => Promise<void>;
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
  readonly terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
  requestUserInput?: (
    request: AgentUserInputRequest,
    options?: {
      description?: string | undefined;
      displayName?: string | undefined;
      signal?: AbortSignal | undefined;
      title?: string | undefined;
      toolUseId?: string | undefined;
    },
  ) => Promise<AgentUserInputResponse>;
  readonly toolHistory: Map<string, number>;
}

const TOOL_VERB_PATTERN =
  /^(Reading|Searching|Finding|Fetching|Calling|Running|Exploring|Recalling|Saving|Checking|Applying|Editing|Generating|Waiting|Using) (.+?)(?:\.{3})?$/;

export function createActivitySink(options: ActivitySinkOptions): ActivitySink {
  const {
    channel,
    client,
    logger,
    renderer,
    sessionStore,
    threadTs,
    userId,
    userInputBridge,
    workspaceLabel,
  } = options;

  let progressMessageTs: string | undefined;
  let progressMessageActive = false;
  let terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
  const toolHistory = new Map<string, number>();
  let previousActivities = new Set<string>();
  let lastStateKey: string | undefined;
  let pendingGeneratedFiles: GeneratedOutputFile[] = [];
  let pendingGeneratedImages: GeneratedImageFile[] = [];
  let executionCompletedSuccessfully = false;
  let terminalStopReason:
    | Extract<AgentExecutionEvent, { type: 'lifecycle'; phase: 'stopped' }>['reason']
    | undefined;
  let hasSentToolbarInTurn = false;
  let sessionUsageInfo: SessionUsageInfo | undefined;

  const defaultThinkingState = createDefaultThinkingState(threadTs);
  const defaultThinkingStateKey = JSON.stringify(defaultThinkingState);

  const isMeaningfulActivityState = (state: AgentActivityState): boolean => {
    if (state.clear) return false;
    if (JSON.stringify(state) === defaultThinkingStateKey) return false;

    const normalizedStatus = state.status?.trim();
    if (normalizedStatus && normalizedStatus !== defaultThinkingState.status) return true;

    const meaningfulActivity = state.activities?.some((activity) => {
      const normalizedActivity = activity.trim();
      return (
        normalizedActivity.length > 0 &&
        normalizedActivity !== normalizedStatus &&
        !(defaultThinkingState.activities ?? []).includes(normalizedActivity)
      );
    });

    return meaningfulActivity === true;
  };

  const toRendererState = (state: AgentActivityState) => ({
    threadTs: state.threadTs,
    ...(state.status != null ? { status: state.status } : {}),
    ...(state.activities != null ? { loadingMessages: state.activities } : {}),
    ...(state.composing != null ? { composing: state.composing } : {}),
    ...(toolHistory.size > 0 ? { toolHistory } : {}),
    clear: state.clear ?? false,
  });

  const updateInFlightIndicator = async (state: AgentActivityState): Promise<void> => {
    if (progressMessageActive) {
      progressMessageTs = await renderer.upsertThreadProgressMessage(
        client,
        channel,
        threadTs,
        toRendererState(state),
        progressMessageTs,
      );
      return;
    }
    await renderer.setUiState(client, channel, toRendererState(state));
  };

  const activateProgressMessage = async (state: AgentActivityState): Promise<void> => {
    if (!progressMessageActive) {
      progressMessageActive = true;
      await renderer.clearUiState(client, channel, threadTs).catch((error) => {
        logger.warn('Failed to clear fallback Slack thinking indicator: %s', String(error));
      });
    }
    progressMessageTs = await renderer.upsertThreadProgressMessage(
      client,
      channel,
      threadTs,
      toRendererState(state),
      progressMessageTs,
    );
  };

  const handleAssistantMessage = async (text: string): Promise<void> => {
    // Only include toolbar (workspaceLabel + toolHistory) on the first message of each turn
    const includeToolbar = !hasSentToolbarInTurn;
    await renderer.postThreadReply(client, channel, threadTs, text, {
      ...(includeToolbar && workspaceLabel ? { workspaceLabel } : {}),
      ...(includeToolbar && toolHistory.size > 0 ? { toolHistory } : {}),
    });
    hasSentToolbarInTurn = true;
    if (pendingGeneratedFiles.length > 0) {
      const batch = [...pendingGeneratedFiles];
      try {
        pendingGeneratedFiles = await renderer.postGeneratedFiles(client, channel, threadTs, batch);
      } catch (error) {
        logger.warn('Failed to post generated files after assistant reply: %s', String(error));
      }
    }
    if (pendingGeneratedImages.length > 0) {
      const batch = [...pendingGeneratedImages];
      try {
        pendingGeneratedImages = await renderer.postGeneratedImages(
          client,
          channel,
          threadTs,
          batch,
        );
      } catch (error) {
        logger.warn('Failed to post generated images after assistant reply: %s', String(error));
      }
    }
    if (progressMessageActive && progressMessageTs) {
      await renderer
        .deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs)
        .catch((error) => {
          logger.warn(
            'Failed to delete thread progress message after assistant reply: %s',
            String(error),
          );
        });
      progressMessageTs = undefined;
      progressMessageActive = false;
    }
    lastStateKey = undefined;
    toolHistory.clear();
    previousActivities = new Set<string>();
    await renderer.clearUiState(client, channel, threadTs).catch((error) => {
      logger.warn('Failed to clear UI state after assistant reply: %s', String(error));
    });
  };

  const handleActivityState = async (state: AgentActivityState): Promise<void> => {
    const nextStateKey = JSON.stringify(state);
    if (nextStateKey === lastStateKey) return;
    lastStateKey = nextStateKey;

    if (!state.clear) {
      previousActivities = collectToolActivity(state, toolHistory, previousActivities);
    }

    if (state.composing && !state.clear) {
      if (progressMessageActive && progressMessageTs) {
        await renderer
          .upsertThreadProgressMessage(
            client,
            channel,
            threadTs,
            {
              threadTs,
              status: 'Composing response...',
              loadingMessages: ['Composing response...'],
              ...(toolHistory.size > 0 ? { toolHistory } : {}),
              clear: false,
            },
            progressMessageTs,
          )
          .catch((error) => {
            logger.warn('Failed to update progress message on composing: %s', String(error));
          });
      } else {
        await renderer
          .setUiState(client, channel, { threadTs, status: 'Composing response...', clear: false })
          .catch((error) => {
            logger.warn('Failed to set composing status: %s', String(error));
          });
      }
      return;
    }

    if (state.clear) {
      if (progressMessageActive && progressMessageTs) {
        await renderer.deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs);
        progressMessageTs = undefined;
        progressMessageActive = false;
        return;
      }
      await renderer.clearUiState(client, channel, threadTs);
      return;
    }

    if (!progressMessageActive && isMeaningfulActivityState(state)) {
      await activateProgressMessage(state);
      return;
    }

    await updateInFlightIndicator(state);
  };

  const handleLifecycleEvent = async (
    event: Extract<AgentExecutionEvent, { type: 'lifecycle' }>,
  ): Promise<void> => {
    if (event.resumeHandle) {
      sessionStore.patch(threadTs, { claudeSessionId: event.resumeHandle });
    }
    if (event.phase === 'started') return;
    if (event.phase === 'completed') {
      terminalPhase = 'completed';
      executionCompletedSuccessfully = true;
      return;
    }
    if (event.phase === 'stopped') {
      terminalPhase = 'stopped';
      terminalStopReason = event.reason;
      if (event.reason !== 'superseded' && !progressMessageTs) {
        await renderer.postThreadReply(client, channel, threadTs, '_Stopped by user._');
      }
      return;
    }
    if (event.phase === 'failed') {
      pendingGeneratedFiles = [];
      pendingGeneratedImages = [];
      terminalPhase = 'failed';
      runtimeError(
        logger,
        'Execution failed for thread %s: %s',
        threadTs,
        redact(String(event.error ?? '')),
      );
      await renderer.postThreadReply(
        client,
        channel,
        threadTs,
        'An error occurred while processing your request.',
      );
    }
  };

  return {
    toolHistory,
    ...(userInputBridge
      ? {
          requestUserInput: async (
            request: AgentUserInputRequest,
            requestOptions?: {
              description?: string | undefined;
              displayName?: string | undefined;
              signal?: AbortSignal | undefined;
              title?: string | undefined;
              toolUseId?: string | undefined;
            },
          ): Promise<AgentUserInputResponse> => {
            const answers: Record<string, string> = {};
            const annotations: NonNullable<AgentUserInputResponse['annotations']> = {};

            for (const [index, question] of request.questions.entries()) {
              await renderer.setUiState(client, channel, {
                threadTs,
                status: 'Waiting for your reply...',
                loadingMessages: [
                  requestOptions?.title ?? 'Waiting for your reply in Slack...',
                  truncateForSlackUi(question.question),
                ],
                clear: false,
              });
              await renderer.postThreadReply(
                client,
                channel,
                threadTs,
                formatUserInputQuestionMessage(question, {
                  currentIndex: index + 1,
                  description: requestOptions?.description,
                  displayName: requestOptions?.displayName,
                  title: requestOptions?.title,
                  totalQuestions: request.questions.length,
                }),
              );

              const reply = await userInputBridge.awaitAnswer({
                expectedUserId: userId,
                question,
                signal: requestOptions?.signal,
                threadTs,
              });

              answers[question.question] = reply.answer;
              if (reply.annotation) {
                annotations[question.question] = reply.annotation;
              }
            }

            const defaultState = createDefaultThinkingState(threadTs);
            await renderer.setUiState(client, channel, {
              threadTs: defaultState.threadTs,
              status: defaultState.status,
              loadingMessages: defaultState.activities,
              clear: false,
            });

            return {
              answers,
              ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
            };
          },
        }
      : {}),

    get terminalPhase() {
      return terminalPhase;
    },

    async onEvent(event: AgentExecutionEvent): Promise<void> {
      if (event.type === 'assistant-message') {
        await handleAssistantMessage(event.text);
        return;
      }
      if (event.type === 'generated-images') {
        pendingGeneratedImages.push(...event.files);
        return;
      }
      if (event.type === 'generated-files') {
        pendingGeneratedFiles.push(...event.files);
        return;
      }
      if (event.type === 'activity-state') {
        await handleActivityState(event.state);
        return;
      }
      if (event.type === 'task-update') return;
      if (event.type === 'usage-info') {
        sessionUsageInfo = event.usage;
        return;
      }
      await handleLifecycleEvent(event as Extract<AgentExecutionEvent, { type: 'lifecycle' }>);
    },

    async finalize(): Promise<void> {
      await renderer.clearUiState(client, channel, threadTs).catch((err) => {
        logger.warn('Failed to clear UI state: %s', String(err));
      });
      if (executionCompletedSuccessfully && pendingGeneratedFiles.length > 0) {
        const batch = [...pendingGeneratedFiles];
        try {
          pendingGeneratedFiles = await renderer.postGeneratedFiles(
            client,
            channel,
            threadTs,
            batch,
          );
        } catch (err) {
          logger.warn('Failed to flush generated files on finalize: %s', String(err));
        }
      }
      if (executionCompletedSuccessfully && pendingGeneratedImages.length > 0) {
        const batch = [...pendingGeneratedImages];
        try {
          pendingGeneratedImages = await renderer.postGeneratedImages(
            client,
            channel,
            threadTs,
            batch,
          );
        } catch (err) {
          logger.warn('Failed to flush generated images on finalize: %s', String(err));
        }
      }
      if (progressMessageTs) {
        if (terminalPhase === 'stopped') {
          if (terminalStopReason === 'superseded') {
            await renderer
              .deleteThreadProgressMessage(client, channel, threadTs, progressMessageTs)
              .catch((err) => {
                logger.warn('Failed to delete superseded progress message: %s', String(err));
              });
          } else {
            await renderer
              .finalizeThreadProgressMessageStopped(
                client,
                channel,
                threadTs,
                progressMessageTs,
                toolHistory,
              )
              .catch((err) => {
                logger.warn('Failed to finalize stopped progress message: %s', String(err));
              });
          }
        } else {
          await renderer
            .finalizeThreadProgressMessage(
              client,
              channel,
              threadTs,
              progressMessageTs,
              toolHistory,
            )
            .catch((err) => {
              logger.warn('Failed to finalize progress message: %s', String(err));
            });
        }
      }
      // Post session usage info as the final context block
      if (executionCompletedSuccessfully && sessionUsageInfo) {
        await renderer
          .postSessionUsageInfo(client, channel, threadTs, sessionUsageInfo)
          .catch((err) => {
            logger.warn('Failed to post session usage info: %s', String(err));
          });
      }
    },
  };
}

function truncateForSlackUi(value: string, maxLength = 120): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatUserInputQuestionMessage(
  question: AgentUserInputQuestion,
  options: {
    currentIndex: number;
    description?: string | undefined;
    displayName?: string | undefined;
    title?: string | undefined;
    totalQuestions: number;
  },
): string {
  const header = [
    '*Skill 需要你的输入*',
    options.totalQuestions > 1
      ? `_问题 ${options.currentIndex}/${options.totalQuestions}_`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const intro = options.title ?? options.displayName ?? 'Claude 需要你提供一个选项。';
  const details = options.description ? [`${intro}`, '', options.description] : [intro];
  const optionLines = question.options.map((option, index) => {
    const description = option.description ? ` — ${option.description}` : '';
    return `${index + 1}. *${option.label}*${description}`;
  });
  const replyHint = question.multiSelect
    ? '请回复编号或标签，多个选项用逗号分隔；如果都不合适，也可以直接回复自由文本。'
    : '请回复编号或标签；如果都不合适，也可以直接回复自由文本。';

  return [
    header,
    '',
    ...details,
    '',
    `*${question.header}*`,
    question.question,
    '',
    ...optionLines,
    '',
    replyHint,
  ].join('\n');
}

function createDefaultThinkingState(threadTs: string): AgentActivityState {
  return {
    threadTs,
    status: 'Thinking...',
    activities: [
      'Reading the thread context...',
      'Planning the next steps...',
      'Generating a response...',
    ],
    clear: false,
  };
}

function collectToolActivity(
  state: AgentActivityState,
  history: Map<string, number>,
  previousActivities: Set<string>,
): Set<string> {
  const candidates = [...(state.activities ?? [])];
  if (state.status?.trim()) candidates.push(state.status);

  const currentActivities = new Set<string>();

  for (const msg of candidates) {
    const trimmed = msg.trim();
    if (!trimmed || currentActivities.has(trimmed)) continue;
    currentActivities.add(trimmed);

    // Only count activities that are newly appearing (not in previous state)
    if (previousActivities.has(trimmed)) continue;

    const match = trimmed.match(TOOL_VERB_PATTERN);
    if (!match) continue;

    const verb = match[1]!;
    const label = verb === 'Using' ? (match[2]!.split(/\s/)[0] ?? verb) : verb;
    history.set(label, (history.get(label) ?? 0) + 1);
  }

  return currentActivities;
}
