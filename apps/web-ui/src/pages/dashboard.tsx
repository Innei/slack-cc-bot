import { Activity, Clock, MessageSquare, Zap } from 'lucide-react';
import { motion } from 'motion/react';

import { Badge } from '~/components/badge';
import { Card, CardDescription, CardTitle } from '~/components/card';
import { MetricCard } from '~/components/metric-card';

const PIPELINE_STEPS = [
  { label: 'Mention', color: 'var(--color-accent-develop)', icon: MessageSquare },
  { label: 'Process', color: 'var(--color-accent-preview)', icon: Zap },
  { label: 'Reply', color: 'var(--color-accent-ship)', icon: Activity },
] as const;

export function DashboardPage() {
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
        className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        <MetricCard description="Currently running" label="Active Sessions" value={0} />
        <MetricCard description="Processed since midnight" label="Messages Today" value={0} />
        <MetricCard description="Median latency" label="Avg Response" value="--" />
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
          Recent Activity
        </h2>
        <div className="mt-6">
          <Card>
            <div className="flex items-center justify-center py-10 text-center">
              <div>
                <Clock className="mx-auto size-5 text-gray-400" strokeWidth={1.5} />
                <p className="mt-3 text-[14px] text-gray-500">No recent activity</p>
                <Badge>Waiting for events</Badge>
              </div>
            </div>
          </Card>
        </div>
      </motion.div>
    </div>
  );
}
