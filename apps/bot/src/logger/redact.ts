import { env } from '~/env/server.js';

const SECRET_VALUES = [env.SLACK_BOT_TOKEN, env.SLACK_APP_TOKEN, env.SLACK_SIGNING_SECRET].filter(
  (v): v is string => typeof v === 'string' && v.length >= 8,
);

export function redact(value: string): string {
  let result = value;
  for (const secret of SECRET_VALUES) {
    result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
}

export function createRedactor(secrets: string[]): (value: string) => string {
  const filtered = secrets.filter((s) => s && s.length >= 8);

  if (filtered.length === 0) {
    return (value) => value;
  }

  const pattern = new RegExp(
    filtered.map((s) => s.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')).join('|'),
    'g',
  );

  return (value: string) => value.replace(pattern, '[REDACTED]');
}
