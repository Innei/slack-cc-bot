import { cn } from '~/lib/cn';

interface LoadingBlockProps {
  className?: string;
}

export function LoadingBlock({ className }: LoadingBlockProps) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-[color:var(--color-line-subtle)]', className)}
    />
  );
}
