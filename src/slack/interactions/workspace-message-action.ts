import { zodParse } from '~/schemas/safe-parse.js';
import { SlackMessageActionShortcutSchema } from '~/schemas/slack/message-action-shortcut.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

import {
  handleThreadConversation,
  type SlackIngressDependencies,
} from '../ingress/app-mention-handler.js';
import type { SlackWebClientLike } from '../types.js';

const MAX_REPO_OPTIONS = 100;

const WORKSPACE_REPO_BLOCK_ID = 'workspace_repo';
const WORKSPACE_REPO_ACTION_ID = 'workspace_repo';
const WORKSPACE_INPUT_BLOCK_ID = 'workspace_input';
const WORKSPACE_INPUT_ACTION_ID = 'workspace_input';
const WORKSPACE_MODE_BLOCK_ID = 'workspace_mode';
const WORKSPACE_MODE_ACTION_ID = 'workspace_mode';

export const WORKSPACE_MESSAGE_ACTION_CALLBACK_ID = 'workspace_message_action';
export const WORKSPACE_MODAL_CALLBACK_ID = 'workspace_selection_modal';

export interface WorkspaceActionMetadata {
  channelId: string;
  selectedMessageText: string;
  selectedMessageTs: string;
  selectedThreadTs?: string | undefined;
  teamId: string;
  userId: string;
}

export function createWorkspaceMessageActionHandler(deps: SlackIngressDependencies) {
  return async (args: any): Promise<void> => {
    const { ack, client, shortcut } = args;
    await ack();

    const parsed = zodParse(
      SlackMessageActionShortcutSchema,
      shortcut,
      'SlackMessageActionShortcut',
    );
    const detectedWorkspace = deps.workspaceResolver.resolveFromText(parsed.message.text, 'manual');
    const initialWorkspace =
      detectedWorkspace.status === 'unique' ? detectedWorkspace.workspace : undefined;
    const metadata: WorkspaceActionMetadata = {
      channelId: parsed.channel.id,
      selectedMessageText: parsed.message.text,
      selectedMessageTs: parsed.message.ts,
      teamId: parsed.team.id,
      userId: parsed.user.id,
      ...(parsed.message.thread_ts ? { selectedThreadTs: parsed.message.thread_ts } : {}),
    };

    await (client as SlackWebClientLike).views.open({
      trigger_id: parsed.trigger_id,
      view: createWorkspaceSelectionModal(
        metadata,
        deps,
        initialWorkspace,
        detectedWorkspace.status,
      ),
    });
  };
}

