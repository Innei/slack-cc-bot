export interface SlackReactionsApi {
  add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
}

export interface SlackAssistantThreadsApi {
  setStatus: (args: {
    channel_id: string;
    thread_ts: string;
    status: string;
    loading_messages?: string[];
  }) => Promise<unknown>;
}

export interface SlackAssistantApi {
  threads: SlackAssistantThreadsApi;
}

export interface SlackConversationsApi {
  replies: (args: {
    channel: string;
    ts: string;
    inclusive?: boolean;
    limit?: number;
  }) => Promise<{ messages?: unknown[] }>;
}

export interface SlackChatStreamStartResult {
  ts?: string;
}

export interface SlackMarkdownTextChunk {
  text: string;
  type: 'markdown_text';
}

export interface SlackTaskUpdateChunk {
  details?: string;
  id: string;
  output?: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  title: string;
  type: 'task_update';
}

export interface SlackPlanUpdateChunk {
  title: string;
  type: 'plan_update';
}

export type SlackStreamChunk = SlackMarkdownTextChunk | SlackTaskUpdateChunk | SlackPlanUpdateChunk;

export interface SlackChatApi {
  appendStream: (args: {
    channel: string;
    ts: string;
    markdown_text?: string;
    chunks?: SlackStreamChunk[];
  }) => Promise<unknown>;
  postMessage: (args: {
    channel: string;
    text: string;
    thread_ts?: string;
  }) => Promise<{ ts?: string }>;
  startStream: (args: {
    channel: string;
    thread_ts: string;
    recipient_team_id: string;
    recipient_user_id: string;
    task_display_mode?: 'plan';
  }) => Promise<SlackChatStreamStartResult>;
  stopStream: (args: {
    channel: string;
    ts: string;
    thread_ts?: string;
    markdown_text?: string;
  }) => Promise<unknown>;
}

export interface SlackWebClientLike {
  assistant: SlackAssistantApi;
  chat: SlackChatApi;
  conversations: SlackConversationsApi;
  reactions: SlackReactionsApi;
}
