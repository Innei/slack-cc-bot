import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAuthStatusMessage,
  SDKHookProgressMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { AppLogger } from '~/logger/index.js';
import { redact } from '~/logger/redact.js';

import {
  applyStreamEventToUiState,
  clearSessionStatus,
  clearSystemStatus,
  clearTaskStatus,
  clearToolStatus,
  clearTransientSystemStatuses,
  describeGenericToolActivity,
  rememberLoadingMessage,
  setSessionStatus,
  setSystemStatus,
  setTaskStatus,
  setToolStatus,
  summarizeProgressOutput,
} from './anthropic-agent-sdk-runtime-ui.js';
import type { ClaudeExecutionSink, MessageHandlers } from './types.js';

export async function handleClaudeSdkMessage(
  logger: AppLogger,
  message: SDKMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  switch (message.type) {
    case 'system': {
      await handleSystemMessage(
        logger,
        message as SDKMessage & { subtype: string },
        sink,
        handlers,
      );
      break;
    }

    case 'assistant': {
      await handleAssistantMessage(logger, message as SDKAssistantMessage, sink, handlers);
      break;
    }

    case 'auth_status': {
      await handleAuthStatusMessage(logger, message as SDKAuthStatusMessage, handlers);
      break;
    }

    case 'tool_progress': {
      await handleToolProgressMessage(logger, message as SDKToolProgressMessage, sink, handlers);
      break;
    }

    case 'stream_event': {
      const stream = message as SDKPartialAssistantMessage;
      if (applyStreamEventToUiState(handlers.runtimeUi, stream)) {
        await handlers.publishUiState();
      }
      break;
    }

    case 'result': {
      clearToolStatus(handlers.runtimeUi);
      clearSystemStatus(handlers.runtimeUi, 'hook');
      clearSystemStatus(handlers.runtimeUi, 'retry');
      clearSystemStatus(handlers.runtimeUi, 'compacting');
      handleResult(logger, message as SDKResultMessage);
      break;
    }

    default: {
      const record = message as { type?: string };
      logger.info('Unhandled Claude SDK message type: %s', record.type ?? 'unknown');
    }
  }
}

async function handleSystemMessage(
  logger: AppLogger,
  message: SDKMessage & { subtype: string },
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  switch (message.subtype) {
    case 'init': {
      handleSystemInit(logger, message as SDKSystemMessage, handlers);
      return;
    }

    case 'api_retry': {
      await handleApiRetryMessage(logger, message as SDKAPIRetryMessage, handlers);
      return;
    }

    case 'task_started': {
      await handleTaskStartedMessage(message as SDKTaskStartedMessage, sink, handlers);
      return;
    }

    case 'task_progress': {
      await handleTaskProgressMessage(message as SDKTaskProgressMessage, sink, handlers);
      return;
    }

    case 'task_notification': {
      await handleTaskNotificationMessage(message as SDKTaskNotificationMessage, sink, handlers);
      return;
    }

    case 'status': {
      await handleStatusMessage(logger, message as SDKStatusMessage, handlers);
      return;
    }

    case 'session_state_changed': {
      await handleSessionStateChangedMessage(
        logger,
        message as SDKSessionStateChangedMessage,
        handlers,
      );
      return;
    }

    case 'hook_progress': {
      await handleHookProgressMessage(logger, message as SDKHookProgressMessage, handlers);
      return;
    }

    default: {
      logger.info('Unhandled Claude system message subtype: %s', message.subtype);
    }
  }
}

function handleSystemInit(
  logger: AppLogger,
  message: SDKSystemMessage,
  handlers: MessageHandlers,
): void {
  handlers.setSessionId(message.session_id);
  logger.info(
    'Claude Code session init: id=%s model=%s cwd=%s',
    message.session_id,
    message.model,
    message.cwd,
  );
}

async function handleApiRetryMessage(
  logger: AppLogger,
  message: SDKAPIRetryMessage,
  handlers: MessageHandlers,
): Promise<void> {
  logger.warn(
    'Claude API retry %d/%d after %dms (http=%s error=%s)',
    message.attempt,
    message.max_retries,
    message.retry_delay_ms,
    message.error_status === null ? 'none' : String(message.error_status),
    message.error,
  );
  setSystemStatus(handlers.runtimeUi, 'retry', 'Retrying Claude API request...');
  rememberLoadingMessage(handlers.runtimeUi, 'Retrying Claude API request...');
  await handlers.publishUiState();
}

async function handleTaskStartedMessage(
  message: SDKTaskStartedMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.description,
    status: 'in_progress',
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  setTaskStatus(handlers.runtimeUi, message.description, message.task_id);
  rememberLoadingMessage(handlers.runtimeUi, message.description);
  await handlers.publishUiState();
}

async function handleTaskProgressMessage(
  message: SDKTaskProgressMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.description,
    status: 'in_progress',
    ...(message.summary ? { details: message.summary } : {}),
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  const taskStatusText = message.last_tool_name
    ? `Running ${message.last_tool_name}...`
    : message.description;
  setTaskStatus(handlers.runtimeUi, taskStatusText, message.task_id);
  rememberLoadingMessage(handlers.runtimeUi, message.summary ?? message.description);
  await handlers.publishUiState();
}

