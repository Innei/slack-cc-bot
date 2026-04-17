import { ArrowLeft, MessageSquareText } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import { Badge } from '~/components/Badge';
import { Card } from '~/components/Card';
import { EmptyState } from '~/components/EmptyState';
import { LoadingBlock } from '~/components/LoadingBlock';
import { PageHeader } from '~/components/PageHeader';
import { formatRelativeTime } from '~/lib/format';
import { useSession } from '~/lib/queries';

export function SessionDetailPage() {
  const params = useParams<{ threadTs: string }>();
  const threadTs = params.threadTs;
  const { data, isLoading, isError, error } = useSession(threadTs);

  return (
    <>
      <PageHeader
        description="Details for a single Slack thread's persisted session record."
        eyebrow="Session"
        title={threadTs ?? '—'}
        actions={
          <Link
            className="inline-flex items-center gap-1.5 text-sm no-underline text-[color:var(--color-ink-subtle)] hover:text-[color:var(--color-ink)]"
            to="/sessions"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Link>
        }
      />

      {isLoading ? (
        <LoadingBlock className="h-64" />
      ) : isError ? (
        <Card>
          <EmptyState
            description={error instanceof Error ? error.message : 'Request failed.'}
            icon={MessageSquareText}
            title="Could not load session"
          />
        </Card>
      ) : !data ? null : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DetailRow label="Thread" value={<Mono>{data.threadTs}</Mono>} />
          <DetailRow label="Channel" value={<Mono>{data.channelId}</Mono>} />
          <DetailRow label="Root message" value={<Mono>{data.rootMessageTs}</Mono>} />
          <DetailRow
            label="Bootstrap msg"
            value={data.bootstrapMessageTs ? <Mono>{data.bootstrapMessageTs}</Mono> : <Dim>—</Dim>}
          />
          <DetailRow
            label="Stream msg"
            value={data.streamMessageTs ? <Mono>{data.streamMessageTs}</Mono> : <Dim>—</Dim>}
          />
          <DetailRow
            label="Provider"
            value={
              <Badge tone={data.agentProvider ? 'ink' : 'neutral'}>
                {data.agentProvider ?? 'unknown'}
              </Badge>
            }
          />
          <DetailRow
            label="Provider session"
            value={data.providerSessionId ? <Mono>{data.providerSessionId}</Mono> : <Dim>—</Dim>}
          />
          <DetailRow label="Workspace" value={data.workspaceLabel ?? '—'} />
          <DetailRow
            label="Workspace path"
            value={data.workspacePath ? <Mono>{data.workspacePath}</Mono> : <Dim>—</Dim>}
          />
          <DetailRow
            label="Workspace source"
            value={
              data.workspaceSource ? (
                <Badge tone={data.workspaceSource === 'manual' ? 'preview' : 'develop'}>
                  {data.workspaceSource}
                </Badge>
              ) : (
                <Dim>—</Dim>
              )
            }
          />
          <DetailRow label="Created" value={formatRelativeTime(data.createdAt)} />
          <DetailRow label="Updated" value={formatRelativeTime(data.updatedAt)} />
        </div>
      )}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-2" padding="sm">
      <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <div className="text-sm text-[color:var(--color-ink)]">{value}</div>
    </Card>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-sm break-all">{children}</span>;
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[color:var(--color-ink-faint)]">{children}</span>;
}
