import type { z } from 'zod';

import { assembleResult } from './assembler.js';
import { PluginInjectError } from './errors.js';
import type { SlotWriterInternal } from './slot-writer.js';
import { createSlotWriter } from './slot-writer.js';
import type { Formatter, Message, PluginDef, PromptResult, Slot, TraceEntry } from './types.js';

const SLOT_ORDER: readonly Slot[] = [
  'system',
  'afterSystem',
  'firstUserMessage',
  'firstUserMessageContext',
  'lastUserMessage',
  'lastUserMessageContext',
  'afterUser',
] as const;

function sortPluginsBySlot(plugins: PluginDef[]): PluginDef[] {
  const slotIndex = new Map(SLOT_ORDER.map((s, i) => [s, i]));
  const indexed = plugins.map((p, registrationOrder) => ({ p, registrationOrder }));
  indexed.sort((a, b) => {
    const slotDiff = (slotIndex.get(a.p.slot) ?? 0) - (slotIndex.get(b.p.slot) ?? 0);
    if (slotDiff !== 0) return slotDiff;
    return a.registrationOrder - b.registrationOrder;
  });
  return indexed.map((x) => x.p);
}

interface Pipeline<TInput> {
  run: (input: TInput & { messages?: Message[] }) => Promise<PromptResult>;
  runWith: <TOutput>(
    input: TInput & { messages?: Message[] },
    formatter: Formatter<TOutput>,
  ) => Promise<TOutput>;
}

export function createPipeline<TInput extends z.ZodType>(config: {
  input: TInput;
  plugins: PluginDef[];
}): Pipeline<z.infer<TInput>> {
  const sorted = sortPluginsBySlot(config.plugins);

  async function run(input: z.infer<TInput> & { messages?: Message[] }): Promise<PromptResult> {
    const parsed = config.input.parse(input);
    const messages = input.messages ?? [];

    const writers = new Map<Slot, SlotWriterInternal>();
    const trace: TraceEntry[] = [];

    for (const plugin of sorted) {
      let deps: unknown;
      if (plugin.inject) {
        try {
          deps = plugin.inject.parse(parsed);
        } catch (err) {
          throw new PluginInjectError(
            plugin.name,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      let writer = writers.get(plugin.slot);
      if (!writer) {
        writer = createSlotWriter();
        writers.set(plugin.slot, writer);
      }

      const start = performance.now();
      await plugin.process(writer, deps as any);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;

      trace.push({ plugin: plugin.name, durationMs });
    }

    return assembleResult(writers, messages, trace);
  }

  return {
    run,
    async runWith<TOutput>(
      input: z.infer<TInput> & { messages?: Message[] },
      formatter: Formatter<TOutput>,
    ): Promise<TOutput> {
      const result = await run(input);
      return formatter.format(result);
    },
  };
}
