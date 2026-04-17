import type { ReactNode } from 'react';

import { cn } from '~/lib/cn';

type Tone = 'blue' | 'ink' | 'ship' | 'preview' | 'develop' | 'neutral';

const toneStyles: Record<Tone, string> = {
  blue: 'bg-[color:var(--color-badge-bg)] text-[color:var(--color-badge-fg)]',
  develop: 'bg-[#e6f0fe] text-[color:var(--color-develop)]',
  ink: 'bg-[color:var(--color-ink)] text-white',
  neutral: 'bg-[color:var(--color-line-subtle)] text-[color:var(--color-ink-subtle)]',
  preview: 'bg-[#fce4f1] text-[color:var(--color-preview)]',
  ship: 'bg-[#ffe1de] text-[color:var(--color-ship)]',
};

interface BadgeProps {
  children: ReactNode;
  className?: string;
  tone?: Tone;
}

export function Badge({ children, className, tone = 'blue' }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        toneStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
