import type { AgentExecutor } from './types.js';

export interface AgentProviderRegistry {
  readonly defaultProviderId: string;
  drain: () => Promise<void>;
  getExecutor: (id: string) => AgentExecutor;
  has: (id: string) => boolean;
  readonly providerIds: string[];
}

export function createProviderRegistry(
  defaultId: string,
  executors: Map<string, AgentExecutor>,
): AgentProviderRegistry {
  if (!executors.has(defaultId)) {
    throw new Error(
      `Default provider "${defaultId}" is not registered. Available: ${[...executors.keys()].join(', ')}`,
    );
  }

  return {
    defaultProviderId: defaultId,
    providerIds: [...executors.keys()],

    has(id: string): boolean {
      return executors.has(id);
    },

    getExecutor(id: string): AgentExecutor {
      const executor = executors.get(id);
      if (!executor) {
        throw new Error(
          `Provider "${id}" is not registered. Available: ${[...executors.keys()].join(', ')}`,
        );
      }
      return executor;
    },

    async drain(): Promise<void> {
      await Promise.allSettled([...executors.values()].map((executor) => executor.drain()));
    },
  };
}
