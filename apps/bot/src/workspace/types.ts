export type WorkspaceSource = 'auto' | 'manual';

export interface WorkspaceRepo {
  aliases: string[];
  id: string;
  label: string;
  name: string;
  relativePath: string;
  repoPath: string;
}

export interface ResolvedWorkspace {
  input: string;
  matchKind: 'path' | 'repo';
  repo: WorkspaceRepo;
  source: WorkspaceSource;
  workspaceLabel: string;
  workspacePath: string;
}

export type WorkspaceResolution =
  | {
      status: 'unique';
      workspace: ResolvedWorkspace;
    }
  | {
      candidates: WorkspaceRepo[];
      query: string;
      reason: string;
      status: 'ambiguous';
    }
  | {
      query: string;
      reason: string;
      status: 'missing';
    };
