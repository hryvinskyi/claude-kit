import { findCatalogField, resolveOption } from '../domain/catalog.ts';
import type { FieldCatalog } from '../domain/catalog.ts';
import { BoardQueueError } from '../domain/errors.ts';
import { BOARD_FIELD_OF } from '../domain/kinds/fields.ts';
import { isRecord } from './json-values.ts';

/**
 * What a caller's wanted option texts look like against the catalog as it was
 * last read.
 *
 * These are notes, never refusals. The cached catalog is a snapshot: somebody may
 * have added the option in the board's own interface a minute ago, and refusing
 * the request here would make this system less capable than the board it serves.
 * The worker matches against the live catalog when the action runs, and that
 * match is the one that decides.
 *
 * The same question is worth asking of an action that already failed on it: an
 * empty answer against a freshly read catalog means the board has since been
 * taught the value it was waiting for.
 */
export function catalogWarnings(payload: unknown, catalog: FieldCatalog): string[] {
  return catalogMisses(payload, catalog).map((miss) => miss.warning);
}

/**
 * The payload's field keys whose wanted text the catalog has no option for — a
 * field the board lacks altogether included. Asked of an action the moment it is
 * blocked for a missing option, against the catalog that refused it, this is the
 * record of what the action is waiting for.
 */
export function unansweredOptions(payload: unknown, catalog: FieldCatalog): string[] {
  return catalogMisses(payload, catalog).map((miss) => miss.key);
}

/** One wanted value the catalog cannot answer for: its payload key, and why, in a sentence. */
type CatalogMiss = { key: string; warning: string };

function catalogMisses(payload: unknown, catalog: FieldCatalog): CatalogMiss[] {
  const misses: CatalogMiss[] = [];
  for (const [key, wanted] of wantedOptions(payload)) {
    const boardField = BOARD_FIELD_OF[key] ?? key;
    const field = findCatalogField(catalog, boardField);
    if (field === null) {
      misses.push({ key, warning: `the board's fields, as they were last read, do not include ${boardField}` });
      continue;
    }
    try {
      resolveOption(field, wanted);
    } catch (error) {
      if (!(error instanceof BoardQueueError)) {
        throw error;
      }
      misses.push({ key, warning: `as the board was last read, ${error.describe()}` });
    }
  }
  return misses;
}

/**
 * The wanted field values inside a payload, whatever the payload calls the group
 * that holds them: a write names it after the writing, a comparison after the
 * expectation. They are recognised by their keys, so this stays true for any kind
 * that speaks about board fields without naming a single one of them here.
 */
export function wantedOptions(payload: unknown): [string, string][] {
  if (!isRecord(payload)) {
    return [];
  }
  const wanted: [string, string][] = [];
  for (const group of Object.values(payload)) {
    if (!isRecord(group)) {
      continue;
    }
    for (const [key, value] of Object.entries(group)) {
      if (typeof value === 'string' && Object.hasOwn(BOARD_FIELD_OF, key)) {
        wanted.push([key, value]);
      }
    }
  }
  return wanted;
}
