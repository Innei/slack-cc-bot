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

export const SlackFileSchema = z
  .object({
    id: z.string().min(1),
    mimetype: z.string().nullish(),
    filetype: z.string().nullish(),
    name: z.string().nullish(),
    title: z.string().nullish(),
    url_private: z.string().nullish(),
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
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();

export type SlackFile = z.infer<typeof SlackFileSchema>;
export type SlackMessage = z.infer<typeof SlackMessageSchema>;