export function createWorkspaceSelectionViewHandler(deps: SlackIngressDependencies) {
  return async (args: any): Promise<void> => {
    const { ack, client, body, view } = args;
    const parsedView = parseWorkspaceSelectionView(view);
    if (!parsedView) {
      await ack();
      return;
    }

    const metadata = parseWorkspaceActionMetadata(parsedView.privateMetadata);
    if (!metadata) {
      await ack({
        response_action: 'errors',
        errors: {
          [WORKSPACE_INPUT_BLOCK_ID]:
            'Missing workspace context. Please run the message action again.',
        },
      });
      return;
    }

    const manualInput = readPlainTextValue(
      parsedView.values,
      WORKSPACE_INPUT_BLOCK_ID,
      WORKSPACE_INPUT_ACTION_ID,
    );
    const selectedRepoId = readSelectedOptionValue(
      parsedView.values,
      WORKSPACE_REPO_BLOCK_ID,
      WORKSPACE_REPO_ACTION_ID,
    );
    const sessionMode =
      readSelectedOptionValue(
        parsedView.values,
        WORKSPACE_MODE_BLOCK_ID,
        WORKSPACE_MODE_ACTION_ID,
      ) ?? 'takeover_thread';

    const resolution = manualInput
      ? deps.workspaceResolver.resolveManualInput(manualInput, 'manual')
      : selectedRepoId
        ? deps.workspaceResolver.resolveRepoId(selectedRepoId, 'manual')
        : deps.workspaceResolver.resolveFromText(metadata.selectedMessageText, 'manual');

    if (resolution.status === 'missing') {
      await ack({
        response_action: 'errors',
        errors: {
          [WORKSPACE_INPUT_BLOCK_ID]:
            'Enter a repo name or path under the repo root, or pick a repository from the list.',
        },
      });
      return;
    }

    if (resolution.status === 'ambiguous') {
      await ack({
        response_action: 'errors',
        errors: {
          [WORKSPACE_INPUT_BLOCK_ID]:
            'That matches multiple repositories. Enter a more specific path or choose the repo explicitly.',
        },
      });
      return;
    }

    await ack();

    const workspace = resolution.workspace;
    const targetThreadTs = metadata.selectedThreadTs ?? metadata.selectedMessageTs;
    const rootMessageTs = metadata.selectedThreadTs ?? metadata.selectedMessageTs;

    let conversationTs = metadata.selectedMessageTs;
    let conversationThreadTs = metadata.selectedThreadTs;
    let conversationRootTs = rootMessageTs;

    if (sessionMode === 'new_session') {
      const starter = await (client as SlackWebClientLike).chat.postMessage({
        channel: metadata.channelId,
        text: `Starting a workspace session in \`${workspace.workspaceLabel}\`.`,
      });
      const starterTs = starter.ts;
      if (!starterTs) {
        throw new Error(
          'Slack did not return a root message timestamp for the new workspace session.',
        );
      }

      conversationTs = starterTs;
      conversationThreadTs = undefined;
      conversationRootTs = starterTs;
    }

    await handleThreadConversation(
      client as SlackWebClientLike,
      {
        channel: metadata.channelId,
        team: metadata.teamId,
        text: buildMessageActionPrompt(
          readBodyUserId(body) ?? metadata.userId,
          metadata.selectedMessageText,
          workspace,
        ),
        thread_ts: conversationThreadTs,
        ts: conversationTs,
        user: readBodyUserId(body) ?? metadata.userId,
      },
      deps,
      {
        addAcknowledgementReaction: false,
        forceNewSession: sessionMode === 'new_session',
        logLabel: 'workspace message action',
        rootMessageTs: conversationRootTs,
        workspaceOverride: workspace,
      },
    );

    if (sessionMode !== 'new_session' && targetThreadTs !== conversationRootTs) {
      deps.logger.debug('Reused thread %s for message action takeover', targetThreadTs);
    }
  };
}

export function createWorkspaceSelectionModal(
  metadata: WorkspaceActionMetadata,
  deps: SlackIngressDependencies,
  initialWorkspace: ResolvedWorkspace | undefined,
  resolutionStatus: 'ambiguous' | 'missing' | 'unique',
): Record<string, unknown> {
  const repoOptions = deps.workspaceResolver
    .listRepos()
    .slice(0, MAX_REPO_OPTIONS)
    .map((repo) => ({
      text: {
        type: 'plain_text',
        text: repo.label,
      },
      value: repo.id,
    }));

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*Selected message*',
          truncateForMrkdwn(metadata.selectedMessageText || '(no text)', 250),
        ].join('\n'),
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          resolutionStatus === 'unique' && initialWorkspace
            ? `Detected workspace: \`${initialWorkspace.workspaceLabel}\``
            : 'Choose the repository manually or enter a more specific path.',
      },
    },
    {
      type: 'input',
      block_id: WORKSPACE_REPO_BLOCK_ID,
      optional: true,
      element: {
        type: 'static_select',
        action_id: WORKSPACE_REPO_ACTION_ID,
        placeholder: {
          type: 'plain_text',
          text: repoOptions.length > 0 ? 'Pick a repository' : 'No repositories found',
        },
        ...(repoOptions.length > 0 ? { options: repoOptions } : {}),
        ...(initialWorkspace
          ? {
              initial_option: {
                text: {
                  type: 'plain_text',
                  text: initialWorkspace.repo.label,
                },
                value: initialWorkspace.repo.id,
              },
            }
          : {}),
      },
      label: {
        type: 'plain_text',
        text: 'Repository',
      },
    },
    {
      type: 'input',
      block_id: WORKSPACE_INPUT_BLOCK_ID,
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: WORKSPACE_INPUT_ACTION_ID,
        placeholder: {
          type: 'plain_text',
          text: 'repo-name or owner/repo/path',
        },
        ...(initialWorkspace && initialWorkspace.workspacePath !== initialWorkspace.repo.repoPath
          ? {
              initial_value: initialWorkspace.workspacePath,
            }
          : {}),
      },
      label: {
        type: 'plain_text',
        text: 'Path or alias override',
      },
      hint: {
        type: 'plain_text',
        text: 'Leave empty to use the selected repo root.',
      },
    },
    {
      type: 'input',
      block_id: WORKSPACE_MODE_BLOCK_ID,
      element: {
        type: 'radio_buttons',
        action_id: WORKSPACE_MODE_ACTION_ID,
        options: [
          {
            text: {
              type: 'plain_text',
              text: 'Take over the current thread',
            },
            value: 'takeover_thread',
          },
          {
            text: {
              type: 'plain_text',
              text: 'Start a new thread/session',
            },
            value: 'new_session',
          },
        ],
        initial_option: {
          text: {
            type: 'plain_text',
            text: 'Take over the current thread',
          },
          value: 'takeover_thread',
        },
      },
      label: {
        type: 'plain_text',
        text: 'Session mode',
      },
    },
  ];

  return {
    type: 'modal',
    callback_id: WORKSPACE_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    submit: {
      type: 'plain_text',
      text: 'Start',
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
    },
    title: {
      type: 'plain_text',
      text: 'Workspace Session',
    },
    blocks,
  };
}

