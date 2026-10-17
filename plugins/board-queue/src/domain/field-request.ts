import type { Config } from './config.ts';
import { RefusedByRule } from './errors.ts';

/**
 * The board field whose value the auto-close workflow watches. A write to it is
 * the one field change this system refuses on its own initiative.
 */
export const STATUS_FIELD = 'Status';

/**
 * Whether a status the board actually carries is one of those this queue refuses
 * to write.
 *
 * The same question is asked at two ends of the system and must be answered the
 * same way at both: before a write, because the board's own automation reacts to
 * these values, and when reading a row back, because a row already carrying one
 * of them got there through that automation rather than through anything here.
 * The option labels carry prose after the word, so the comparison is a prefix
 * one — `Done · shipped` is the refused `Done`.
 */
export function namesRefusedStatus(status: string, refused: readonly string[]): boolean {
  const name = status.trim().toLowerCase();
  return refused.some((candidate) => {
    const text = candidate.trim().toLowerCase();
    return text !== '' && name.startsWith(text);
  });
}

/**
 * Whether a text somebody typed could end up writing one of the refused statuses.
 *
 * A wanted text never reaches the board as it was typed: it is matched against
 * the live options as a prefix, so `Don` writes `Done` and `Done · shipped` is
 * `Done` as well. Either text names the same value, so either is refused where
 * the person is, rather than five minutes later in a worker log.
 */
export function couldReachRefusedStatus(wanted: string, refused: readonly string[]): boolean {
  const name = wanted.trim().toLowerCase();
  if (name === '') {
    return false;
  }
  return refused.some((candidate) => {
    const text = candidate.trim().toLowerCase();
    return text !== '' && (name.startsWith(text) || text.startsWith(name));
  });
}

/** A read expectation may name any value; a write may not. */
export type FieldRequestMode = 'write' | 'read';

/**
 * What an action wants a board row to say: field name → wanted option text.
 *
 * Only the fields the configuration lists exist here, spelled the way it spells
 * them, so the rest of the system never has to guess whether "status" and
 * "Status" are the same column. A request always names at least one field —
 * an empty one would be a write that writes nothing and reads as a success.
 *
 * The wanted text is what the caller typed, not an option id: matching it to a
 * live option happens against the board's own catalog at execution time.
 */
export class FieldRequest {
  private readonly values: Map<string, string>;

  private constructor(values: Map<string, string>) {
    this.values = values;
  }

  /**
   * A request that will be written to the board.
   *
   * A status the configuration refuses is rejected here, at the moment somebody
   * asks for it: the board's auto-close workflow reacts to that value by closing
   * the issue, which would happen before the evidence comment this system is
   * about to post exists. Closing the issue directly is the supported way, and
   * the board follows.
   */
  static forWrite(wanted: Record<string, string>, config: Config): FieldRequest {
    const values = normalise(wanted, config);
    const status = values.get(canonicalFieldName(STATUS_FIELD, config) ?? STATUS_FIELD);
    if (status !== undefined && couldReachRefusedStatus(status, config.refusedStatus)) {
      throw new RefusedByRule(
        `${STATUS_FIELD} "${status}" is not written by this queue: the board's auto-close workflow `
        + 'would close the issue before its evidence comment exists. Close the issue itself and let '
        + 'the board follow.',
      );
    }
    return new FieldRequest(values);
  }

  /**
   * A request that will be compared against the board.
   *
   * Every value is allowed, including a refused status: confirming that closing
   * an issue carried its row to that status is exactly what a verification is for.
   */
  static forRead(wanted: Record<string, string>, config: Config): FieldRequest {
    return new FieldRequest(normalise(wanted, config));
  }

  /** The other request's values win, field by field. */
  merge(other: FieldRequest): FieldRequest {
    const merged = new Map(this.values);
    for (const [field, value] of other.values) {
      merged.set(field, value);
    }
    return new FieldRequest(merged);
  }

  entries(): [string, string][] {
    return [...this.values.entries()];
  }

  names(): string[] {
    return [...this.values.keys()];
  }

  get size(): number {
    return this.values.size;
  }

  get(field: string): string | undefined {
    for (const [name, value] of this.values) {
      if (name.toLowerCase() === field.trim().toLowerCase()) {
        return value;
      }
    }
    return undefined;
  }

  has(field: string): boolean {
    return this.get(field) !== undefined;
  }

  toObject(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  describe(): string {
    return this.entries()
      .map(([field, value]) => `${field} → ${value}`)
      .join(', ');
  }
}

function canonicalFieldName(wanted: string, config: Config): string | null {
  const needle = wanted.trim().toLowerCase();
  for (const configured of config.fields) {
    if (configured.toLowerCase() === needle) {
      return configured;
    }
  }
  return null;
}

function normalise(wanted: Record<string, string>, config: Config): Map<string, string> {
  const values = new Map<string, string>();
  for (const [rawField, rawValue] of Object.entries(wanted)) {
    const field = canonicalFieldName(rawField, config);
    if (field === null) {
      throw new RefusedByRule(
        `"${rawField}" is not a board field this queue manages; it manages ${config.fields.join(', ')}`,
      );
    }
    if (values.has(field)) {
      throw new RefusedByRule(`${field} is named twice in one request`);
    }
    const value = rawValue.trim();
    if (value === '') {
      throw new RefusedByRule(`${field} was asked for with an empty value`);
    }
    values.set(field, value);
  }
  if (values.size === 0) {
    throw new RefusedByRule('a field request names at least one field');
  }
  return values;
}
