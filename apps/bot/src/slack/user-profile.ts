export interface SlackUserProfile {
  display_name?: string;
  real_name?: string;
}

export function resolveUserName(profile: SlackUserProfile | undefined): string | undefined {
  if (!profile) return undefined;
  return profile.display_name || profile.real_name || undefined;
}
