import {
  type SlackIngressDependencies,
  WORKSPACE_PICKER_ACTION_ID,
} from '../ingress/app-mention-handler.js';
import type { SlackWebClientLike } from '../types.js';
import {
  createWorkspaceSelectionModal,
  type WorkspaceActionMetadata,
} from './workspace-message-action.js';
import { decodeWorkspacePickerButtonValue } from './workspace-picker-payload.js';

interface WorkspacePickerActionBody {
  actions?: Array<{ action_id?: string; value?: string }>;
  channel?: { id?: string };
  message?: {
    thread_ts?: string;
    ts?: string;
  };
  team?: { id?: string };
  trigger_id?: string;
  user?: { id?: string };
}

export function createWorkspacePickerActionHandler(deps: SlackIngressDependencies) {
  return async (args: {
    ack: () => Promise<void>;
    body: unknown;
    client: unknown;
  }): Promise<void> => {
    const { ack, client } = args;
    await ack();

    const body = args.body as WorkspacePickerActionBody;
    const triggerId = body.trigger_id;
    const channelId = body.channel?.id;
    const threadTs = body.message?.thread_ts ?? body.message?.ts;
    const teamId = body.team?.id;
    const userId = body.user?.id;

    if (!triggerId || !channelId || !threadTs || !teamId || !userId) {
      deps.logger.warn(
        'Workspace picker action missing required fields (trigger=%s channel=%s thread=%s)',
        triggerId ?? 'missing',
        channelId ?? 'missing',
        threadTs ?? 'missing',
      );
      return;
    }

    const slackClient = client as SlackWebClientLike;

    const encoded = body.actions?.find(
      (action) => action.action_id === WORKSPACE_PICKER_ACTION_ID,
    )?.value;
    let originalText = decodeWorkspacePickerButtonValue(encoded);

    if (originalText === undefined) {
      deps.logger.warn(
        'Workspace picker button missing payload; falling back to conversations.replies (may miss trigger_id window)',
      );
      const replies = await slackClient.conversations.replies({
        channel: channelId,
        inclusive: true,
        limit: 1,
        ts: threadTs,
      });
      const rootMessage = replies.messages?.[0] as { text?: string } | undefined;
      originalText = typeof rootMessage?.text === 'string' ? rootMessage.text : '';
    }

    const detectedWorkspace = deps.workspaceResolver.resolveFromText(originalText, 'manual');
    const initialWorkspace =
      detectedWorkspace.status === 'unique' ? detectedWorkspace.workspace : undefined;

    const metadata: WorkspaceActionMetadata = {
      channelId,
      selectedMessageText: originalText,
      selectedMessageTs: threadTs,
      teamId,
      userId,
    };

    try {
      await slackClient.views.open({
        trigger_id: triggerId,
        view: createWorkspaceSelectionModal(
          metadata,
          deps,
          initialWorkspace,
          detectedWorkspace.status,
        ),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('views.open failed for workspace picker: %s', message);
      await deps.renderer.postThreadReply(
        slackClient,
        channelId,
        threadTs,
        'Could not open the workspace picker. Please try again, or use the message shortcut from the message menu.',
      );
    }
  };
}
