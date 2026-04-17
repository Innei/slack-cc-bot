import { Building2 } from 'lucide-react';

import { Badge } from '~/components/Badge';
import { Card } from '~/components/Card';
import { EmptyState } from '~/components/EmptyState';
import { LoadingBlock } from '~/components/LoadingBlock';
import { PageHeader } from '~/components/PageHeader';
import { useWorkspaces } from '~/lib/queries';

export function WorkspacesPage() {
  const { data, isLoading } = useWorkspaces();

  return (
    <>
      <PageHeader
        description="Candidate repositories that Kagura can route sessions into, discovered under REPO_ROOT_DIR."
        eyebrow="Routing"
        title="Workspaces"
      />

      {isLoading ? (
        <LoadingBlock className="h-64" />
      ) : (data?.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            description="Configure REPO_ROOT_DIR in .env. Each git repository under that directory becomes a workspace."
            icon={Building2}
            title="No workspaces discovered"
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {(data ?? []).map((repo) => (
            <Card className="flex flex-col gap-3" key={repo.id} padding="md">
              <div className="flex items-center gap-2">
                <Building2
                  className="h-4 w-4 text-[color:var(--color-ink-faint)]"
                  strokeWidth={1.75}
                />
                <span className="text-base font-semibold tracking-display-md">{repo.label}</span>
              </div>
              <div className="flex flex-col gap-1.5 font-mono text-xs text-[color:var(--color-ink-subtle)]">
                <div>
                  <span className="text-[color:var(--color-ink-faint)]">id: </span>
                  {repo.id}
                </div>
                <div>
                  <span className="text-[color:var(--color-ink-faint)]">path: </span>
                  {repo.relativePath}
                </div>
                <div className="truncate">
                  <span className="text-[color:var(--color-ink-faint)]">abs: </span>
                  {repo.repoPath}
                </div>
              </div>
              {repo.aliases.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {repo.aliases.map((alias) => (
                    <Badge key={alias} tone="neutral">
                      {alias}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