function parseWorkspaceActionMetadata(
  rawMetadata: string | undefined,
): WorkspaceActionMetadata | undefined {
  if (!rawMetadata) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawMetadata) as WorkspaceActionMetadata;
    if (
      typeof parsed.channelId === 'string' &&
      typeof parsed.selectedMessageText === 'string' &&
      typeof parsed.selectedMessageTs === 'string' &&
      typeof parsed.teamId === 'string' &&
      typeof parsed.userId === 'string'
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseWorkspaceSelectionView(view: unknown):
  | {
      privateMetadata?: string | undefined;
      values: Record<string, Record<string, Record<string, unknown>>>;
    }
  | undefined {
  if (!view || typeof view !== 'object') {
    return undefined;
  }

  const candidate = view as {
    private_metadata?: unknown;
    state?: { values?: unknown };
  };
  const values = candidate.state?.values;
  if (!values || typeof values !== 'object') {
    return undefined;
  }

  return {
    privateMetadata:
      typeof candidate.private_metadata === 'string' ? candidate.private_metadata : undefined,
    values: values as Record<string, Record<string, Record<string, unknown>>>,
  };
}

function readBodyUserId(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const user = (body as { user?: { id?: unknown } }).user;
  return typeof user?.id === 'string' ? user.id : undefined;
}

function readPlainTextValue(
  values: Record<string, Record<string, Record<string, unknown>>>,
  blockId: string,
  actionId: string,
): string {
  const value = values[blockId]?.[actionId]?.value;
  return typeof value === 'string' ? value.trim() : '';
}

function readSelectedOptionValue(
  values: Record<string, Record<string, Record<string, unknown>>>,
  blockId: string,
  actionId: string,
): string | undefined {
  const selectedOption = values[blockId]?.[actionId]?.selected_option;
  if (!selectedOption || typeof selectedOption !== 'object') {
    return undefined;
  }

  const option = selectedOption as { value?: unknown };
  return typeof option.value === 'string' ? option.value : undefined;
}

function buildMessageActionPrompt(
  userId: string,
  selectedMessageText: string,
  workspace: ResolvedWorkspace,
): string {
  return [
    `Slack message action invoked by <@${userId}>.`,
    `Selected workspace: ${workspace.workspaceLabel}.`,
    '',
    'Treat the selected Slack message below as the task/request to work on:',
    selectedMessageText || '(no message text)',
  ].join('\n');
}

function truncateForMrkdwn(value: string, maxLength: number): string {
  const normalized = value.trim().replaceAll(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
