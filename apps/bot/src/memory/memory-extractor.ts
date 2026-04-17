import Anthropic from '@anthropic-ai/sdk';

import type {
  ExtractedMemory,
  MemoryExtractionParams,
  MemoryExtractor,
} from '~/agent/shared/memory-extractor.js';
import type { AppLogger } from '~/logger/index.js';

export type { ExtractedMemory } from '~/agent/shared/memory-extractor.js';

const EXTRACTION_MODEL = 'claude-haiku-4-20250414';
const EXTRACTION_TIMEOUT_MS = 5_000;
const EXTRACTION_MAX_TOKENS = 512;

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction agent. Your job is to analyze a conversation between a user and an AI assistant, and extract any information that should be remembered across sessions.

Focus ONLY on:
1. Identity preferences: nicknames for the assistant ("叫你小汐", "call you X", "your name is X")
2. Identity preferences: how to address the user ("叫我…", "call me…", "my name is…")
3. Communication preferences: language, tone, formality ("用中文", "be more casual", "reply in English")
4. Behavioral rules: standing instructions ("以后都…", "from now on…", "always…", "never…", "记住…", "remember…")
5. Important user facts that should persist (role, team, timezone, etc.)

Do NOT extract:
- Transient conversation content (what was discussed, task outcomes)
- Information that only matters for the current session
- Things already captured in the existing memories below

Return a JSON array of objects to save. Each object:
{ "category": "preference", "content": "<concise description>", "scope": "global" }

If the new information supersedes an existing memory, include a "supersedes" field with the id of the old memory:
{ "category": "preference", "content": "<new preference>", "scope": "global", "supersedes": "<old-memory-id>" }

Return an empty array [] if there is nothing worth saving.
Return ONLY the JSON array, no markdown fences, no explanation.`;

interface ExtractionResult {
  category: 'preference';
  content: string;
  scope: 'global' | 'workspace';
  supersedes?: string;
}

export function createAnthropicMemoryExtractor(logger: AppLogger): MemoryExtractor {
  return {
    extract: (params) => extractImplicitMemories({ ...params, logger }),
  };
}

export async function extractImplicitMemories(
  params: MemoryExtractionParams,
): Promise<ExtractedMemory[]> {
  const { userMessage, assistantResponse, existingMemories, logger } = params;

  if (!userMessage.trim() || !assistantResponse.trim()) {
    return [];
  }

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    logger.debug('Skipping memory extraction because ANTHROPIC_API_KEY is not configured.');
    return [];
  }

  const existingBlock =
    existingMemories.length > 0
      ? `\nExisting memories (avoid duplicates, reference ids for superseding):\n${existingMemories.map((m) => `- [${m.id}] (${m.category}) ${m.content}`).join('\n')}`
      : '\nNo existing memories.';

  const userContent = `${existingBlock}\n\n---\nUser: ${userMessage}\nAssistant: ${assistantResponse}`;

  const client = new Anthropic();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model: EXTRACTION_MODEL,
        max_tokens: EXTRACTION_MAX_TOKENS,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      { signal: controller.signal },
    );

    const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';

    if (!text || text === '[]') {
      return [];
    }

    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      logger.warn('Memory extractor returned non-array: %s', text.slice(0, 200));
      return [];
    }

    return (parsed as ExtractionResult[])
      .filter(
        (item) =>
          item &&
          typeof item.content === 'string' &&
          item.content.length > 0 &&
          item.category === 'preference',
      )
      .map((item) => ({
        category: item.category,
        content: item.content,
        ...(item.supersedes ? { supersedesId: item.supersedes } : {}),
      }));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('Memory extraction timed out after %dms', EXTRACTION_TIMEOUT_MS);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('Memory extraction failed: %s', msg);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
