import { z } from 'zod';

export const UploadSlackFileToolInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      'Path to an existing local file inside the current workspace/session root. Relative paths are resolved from the current workspace root.',
    ),
});

export type UploadSlackFileToolInput = z.infer<typeof UploadSlackFileToolInputSchema>;