async function handleTaskNotificationMessage(
  message: SDKTaskNotificationMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const status = message.status === 'completed' ? ('complete' as const) : ('error' as const);
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id,
    title: message.summary,
    status,
    ...(message.output_file ? { output: message.output_file } : {}),
  });
  clearTaskStatus(handlers.runtimeUi, message.task_id);
  clearToolStatus(handlers.runtimeUi);
  await handlers.publishUiState();
}

async function handleStatusMessage(
  logger: AppLogger,
  message: SDKStatusMessage,
  handlers: MessageHandlers,
): Promise<void> {
  logger.info(
    'Claude session status update: status=%s permissionMode=%s',
    message.status ?? 'idle',
    message.permissionMode ?? 'unknown',
  );
  if (message.status === 'compacting') {
    setSystemStatus(handlers.runtimeUi, 'compacting', 'Compacting conversation context...');
    rememberLoadingMessage(handlers.runtimeUi, 'Compacting conversation context...');
  } else {
    clearSystemStatus(handlers.runtimeUi, 'compacting');
  }
  await handlers.publishUiState();
}

async function handleSessionStateChangedMessage(
  logger: AppLogger,
  message: SDKSessionStateChangedMessage,
  handlers: MessageHandlers,
): Promise<void> {
  logger.info('Claude session state changed: %s', message.state);
  if (message.state === 'running') {
    setSessionStatus(handlers.runtimeUi, 'Thinking...');
    clearSystemStatus(handlers.runtimeUi, 'permission');
  } else if (message.state === 'requires_action') {
    setSystemStatus(handlers.runtimeUi, 'permission', 'Awaiting permission...');
    rememberLoadingMessage(handlers.runtimeUi, 'Waiting for permission approval...');
  } else {
    clearSystemStatus(handlers.runtimeUi, 'permission');
    clearSessionStatus(handlers.runtimeUi);
  }
  await handlers.publishUiState();
}

async function handleHookProgressMessage(
  logger: AppLogger,
  message: SDKHookProgressMessage,
  handlers: MessageHandlers,
): Promise<void> {
  const output = summarizeProgressOutput(message.output || message.stderr || message.stdout);
  logger.info(
    'Claude hook progress: %s (%s)%s',
    message.hook_name,
    message.hook_event,
    output ? ` - ${redact(output)}` : '',
  );
  const hookStatus = `Running ${message.hook_name} hook...`;
  setSystemStatus(handlers.runtimeUi, 'hook', hookStatus);
  rememberLoadingMessage(handlers.runtimeUi, output || hookStatus);
  await handlers.publishUiState();
}

async function handleAssistantMessage(
  logger: AppLogger,
  message: SDKAssistantMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  if (message.error) {
    logger.warn('Assistant message reported error=%s', message.error);
  }

  const completedText = extractAssistantText(message);
  if (!completedText) {
    return;
  }

  handlers.collectAssistantText(completedText);
  logger.info(
    'Assistant message completed; emitting Slack reply payload (%d chars)',
    completedText.length,
  );
  await sink.onEvent({ type: 'assistant-message', text: completedText });
}

async function handleAuthStatusMessage(
  logger: AppLogger,
  message: SDKAuthStatusMessage,
  handlers: MessageHandlers,
): Promise<void> {
  const output = message.output.join('\n').trim();
  if (message.error) {
    logger.error('Claude auth status error: %s', redact(message.error));
  } else {
    logger.info('Claude auth status: authenticating=%s', String(message.isAuthenticating));
    if (message.isAuthenticating) {
      setSystemStatus(handlers.runtimeUi, 'auth', 'Authenticating Claude...');
      rememberLoadingMessage(handlers.runtimeUi, 'Authenticating Claude...');
    } else {
      clearSystemStatus(handlers.runtimeUi, 'auth');
    }
  }

  if (output) {
    logger.info('Claude auth status output: %s', redact(output));
    rememberLoadingMessage(handlers.runtimeUi, output);
  }

  await handlers.publishUiState();
}

async function handleToolProgressMessage(
  logger: AppLogger,
  message: SDKToolProgressMessage,
  sink: ClaudeExecutionSink,
  handlers: MessageHandlers,
): Promise<void> {
  const elapsed = message.elapsed_time_seconds.toFixed(1);
  logger.info('Claude tool progress: %s (%ss elapsed)', message.tool_name, elapsed);
  await sink.onEvent({
    type: 'task-update',
    taskId: message.task_id ?? message.tool_use_id,
    title: `Running ${message.tool_name}`,
    status: 'in_progress',
    details: `Elapsed ${elapsed}s`,
  });
  clearTransientSystemStatuses(handlers.runtimeUi);
  setToolStatus(
    handlers.runtimeUi,
    `Running ${message.tool_name} (${elapsed}s)...`,
    message.tool_name,
  );
  rememberLoadingMessage(handlers.runtimeUi, describeGenericToolActivity(message.tool_name));
  await handlers.publishUiState();
}

function handleResult(logger: AppLogger, message: SDKResultMessage): void {
  if (message.subtype === 'success') {
    logger.info(
      'Claude execution completed in %dms, cost $%s',
      message.duration_ms,
      message.total_cost_usd.toFixed(4),
    );
  } else {
    logger.warn('Claude execution ended with %s: %s', message.subtype, message.errors.join('; '));
  }
}

function extractAssistantText(message: SDKAssistantMessage): string {
  const content = Array.isArray(message.message.content) ? message.message.content : [];

  return content
    .flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return [block.text];
      }

      return [];
    })
    .join('');
}
