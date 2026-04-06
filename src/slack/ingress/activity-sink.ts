import type { AgentActivityState, AgentExecutionEvent, GeneratedImageFile } from '~/agent/types.js';
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
  const seenActivities = new Set<string>();
  let lastStateKey: string | undefined;
  let pendingGeneratedImages: GeneratedImageFile[] = [];
  let executionCompletedSuccessfully = false;

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
    await renderer.postThreadReply(client, channel, threadTs, text, {
      ...(workspaceLabel ? { workspaceLabel } : {}),
      ...(toolHistory.size > 0 ? { toolHistory } : {}),
    });
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
    seenActivities.clear();
    await renderer.clearUiState(client, channel, threadTs).catch((error) => {
      logger.warn('Failed to clear UI state after assistant reply: %s', String(error));
    });
  };

  const handleActivityState = async (state: AgentActivityState): Promise<void> => {
    const nextStateKey = JSON.stringify(state);
    if (nextStateKey === lastStateKey) return;
    lastStateKey = nextStateKey;

    if (!state.clear) {
      collectToolActivity(state, toolHistory, seenActivities);
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
      if (!progressMessageTs) {
        await renderer.postThreadReply(client, channel, threadTs, '_Stopped by user._');
      }
      return;
    }
    if (event.phase === 'failed') {
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

    async onEvent(event: AgentExecutionEvent): Promise<void> {
      if (event.type === 'assistant-message') {
        await handleAssistantMessage(event.text);
        return;
      }
      if (event.type === 'generated-images') {
        pendingGeneratedImages.push(...event.files);
        return;
      }
      if (event.type === 'activity-state') {
        await handleActivityState(event.state);
        return;
      }
      if (event.type === 'task-update') return;
      await handleLifecycleEvent(event as Extract<AgentExecutionEvent, { type: 'lifecycle' }>);
    },

    async finalize(): Promise<void> {
      await renderer.clearUiState(client, channel, threadTs).catch((err) => {
        logger.warn('Failed to clear UI state: %s', String(err));
      });
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
  seenActivities: Set<string>,
): void {
  const candidates = [...(state.activities ?? [])];
  if (state.status?.trim()) candidates.push(state.status);

  for (const msg of candidates) {
    const trimmed = msg.trim();
    if (!trimmed || seenActivities.has(trimmed)) continue;
    const match = trimmed.match(TOOL_VERB_PATTERN);
    if (!match) continue;
    seenActivities.add(trimmed);
    const verb = match[1]!;
    const label = verb === 'Using' ? (match[2]!.split(/\s/)[0] ?? verb) : verb;
    history.set(label, (history.get(label) ?? 0) + 1);
  }
}
