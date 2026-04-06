import { env } from '~/env/server.js';

export const MAX_THREAD_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_THREAD_TEXT_FILE_CHARS = 48_000;

const decoder = new TextDecoder('utf-8');

export async function downloadSlackTextFile(
  url: string,
): Promise<{ mimeType: string; text: string; truncated: boolean }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader != null) {
    const n = Number.parseInt(lengthHeader, 10);
    if (!Number.isNaN(n) && n > MAX_THREAD_TEXT_FILE_BYTES) {
      throw new Error(`file exceeds max size (${MAX_THREAD_TEXT_FILE_BYTES} bytes)`);
    }
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_THREAD_TEXT_FILE_BYTES) {
    throw new Error(`file exceeds max size (${MAX_THREAD_TEXT_FILE_BYTES} bytes)`);
  }

  const bytes = new Uint8Array(buffer);
  if (looksBinary(bytes)) {
    throw new Error('not a supported text/code file');
  }

  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const decoded = stripLeadingBom(decoder.decode(bytes));
  if (decoded.length > MAX_THREAD_TEXT_FILE_CHARS) {
    return {
      mimeType,
      text: decoded.slice(0, MAX_THREAD_TEXT_FILE_CHARS),
      truncated: true,
    };
  }

  return {
    mimeType,
    text: decoded,
    truncated: false,
  };
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return true;
    }
  }
  return false;
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
