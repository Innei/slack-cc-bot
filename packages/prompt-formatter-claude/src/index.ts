import type { Formatter, PromptResult } from '@kagura/prompt-pipeline';

interface ClaudeTextContent {
  text: string;
  type: 'text';
}

interface ClaudeImageContent {
  source: { type: 'base64'; media_type: string; data: string };
  type: 'image';
}

type ClaudeContentBlock = ClaudeTextContent | ClaudeImageContent;

interface ClaudeMessage {
  content: string | ClaudeContentBlock[];
  role: 'user' | 'assistant';
}

export interface ClaudePayload {
  messages: ClaudeMessage[];
  system: string;
}

export const claudeFormatter: Formatter<ClaudePayload> = {
  name: 'claude',
  format(result: PromptResult): ClaudePayload {
    const messages: ClaudeMessage[] = result.messages.map((m) => {
      if (m.images?.length) {
        return {
          role: m.role,
          content: [
            { type: 'text' as const, text: m.content },
            ...m.images.map((img) => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: img.mimeType,
                data: img.base64Data,
              },
            })),
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    return { system: result.system, messages };
  },
};
