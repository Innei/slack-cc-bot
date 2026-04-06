import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

const VARIANT_STYLES: Record<BadgeVariant, string> = {
  default: 'bg-[var(--color-badge-bg)] text-[var(--color-badge-text)]',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  error: 'bg-red-50 text-red-700',
};

export function Badge({
  children,
  variant = 'default',
}: {
  children: ReactNode;
  variant?: BadgeVariant;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${VARIANT_STYLES[variant]}`}
    >
      {children}
    </span>
  );
}
