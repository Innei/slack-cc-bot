import { z } from 'zod';

export const ClaudeUiStateToolInputShape = {
  status: z.string().min(1).max(120).optional(),
  loadingMessages: z.array(z.string().min(1).max(240)).max(10).optional(),
  clear: z.boolean().default(false),
} as const;

export const ClaudeUiStateSchema = z
  .object({
    threadTs: z.string().min(1),
    composing: z.boolean().optional(),
    ...ClaudeUiStateToolInputShape,
  })
  .superRefine((value, context) => {
    if (value.clear) {
      return;
    }

    if (!value.status && !value.loadingMessages?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of status or loadingMessages must be provided when clear is false.',
      });
    }
  });

export type ClaudeUiState = z.infer<typeof ClaudeUiStateSchema>;
