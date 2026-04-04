export const MEMORY_CATEGORIES = ['task_completed', 'decision', 'context', 'observation'] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryRecord {
  category: MemoryCategory;
  content: string;
  createdAt: string;
  expiresAt?: string | undefined;
  id: string;
  metadata?: Record<string, unknown> | undefined;
  repoId: string;
  threadTs?: string | undefined;
}

export interface SaveMemoryInput {
  category: MemoryCategory;
  content: string;
  expiresAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  repoId: string;
  threadTs?: string | undefined;
}

export interface MemorySearchOptions {
  category?: MemoryCategory | undefined;
  limit?: number | undefined;
  query?: string | undefined;
}

export interface MemoryStore {
  countAll: (repoId?: string) => number;
  delete: (id: string) => boolean;
  listRecent: (repoId: string, limit?: number) => MemoryRecord[];
  prune: (repoId: string) => number;
  pruneAll: () => number;
  save: (input: SaveMemoryInput) => MemoryRecord;
  search: (repoId: string, options?: MemorySearchOptions) => MemoryRecord[];
}
