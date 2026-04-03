import { z } from 'zod';

const SlackTextObjectSchema = z
  .object({
    type: z.enum(['plain_text', 'mrkdwn']),
    text: z.string(),
  })
  .passthrough();

const SlackSectionBlockSchema = z
  .object({
    type: z.literal('section'),
    text: SlackTextObjectSchema.optional(),
    fields: z.array(SlackTextObjectSchema).optional(),
  })
  .passthrough();

const SlackGenericBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const SlackMessageSchema = z
  .object({
    channel: z.string().min(1).optional(),
    team: z.string().min(1).optional(),
    text: z.string().default(''),
    ts: z.string().min(1),
    thread_ts: z.string().min(1).optional(),
    subtype: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    blocks: z.array(z.union([SlackSectionBlockSchema, SlackGenericBlockSchema])).optional(),
  })
  .passthrough();

export type SlackMessage = z.infer<typeof SlackMessageSchema>;
