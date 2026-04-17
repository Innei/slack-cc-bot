import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractImplicitMemories } from '~/memory/memory-extractor.js';
import type { MemoryRecord } from '~/memory/types.js';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

function createTestLogger() {
  return {
    child: () => createTestLogger(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  } as unknown as Parameters<typeof extractImplicitMemories>[0]['logger'];
}

function setMockResponse(text: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
  });
}

describe('extractImplicitMemories', () => {
  let previousApiKey: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  afterEach(() => {
    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
      return;
    }
    process.env.ANTHROPIC_API_KEY = previousApiKey;
  });

  it('extracts nickname preferences from conversation', async () => {
    setMockResponse(
      JSON.stringify([
        {
          category: 'preference',
          content: 'User wants to call the assistant "小汐"',
          scope: 'global',
        },
      ]),
    );

    const result = await extractImplicitMemories({
      userMessage: '以后叫你小汐把',
      assistantResponse: '好的呀，小汐这个名字很好听～以后叫我小汐就行了',
      existingMemories: [],
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe('preference');
    expect(result[0]!.content).toContain('小汐');
  });

  it('extracts behavioral instructions', async () => {
    setMockResponse(
      JSON.stringify([
        {
          category: 'preference',
          content: 'User prefers responses in Chinese',
          scope: 'global',
        },
      ]),
    );

    const result = await extractImplicitMemories({
      userMessage: '以后都用中文回复我',
      assistantResponse: '好的，以后我会用中文回复你。',
      existingMemories: [],
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toContain('Chinese');
  });

  it('returns empty array for conversations with nothing to remember', async () => {
    setMockResponse('[]');

    const result = await extractImplicitMemories({
      userMessage: 'What is 1+1?',
      assistantResponse: '1+1 = 2',
      existingMemories: [],
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', async () => {
    const result = await extractImplicitMemories({
      userMessage: '',
      assistantResponse: '',
      existingMemories: [],
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(0);
  });

  it('handles supersedes field', async () => {
    setMockResponse(
      JSON.stringify([
        {
          category: 'preference',
          content: 'User wants to call the assistant "小夕"',
          scope: 'global',
          supersedes: 'old-pref-1',
        },
      ]),
    );

    const existing: MemoryRecord[] = [
      {
        id: 'old-pref-1',
        category: 'preference',
        content: 'User wants to call the assistant "小汐"',
        scope: 'global',
        createdAt: new Date().toISOString(),
      },
    ];

    const result = await extractImplicitMemories({
      userMessage: '别叫小汐了，叫小夕',
      assistantResponse: '好的，以后叫我小夕吧！',
      existingMemories: existing,
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.supersedesId).toBe('old-pref-1');
    expect(result[0]!.content).toContain('小夕');
  });

  it('handles API errors gracefully', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit'));

    const logger = createTestLogger();
    const result = await extractImplicitMemories({
      userMessage: '叫你小汐',
      assistantResponse: '好的',
      existingMemories: [],
      logger,
    });

    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('handles malformed JSON response', async () => {
    setMockResponse('not valid json');

    const logger = createTestLogger();
    const result = await extractImplicitMemories({
      userMessage: '叫你小汐',
      assistantResponse: '好的',
      existingMemories: [],
      logger,
    });

    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('filters out non-preference categories from response', async () => {
    setMockResponse(
      JSON.stringify([
        { category: 'preference', content: 'valid preference', scope: 'global' },
        { category: 'context', content: 'should be filtered', scope: 'global' },
        { category: 'preference', content: '', scope: 'global' },
      ]),
    );

    const result = await extractImplicitMemories({
      userMessage: 'some message',
      assistantResponse: 'some response',
      existingMemories: [],
      logger: createTestLogger(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe('valid preference');
  });
});
