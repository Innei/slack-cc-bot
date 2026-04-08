import type { Formatter } from '@kagura/prompt-pipeline';
import { createPipeline, definePlugin } from '@kagura/prompt-pipeline';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('createPipeline', () => {
  it('runs plugins in slot order regardless of registration order', async () => {
    const order: string[] = [];

    const lastPlugin = definePlugin({
      name: 'last',
      slot: 'lastUserMessage',
      async process(ctx) {
        order.push('last');
        ctx.append('User question');
      },
    });

    const systemPlugin = definePlugin({
      name: 'sys',
      slot: 'system',
      async process(ctx) {
        order.push('system');
        ctx.append('You are helpful.');
      },
    });

    const pipeline = createPipeline({
      input: z.object({}),
      plugins: [lastPlugin, systemPlugin],
    });

    const result = await pipeline.run({});

    expect(order).toEqual(['system', 'last']);
    expect(result.system).toBe('You are helpful.');
    expect(result.messages[0]!.content).toBe('User question');
  });

  it('plugins within same slot run in registration order', async () => {
    const order: string[] = [];

    const a = definePlugin({
      name: 'a',
      slot: 'system',
      async process(ctx) {
        order.push('a');
        ctx.append('A');
      },
    });

    const b = definePlugin({
      name: 'b',
      slot: 'system',
      async process(ctx) {
        order.push('b');
        ctx.append('B');
      },
    });

    const pipeline = createPipeline({ input: z.object({}), plugins: [a, b] });
    const result = await pipeline.run({});

    expect(order).toEqual(['a', 'b']);
    expect(result.system).toBe('A\nB');
  });

  it('injects validated dependencies to plugins', async () => {
    const plugin = definePlugin({
      name: 'user-msg',
      slot: 'lastUserMessage',
      inject: z.object({ userId: z.string(), text: z.string() }),
      async process(ctx, deps) {
        ctx.append(`<@${deps.userId}>: ${deps.text}`);
      },
    });

    const pipeline = createPipeline({
      input: z.object({ userId: z.string(), text: z.string() }),
      plugins: [plugin],
    });

    const result = await pipeline.run({ userId: 'U1', text: 'hello' });
    expect(result.messages[0]!.content).toBe('<@U1>: hello');
  });

  it('throws PluginInjectError on invalid inject data', async () => {
    const plugin = definePlugin({
      name: 'strict-plugin',
      slot: 'system',
      inject: z.object({ count: z.number() }),
      async process(ctx, deps) {
        ctx.append(String(deps.count));
      },
    });

    const pipeline = createPipeline({
      input: z.object({ count: z.number() }),
      plugins: [plugin],
    });

    await expect(pipeline.run({ count: 'not-a-number' as any })).rejects.toThrow();
  });

  it('validates pipeline input schema', async () => {
    const pipeline = createPipeline({
      input: z.object({ name: z.string() }),
      plugins: [],
    });

    await expect(pipeline.run({ name: 123 as any })).rejects.toThrow();
  });

  it('passes thread history messages through', async () => {
    const pipeline = createPipeline({
      input: z.object({}),
      plugins: [
        definePlugin({
          name: 'first',
          slot: 'firstUserMessage',
          async process(ctx) {
            ctx.append('First');
          },
        }),
        definePlugin({
          name: 'last',
          slot: 'lastUserMessage',
          async process(ctx) {
            ctx.append('Last');
          },
        }),
      ],
    });

    const result = await pipeline.run({
      messages: [
        { role: 'user', content: 'old Q' },
        { role: 'assistant', content: 'old A' },
      ],
    });

    expect(result.messages.map((m) => m.content)).toEqual(['First', 'old Q', 'old A', 'Last']);
  });

  it('trace records duration per plugin', async () => {
    const plugin = definePlugin({
      name: 'slow',
      slot: 'system',
      async process(ctx) {
        await new Promise((r) => setTimeout(r, 10));
        ctx.append('done');
      },
    });

    const pipeline = createPipeline({ input: z.object({}), plugins: [plugin] });
    const result = await pipeline.run({});

    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]!.plugin).toBe('slow');
    expect(result.trace[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runWith applies formatter to result', async () => {
    const plugin = definePlugin({
      name: 'sys',
      slot: 'system',
      async process(ctx) {
        ctx.append('System prompt');
      },
    });

    const pipeline = createPipeline({ input: z.object({}), plugins: [plugin] });

    const testFormatter: Formatter<{ sys: string; msgCount: number }> = {
      name: 'test',
      format(result) {
        return { sys: result.system, msgCount: result.messages.length };
      },
    };

    const output = await pipeline.runWith({}, testFormatter);
    expect(output).toEqual({ sys: 'System prompt', msgCount: 0 });
  });

  it('no-inject plugins receive undefined deps', async () => {
    let receivedDeps: unknown = 'sentinel';

    const plugin = definePlugin({
      name: 'no-deps',
      slot: 'system',
      async process(_ctx, deps) {
        receivedDeps = deps;
      },
    });

    const pipeline = createPipeline({ input: z.object({}), plugins: [plugin] });
    await pipeline.run({});

    expect(receivedDeps).toBeUndefined();
  });
});
