import { Loader2 } from 'lucide-react';

import { Card } from './card';

export function MetricCard({
  label,
  value,
  description,
  loading,
}: {
  label: string;
  value: string | number;
  description?: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <p className="text-[12px] font-medium uppercase tracking-wide text-gray-500 font-mono">
        {label}
      </p>
      {loading ? (
        <Loader2 className="mt-3 size-6 animate-spin text-gray-300" strokeWidth={1.5} />
      ) : (
        <p
          className="mt-2 text-[48px] font-semibold text-gray-900"
          style={{ letterSpacing: '-2.4px', lineHeight: '1' }}
        >
          {value}
        </p>
      )}
      {description && <p className="mt-2 text-[14px] text-gray-500">{description}</p>}
    </Card>
  );
}
