import type { LucideIcon } from 'lucide-react';

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div
        className="flex size-12 items-center justify-center rounded-xl"
        style={{ boxShadow: 'var(--shadow-card)' }}
      >
        <Icon className="size-5 text-gray-400" strokeWidth={1.5} />
      </div>
      <h3
        className="mt-4 text-[20px] font-semibold text-gray-900"
        style={{ letterSpacing: '-0.96px' }}
      >
        {title}
      </h3>
      <p className="mt-1.5 max-w-sm text-[14px] text-gray-500">{description}</p>
    </div>
  );
}
