import type { z } from 'zod';
import { RefusedByRule } from '../errors.ts';

/**
 * What a release by the board would run again, checked against a kind's rules as
 * they read now, and handed back unchanged when it passes. The rules may have
 * changed since the action was filed — a field dropped from the configuration, a
 * status added to the refused ones — and a replay they refuse is a refusal for a
 * person, said now, never a payload that fails each time a worker runs it.
 */
export function validatedReplay(schema: z.ZodType, replay: unknown): unknown {
  const checked = schema.safeParse(replay);
  if (!checked.success) {
    const issues = checked.error.issues.map((issue) => issue.message).join('; ');
    throw new RefusedByRule(`what would run again is not accepted any longer — ${issues}`);
  }
  return replay;
}
