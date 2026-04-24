import type { KaguraPaths } from '../config/paths.js';

export interface SlackOnboardingOptions {
  allowSkip: boolean;
}

export async function runSlackOnboarding(
  _paths: KaguraPaths,
  _opts: SlackOnboardingOptions,
): Promise<void> {
  // Populated by Task 5.2 with the real new-app / reuse flows.
}
