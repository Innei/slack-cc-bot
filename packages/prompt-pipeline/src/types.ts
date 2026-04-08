import type { z } from 'zod';

export type Slot =
  | 'system'
  | 'afterSystem'
  | 'firstUserMessage'
  | 'firstUserMessageContext'
  | 'lastUserMessage'
  | 'lastUserMessageContext'
  | 'afterUser';

export interface ImageAsset {
  base64Data: string;
  mimeType: string;
  name: string;
}

export interface Message {
  content: string;
  images?: ImageAsset[];
  role: 'user' | 'assistant';
}

export interface SlotWriter {
  append: (text: string) => void;
  image: (asset: ImageAsset) => void;
  prepend: (text: string) => void;
}

export interface PluginDef<TInject extends z.ZodType = z.ZodType> {
  inject?: TInject;
  name: string;
  process: (ctx: SlotWriter, deps: z.infer<TInject>) => Promise<void>;
  slot: Slot;
}

export interface ResolvedMessage {
  content: string;
  images?: ImageAsset[];
  role: 'user' | 'assistant';
}

export interface TraceEntry {
  durationMs: number;
  plugin: string;
}

export interface PromptResult {
  afterSystem: string[];
  messages: ResolvedMessage[];
  system: string;
  trace: TraceEntry[];
}

export interface Formatter<TOutput> {
  format: (result: PromptResult) => TOutput;
  name: string;
}
