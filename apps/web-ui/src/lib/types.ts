export interface BotStatus {
  activeSessionCount: number;
  avgResponseMs: number | null;
  connected: boolean;
  messagesToday: number;
  uptime: number | null;
}

export interface Session {
  channel: string;
  createdAt: string;
  id: string;
  messageCount: number;
  status: 'active' | 'completed' | 'error';
  threadTs: string;
  updatedAt: string;
  user: string;
}

export interface Workspace {
  branch: string | null;
  name: string;
  path: string;
  repo: string | null;
}

export interface AppSettings {
  claudeMaxTurns: number;
  claudeModel: string;
  logLevel: string;
  repoRootDir: string;
  repoScanDepth: number;
  slackConnected: boolean;
}
