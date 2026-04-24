import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appsManifestCreate,
  appsManifestExport,
  appsManifestUpdate,
  rotateToolingToken,
} from '../src/slack/config-token.js';

const origFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = origFetch;
});

function mockFetch(body: unknown, ok = true) {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('config-token wrappers', () => {
  it('appsManifestCreate returns ok payload', async () => {
    mockFetch({ ok: true, app_id: 'A123', credentials: { signing_secret: 's1' } });
    const res = await appsManifestCreate('xoxe-tok', {
      display_information: { name: 'x' },
    } as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.app_id).toBe('A123');
  });

  it('rotateToolingToken returns new tokens', async () => {
    mockFetch({ ok: true, token: 't2', refresh_token: 'r2', exp: 1 });
    const res = await rotateToolingToken('t1', 'r1');
    expect(res.ok).toBe(true);
  });

  it('appsManifestExport unwraps manifest', async () => {
    mockFetch({ ok: true, manifest: { display_information: { name: 'x' } } });
    const res = await appsManifestExport('tok', 'A123');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.manifest.display_information.name).toBe('x');
  });

  it('appsManifestUpdate returns ok:true', async () => {
    mockFetch({ ok: true });
    const res = await appsManifestUpdate('tok', 'A123', {} as never);
    expect(res.ok).toBe(true);
  });

  it('propagates Slack error', async () => {
    mockFetch({ ok: false, error: 'invalid_auth' });
    const res = await appsManifestCreate('tok', {} as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('invalid_auth');
  });
});
