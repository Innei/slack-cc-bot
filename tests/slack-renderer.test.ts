import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GeneratedImageFile, GeneratedOutputFile } from '~/agent/types.js';
import type { AppLogger } from '~/logger/index.js';
import { SlackRenderer, SlackRenderTimeoutError } from '~/slack/render/slack-renderer.js';
import type { SlackWebClientLike } from '~/slack/types.js';

function createTestLogger(): AppLogger {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
    withTag: vi.fn(),
  };
  logger.withTag.mockReturnValue(logger);
  return logger as unknown as AppLogger;
}

function createClientFixture(): {
  client: SlackWebClientLike;
  imagePostCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]>;
} {
  const imagePostCalls: Array<Parameters<SlackWebClientLike['chat']['postMessage']>[0]> = [];

  const client: SlackWebClientLike = {
    assistant: { threads: { setStatus: vi.fn().mockResolvedValue({}) } },
    chat: {
      delete: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockImplementation(async (args) => {
        imagePostCalls.push(args);
        return { ts: 'post-ts' };
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    files: {
      uploadV2: vi.fn(),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    views: {
      open: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({}),
    },
  };

  return { client, imagePostCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SlackRenderer.postGeneratedImages', () => {
  it('uploads each file and posts an image block referencing the uploaded file id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-'));
    const pathA = path.join(dir, 'a.png');
    const pathB = path.join(dir, 'b.png');
    await writeFile(pathA, Buffer.from('png-a'));
    await writeFile(pathB, Buffer.from('png-b'));

    const { client, imagePostCalls } = createClientFixture();
    const uploadCalls: Array<Parameters<SlackWebClientLike['files']['uploadV2']>[0]> = [];
    let uploadId = 0;
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      uploadCalls.push(args);
      uploadId += 1;
      return { files: [{ id: `F_ID_${uploadId}` }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const files: GeneratedImageFile[] = [
      { fileName: 'a.png', path: pathA, providerFileId: 'pf1' },
      { fileName: 'b.png', path: pathB, providerFileId: 'pf2' },
    ];

    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', files);

    expect(failed).toEqual([]);
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'a.png',
      title: 'a.png',
      alt_text: 'a.png',
    });
    expect(uploadCalls[0]!.file.equals(Buffer.from('png-a'))).toBe(true);
    expect(uploadCalls[1]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'b.png',
    });
    expect(uploadCalls[1]!.file.equals(Buffer.from('png-b'))).toBe(true);

    expect(imagePostCalls).toHaveLength(2);
    expect(imagePostCalls[0]!.blocks?.[0]).toMatchObject({
      type: 'image',
      alt_text: 'a.png',
      slack_file: { id: 'F_ID_1' },
    });
    expect(imagePostCalls[1]!.blocks?.[0]).toMatchObject({
      type: 'image',
      alt_text: 'b.png',
      slack_file: { id: 'F_ID_2' },
    });
  });

  it('warns and skips the image block when upload returns no file id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-warn-'));
    const pathA = path.join(dir, 'x.png');
    await writeFile(pathA, Buffer.from('x'));

    const logger = createTestLogger();
    const { client, imagePostCalls } = createClientFixture();
    vi.mocked(client.files.uploadV2).mockResolvedValue({ files: [{}] });

    const renderer = new SlackRenderer(logger);
    const meta = { fileName: 'x.png', path: pathA, providerFileId: 'pf' };
    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', [meta]);

    expect(failed).toEqual([meta]);
    expect(logger.warn).toHaveBeenCalled();
    expect(imagePostCalls).toHaveLength(0);
  });

  it('returns only the files that failed upload, not successful ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-partial-'));
    const pathA = path.join(dir, 'a.png');
    const pathB = path.join(dir, 'b.png');
    await writeFile(pathA, Buffer.from('a'));
    await writeFile(pathB, Buffer.from('b'));

    const { client, imagePostCalls } = createClientFixture();
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      if (args.filename === 'b.png') {
        throw new Error('upload failed');
      }
      return { files: [{ id: 'F_OK' }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const a: GeneratedImageFile = { fileName: 'a.png', path: pathA, providerFileId: 'pa' };
    const b: GeneratedImageFile = { fileName: 'b.png', path: pathB, providerFileId: 'pb' };
    const failed = await renderer.postGeneratedImages(client, 'C1', 'ts-root', [a, b]);

    expect(failed).toEqual([b]);
    expect(imagePostCalls).toHaveLength(1);
    expect(imagePostCalls[0]!.blocks?.[0]).toMatchObject({
      type: 'image',
      alt_text: 'a.png',
      slack_file: { id: 'F_OK' },
    });
  });
});

describe('SlackRenderer.postGeneratedFiles', () => {
  it('uploads non-image files without posting extra image blocks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'slack-renderer-files-'));
    const filePath = path.join(dir, 'report.txt');
    await writeFile(filePath, Buffer.from('report body'));

    const { client, imagePostCalls } = createClientFixture();
    const uploadCalls: Array<Parameters<SlackWebClientLike['files']['uploadV2']>[0]> = [];
    vi.mocked(client.files.uploadV2).mockImplementation(async (args) => {
      uploadCalls.push(args);
      return { files: [{ id: 'F_FILE' }] };
    });

    const renderer = new SlackRenderer(createTestLogger());
    const files: GeneratedOutputFile[] = [
      { fileName: 'report.txt', path: filePath, providerFileId: 'pf-report' },
    ];

    const failed = await renderer.postGeneratedFiles(client, 'C1', 'ts-root', files);

    expect(failed).toEqual([]);
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]).toMatchObject({
      channel_id: 'C1',
      thread_ts: 'ts-root',
      filename: 'report.txt',
      title: 'report.txt',
    });
    expect(uploadCalls[0]).not.toHaveProperty('alt_text');
    expect(uploadCalls[0]!.file.equals(Buffer.from('report body'))).toBe(true);
    expect(imagePostCalls).toHaveLength(0);
  });
});

describe('SlackRenderer timeouts', () => {
  it('times out Slack API operations that never settle', async () => {
    vi.useFakeTimers();

    const { client } = createClientFixture();
    vi.mocked(client.chat.update).mockImplementation(
      () => new Promise(() => {}) as ReturnType<SlackWebClientLike['chat']['update']>,
    );

    const renderer = new SlackRenderer(createTestLogger(), undefined, { operationTimeoutMs: 50 });
    const pending = renderer.finalizeThreadProgressMessage(
      client,
      'C1',
      'thread-ts',
      'progress-ts',
    );
    const expectation = expect(pending).rejects.toBeInstanceOf(SlackRenderTimeoutError);

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
  });
});
