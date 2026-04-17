import { z } from 'zod';

export const SetChannelDefaultWorkspaceToolInputSchema = z.object({
  workspaceInput: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'The workspace input to set as default for this channel, e.g. a repository name or absolute path.',
    ),
});

export type SetChannelDefaultWorkspaceToolInput = z.infer<
  typeof SetChannelDefaultWorkspaceToolInputSchema
>;
