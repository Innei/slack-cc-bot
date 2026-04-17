import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { assemblePrompt } from '~/agent/prompt/index.js';
import { createClaudePromptInput } from '~/agent/providers/claude-code/prompt-input.js';
import type { AgentExecutionRequest } from '~/agent/types.js';

function baseRequest(
  overrides: Omit<Partial<AgentExecutionRequest>, 'threadContext'> & {
    threadContext?: Partial<AgentExecutionRequest['threadContext']>;
  } = {},
): AgentExecutionRequest {
  const threadDefaults: AgentExecutionRequest['threadContext'] = {
    channelId: 'C1',
    fileLoadFailures: [],
    loadedFiles: [],
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

describe('prompt assembly', () => {
  describe('system prompt stability', () => {
    it('produces identical system prompts for different threads', () => {
      const req1 = baseRequest({ channelId: 'C1', threadTs: '100.000' });
      const req2 = baseRequest({ channelId: 'C2', threadTs: '200.000' });
      const { systemPrompt: sp1 } = assemblePrompt(req1);
      const { systemPrompt: sp2 } = assemblePrompt(req2);
      expect(sp1).toBe(sp2);
    });

    it('produces identical system prompts with and without memories', () => {
      const reqNoMemory = baseRequest();
      const reqWithMemory = baseRequest({
        contextMemories: {
          global: [
            {
              id: '1',
              category: 'context',
              content: 'some memory',
              createdAt: '2026-01-01',
              scope: 'global',
            },
          ],
          workspace: [],
          preferences: [
            {
              id: '2',
              category: 'preference',
              content: 'use Chinese',
              createdAt: '2026-01-01',
              scope: 'global',
            },
          ],
        },
      });
      const { systemPrompt: sp1 } = assemblePrompt(reqNoMemory);
      const { systemPrompt: sp2 } = assemblePrompt(reqWithMemory);
      expect(sp1).toBe(sp2);
    });

    it('produces identical system prompts with and without workspace', () => {
      const reqNoWorkspace = baseRequest();
      const reqWithWorkspace = baseRequest({
        workspacePath: '/repos/my-project',
        workspaceLabel: 'my-project',
        workspaceRepoId: 'repo-123',
      });
      const { systemPrompt: sp1 } = assemblePrompt(reqNoWorkspace);
      const { systemPrompt: sp2 } = assemblePrompt(reqWithWorkspace);
      expect(sp1).toBe(sp2);
    });

    it('produces identical system prompts for new vs resume sessions', () => {
      const reqNew = baseRequest();
      const reqResume = baseRequest({ resumeHandle: 'session-abc' });
      const { systemPrompt: sp1 } = assemblePrompt(reqNew);
      const { systemPrompt: sp2 } = assemblePrompt(reqResume);
      expect(sp1).toBe(sp2);
    });

    it('advertises Slack attachment read/write capability to the model', () => {
      const { systemPrompt } = assemblePrompt(baseRequest());

      expect(systemPrompt).toContain('Slack attachment capabilities:');
      expect(systemPrompt).toContain(
        'Supported Slack text/code files attached in the thread are downloaded and included in your context when available.',
      );
      expect(systemPrompt).toContain(
        'Use upload_slack_file after creating a local file that must be delivered into Slack.',
      );
      expect(systemPrompt).toContain(
        'you must actually create and save the file locally, then call upload_slack_file; a text-only reply is not sufficient.',
      );
      expect(systemPrompt).toContain(
        'Do not claim that you cannot upload files or images to Slack when this flow applies.',
      );
    });

    it('instructs the model to use AskUserQuestion for confirmation instead of assuming user consent', () => {
      const { systemPrompt } = assemblePrompt(baseRequest());

      expect(systemPrompt).toContain('AskUserQuestion: pause and ask the Slack user');
      expect(systemPrompt).toContain(
        'If you need confirmation, approval, disambiguation, or a choice from the user, you MUST use AskUserQuestion instead of assuming an answer.',
      );
      expect(systemPrompt).toContain(
        'Never say or imply that the user already confirmed unless that confirmation is present in the thread context or returned by AskUserQuestion.',
      );
    });
  });

  describe('user prompt construction', () => {
    it('returns assembled user text for text-only requests', () => {
      const request = baseRequest();
      const { userText } = assemblePrompt(request);
      expect(typeof userText).toBe('string');
    });

    it('includes session context with channel and thread', () => {
      const request = baseRequest({ channelId: 'C42', threadTs: '999.000' });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('channel C42');
      expect(userText).toContain('thread 999.000');
    });

    it('includes workspace info in context when set', () => {
      const request = baseRequest({
        workspacePath: '/repos/my-project',
        workspaceLabel: 'my-project',
        workspaceRepoId: 'repo-123',
      });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('/repos/my-project');
      expect(userText).toContain('my-project');
    });

    it('includes memory context when memories exist', () => {
      const request = baseRequest({
        contextMemories: {
          global: [],
          workspace: [],
          preferences: [
            {
              id: '1',
              category: 'preference',
              content: 'Always reply in Chinese',
              createdAt: '2026-01-01',
              scope: 'global',
            },
          ],
        },
      });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('Always reply in Chinese');
      expect(userText).toContain('<conversation_memory>');
    });

    it('includes thread context for new sessions', () => {
      const request = baseRequest({
        threadContext: {
          messages: [
            {
              text: 'hello',
              ts: '100.000',
              authorId: 'U1',
              files: [],
              images: [],
              rawText: 'hello',
              threadTs: '100.000',
            },
          ],
          renderedPrompt: 'Message 1 | ts=100.000 | author=U1\nhello',
        },
      });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('<thread_context>');
      expect(userText).toContain('Message 1 | ts=100.000');
    });

    it('skips full thread context for resume sessions without a cursor', () => {
      const request = baseRequest({
        resumeHandle: 'session-abc',
        threadContext: {
          messages: [
            {
              text: 'hello',
              ts: '100.000',
              authorId: 'U1',
              files: [],
              images: [],
              rawText: 'hello',
              threadTs: '100.000',
            },
          ],
          renderedPrompt: 'Message 1 | ts=100.000 | author=U1\nhello',
        },
      });
      const { userText } = assemblePrompt(request);
      expect(userText).not.toContain('<thread_context>');
      expect(userText).not.toContain('<slack_transcript_since_last_turn>');
    });

    it('injects incremental slack transcript on resume when a cursor is set', () => {
      const request = baseRequest({
        resumeHandle: 'session-abc',
        previousTurnTriggerTs: '100.000',
        currentTriggerTs: '300.000',
        threadContext: {
          messages: [
            {
              text: 'earlier user turn (already in SDK history)',
              ts: '100.000',
              authorId: 'U1',
              files: [],
              images: [],
              rawText: 'earlier user turn (already in SDK history)',
              threadTs: '100.000',
            },
            {
              text: 'bot reply visible in Slack between turns',
              ts: '200.000',
              authorId: 'B_BOT',
              files: [],
              images: [],
              rawText: 'bot reply visible in Slack between turns',
              threadTs: '100.000',
            },
            {
              text: 'follow-up user message (current trigger)',
              ts: '300.000',
              authorId: 'U1',
              files: [],
              images: [],
              rawText: 'follow-up user message (current trigger)',
              threadTs: '100.000',
            },
          ],
          renderedPrompt: 'should be ignored on resume',
        },
      });
      const { userText } = assemblePrompt(request);

      expect(userText).not.toContain('<thread_context>');
      expect(userText).toContain('<slack_transcript_since_last_turn>');
      expect(userText).toContain('bot reply visible in Slack between turns');
      expect(userText).not.toContain('earlier user turn (already in SDK history)');
      expect(userText).not.toContain('follow-up user message (current trigger)');
    });

    it('omits transcript block on resume when no messages have appeared since the cursor', () => {
      const request = baseRequest({
        resumeHandle: 'session-abc',
        previousTurnTriggerTs: '200.000',
        currentTriggerTs: '300.000',
        threadContext: {
          messages: [
            {
              text: 'current trigger',
              ts: '300.000',
              authorId: 'U1',
              files: [],
              images: [],
              rawText: 'current trigger',
              threadTs: '100.000',
            },
          ],
          renderedPrompt: 'should be ignored on resume',
        },
      });
      const { userText } = assemblePrompt(request);
      expect(userText).not.toContain('<thread_context>');
      expect(userText).not.toContain('<slack_transcript_since_last_turn>');
    });

    it('includes user message in <user_message> tags', () => {
      const request = baseRequest({ mentionText: 'Explain the code' });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('<user_message>');
      expect(userText).toContain('Explain the code');
      expect(userText).toContain('</user_message>');
    });

    it('includes user ID for new sessions but not resume', () => {
      const reqNew = baseRequest({ userId: 'U42', mentionText: 'hi' });
      const reqResume = baseRequest({ userId: 'U42', mentionText: 'hi', resumeHandle: 'sess' });
      const { userText: newPrompt } = assemblePrompt(reqNew);
      const { userText: resumePrompt } = assemblePrompt(reqResume);
      expect(newPrompt).toContain('From <@U42>');
      expect(resumePrompt).not.toContain('From <@U42>');
    });

    it('includes loaded thread files in the user prompt as structured context', () => {
      const request = baseRequest({
        threadContext: {
          loadedFiles: [
            {
              authorId: 'U1',
              content: 'export const answer = 42;\n',
              fileId: 'F_FILE',
              fileName: 'answer.ts',
              messageIndex: 1,
              messageTs: '100.100',
              mimeType: 'application/typescript',
              slackUrl: 'https://files.example/answer.ts',
              truncated: false,
            },
          ],
        },
      });

      const { userText } = assemblePrompt(request);
      expect(userText).toContain('<thread_files>');
      expect(userText).toContain('filename=answer.ts');
      expect(userText).toContain('export const answer = 42;');
    });

    it('includes thread file load failures in the user prompt', () => {
      const request = baseRequest({
        threadContext: {
          fileLoadFailures: [
            'Failed to download Slack file F_BAD (blob.txt): not a supported text/code file',
          ],
        },
      });

      const { userText } = assemblePrompt(request);
      expect(userText).toContain('<thread_file_load_failures>');
      expect(userText).toContain('Failed to download Slack file F_BAD');
    });
  });

  describe('Claude provider prompt adaptation', () => {
    it('appends image load failure note to the assembled user text when all images failed to load', () => {
      const request = baseRequest({
        threadContext: {
          loadedImages: [],
          imageLoadFailures: ['Failed to download Slack image F1 (missing.png): 404'],
        },
      });
      const { userText } = assemblePrompt(request);
      expect(userText).toContain('Failed to download Slack image F1');
      expect(userText.toLowerCase()).toMatch(/could not be loaded|not be loaded/);
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
      const { userPrompt } = createClaudePromptInput(request);
      expect(typeof userPrompt).toBe('object');
      expect(typeof (userPrompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]).toBe(
        'function',
      );
      const messages = await collectUserMessages(userPrompt);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    });

    it('includes assembled prompt in the primary user message', async () => {
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
      const { userPrompt } = createClaudePromptInput(request);
      const messages = await collectUserMessages(userPrompt);
      const primary = messages[0];
      expect(primary?.type).toBe('user');
      expect(primary?.message.role).toBe('user');
      expect(typeof primary?.message.content).toBe('string');
      expect(primary?.message.content as string).toContain('Explain the diagram');
      expect(primary?.message.content as string).toContain('<session_context>');
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
      const { userPrompt } = createClaudePromptInput(request);
      const messages = await collectUserMessages(userPrompt);
      const primary = messages[0];
      expect(typeof primary?.message.content).toBe('string');
      const text = primary?.message.content as string;
      expect(text.toLowerCase()).toMatch(/fail|could not|not load|unable/i);
      expect(text).toContain('Failed to download Slack image F_BAD');
    });

    it('yields one follow-up user message per loaded image', async () => {
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
      const { userPrompt } = createClaudePromptInput(request);
      const messages = await collectUserMessages(userPrompt);
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
});
