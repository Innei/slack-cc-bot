import { z } from 'zod';

import { SlackMessageSchema } from './message.js';

export const SlackMessageActionShortcutSchema = z.looseObject({
  callback_id: z.string().min(1),
  channel: z.object({
    id: z.string().min(1),
  }),
  message: SlackMessageSchema,
  trigger_id: z.string().min(1),
  type: z.literal('message_action'),
  user: z.object({
    id: z.string().min(1),
  }),
  team: z.object({
    id: z.string().min(1),
  }),
});
