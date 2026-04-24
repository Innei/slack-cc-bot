import { env } from '~/env/server.js';

const REDACTED = '[REDACTED]';

const SECRET_VALUES = [
  env.SLACK_BOT_TOKEN,
  env.SLACK_BOT_2_TOKEN,
  env.SLACK_APP_TOKEN,
  env.SLACK_APP_2_TOKEN,
  env.SLACK_SIGNING_SECRET,
  env.SLACK_SIGNING_2_SECRET,
  env.SLACK_CONFIG_TOKEN,
  env.SLACK_CONFIG_REFRESH_TOKEN,
  env.SLACK_E2E_TRIGGER_USER_TOKEN,
].filter((v): v is string => typeof v === 'string' && v.length >= 8);

const SECRET_PATTERNS = [
  /\bbearer\s+xoxe(?:\.xoxp)?-[\da-z-]+/gi,
  /\bbearer\s+xox[aboprs]-[\da-z-]+/gi,
  /\bbearer\s+xapp-[\da-z-]+/gi,
  /\btoken=xoxe(?:\.xoxp)?-[\da-z-]+/gi,
  /\btoken=xox[aboprs]-[\da-z-]+/gi,
  /\btoken=xapp-[\da-z-]+/gi,
  /\brefresh_token=xoxe(?:\.xoxp)?-[\da-z-]+/gi,
  /\bxoxe(?:\.xoxp)?-[\dA-Za-z-]+/g,
  /\bxox[aboprs]-[\dA-Za-z-]+/g,
  /\bxapp-[\dA-Za-z-]+/g,
];

export function redact(value: string): string {
  let result = value;
  for (const secret of SECRET_VALUES) {
    result = result.replaceAll(secret, REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) =>
      match.includes('=') ? `${match.split('=')[0]}=${REDACTED}` : REDACTED,
    );
  }
  return result;
}

export function redactUnknown(value: unknown): string {
  if (value instanceof Error) {
    return redact(value.stack ?? value.message);
  }

  if (typeof value === 'string') {
    return redact(value);
  }

  try {
    return redact(
      JSON.stringify(
        value,
        (_key, nested) => {
          if (nested instanceof Error) {
            return {
              message: nested.message,
              name: nested.name,
              stack: nested.stack,
            };
          }
          return nested as unknown;
        },
        2,
      ) ?? String(value),
    );
  } catch {
    return redact(String(value));
  }
}

export function createRedactor(secrets: string[]): (value: string) => string {
  const filtered = secrets.filter((s) => s && s.length >= 8);

  if (filtered.length === 0) {
    return redact;
  }

  const pattern = new RegExp(
    filtered.map((s) => s.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&')).join('|'),
    'g',
  );

  return (value: string) => redact(value.replace(pattern, REDACTED));
}
