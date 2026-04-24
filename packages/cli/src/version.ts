declare const __KAGURA_VERSION__: string | undefined;
declare const __GIT_HASH__: string | undefined;
declare const __GIT_COMMIT_DATE__: string | undefined;

export const KAGURA_VERSION =
  (typeof __KAGURA_VERSION__ !== 'undefined' && __KAGURA_VERSION__) || '0.0.0-dev';
export const GIT_HASH = (typeof __GIT_HASH__ !== 'undefined' && __GIT_HASH__) || 'unknown';
export const GIT_COMMIT_DATE =
  (typeof __GIT_COMMIT_DATE__ !== 'undefined' && __GIT_COMMIT_DATE__) || 'unknown';

export function formatVersion(): string {
  const short = GIT_HASH.slice(0, 7);
  return `@innei/kagura v${KAGURA_VERSION} (${short}, ${GIT_COMMIT_DATE})`;
}
