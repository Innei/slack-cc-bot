import { Loader2, MessageCircle } from 'lucide-react';
import { motion } from 'motion/react';

import { Badge } from '~/components/badge';
import { Card } from '~/components/card';
import { EmptyState } from '~/components/empty-state';
import { useSessions } from '~/hooks/use-api';

const STATUS_VARIANT = {
  active: 'success',
  completed: 'default',
  error: 'error',
} as const;

export function SessionsPage() {
  const { data: sessions, isLoading } = useSessions();

  return (
    <div>
      <motion.div animate={{ opacity: 1, y: 0 }} initial={{ opacity: 0, y: 8 }}>
        <h1
          className="text-[48px] font-semibold text-gray-900"
          style={{ letterSpacing: '-2.4px', lineHeight: '1.17' }}
        >
          Sessions
        </h1>
        <p className="mt-3 text-[20px] leading-relaxed text-gray-600">
          View and manage active and past conversation sessions.
        </p>
      </motion.div>

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-10"
        initial={{ opacity: 0, y: 12 }}
        transition={{ delay: 0.05 }}
      >
        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="size-5 animate-spin text-gray-400" strokeWidth={1.5} />
          </div>
        ) : sessions && sessions.length > 0 ? (
          <div className="flex flex-col gap-3">
            {sessions.map((s) => (
              <Card key={s.id}>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[14px] font-medium text-gray-900 font-mono">{s.id}</p>
                    <p className="mt-1 text-[13px] text-gray-500">
                      #{s.channel} &middot; {s.messageCount} messages
                    </p>
                  </div>
                  <Badge variant={STATUS_VARIANT[s.status]}>{s.status}</Badge>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            description="Sessions will appear here when users interact with the bot in Slack."
            icon={MessageCircle}
            title="No sessions yet"
          />
        )}
      </motion.div>
    </div>
  );
}
