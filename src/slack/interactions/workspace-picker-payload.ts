/** Slack button `value` max length — must fit `trigger_id` window; avoid slow API before `views.open`. */
const MAX_BUTTON_VALUE_LENGTH = 2000;

export function encodeWorkspacePickerButtonValue(messageText: string): string {
  const payload = (version: 1, text: string) => JSON.stringify({ v: version, t: text });

  if (payload(1, messageText).length <= MAX_BUTTON_VALUE_LENGTH) {
    return payload(1, messageText);
  }

  let low = 0;
  let high = messageText.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (payload(1, messageText.slice(0, mid)).length <= MAX_BUTTON_VALUE_LENGTH) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return payload(1, messageText.slice(0, low));
}

export function decodeWorkspacePickerButtonValue(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as { t?: unknown; v?: unknown };
    if (parsed.v === 1 && typeof parsed.t === 'string') {
      return parsed.t;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
