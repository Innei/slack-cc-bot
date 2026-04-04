interface SlackApiSuccessResponse {
  ok: true;
  response_metadata?: {
    warnings?: string[];
  };
}

interface SlackApiErrorResponse {
  error: string;
  ok: false;
}

type SlackApiResponse<T> = SlackApiSuccessResponse & T;

export interface SlackAuthTestResponse {
  team: string;
  team_id: string;
  url: string;
  user: string;
  user_id: string;
}

export interface SlackPostedMessageResponse {
  channel: string;
  message?: {
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  };
  ts: string;
}

export interface SlackConversationRepliesResponse {
  has_more?: boolean;
  messages?: Array<{
    blocks?: Array<{
      block_id?: string;
      elements?: Array<Record<string, unknown>>;
      type?: string;
    }>;
    bot_id?: string;
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  }>;
}

export class SlackApiClient {
  constructor(private readonly token: string) {}

  async authTest(): Promise<SlackAuthTestResponse> {
    return this.call<SlackAuthTestResponse>('auth.test', undefined, 'GET');
  }

  async postMessage(args: {
    channel: string;
    text: string;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  }): Promise<SlackPostedMessageResponse> {
    return this.call<SlackPostedMessageResponse>('chat.postMessage', args, 'POST');
  }

  async conversationReplies(args: {
    channel: string;
    inclusive?: boolean;
    limit?: number;
    ts: string;
  }): Promise<SlackConversationRepliesResponse> {
    return this.call<SlackConversationRepliesResponse>('conversations.replies', args, 'GET');
  }

  private async call<T extends object>(
    method: string,
    params?: Record<string, unknown>,
    httpMethod: 'GET' | 'POST' = 'POST',
  ): Promise<SlackApiResponse<T>> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) {
        continue;
      }

      searchParams.set(key, String(value));
    }

    const url =
      httpMethod === 'GET' && searchParams.size > 0
        ? `https://slack.com/api/${method}?${searchParams.toString()}`
        : `https://slack.com/api/${method}`;

    const response = await this.fetchWithRetry(url, {
      method: httpMethod,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(httpMethod === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }
          : {}),
      },
      ...(httpMethod === 'POST' ? { body: searchParams.toString() } : {}),
    });

    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as SlackApiResponse<T> | SlackApiErrorResponse;
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`);
    }

    return data;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await fetch(url, init);
      } catch (error) {
        lastError = error;
        if (attempt === 3) {
          break;
        }

        await delay(500 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
