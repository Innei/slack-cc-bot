import { ArrowUpRight, Cpu, DollarSign, Gauge, Sparkles, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '~/components/Badge';
import { Card } from '~/components/Card';
import { EmptyState } from '~/components/EmptyState';
import { LoadingBlock } from '~/components/LoadingBlock';
import { Metric } from '~/components/Metric';
import { PageHeader } from '~/components/PageHeader';
import {
  formatCount,
  formatDurationMs,
  formatInteger,
  formatPercent,
  formatRelativeTime,
  formatUSD,
} from '~/lib/format';
import { useModelAnalytics, useOverview, useRecentSessions } from '~/lib/queries';

export function OverviewPage() {
  const overview = useOverview();
  const models = useModelAnalytics();
  const sessions = useRecentSessions(8);

  return (
    <>
      <PageHeader
        description="A live window into Kagura's Slack sessions — token usage, cost, and cache efficiency at a glance."
        eyebrow="Operator console"
        title="Overview"
      />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {overview.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <LoadingBlock className="h-32 w-full" key={i} />)
        ) : (
          <>
            <Metric
              hint="threads tracked"
              label="Sessions"
              value={formatCount(overview.data?.totalSessions ?? 0)}
            />
            <Metric
              label="Total spend"
              value={formatUSD(overview.data?.totalCostUSD ?? 0)}
              hint={
                <span className="flex items-center gap-1">
                  <DollarSign className="h-3 w-3" /> lifetime cost
                </span>
              }
            />
            <Metric
              label="Cache hit rate"
              value={formatPercent(overview.data?.cacheHitRate ?? 0)}
              hint={
                <span className="flex items-center gap-1">
                  <Gauge className="h-3 w-3" /> token reuse
                </span>
              }
            />
            <Metric
              label="Avg. duration"
              value={formatDurationMs(overview.data?.avgDurationMs ?? 0)}
              hint={
                <span className="flex items-center gap-1">
                  <Timer className="h-3 w-3" /> per session
                </span>
              }
            />
          </>
        )}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between pb-4">
            <div>
              <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-develop)]">
                Models
              </div>
              <h2 className="text-2xl font-semibold tracking-display-lg">Usage by model</h2>
            </div>
            <Cpu className="h-4 w-4 text-[color:var(--color-ink-faint)]" />
          </div>

          {models.isLoading ? (
            <LoadingBlock className="h-40" />
          ) : (models.data?.length ?? 0) === 0 ? (
            <EmptyState
              description="Once @mentioned sessions start running, per-model token and cost breakdowns appear here."
              icon={Cpu}
              title="No model usage yet"
            />
          ) : (
            <ul className="flex flex-col divide-y divide-[color:var(--color-line)]">
              {(models.data ?? []).map((row) => (
                <li className="flex items-center justify-between gap-4 py-3" key={row.model}>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-mono text-sm text-[color:var(--color-ink)]">
                      {row.model}
                    </span>
                    <span className="text-xs text-[color:var(--color-ink-subtle)]">
                      {formatInteger(row.inputTokens)} in · {formatInteger(row.outputTokens)} out ·{' '}
                      {formatPercent(row.cacheHitRate)} cache
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm font-medium">
                      {formatUSD(row.totalCostUSD)}
                    </div>
                    <Badge className="mt-1" tone="neutral">
                      {formatInteger(row.sessions)} sessions
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between pb-4">
            <div>
              <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-preview)]">
                Recent
              </div>
              <h2 className="text-2xl font-semibold tracking-display-lg">Latest sessions</h2>
            </div>
            <Link
              className="inline-flex items-center gap-1 text-sm no-underline text-[color:var(--color-ink-subtle)] hover:text-[color:var(--color-ink)]"
              to="/sessions"
            >
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {sessions.isLoading ? (
            <LoadingBlock className="h-40" />
          ) : (sessions.data?.length ?? 0) === 0 ? (
            <EmptyState
              description="When a Slack thread triggers a Claude agent, it will show up here with cost and tokens."
              icon={Sparkles}
              title="No sessions yet"
            />
          ) : (
            <ul className="flex flex-col divide-y divide-[color:var(--color-line)]">
              {(sessions.data ?? []).map((row) => (
                <li className="flex items-center justify-between gap-4 py-3" key={row.id}>
                  <Link
                    className="flex min-w-0 flex-col no-underline text-[color:var(--color-ink)] hover:underline"
                    to={`/sessions/${encodeURIComponent(row.threadTs)}`}
                  >
                    <span className="truncate font-mono text-sm">{row.threadTs}</span>
                    <span className="text-xs text-[color:var(--color-ink-subtle)]">
                      {formatRelativeTime(row.createdAt)} · {formatDurationMs(row.durationMs)}
                    </span>
                  </Link>
                  <div className="text-right">
                    <div className="font-mono text-sm">{formatUSD(row.totalCostUSD)}</div>
                    <div className="text-xs text-[color:var(--color-ink-subtle)]">
                      {formatInteger(row.inputTokens)} in · {formatInteger(row.outputTokens)} out
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </>
  );
}
