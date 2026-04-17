import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '~/lib/cn';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: 'sm' | 'md' | 'lg';
}

export function Card({ children, className, padding = 'md', ...rest }: CardProps) {
  const paddingClass = padding === 'sm' ? 'p-4' : padding === 'lg' ? 'p-8' : 'p-6';

  return (
    <div
      className={cn(
        'shadow-card rounded-lg bg-[color:var(--color-surface)]',
        paddingClass,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
