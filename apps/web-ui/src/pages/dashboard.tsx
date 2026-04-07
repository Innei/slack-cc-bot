import { Activity, Clock, Loader2, MessageSquare, Zap } from 'lucide-react';
import { motion } from 'motion/react';

import { Badge } from '~/components/badge';
import { Card, CardDescription, CardTitle } from '~/components/card';
import { MetricCard } from '~/components/metric-card';
import { useStatus } from '~/hooks/use-api';

const PIPELINE_STEPS = [
  { label: 'Mention', color: 'var(--color-accent-develop)', icon: MessageSquare },
  { label: 'Process', color: 'var(--color-accent-preview)', icon: Zap },
  { label: 'Reply', color: 'var(--color-accent-ship)', icon: Activity },
] as const;

function formatUptime(ms: number | null): string {
  if (ms == null) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function DashboardPage() {
  const { data: status, isLoading } = useStatus();

  return (
    <div>
      <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 8 }}>
        <h1
          className="text-[48px] font-semibold text-gray-900"
          style={{ letterSpacing: '-2.4px', lineHeight: '1.17' }}
        >
          Dashboard
        </h1>
        <p className="mt-3 text-[20px] leading-relaxed text-gray-600">
          Monitor your Slack bot activity and performance.
        </p>
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        <MetricCard
          description={status?.connected ? 'Online' : 'Offline'}
          label="Status"
          loading={isLoading}
          value={status?.connected ? 'Up' : 'Down'}
        />
        <MetricCard
          description="Active sessions"
          label="Sessions"
          loading={isLoading}
          value={status?.activeSessionCount ?? 0}
        />
        <MetricCard
          description="Processed today"
          label="Messages"
          loading={isLoading}
          value={status?.messagesToday ?? 0}
        />
        <MetricCard
          label="Latency"
          loading={isLoading}
          value={status?.avgResponseMs != null ? `${status.avgResponseMs}ms` : '--'}
          description={
            status?.avgResponseMs != null ? `${status.avgResponseMs}ms median` : 'No data'
          }
        />
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.1 }}
      >
        <h2
          className="text-[32px] font-semibold text-gray-900"
          style={{ letterSpacing: '-1.28px', lineHeight: '1.25' }}
        >
          Pipeline
        </h2>
        <p className="mt-2 text-[16px] text-gray-600">How messages flow through the bot.</p>

        <div className="mt-6 flex flex-col items-stretch gap-4 sm:flex-row">
          {PIPELINE_STEPS.map((step, i) => (
            <Card className="flex-1" key={step.label}>
              <div className="flex items-center gap-3">
                <span
                  className="text-[12px] font-medium uppercase font-mono"
                  style={{ color: step.color, letterSpacing: '0.05em' }}
                >
                  {`0${i + 1}`}
                </span>
                <step.icon className="size-4" strokeWidth={1.5} style={{ color: step.color }} />
              </div>
              <CardTitle>{step.label}</CardTitle>
              <CardDescription>
                {i === 0 && 'User @mentions the bot in a Slack channel or thread.'}
                {i === 1 && 'Message is routed through the conversation pipeline to Claude.'}
                {i === 2 && 'Agent response is streamed back to the Slack thread.'}
              </CardDescription>
            </Card>
          ))}
        </div>
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.15 }}
      >
        <h2
          className="text-[32px] font-semibold text-gray-900"
          style={{ letterSpacing: '-1.28px', lineHeight: '1.25' }}
        >
          Uptime
        </h2>
        <div className="mt-6">
          <Card>
            <div className="flex items-center justify-center py-10 text-center">
              {isLoading ? (
                <Loader2 className="mx-auto size-5 animate-spin text-gray-400" strokeWidth={1.5} />
              ) : (
                <div>
                  <Clock className="mx-auto size-5 text-gray-400" strokeWidth={1.5} />
                  <p className="mt-3 text-[14px] text-gray-500">
                    {formatUptime(status?.uptime ?? null)}
                  </p>
                  <Badge>{status?.connected ? 'Connected' : 'Disconnected'}</Badge>
                </div>
              )}
            </div>
          </Card>
        </div>
      </motion.div>
    </div>
  );
}
