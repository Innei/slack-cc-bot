import type { z,ZodError, ZodSchema } from 'zod';

export class SchemaParseError extends Error {
  constructor(
    public readonly schemaName: string,
    public readonly zodError: ZodError,
  ) {
    const details = zodError.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    super(`${schemaName} validation failed: ${details}`);
    this.name = 'SchemaParseError';
  }
}

/**
 * Wrapper around `schema.parse()` that throws a `SchemaParseError` with
 * a human-readable message including the schema name and field paths.
 */
export function zodParse<T extends ZodSchema>(
  schema: T,
  data: unknown,
  schemaName: string,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new SchemaParseError(schemaName, result.error);
  }
  return result.data;
}
