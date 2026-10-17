/**
 * Reading values that came from outside this run — a stored row, a cached blob —
 * as what they claim to be, or as nothing.
 *
 * Anything written by an earlier version, by hand, or by a half-finished write is
 * read through these: a report that says "no last tick" is fine, a report that
 * crashes on a stray character is not.
 */

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** An ISO moment, or nothing; an unreadable date is not a date. */
export function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (text === null) {
    return null;
  }
  const moment = new Date(text);
  return Number.isNaN(moment.getTime()) ? null : moment;
}
