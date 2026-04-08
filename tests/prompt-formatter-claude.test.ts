import { claudeFormatter } from '@kagura/prompt-formatter-claude';
import type { PromptResult } from '@kagura/prompt-pipeline';
import { describe, expect, it } from 'vitest';

describe('claudeFormatter', () => {
  it('formats text-only messages', () => {
    const result: PromptResult = {
      system: 'You are helpful.',
      afterSystem: [],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      trace: [],
    };

    const output = claudeFormatter.format(result);
    expect(output.system).toBe('You are helpful.');
    expect(output.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
  });

  it('formats messages with images as multi-part content', () => {
    const result: PromptResult = {
      system: 'System',
      afterSystem: [],
      messages: [
        {
          role: 'user',
          content: 'See this image',
          images: [{ name: 'photo.jpg', mimeType: 'image/jpeg', base64Data: 'abc123' }],
        },
      ],
      trace: [],
    };

    const output = claudeFormatter.format(result);
    expect(output.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'See this image' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
        },
      ],
    });
  });

  it('handles empty messages array', () => {
    const result: PromptResult = {
      system: 'Sys',
      afterSystem: [],
      messages: [],
      trace: [],
    };

    const output = claudeFormatter.format(result);
    expect(output.messages).toEqual([]);
  });
});
