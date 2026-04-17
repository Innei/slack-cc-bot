const compactFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  notation: 'compact',
});

const integerFormatter = new Intl.NumberFormat('en-US');

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1000) return integerFormatter.format(value);
  return compactFormatter.format(value);
}

export function formatInteger(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return integerFormatter.format(Math.round(value));
}

export function formatUSD(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const digits = value < 1 ? 4 : 2;
  return `$${value.toFixed(digits)}`;
}

export function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remaining}s`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  const diff = Date.now() - parsed.getTime();
  const absSeconds = Math.abs(diff / 1000);
  const units: Array<[number, string]> = [
    [60, 'sec'],
    [60 * 60, 'min'],
    [60 * 60 * 24, 'hr'],
    [60 * 60 * 24 * 30, 'd'],
    [60 * 60 * 24 * 365, 'mo'],
  ];
  for (const [seconds, label] of units) {
    if (absSeconds < seconds) {
      const size = Math.max(1, Math.round(absSeconds / (seconds / (label === 'sec' ? 1 : 60))));
      const suffix = diff >= 0 ? 'ago' : 'from now';
      return `${size} ${label} ${suffix}`;
    }
  }
  return parsed.toLocaleDateString();
}
