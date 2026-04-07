import type {
  AgentActivityState,
  AgentExecutionEvent,
  GeneratedImageFile,
  GeneratedOutputFile,
  SessionUsageInfo,
} from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';
import { runtimeError } from '~/logger/runtime.js';
import type { SessionStore } from '~/session/types.js';

import type { SlackRenderer } from '../render/slack-renderer.js';
import type { SlackWebClientLike } from '../types.js';

export interface ActivitySinkOptions {
  channel: string;
  client: SlackWebClientLike;
  logger: AppLogger;
  renderer: SlackRenderer;
  sessionStore: SessionStore;
  threadTs: string;
  workspaceLabel?: string;
}

export interface ActivitySink {
  finalize: () => Promise<void>;
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
  readonly terminalPhase: 'completed' | 'failed' | 'stopped' | undefined;
  readonly toolHistory: Map<string, number>;
}

const TOOL_VERB_PATTERN =
  /^(Reading|Searching|Finding|Fetching|Calling|Running|Exploring|Recalling|Saving|Checking|Applying|Editing|Generating|Waiting|Using) (.+?)(?:\.{3})?$/;

export function createActivitySink(options: ActivitySinkOptions): ActivitySink {
  const { channel, client, logger, renderer, sessionStore, threadTs, workspaceLabel } = options;

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
