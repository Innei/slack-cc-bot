export interface ChannelPreferenceRecord {
  channelId: string;
  createdAt: string;
  defaultWorkspaceInput: string | undefined;
  updatedAt: string;
}

export interface ChannelPreferenceStore {
  get: (channelId: string) => ChannelPreferenceRecord | undefined;
  upsert: (channelId: string, defaultWorkspaceInput: string | undefined) => ChannelPreferenceRecord;
}
