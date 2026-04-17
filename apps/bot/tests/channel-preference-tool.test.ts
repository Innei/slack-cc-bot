import { describe, expect, it } from 'vitest';

import { parseSetChannelDefaultWorkspaceToolInput } from '~/agent/providers/claude-code/tools/set-channel-default-workspace.js';

describe('parseSetChannelDefaultWorkspaceToolInput', () => {
  it('parses valid input', () => {
    const input = { workspaceInput: 'my-repo/sub' };
    const parsed = parseSetChannelDefaultWorkspaceToolInput(input);
    expect(parsed.workspaceInput).toBe('my-repo/sub');
  });

  it('throws on empty workspaceInput', () => {
    expect(() => parseSetChannelDefaultWorkspaceToolInput({ workspaceInput: '' })).toThrow();
  });

  it('throws on missing workspaceInput', () => {
    expect(() => parseSetChannelDefaultWorkspaceToolInput({})).toThrow();
  });

  it('throws on overly long workspaceInput', () => {
    expect(() =>
      parseSetChannelDefaultWorkspaceToolInput({ workspaceInput: 'a'.repeat(501) }),
    ).toThrow();
  });
});
