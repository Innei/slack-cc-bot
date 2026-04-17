import type { ReactNode } from 'react';

interface PageHeaderProps {
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}

export function PageHeader({ actions, description, eyebrow, title }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-3 border-b border-[color:var(--color-line)] pb-8">
      {eyebrow && (
        <div className="font-mono text-xs tracking-wide uppercase text-[color:var(--color-develop)]">
          {eyebrow}
        </div>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-semibold tracking-display-xl text-[color:var(--color-ink)]">
            {title}
          </h1>
          {description && (
            <p className="max-w-2xl text-base text-[color:var(--color-ink-subtle)]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
