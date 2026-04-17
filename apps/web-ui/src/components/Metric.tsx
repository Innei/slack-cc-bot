import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { Card } from './Card';

interface MetricProps {
  delta?: ReactNode;
  hint?: ReactNode;
  label: ReactNode;
  value: ReactNode;
}

export function Metric({ delta, hint, label, value }: MetricProps) {
  return (
    <Card className="flex flex-col gap-2" padding="md">
      <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-ink-faint)]">
        {label}
      </div>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="text-4xl font-semibold tracking-display-xl text-[color:var(--color-ink)]"
        initial={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
      >
        {value}
      </motion.div>
      {(delta || hint) && (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-ink-subtle)]">
          {delta}
          {hint}
        </div>
      )}
    </Card>
  );
}
