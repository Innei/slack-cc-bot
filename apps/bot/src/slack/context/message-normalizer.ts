import path from 'node:path';

import { type SlackMessage, SlackMessageSchema } from '~/schemas/slack/message.js';

const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const SUPPORTED_TEXT_FILE_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-toml',
  'application/x-typescript',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
  'text/cache-manifest',
  'text/calendar',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/jsx',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/tsx',
  'text/typescript',
  'text/x-c',
  'text/x-c++',
  'text/x-go',
  'text/x-java-source',
  'text/x-kotlin',
  'text/x-python',
  'text/x-ruby',
  'text/x-rust',
  'text/x-script.python',
  'text/x-script.sh',
  'text/x-shellscript',
  'text/x-sql',
  'text/xml',
]);
const SUPPORTED_TEXT_FILE_EXTENSIONS = new Set([
  '.bash',
  '.c',
  '.cc',
  '.cfg',
  '.conf',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.graphql',
  '.h',
  '.hpp',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.less',
  '.log',
  '.lua',
  '.mjs',
  '.md',
  '.php',
  '.pl',
  '.py',
  '.rb',
  '.rs',
  '.sass',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.swift',
  '.text',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
]);

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

export interface NormalizedThreadFile {
  authorId: string | null;
  fileId: string;
  fileName: string;
  fileType?: string;
  messageTs: string;
  mimeType: string;
  slackUrl: string | undefined;
  title?: string;
}

export interface NormalizedThreadMessage {
  authorId: string | null;
  files: NormalizedThreadFile[];
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
    return normalized.text || normalized.images.length > 0 || normalized.files.length > 0
      ? [normalized]
      : [];
  });
}

export function normalizeThreadMessage(message: SlackMessage): NormalizedThreadMessage {
  const threadTs = message.thread_ts ?? message.ts;
  const blockText = extractTextFromBlocks(message);
  const rawText = [message.text, blockText].filter(Boolean).join('\n').trim();
  const authorId = message.user ?? message.bot_id ?? null;
  const images = extractSupportedImages(message, authorId);
  const files = extractSupportedFiles(message, authorId);

  return {
    ts: message.ts,
    threadTs,
    authorId,
    files,
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

function extractSupportedFiles(
  message: SlackMessage,
  authorId: string | null,
): NormalizedThreadFile[] {
  const files: NormalizedThreadFile[] = [];

  for (const file of message.files ?? []) {
    const rawMimeType = file.mimetype;
    if (isSupportedImageMime(rawMimeType) || !isSupportedTextLikeFile(file)) {
      continue;
    }

    const fileName = file.name ?? file.title ?? file.id;
    const entry: NormalizedThreadFile = {
      authorId,
      fileId: file.id,
      fileName,
      messageTs: message.ts,
      mimeType: rawMimeType ?? '',
      slackUrl: file.url_private ?? undefined,
    };

    if (file.filetype != null) {
      entry.fileType = file.filetype;
    }
    if (file.title != null) {
      entry.title = file.title;
    }

    files.push(entry);
  }

  return files;
}

function isSupportedTextLikeFile(file: {
  filetype?: string | null | undefined;
  id: string;
  mimetype?: string | null | undefined;
  name?: string | null | undefined;
  title?: string | null | undefined;
}): boolean {
  const canonical = canonicalMimeType(file.mimetype);
  if (canonical != null) {
    if (canonical.startsWith('text/')) {
      return true;
    }
    if (SUPPORTED_TEXT_FILE_MIME_TYPES.has(canonical)) {
      return true;
    }
  }

  const fileName = file.name ?? file.title ?? file.id;
  const ext = path.extname(fileName).toLowerCase();
  return ext !== '' && SUPPORTED_TEXT_FILE_EXTENSIONS.has(ext);
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
