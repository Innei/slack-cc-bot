import { describe, expect, it } from 'vitest';

import {
  decodeWorkspacePickerButtonValue,
  encodeWorkspacePickerButtonValue,
} from '~/slack/interactions/workspace-picker-payload.js';

describe('workspace-picker-payload', () => {
  it('round-trips short text', () => {
    const text = '<@U> hello world';
    const encoded = encodeWorkspacePickerButtonValue(text);
    expect(encoded.length).toBeLessThanOrEqual(2000);
    expect(decodeWorkspacePickerButtonValue(encoded)).toBe(text);
  });

  it('truncates very long text to fit Slack button value limit', () => {
    const text = 'x'.repeat(5000);
    const encoded = encodeWorkspacePickerButtonValue(text);
    expect(encoded.length).toBeLessThanOrEqual(2000);
    const decoded = decodeWorkspacePickerButtonValue(encoded);
    expect(decoded).toBeDefined();
    expect(decoded!.length).toBeLessThan(text.length);
    expect(decoded!.length).toBeGreaterThan(0);
  });
});
