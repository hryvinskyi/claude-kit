import type { RowAtBlock, WriteGuard } from '../domain/action.ts';
import { findCatalogField } from '../domain/catalog.ts';
import type { FieldCatalog, FieldReading, ReadItemResult } from '../domain/catalog.ts';
import { BOARD_FIELD_OF } from '../domain/kinds/fields.ts';
import { wantedOptions } from './catalog-warnings.ts';

/**
 * What an action blocked for a missing option takes back onto the queue once the
 * board offers it, under what guard, and why each value it leaves out is left out.
 *
 * The values the board lacked are the decision somebody made by adding the
 * options, so they always run. Every other value the action wanted was answerable
 * when it ran and was not written then, because the write resolves every value
 * before it writes any. Whether it still belongs to this action depends on the
 * row, so it goes back guarded by what the row read when the action blocked, and
 * the write checks that reading right before it happens: a value somebody moved
 * in between — before the release or after it — is left alone. A guard an earlier
 * release set is the older reading and wins, for a value the board lacked too. A
 * value the board no longer offers would only block the action again, and a value
 * whose blocked reading nobody knows cannot be guarded; both are left out.
 */
export type ReplayPlan = {
  /** The payload's field keys the replay carries. */
  keys: string[];
  /** Per carried key that is guarded, what the row must still read. */
  guard: Record<string, FieldReading>;
  /** Per payload key left out, the reason, in a clause that follows "was not written:". */
  leftOut: Map<string, string>;
};

export type ReplayFacts = {
  /** The payload's field keys the board lacked when the action blocked. */
  missing: readonly string[];
  /** Every payload key the action wants, the missing ones included. */
  wanted: readonly string[];
  /** The payload keys the catalog cannot answer for now. */
  unanswered: ReadonlySet<string>;
  /** The row as it read at the block, or null when it could not be read then. */
  atBlock: RowAtBlock | null;
  /** The guard an earlier release set, when the action carries one. */
  earlier: WriteGuard | null;
};

export function planReplay(facts: ReplayFacts): ReplayPlan {
  const missing = new Set(facts.missing);
  const keys: string[] = [];
  const guard: Record<string, FieldReading> = {};
  const leftOut = new Map<string, string>();
  for (const key of new Set(facts.wanted)) {
    const earlier = facts.earlier?.[key];
    if (missing.has(key)) {
      keys.push(key);
      if (earlier !== undefined) {
        guard[key] = earlier;
      }
      continue;
    }
    const field = BOARD_FIELD_OF[key] ?? key;
    if (facts.unanswered.has(key)) {
      leftOut.set(key, `the board no longer offers it in ${field}`);
      continue;
    }
    const reading = earlier ?? facts.atBlock?.[key];
    if (reading === undefined) {
      leftOut.set(key, 'the row could not be read when the action blocked, so nothing tells whether '
        + `${field} has been changed on the board since`);
      continue;
    }
    keys.push(key);
    guard[key] = reading;
  }
  return { keys, guard, leftOut };
}

/**
 * What the row holds for each of these payload keys, read under the board's own
 * field names, with each option's id as the catalog knows it; no value for every
 * key when the issue has no row at all. A key whose field the catalog does not
 * hold is left out: it cannot be compared, so it reads as unknown.
 */
export function rowReadingsOf(
  keys: readonly string[],
  catalog: FieldCatalog,
  row: ReadItemResult | null,
): Record<string, FieldReading> {
  const readings: Record<string, FieldReading> = {};
  for (const key of keys) {
    const field = findCatalogField(catalog, BOARD_FIELD_OF[key] ?? key);
    if (field === null) {
      continue;
    }
    const name = row?.values[field.name] ?? '';
    const optionId = name === '' ? null : field.options.find((option) => option.name === name)?.id ?? null;
    readings[key] = { name, optionId };
  }
  return readings;
}

/**
 * What a release by the board runs again, on what condition, and what it leaves
 * out and why, for a person reading the action later and wondering why a value
 * they once asked for did not land.
 */
export function replayNote(
  filed: unknown,
  replay: unknown,
  plan: ReplayPlan,
): string {
  const replayed = wantedOptions(replay);
  const kept = new Set(replayed.map(([key]) => key));
  const runs = replayed.length === 0
    ? 'the board now offers what this waited for, so it runs again'
    : `the board now offers what this waited for, so it runs again with ${named(replayed)}`;
  const guarded = replayed.filter(([key]) => Object.hasOwn(plan.guard, key)).map(([key]) => key);
  const condition = guarded.length === 0
    ? ''
    : `; ${guarded.join(', ')} only if the row still reads as it did when the action blocked`;
  const left = wantedOptions(filed).filter(([key]) => !kept.has(key));
  if (left.length === 0) {
    return `${runs}${condition}`;
  }
  const clauses = left.map(([key, value]) => {
    const reason = plan.leftOut.get(key) ?? 'it was left out';
    return `${key} "${value}" was not written: ${reason}`;
  });
  return `${runs}${condition}; ${clauses.join('; ')} — file it anew if it still holds`;
}

function named(values: readonly [string, string][]): string {
  return values.map(([key, value]) => `${key} "${value}"`).join(', ');
}
