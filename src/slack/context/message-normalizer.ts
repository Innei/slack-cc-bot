import { type SlackMessage, SlackMessageSchema } from '~/schemas/slack/message.js';

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

/** Lowercases and strips MIME parameters (e.g. `image/PNG; charset=binary` → `image/png`). */
function canonicalMimeType(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }
  const base = raw.split(';')[0]?.trim() ?? '';
  if (!base) {
    return null;
  }
  return base.toLowerCase();
}

function isSupportedImageMime(raw: string | null | undefined): boolean {
  const canonical = canonicalMimeType(raw);
  return canonical != null && SUPPORTED_IMAGE_MIME_TYPES.has(canonical);
}

export interface NormalizedThreadImage {
  authorId: string | null;
  fileId: string;
  fileName: string;
  messageTs: string;
  mimeType: string;
  slackUrl: string | undefined;
  title?: string;
}

export interface NormalizedThreadMessage {
  authorId: string | null;
  images: NormalizedThreadImage[];
  rawText: string;
  text: string;
  threadTs: string;
  ts: string;
}

export function normalizeThreadMessages(messages: unknown[]): NormalizedThreadMessage[] {
  return messages.flatMap((message) => {
    const parsed = SlackMessageSchema.safeParse(message);

    if (!parsed.success) {
      return [];
    }

    const normalized = normalizeThreadMessage(parsed.data);
    return normalized.text || normalized.images.length > 0 ? [normalized] : [];
  });
}

export function normalizeThreadMessage(message: SlackMessage): NormalizedThreadMessage {
  const threadTs = message.thread_ts ?? message.ts;
  const blockText = extractTextFromBlocks(message);
  const rawText = [message.text, blockText].filter(Boolean).join('\n').trim();
  const authorId = message.user ?? message.bot_id ?? null;
  const images = extractSupportedImages(message, authorId);

  return {
    ts: message.ts,
    threadTs,
    authorId,
    text: dedupeLines(rawText),
    rawText,
    images,
  };
}

function extractSupportedImages(
  message: SlackMessage,
  authorId: string | null,
): NormalizedThreadImage[] {
  const images: NormalizedThreadImage[] = [];

  for (const file of message.files ?? []) {
    const rawMimeType = file.mimetype;
    if (!isSupportedImageMime(rawMimeType)) {
      continue;
    }

    const fileName = file.name ?? file.title ?? file.id;
    const entry: NormalizedThreadImage = {
      authorId,
      fileId: file.id,
      fileName,
      messageTs: message.ts,
      mimeType: rawMimeType ?? '',
      slackUrl: file.url_private ?? undefined,
    };

    if (file.title != null) {
      entry.title = file.title;
    }

    images.push(entry);
  }

  return images;
}

function extractTextFromBlocks(message: SlackMessage): string {
  const segments: string[] = [];

  for (const block of message.blocks ?? []) {
    if (block.type !== 'section') {
      continue;
    }

    const sectionBlock = block as {
      text?: {
        text?: string;
      };
      fields?: Array<{
        text?: string;
      }>;
    };

    if (sectionBlock.text?.text) {
      segments.push(sectionBlock.text.text);
    }

    for (const field of sectionBlock.fields ?? []) {
      if (field.text) {
        segments.push(field.text);
      }
    }
  }

  return segments.join('\n').trim();
}

function dedupeLines(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return [...new Set(lines)].join('\n');
}
