import { describe, expect, it } from 'vitest';

import {
  normalizeThreadMessage,
  normalizeThreadMessages,
} from '~/slack/context/message-normalizer.js';

describe('normalizeThreadMessages (images)', () => {
  it('preserves image-only messages and extracts supported image metadata', () => {
    const messages = [
      {
        ts: '123.456',
        thread_ts: '100.000',
        user: 'U_AUTHOR',
        text: '',
        files: [
          {
            id: 'F001',
            name: 'screenshot.png',
            mimetype: 'image/png',
            url_private: 'https://files.slack.com/files-pri/T-test-F001/screenshot.png',
            title: 'Screenshot',
          },
          {
            id: 'F002',
            name: 'doc.pdf',
            mimetype: 'application/pdf',
            url_private: 'https://files.slack.com/files-pri/T-test-F002/doc.pdf',
          },
        ],
      },
    ];

    const result = normalizeThreadMessages(messages);

    expect(result).toHaveLength(1);
    const first = result[0];
    if (!first) {
      throw new Error('Expected one normalized message');
    }
    expect(first).toMatchObject({
      authorId: 'U_AUTHOR',
      files: [],
      text: '',
      rawText: '',
      threadTs: '100.000',
      ts: '123.456',
    });
    expect(first.images).toHaveLength(1);
    const firstImage = first.images[0];
    if (!firstImage) {
      throw new Error('Expected one normalized image');
    }
    expect(firstImage).toEqual({
      authorId: 'U_AUTHOR',
      fileId: 'F001',
      fileName: 'screenshot.png',
      messageTs: '123.456',
      mimeType: 'image/png',
      slackUrl: 'https://files.slack.com/files-pri/T-test-F001/screenshot.png',
      title: 'Screenshot',
    });
  });

  it('resolves fileName from name, title, or id', () => {
    const withTitleOnly = normalizeThreadMessage({
      ts: '1.0',
      user: 'U1',
      text: '',
      files: [
        {
          id: 'FID',
          mimetype: 'image/jpeg',
          title: 'From title',
        },
      ],
    });
    expect(withTitleOnly.images[0]?.fileName).toBe('From title');

    const withIdOnly = normalizeThreadMessage({
      ts: '2.0',
      user: 'U1',
      text: '',
      files: [
        {
          id: 'FID_ONLY',
          mimetype: 'image/webp',
        },
      ],
    });
    expect(withIdOnly.images[0]?.fileName).toBe('FID_ONLY');
  });

  it('preserves supported text/code files and keeps file-only messages', () => {
    const result = normalizeThreadMessages([
      {
        ts: '55.001',
        thread_ts: '50.000',
        user: 'U_FILE',
        text: '',
        files: [
          {
            id: 'F_TEXT',
            name: 'notes.txt',
            mimetype: 'text/plain; charset=utf-8',
            filetype: 'text',
            title: 'Notes',
            url_private: 'https://files.slack.com/files-pri/T-test-F_TEXT/notes.txt',
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    const first = result[0];
    if (!first) {
      throw new Error('Expected one normalized message');
    }
    expect(first.images).toEqual([]);
    expect(first.files).toEqual([
      {
        authorId: 'U_FILE',
        fileId: 'F_TEXT',
        fileName: 'notes.txt',
        fileType: 'text',
        messageTs: '55.001',
        mimeType: 'text/plain; charset=utf-8',
        slackUrl: 'https://files.slack.com/files-pri/T-test-F_TEXT/notes.txt',
        title: 'Notes',
      },
    ]);
  });

  it('treats MIME types with parameters as supported images', () => {
    const messages = [
      {
        ts: '9.9',
        user: 'U1',
        text: '',
        files: [
          {
            id: 'F_PARAM',
            name: 'a.png',
            mimetype: 'IMAGE/PNG; charset=binary',
            url_private: 'https://files.example/F_PARAM',
          },
        ],
      },
    ];

    const result = normalizeThreadMessages(messages);

    expect(result).toHaveLength(1);
    const first = result[0];
    if (!first) {
      throw new Error('Expected one normalized message');
    }
    expect(first.images).toHaveLength(1);
    expect(first.files).toEqual([]);
    const firstImage = first.images[0];
    if (!firstImage) {
      throw new Error('Expected one normalized image');
    }
    expect(firstImage.mimeType).toBe('IMAGE/PNG; charset=binary');
    expect(firstImage.fileName).toBe('a.png');
  });

  it('parses files with null optional metadata without dropping the message', () => {
    const messages = [
      {
        ts: '8.8',
        user: 'U_NULL',
        text: '',
        files: [
          {
            id: 'F_NULL_META',
            mimetype: 'image/gif',
            name: null,
            title: null,
            filetype: null,
            url_private: null,
          },
        ],
      },
    ];

    const result = normalizeThreadMessages(messages);

    expect(result).toHaveLength(1);
    const first = result[0];
    if (!first) {
      throw new Error('Expected one normalized message');
    }
    expect(first.images).toHaveLength(1);
    expect(first.files).toEqual([]);
    const firstImage = first.images[0];
    if (!firstImage) {
      throw new Error('Expected one normalized image');
    }
    expect(firstImage).toMatchObject({
      authorId: 'U_NULL',
      fileId: 'F_NULL_META',
      fileName: 'F_NULL_META',
      mimeType: 'image/gif',
      slackUrl: undefined,
    });
    expect(firstImage.title).toBeUndefined();
  });

  it('drops messages with neither text nor supported images', () => {
    const messages = [
      {
        ts: '1.1',
        user: 'U1',
        text: '',
        files: [
          {
            id: 'F_PDF',
            mimetype: 'application/pdf',
            name: 'x.pdf',
          },
        ],
      },
      {
        ts: '2.2',
        user: 'U1',
        text: '   ',
      },
    ];

    expect(normalizeThreadMessages(messages)).toHaveLength(0);
  });

  it('treats supported code extensions as text-like even when mime metadata is missing', () => {
    const result = normalizeThreadMessage({
      ts: '3.3',
      user: 'U1',
      text: '',
      files: [
        {
          id: 'F_TS',
          name: 'index.ts',
          mimetype: null,
          title: null,
        },
      ],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.fileName).toBe('index.ts');
    expect(result.images).toEqual([]);
  });
});
