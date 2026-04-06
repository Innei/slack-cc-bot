import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildClaudePromptInput } from '~/agent/providers/claude-code/multimodal-prompt.js';
import { buildPrompt } from '~/agent/providers/claude-code/prompts.js';
import type { AgentExecutionRequest } from '~/agent/types.js';

function baseRequest(
  overrides: Omit<Partial<AgentExecutionRequest>, 'threadContext'> & {
    threadContext?: Partial<AgentExecutionRequest['threadContext']>;
  } = {},
): AgentExecutionRequest {
  const threadDefaults: AgentExecutionRequest['threadContext'] = {
    channelId: 'C1',
    threadTs: '100.000',
    messages: [],
    renderedPrompt: 'Message 1 | ts=100.000 | author=U1\nhello',
    loadedImages: [],
    imageLoadFailures: [],
  };
  const { threadContext: threadOverrides, ...rest } = overrides;
  const threadContext: AgentExecutionRequest['threadContext'] = {
    ...threadDefaults,
    ...threadOverrides,
  };
  return {
    channelId: 'C1',
    mentionText: 'What is this?',
    threadTs: '100.000',
    userId: 'U9',
    threadContext,
    ...rest,
  };
}

async function collectUserMessages(
  input: string | AsyncIterable<SDKUserMessage>,
): Promise<SDKUserMessage[]> {
  if (typeof input === 'string') {
    return [];
  }
  const out: SDKUserMessage[] = [];
  for await (const m of input) {
    out.push(m);
  }
  return out;
}

describe('buildClaudePromptInput', () => {
  it('returns a plain string prompt for text-only requests', () => {
    const request = baseRequest();
    const result = buildClaudePromptInput(request);
    expect(typeof result).toBe('string');
    expect(result).toBe(buildPrompt(request));
  });

  it('appends image load failure note to the string prompt when all images failed to load', () => {
    const request = baseRequest({
      threadContext: {
        loadedImages: [],
        imageLoadFailures: ['Failed to download Slack image F1 (missing.png): 404'],
      },
    });
    const base = buildPrompt(request);
    const result = buildClaudePromptInput(request);
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') {
      throw new Error('Expected buildClaudePromptInput() to return a string prompt');
    }
    expect(result.startsWith(base)).toBe(true);
    expect(result.length).toBeGreaterThan(base.length);
    expect(result).toContain('Failed to download Slack image F1');
    expect(result.toLowerCase()).toMatch(/could not be loaded|not be loaded/);
  });

  it('returns AsyncIterable<SDKUserMessage> when thread images are present', async () => {
    const request = baseRequest({
      threadContext: {
        loadedImages: [
          {
            authorId: 'U1',
            fileId: 'F1',
            fileName: 'pic.png',
            messageTs: '100.000',
            mimeType: 'image/png',
            slackUrl: 'https://files.example/pic.png',
            base64Data: Buffer.from([137, 80, 78, 71]).toString('base64'),
            messageIndex: 1,
          },
        ],
      },
    });
    const result = buildClaudePromptInput(request);
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
    expect(typeof (result as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]).toBe('function');
    const messages = await collectUserMessages(result);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it('includes buildPrompt(request) in the primary user message', async () => {
    const request = baseRequest({
      mentionText: 'Explain the diagram',
      threadContext: {
        loadedImages: [
          {
            authorId: 'U1',
            fileId: 'F1',
            fileName: 'diagram.png',
            messageTs: '101.000',
            mimeType: 'image/png',
            slackUrl: 'https://files.example/diagram.png',
            base64Data: 'AAAAGG',
            messageIndex: 2,
          },
        ],
      },
    });
    const expectedPrompt = buildPrompt(request);
    const result = buildClaudePromptInput(request);
    expect(typeof result).not.toBe('string');
    const messages = await collectUserMessages(result);
    const primary = messages[0];
    expect(primary?.type).toBe('user');
    expect(primary?.message.role).toBe('user');
    expect(typeof primary?.message.content).toBe('string');
    expect(primary?.message.content).toBe(expectedPrompt);
  });

  it('adds a short note to the primary message when imageLoadFailures exist', async () => {
    const request = baseRequest({
      threadContext: {
        loadedImages: [
          {
            authorId: 'U1',
            fileId: 'F_OK',
            fileName: 'ok.png',
            messageTs: '102.000',
            mimeType: 'image/png',
            slackUrl: 'https://files.example/ok.png',
            base64Data: 'YmFzZTY0',
            messageIndex: 1,
          },
        ],
        imageLoadFailures: ['Failed to download Slack image F_BAD (x.png): 404'],
      },
    });
    const base = buildPrompt(request);
    const result = buildClaudePromptInput(request);
    const messages = await collectUserMessages(result);
    const primary = messages[0];
    expect(typeof primary?.message.content).toBe('string');
    const text = primary?.message.content as string;
    expect(text.startsWith(base)).toBe(true);
    expect(text.length).toBeGreaterThan(base.length);
    expect(text.toLowerCase()).toMatch(/fail|could not|not load|unable/i);
    expect(text).toContain('Failed to download Slack image F_BAD');
  });

  it('yields one follow-up user message per loaded image with text preamble and one image block', async () => {
    const b64 = Buffer.from([255, 216, 255]).toString('base64');
    const request = baseRequest({
      threadContext: {
        loadedImages: [
          {
            authorId: 'U1',
            fileId: 'F_A',
            fileName: 'a.jpeg',
            messageTs: '10.001',
            mimeType: 'image/jpeg',
            slackUrl: 'https://files.example/a.jpeg',
            base64Data: b64,
            messageIndex: 1,
          },
          {
            authorId: 'U2',
            fileId: 'F_B',
            fileName: 'b.png',
            messageTs: '10.002',
            mimeType: 'image/png',
            slackUrl: 'https://files.example/b.png',
            base64Data: 'eGdn',
            messageIndex: 3,
          },
        ],
      },
    });
    const messages = await collectUserMessages(buildClaudePromptInput(request));
    expect(messages).toHaveLength(3);

    const firstFollowUp = messages[1];
    expect(firstFollowUp?.message.role).toBe('user');
    expect(Array.isArray(firstFollowUp?.message.content)).toBe(true);
    const blocks1 = firstFollowUp?.message.content as Array<{
      type: string;
      text?: string;
      source?: unknown;
    }>;
    expect(blocks1).toHaveLength(2);
    expect(blocks1[0]?.type).toBe('text');
    expect(blocks1[0]?.text).toContain('ts=10.001');
    expect(blocks1[0]?.text).toContain('filename: a.jpeg');
    expect(blocks1[0]?.text).not.toMatch(/Message\s+\d+/);
    expect(blocks1[1]?.type).toBe('image');
    expect(blocks1[1]?.source).toMatchObject({
      type: 'base64',
      media_type: 'image/jpeg',
      data: b64,
    });

    const secondFollowUp = messages[2];
    const blocks2 = secondFollowUp?.message.content as Array<{
      type: string;
      source?: { media_type?: string };
    }>;
    expect(blocks2?.[1]?.type).toBe('image');
    expect(blocks2?.[1]?.source).toMatchObject({
      type: 'base64',
      media_type: 'image/png',
    });
  });
});
