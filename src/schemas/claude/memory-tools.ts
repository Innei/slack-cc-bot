import { z } from 'zod';

import { MEMORY_CATEGORIES } from '../../memory/types.js';

export const MemoryCategorySchema = z.enum(MEMORY_CATEGORIES);

export const RecallMemoryToolInputSchema = z.object({
  query: z.string().min(1).max(240).optional(),
  category: MemoryCategorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const SaveMemoryToolInputSchema = z.object({
  category: MemoryCategorySchema,
  content: z.string().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type RecallMemoryToolInput = z.infer<typeof RecallMemoryToolInputSchema>;
export type SaveMemoryToolInput = z.infer<typeof SaveMemoryToolInputSchema>;
