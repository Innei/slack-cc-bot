import { Card } from './card';

export function MetricCard({
  label,
  value,
  description,
}: {
  label: string;
  value: string | number;
  description?: string;
}) {
  return (
    <Card>
      <p className="text-[12px] font-medium uppercase tracking-wide text-gray-500 font-mono">
        {label}
      </p>
      <p
        className="mt-2 text-[48px] font-semibold text-gray-900"
        style={{ letterSpacing: '-2.4px', lineHeight: '1' }}
      >
        {value}
      </p>
      {description && <p className="mt-2 text-[14px] text-gray-500">{description}</p>}
    </Card>
  );
}
