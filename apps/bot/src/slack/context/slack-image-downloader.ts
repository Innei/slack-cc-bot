import { env } from '~/env/server.js';

export const MAX_THREAD_IMAGE_BYTES = 5 * 1024 * 1024;

export async function downloadSlackImage(
  url: string,
): Promise<{ base64Data: string; mimeType: string }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const rawType = response.headers.get('content-type');
  const mimeType = rawType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`not an image (content-type: ${rawType ?? 'missing'})`);
  }

  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader != null) {
    const n = Number.parseInt(lengthHeader, 10);
    if (!Number.isNaN(n) && n > MAX_THREAD_IMAGE_BYTES) {
      throw new Error(`image exceeds max size (${MAX_THREAD_IMAGE_BYTES} bytes)`);
    }
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_THREAD_IMAGE_BYTES) {
    throw new Error(`image exceeds max size (${MAX_THREAD_IMAGE_BYTES} bytes)`);
  }

  return {
    base64Data: Buffer.from(buffer).toString('base64'),
    mimeType,
  };
}
