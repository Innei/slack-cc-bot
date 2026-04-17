import type { AppLogger } from '~/logger/index.js';
import type { MemoryRecord, SaveMemoryInput } from '~/memory/types.js';

export interface ExtractedMemory extends SaveMemoryInput {
  supersedesId?: string;
}

export interface MemoryExtractionParams {
  assistantResponse: string;
  existingMemories: MemoryRecord[];
  logger: AppLogger;
  userMessage: string;
}

export interface MemoryExtractor {
  extract: (params: MemoryExtractionParams) => Promise<ExtractedMemory[]>;
}
