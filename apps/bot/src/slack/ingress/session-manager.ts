import type { SessionRecord, SessionStore } from '~/session/types.js';
import type { ResolvedWorkspace } from '~/workspace/types.js';

export interface SessionResolution {
  resumeHandle: string | undefined;
  session: SessionRecord;
}

export function resolveAndPersistSession(
  threadTs: string,
  channelId: string,
  rootMessageTs: string,
  workspace: ResolvedWorkspace | undefined,
  forceNewSession: boolean,
  sessionStore: SessionStore,
): SessionResolution {
  const existingSession = sessionStore.get(threadTs);

  const shouldResetSession =
    forceNewSession ||
    Boolean(
      workspace &&
      existingSession?.providerSessionId &&
      existingSession.workspacePath !== workspace.workspacePath,
    );
  const resumeHandle = shouldResetSession ? undefined : existingSession?.providerSessionId;

  const workspaceFields = workspace
    ? {
        workspaceLabel: workspace.workspaceLabel,
        workspacePath: workspace.workspacePath,
        workspaceRepoId: workspace.repo.id,
        workspaceRepoPath: workspace.repo.repoPath,
        workspaceSource: workspace.source,
      }
    : {};

  if (existingSession) {
    const patched = sessionStore.patch(threadTs, {
      channelId,
      rootMessageTs,
      ...workspaceFields,
      ...(shouldResetSession ? { providerSessionId: undefined } : {}),
    });
    return { resumeHandle, session: patched ?? existingSession };
  }

  const session = sessionStore.upsert({
    channelId,
    threadTs,
    rootMessageTs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...workspaceFields,
  });

  return { resumeHandle, session };
}
