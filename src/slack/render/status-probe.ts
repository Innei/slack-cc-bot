export interface SlackStatusProbeRecord {
  channelId: string;
  clear: boolean;
  loadingMessages?: string[];
  recordedAt: string;
  status: string;
  threadTs: string;
}

export interface SlackStatusProbe {
  recordStatus: (record: SlackStatusProbeRecord) => Promise<void>;
}
