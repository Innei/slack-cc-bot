import type { SlotWriterInternal } from './slot-writer.js';
import type {
  ImageAsset,
  Message,
  PromptResult,
  ResolvedMessage,
  Slot,
  TraceEntry,
} from './types.js';

function mergeSlotPair(
  bodyWriter: SlotWriterInternal | undefined,
  contextWriter: SlotWriterInternal | undefined,
): ResolvedMessage | null {
  const bodyText = bodyWriter?.getText() ?? '';
  const contextText = contextWriter?.getText() ?? '';
  if (!bodyText && !contextText) return null;

  const parts: string[] = [];
  if (bodyText) parts.push(bodyText);
  if (contextText) parts.push(contextText);

  const images: ImageAsset[] = [
    ...(bodyWriter?.getImages() ?? []),
    ...(contextWriter?.getImages() ?? []),
  ];

  const msg: ResolvedMessage = { role: 'user', content: parts.join('\n') };
  if (images.length > 0) msg.images = images;
  return msg;
}

function segmentsToMessages(writer: SlotWriterInternal | undefined): ResolvedMessage[] {
  if (!writer) return [];
  const images = writer.getImages();
  return writer.getSegments().map((text, i) => {
    const msg: ResolvedMessage = { role: 'user', content: text };
    if (i === 0 && images.length > 0) msg.images = images;
    return msg;
  });
}

export function assembleResult(
  writers: Map<Slot, SlotWriterInternal>,
  threadHistory: Message[],
  trace: TraceEntry[],
): PromptResult {
  const systemWriter = writers.get('system');
  const system = systemWriter?.getText() ?? '';

  const afterSystemMessages = segmentsToMessages(writers.get('afterSystem'));
  const afterSystem = writers.get('afterSystem')?.getSegments() ?? [];

  const firstMessage = mergeSlotPair(
    writers.get('firstUserMessage'),
    writers.get('firstUserMessageContext'),
  );

  const historyMessages: ResolvedMessage[] = threadHistory.map((m) => {
    const msg: ResolvedMessage = { role: m.role, content: m.content };
    if (m.images?.length) msg.images = m.images;
    return msg;
  });

  const lastMessage = mergeSlotPair(
    writers.get('lastUserMessage'),
    writers.get('lastUserMessageContext'),
  );

  const afterUserMessages = segmentsToMessages(writers.get('afterUser'));

  const messages: ResolvedMessage[] = [
    ...afterSystemMessages,
    ...(firstMessage ? [firstMessage] : []),
    ...historyMessages,
    ...(lastMessage ? [lastMessage] : []),
    ...afterUserMessages,
  ];

  return { system, afterSystem, messages, trace };
}
