import { definePlugin } from '@kagura/prompt-pipeline';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

describe('definePlugin', () => {
  it('returns the plugin definition unchanged', () => {
    const process = vi.fn();
    const plugin = definePlugin({
      name: 'test',
      slot: 'system',
      process,
    });
    expect(plugin.name).toBe('test');
    expect(plugin.slot).toBe('system');
    expect(plugin.process).toBe(process);
    expect(plugin.inject).toBeUndefined();
  });

  it('preserves inject schema', () => {
    const schema = z.object({ userId: z.string() });
    const plugin = definePlugin({
      name: 'test',
      slot: 'lastUserMessage',
      inject: schema,
      async process(_ctx, deps) {
        void deps.userId;
      },
    });
    expect(plugin.inject).toBe(schema);
  });
});
