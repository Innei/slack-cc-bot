import { MessageCircle } from 'lucide-react';
import { motion } from 'motion/react';

import { EmptyState } from '~/components/empty-state';

export function SessionsPage() {
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
        <EmptyState
          description="Sessions will appear here when users interact with the bot in Slack."
          icon={MessageCircle}
          title="No sessions yet"
        />
      </motion.div>
    </div>
  );
}
