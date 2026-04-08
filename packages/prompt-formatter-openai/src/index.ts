import type { Formatter, PromptResult } from '@kagura/prompt-pipeline';

interface OpenAIMessage {
  content: string;
  role: 'system' | 'user' | 'assistant';
}

export interface OpenAIPayload {
  messages: OpenAIMessage[];
}

export const openaiFormatter: Formatter<OpenAIPayload> = {
  name: 'openai',
  format(result: PromptResult): OpenAIPayload {
    const messages: OpenAIMessage[] = [];

    if (result.system) {
      messages.push({ role: 'system', content: result.system });
    }

    for (const m of result.messages) {
      messages.push({ role: m.role, content: m.content });
    }

    return { messages };
  },
};
