import { redact } from '~/logger/redact.js';

export function formatClaudeExecutionFailureReply(error: unknown): string {
  const detail = formatVisibleErrorDetail(error);
  if (!detail) {
    return 'Claude execution failed. No error detail was provided.';
  }

  return `Claude execution failed: ${detail}`;
}

export function formatVisibleErrorDetail(error: unknown, maxLength = 300): string {
  const normalized = redact(error instanceof Error ? error.message : String(error ?? ''))
    .replaceAll(/sk-ant-[\w-]+/g, '[REDACTED]')
    .replaceAll(/bearer\s+[\w+./~-]+=*/gi, 'Bearer [REDACTED]')
    .trim()
    .replaceAll(/\s+/g, ' ');

  if (!normalized || normalized === '[REDACTED]') {
    return normalized;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
