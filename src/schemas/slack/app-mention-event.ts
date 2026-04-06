import { z } from 'zod';

export const SlackAppMentionEventSchema = z
  .object({
    type: z.literal('app_mention'),
    channel: z.string().min(1),
    team: z.string().min(1).optional(),
    user: z.string().min(1),
    text: z.string().min(1),
    ts: z.string().min(1),
    thread_ts: z.string().min(1).optional(),
  })
  .passthrough();

export type SlackAppMentionEvent = z.infer<typeof SlackAppMentionEventSchema>;
