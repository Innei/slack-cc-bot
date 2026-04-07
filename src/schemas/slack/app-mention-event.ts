import { z } from 'zod';

import { SlackFileSchema } from './message.js';

export const SlackAppMentionEventSchema = z.looseObject({
  type: z.literal('app_mention'),
  channel: z.string().min(1),
  team: z.string().min(1).optional(),
  user: z.string().min(1),
  text: z.string().default(''),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  files: z.array(SlackFileSchema).optional(),
});

export type SlackAppMentionEvent = z.infer<typeof SlackAppMentionEventSchema>;
