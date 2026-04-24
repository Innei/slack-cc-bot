import type { SlackManifest } from './manifest-template.js';

export type SlackResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function appsManifestCreate(
  token: string,
  manifest: SlackManifest,
): Promise<
  SlackResult<{
    app_id: string;
    credentials: {
      signing_secret: string;
      client_id?: string;
      client_secret?: string;
      verification_token?: string;
    };
  }>
> {
  return slackPost(token, 'apps.manifest.create', { manifest });
}

export async function appsManifestExport(
  token: string,
  appId: string,
): Promise<SlackResult<{ manifest: SlackManifest }>> {
  return slackPost(token, 'apps.manifest.export', { app_id: appId });
}

export async function appsManifestUpdate(
  token: string,
  appId: string,
  manifest: SlackManifest,
): Promise<SlackResult<Record<string, never>>> {
  return slackPost(token, 'apps.manifest.update', { app_id: appId, manifest });
}

export async function rotateToolingToken(
  token: string,
  refreshToken: string,
): Promise<SlackResult<{ token: string; refresh_token: string; exp: number }>> {
  const body = new URLSearchParams({ token, refresh_token: refreshToken });
  const res = await fetch('https://slack.com/api/tooling.tokens.rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    token?: string;
    refresh_token?: string;
    exp?: number;
  };
  if (!data.ok) return { ok: false, error: data.error ?? 'unknown' };
  if (!data.token || !data.refresh_token) return { ok: false, error: 'malformed_response' };
  return { ok: true, token: data.token, refresh_token: data.refresh_token, exp: data.exp ?? 0 };
}

async function slackPost<T>(token: string, method: string, body: unknown): Promise<SlackResult<T>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  const data = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!data.ok) return { ok: false, error: data.error ?? 'unknown' };
  const { ok: _ok, error: _err, ...rest } = data;
  return { ok: true, ...(rest as T) };
}
