export interface SlackStatusProbeStatusRecord {
  channelId: string;
  clear: boolean;
  kind: 'status';
  loadingMessages?: string[];
  recordedAt: string;
  status: string;
  threadTs: string;
}

export interface SlackStatusProbeProgressRecord {
  action: 'post' | 'update' | 'delete' | 'finalize' | 'stopped';
  channelId: string;
  kind: 'progress-message';
  messageTs?: string;
  recordedAt: string;
  text?: string;
  threadTs: string;
}

export type SlackStatusProbeRecord = SlackStatusProbeStatusRecord | SlackStatusProbeProgressRecord;

export interface SlackStatusProbe {
  recordProgressMessage: (record: SlackStatusProbeProgressRecord) => Promise<void>;
  recordStatus: (record: SlackStatusProbeStatusRecord) => Promise<void>;
}
