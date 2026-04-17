import type { AgentUserInputQuestion } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';

export interface SlackUserInputAnswer {
  annotation?: {
    notes?: string | undefined;
    preview?: string | undefined;
  };
  answer: string;
}

export interface SlackUserInputReplyResult {
  accepted?: boolean | undefined;
  feedback?: string | undefined;
  handled: boolean;
}

interface PendingSlackUserInputQuestion {
  expectedUserId?: string | undefined;
  question: AgentUserInputQuestion;
  reject: (reason?: unknown) => void;
  resolve: (value: SlackUserInputAnswer) => void;
}

export class SlackUserInputBridge {
  private readonly pendingByThread = new Map<string, PendingSlackUserInputQuestion>();

  constructor(private readonly logger: AppLogger) {}

  hasPending(threadTs: string): boolean {
    return this.pendingByThread.has(threadTs);
  }

  async awaitAnswer(params: {
    expectedUserId?: string | undefined;
    question: AgentUserInputQuestion;
    signal?: AbortSignal | undefined;
    threadTs: string;
  }): Promise<SlackUserInputAnswer> {
    if (this.pendingByThread.has(params.threadTs)) {
      throw new Error(`Thread ${params.threadTs} is already waiting for user input.`);
    }

    if (params.signal?.aborted) {
      throw (
        params.signal.reason ??
        new Error(`User input request aborted for thread ${params.threadTs}`)
      );
    }

    return await new Promise<SlackUserInputAnswer>((resolve, reject) => {
      const cleanupAbort = this.attachAbortHandler(params.threadTs, params.signal, reject);

      this.pendingByThread.set(params.threadTs, {
        expectedUserId: params.expectedUserId,
        question: params.question,
        reject: (reason) => {
          cleanupAbort();
          this.pendingByThread.delete(params.threadTs);
          reject(reason);
        },
        resolve: (value) => {
          cleanupAbort();
          this.pendingByThread.delete(params.threadTs);
          resolve(value);
        },
      });
    });
  }

  submitReply(params: {
    text: string;
    threadTs: string;
    userId: string;
  }): SlackUserInputReplyResult {
    const pending = this.pendingByThread.get(params.threadTs);
    if (!pending) {
      return { handled: false };
    }

    if (pending.expectedUserId && pending.expectedUserId !== params.userId) {
      return {
        handled: true,
        feedback: `我正在等待 <@${pending.expectedUserId}> 的回复来继续当前 skill 交互。`,
      };
    }

    const parsed = parseSlackUserInputReply(params.text, pending.question);
    if (!parsed.ok) {
      return {
        handled: true,
        feedback: parsed.error,
      };
    }

    this.logger.info('Accepted Slack user-input reply for thread %s', params.threadTs);
    pending.resolve(parsed.value);
    return {
      accepted: true,
      handled: true,
    };
  }

  private attachAbortHandler(
    threadTs: string,
    signal: AbortSignal | undefined,
    reject: (reason?: unknown) => void,
  ): () => void {
    if (!signal) {
      return () => {};
    }

    const onAbort = () => {
      const pending = this.pendingByThread.get(threadTs);
      if (!pending) {
        return;
      }
      pending.reject(
        signal.reason ?? new Error(`User input request aborted for thread ${threadTs}`),
      );
    };

    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }
}

function parseSlackUserInputReply(
  input: string,
  question: AgentUserInputQuestion,
):
  | {
      ok: true;
      value: SlackUserInputAnswer;
    }
  | {
      error: string;
      ok: false;
    } {
  const text = input.trim();
  if (!text) {
    return {
      ok: false,
      error: buildInvalidReplyMessage(question),
    };
  }

  const rawTokens = question.multiSelect
    ? text
        .split(/[\n,;、，；]+/g)
        .map((token) => token.trim())
        .filter(Boolean)
    : [text];
  const tokens = rawTokens.length > 0 ? rawTokens : [text];
  const selectedOptions: AgentUserInputQuestion['options'] = [];

  for (const token of tokens) {
    const option = findMatchingOption(token, question.options);
    if (!option) {
      if (tokens.length === 1) {
        return {
          ok: true,
          value: {
            answer: text,
          },
        };
      }

      return {
        ok: false,
        error: buildInvalidReplyMessage(question),
      };
    }
    selectedOptions.push(option);
  }

  const deduped = selectedOptions.filter(
    (option, index) =>
      selectedOptions.findIndex((candidate) => candidate.label === option.label) === index,
  );
  const answer = deduped.map((option) => option.label).join(', ');
  const annotation =
    deduped.length === 1 && deduped[0]?.preview
      ? {
          preview: deduped[0].preview,
        }
      : undefined;

  return {
    ok: true,
    value: {
      answer,
      ...(annotation ? { annotation } : {}),
    },
  };
}

function findMatchingOption(
  token: string,
  options: AgentUserInputQuestion['options'],
): AgentUserInputQuestion['options'][number] | undefined {
  const normalizedToken = normalizeToken(token);
  if (!normalizedToken) {
    return undefined;
  }

  const numericIndex = Number.parseInt(normalizedToken, 10);
  if (Number.isInteger(numericIndex) && String(numericIndex) === normalizedToken) {
    return options[numericIndex - 1];
  }

  return options.find((option) => normalizeToken(option.label) === normalizedToken);
}

function normalizeToken(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function buildInvalidReplyMessage(question: AgentUserInputQuestion): string {
  const formatHint = question.multiSelect
    ? '请回复选项编号或标签，多个选项用逗号分隔。'
    : '请回复选项编号或标签。';
  const options = question.options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join('\n');

  return [`没有识别你的回复。${formatHint}`, '', options].join('\n');
}
