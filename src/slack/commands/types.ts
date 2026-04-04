import type { AppLogger } from '../../logger/index.js';
import type { MemoryStore } from '../../memory/types.js';
import type { SessionStore } from '../../session/types.js';
import type { WorkspaceResolver } from '../../workspace/resolver.js';

export interface SlashCommandDependencies {
  logger: AppLogger;
  memoryStore: MemoryStore;
  sessionStore: SessionStore;
  workspaceResolver: WorkspaceResolver;
}

export interface SlashCommandResponse {
  response_type?: 'ephemeral' | 'in_channel';
  text: string;
}
