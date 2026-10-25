import { z } from 'zod';
import { ProjectSettingsSchema } from '@common/types';

export const PatchProjectSettingsSchema = ProjectSettingsSchema.partial().and(
  z.object({
    projectDir: z.string().min(1, 'Project directory is required'),
  }),
);

/**
 * Keeps only the keys the client actually sent. Zod 4 fills `.default()` values even under
 * `.partial()`, so a parsed PATCH body otherwise carries a default for every omitted field.
 */
export const pickKeysPresentInBody = <T extends object>(parsed: T, body: unknown): Partial<T> => {
  if (!body || typeof body !== 'object') {
    return {};
  }
  const bodyKeys = new Set(Object.keys(body));
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => bodyKeys.has(key))) as Partial<T>;
};
