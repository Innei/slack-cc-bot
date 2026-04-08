import type { z } from 'zod';

import type { PluginDef, Slot, SlotWriter } from './types.js';

export function definePlugin<TInjectSchema extends z.ZodType>(def: {
  name: string;
  slot: Slot;
  inject?: TInjectSchema;
  process: (ctx: SlotWriter, deps: z.infer<TInjectSchema>) => Promise<void>;
}): PluginDef<TInjectSchema> {
  return def;
}
