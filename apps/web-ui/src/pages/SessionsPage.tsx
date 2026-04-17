import { MessageSquareText } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '~/components/Badge';
import { Card } from '~/components/Card';
import { EmptyState } from '~/components/EmptyState';
import { LoadingBlock } from '~/components/LoadingBlock';
import { PageHeader } from '~/components/PageHeader';
import { formatRelativeTime } from '~/lib/format';
import { useSessions } from '~/lib/queries';

export function SessionsPage() {
  const { data, isLoading, isError, error } = useSessions(100);

  return (
    <>
      <PageHeader
        actions={data && <Badge tone="neutral">{data.total} total</Badge>}
        description="Every Slack thread this bot has touched, with its resolved workspace and agent provider."
        eyebrow="Threads"
        title="Sessions"
      />

      {isLoading ? (
        <LoadingBlock className="h-64" />
      ) : isError ? (
        <Card>
          <EmptyState
            description={error instanceof Error ? error.message : 'Request failed.'}
            icon={MessageSquareText}
            title="Could not load sessions"
          />
        </Card>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            description="Mention the bot in a Slack thread to start one. The dashboard updates live."
            icon={MessageSquareText}
            title="No sessions yet"
          />
        </Card>
      ) : (
        <Card padding="sm">
          <div className="overflow-hidden rounded-md">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-[11px] tracking-wide uppercase text-[color:var(--color-ink-faint)]">
                  <th className="px-4 py-3 text-left font-medium">Thread</th>
                  <th className="px-4 py-3 text-left font-medium">Workspace</th>
                  <th className="px-4 py-3 text-left font-medium">Provider</th>
                  <th className="px-4 py-3 text-left font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map((row) => (
                  <tr
                    className="border-t border-[color:var(--color-line)] hover:bg-[color:var(--color-surface-tint)]"
                    key={row.threadTs}
                  >
                    <td className="px-4 py-3 align-top">
                      <Link
                        className="font-mono text-sm no-underline text-[color:var(--color-ink)] hover:underline"
                        to={`/sessions/${encodeURIComponent(row.threadTs)}`}
                      >
                        {row.threadTs}
                      </Link>
                      <div className="mt-1 font-mono text-[11px] text-[color:var(--color-ink-faint)]">
                        {row.channelId}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {row.workspaceLabel ? (
                        <span className="text-sm">{row.workspaceLabel}</span>
                      ) : (
                        <span className="text-sm text-[color:var(--color-ink-faint)]">—</span>
                      )}
                      {row.workspaceSource && (
                        <Badge
                          className="ml-2"
                          tone={row.workspaceSource === 'manual' ? 'preview' : 'develop'}
                        >
                          {row.workspaceSource}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Badge tone={row.agentProvider ? 'ink' : 'neutral'}>
                        {row.agentProvider ?? 'unknown'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 align-top text-[color:var(--color-ink-subtle)]">
                      {formatRelativeTime(row.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
