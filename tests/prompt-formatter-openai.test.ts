import { openaiFormatter } from '@kagura/prompt-formatter-openai';
import type { PromptResult } from '@kagura/prompt-pipeline';
import { describe, expect, it } from 'vitest';

describe('openaiFormatter', () => {
  it('prepends system as a system-role message', () => {
    const result: PromptResult = {
      system: 'You are helpful.',
      afterSystem: [],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      trace: [],
    };

    const output = openaiFormatter.format(result);
    expect(output.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
    expect(output.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(output.messages[2]).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('omits system message when system string is empty', () => {
    const result: PromptResult = {
      system: '',
      afterSystem: [],
      messages: [{ role: 'user', content: 'hi' }],
      trace: [],
    };

    const output = openaiFormatter.format(result);
    expect(output.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });
});
