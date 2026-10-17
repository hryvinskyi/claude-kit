import { RefusedByRule } from '../domain/errors.ts';

/**
 * Turning what somebody typed — on a command line, in a tool call — into the
 * values the application takes.
 *
 * Every refusal here names the text that was refused. A delivery mechanism is the
 * last place that still knows what was typed; once the value is gone, an error
 * further in can only say that something was wrong with it.
 */

/** A moment a schema accepted but the calendar does not, refused in words. */
export function momentOf(text: string): Date {
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new RefusedByRule(`"${text}" is not a moment on the calendar`);
  }
  return parsed;
}

/** A whole positive number, or a refusal naming what it was meant to be. */
export function positiveIntegerOf(text: string, what: string): number {
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RefusedByRule(`${what} is a whole number above zero, not "${text}"`);
  }
  return value;
}
