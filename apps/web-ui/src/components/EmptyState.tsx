import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  description?: ReactNode;
  icon?: LucideIcon;
  title: ReactNode;
}

export function EmptyState({ description, icon: Icon, title }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      {Icon && (
        <div className="shadow-ring-light flex h-10 w-10 items-center justify-center rounded-full bg-[color:var(--color-surface-tint)] text-[color:var(--color-ink-faint)]">
          <Icon className="h-5 w-5" strokeWidth={1.5} />
        </div>
      )}
      <div className="text-sm font-medium text-[color:var(--color-ink)]">{title}</div>
      {description && (
        <div className="max-w-md text-sm text-[color:var(--color-ink-subtle)]">{description}</div>
      )}
    </div>
  );
}
