import type { IssueRef } from './issue-ref.ts';
import { AmbiguousOption, OptionNotFound } from './errors.ts';

export type CatalogOption = {
  id: string;
  name: string;
};

export type CatalogField = {
  id: string;
  name: string;
  dataType: string;
  options: CatalogOption[];
};

/** The board's own vocabulary: which fields exist and which options each offers. */
export type FieldCatalog = {
  projectId: string;
  fields: CatalogField[];
};

/** One row of the board: the item, the issue it holds, and its single-select values. */
export type ReadItemResult = {
  itemId: string;
  ref: IssueRef;
  values: Record<string, string>;
};

/** Every row, read in one paginated walk and reusable for a short while. */
export type BoardSnapshot = {
  fetchedAt: Date;
  items: ReadItemResult[];
};

/** The catalog as it was last fetched, with the moment it was fetched. */
export type CachedCatalog = {
  fetchedAt: Date;
  catalog: FieldCatalog;
};

export function findCatalogField(catalog: FieldCatalog, name: string): CatalogField | null {
  const needle = name.trim().toLowerCase();
  return catalog.fields.find((field) => field.name.toLowerCase() === needle) ?? null;
}

/**
 * Turns the text a caller typed into one of the board's options.
 *
 * An exact match (ignoring case) wins; otherwise a prefix that fits exactly one
 * option is taken, because the option labels carry prose and nobody retypes them
 * in full. A text that fits nothing, or fits several options, is refused with the
 * list the field accepts — never guessed, never silently skipped.
 */
export function resolveOption(field: CatalogField, wanted: string): CatalogOption {
  const needle = wanted.trim().toLowerCase();
  const accepted = field.options.map((option) => option.name);
  const exact = field.options.filter((option) => option.name.toLowerCase() === needle);
  if (exact.length === 1 && exact[0] !== undefined) {
    return exact[0];
  }
  const prefixed = field.options.filter((option) => option.name.toLowerCase().startsWith(needle));
  if (prefixed.length === 1 && prefixed[0] !== undefined) {
    return prefixed[0];
  }
  if (prefixed.length > 1) {
    throw new AmbiguousOption(field.name, wanted, accepted, prefixed.map((option) => option.name));
  }
  throw new OptionNotFound(field.name, wanted, accepted);
}
