import type { BoardGateway, CatalogStore, Clock } from '../../src/application/ports.ts';
import type {
  BoardSnapshot,
  CatalogField,
  CatalogOption,
  FieldCatalog,
  ReadItemResult,
} from '../../src/domain/catalog.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';
import { TransientFailure } from '../../src/domain/errors.ts';
import { IssueRef } from '../../src/domain/issue-ref.ts';
import { RateBudget } from '../../src/domain/rate-budget.ts';

/** Every call a test can script a refusal for, named as the port names it. */
export type BoardCall =
  | 'catalog'
  | 'snapshot'
  | 'ensureItem'
  | 'readItemById'
  | 'setSingleSelect'
  | 'probeBudget';

export type SeededItem = {
  ref: IssueRef;
  itemId: string;
  values: Record<string, string>;
};

export type FakeBoardOptions = {
  catalog?: FieldCatalog;
  items?: readonly SeededItem[];
  clock?: Clock;
  /** Where a fetched catalog is left, exactly as the real gateway leaves it. */
  store?: CatalogStore;
  budget?: RateBudget;
  /** How long a fetched catalog stays usable, as the real gateway keeps it. */
  catalogTtlSec?: number;
};

export type WrittenValue = {
  itemId: string;
  fieldId: string;
  optionId: string;
};

const HOUR_AHEAD = (): Date => new Date(Date.now() + 60 * 60 * 1000);

/**
 * The board, in memory.
 *
 * It keeps the two things the real one keeps — a catalog and a set of rows — and
 * writes a fetched catalog into the same store the real gateway writes to, because
 * the worker tells a fetch from a cache hit by the moment that store carries.
 * Everything a test wants to prove about a tick is countable here: which calls
 * were made, which were forced, what landed on which row.
 */
export class FakeBoardGateway implements BoardGateway {
  /** Every call in order, so a test can prove what was and was not asked for. */
  readonly calls: BoardCall[] = [];
  /** One entry per issue the tick asked the board to hold, whether or not it did. */
  readonly ensured: string[] = [];
  readonly written: WrittenValue[] = [];
  catalogFetches = 0;
  forcedCatalogFetches = 0;
  snapshotFetches = 0;
  /** Fields whose writes are accepted and quietly not stored, the way a lost write reads. */
  readonly swallowWrites = new Set<string>();
  /** Runs after every call that reached the board, for a test that moves the allowance. */
  onCall: ((call: BoardCall) => void) | null = null;
  budget: RateBudget;

  readonly #scripted = new Map<BoardCall, BoardQueueError[]>();
  readonly #items = new Map<string, SeededItem>();
  readonly #clock: Clock | null;
  readonly #store: CatalogStore | null;
  readonly #catalogTtlMs: number;
  #catalog: FieldCatalog;
  #held: { catalog: FieldCatalog; fetchedAt: Date } | null = null;
  #nextItem = 0;

  constructor(options: FakeBoardOptions = {}) {
    this.#catalog = options.catalog ?? emptyCatalog();
    this.#clock = options.clock ?? null;
    this.#store = options.store ?? null;
    this.#catalogTtlMs = (options.catalogTtlSec ?? 3600) * 1000;
    this.budget = options.budget ?? new RateBudget({
      resource: 'graphql',
      remaining: 5000,
      limit: 5000,
      used: 0,
      resetAt: HOUR_AHEAD(),
    });
    for (const item of options.items ?? []) {
      this.#items.set(item.ref.key(), { ...item, values: { ...item.values } });
      this.#nextItem += 1;
    }
  }

  /** Scripts the next answer to this call as a refusal. */
  fail(call: BoardCall, error: BoardQueueError): this {
    const queued = this.#scripted.get(call) ?? [];
    queued.push(error);
    this.#scripted.set(call, queued);
    return this;
  }

  /** What somebody adding an option in the board's own interface would do. */
  addOption(fieldName: string, option: CatalogOption): void {
    this.#catalog = {
      projectId: this.#catalog.projectId,
      fields: this.#catalog.fields.map((field) => (field.name === fieldName
        ? { ...field, options: [...field.options, option] }
        : field)),
    };
  }

  valuesOf(ref: IssueRef): Record<string, string> | null {
    const item = this.#items.get(ref.key());
    return item === undefined ? null : { ...item.values };
  }

  async catalog(force = false): Promise<FieldCatalog> {
    this.#answer('catalog');
    const now = this.#now();
    const held = this.#held;
    if (!force && held !== null && now.getTime() - held.fetchedAt.getTime() < this.#catalogTtlMs) {
      return held.catalog;
    }
    this.catalogFetches += 1;
    if (force) {
      this.forcedCatalogFetches += 1;
    }
    this.#held = { catalog: this.#catalog, fetchedAt: now };
    await this.#store?.put(this.#catalog, now);
    return this.#catalog;
  }

  snapshot(_force = false): Promise<BoardSnapshot> {
    this.#answer('snapshot');
    this.snapshotFetches += 1;
    return Promise.resolve({
      fetchedAt: this.#now(),
      items: [...this.#items.values()].map(toReadItem),
    });
  }

  async findItem(ref: IssueRef): Promise<ReadItemResult | null> {
    const snapshot = await this.snapshot();
    return snapshot.items.find((item) => item.ref.equals(ref)) ?? null;
  }

  ensureItem(ref: IssueRef): Promise<string> {
    this.#answer('ensureItem');
    // The real mutation is sent every time and hands back the row that is already
    // there; nothing here infers membership from the issue's side either.
    this.ensured.push(ref.toString());
    const existing = this.#items.get(ref.key());
    if (existing !== undefined) {
      return Promise.resolve(existing.itemId);
    }
    this.#nextItem += 1;
    const itemId = `item-${String(this.#nextItem)}`;
    this.#items.set(ref.key(), { ref, itemId, values: {} });
    return Promise.resolve(itemId);
  }

  readItemById(itemId: string): Promise<ReadItemResult> {
    this.#answer('readItemById');
    const item = [...this.#items.values()].find((candidate) => candidate.itemId === itemId);
    if (item === undefined) {
      throw new TransientFailure(`the board row ${itemId} answered nothing`);
    }
    return Promise.resolve(toReadItem(item));
  }

  setSingleSelect(itemId: string, fieldId: string, optionId: string): Promise<void> {
    this.#answer('setSingleSelect');
    this.written.push({ itemId, fieldId, optionId });
    const item = [...this.#items.values()].find((candidate) => candidate.itemId === itemId);
    const field = this.#catalog.fields.find((candidate) => candidate.id === fieldId);
    const option = field?.options.find((candidate) => candidate.id === optionId);
    if (item === undefined || field === undefined || option === undefined) {
      throw new TransientFailure(`the board refused a value for the row ${itemId}`);
    }
    if (!this.swallowWrites.has(field.name)) {
      item.values[field.name] = option.name;
    }
    return Promise.resolve();
  }

  async membership(refs: readonly IssueRef[]): Promise<Map<string, ReadItemResult | 'missing'>> {
    const snapshot = await this.snapshot();
    const found = new Map<string, ReadItemResult | 'missing'>();
    for (const ref of refs) {
      found.set(ref.key(), snapshot.items.find((item) => item.ref.equals(ref)) ?? 'missing');
    }
    return found;
  }

  probeBudget(): Promise<RateBudget> {
    this.#answer('probeBudget');
    return Promise.resolve(this.budget);
  }

  lastBudget(): RateBudget | null {
    return this.budget;
  }

  #now(): Date {
    return this.#clock?.now() ?? new Date();
  }

  #answer(call: BoardCall): void {
    this.calls.push(call);
    const scripted = this.#scripted.get(call)?.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
    this.onCall?.(call);
  }
}

function toReadItem(item: SeededItem): ReadItemResult {
  return { itemId: item.itemId, ref: item.ref, values: { ...item.values } };
}

function emptyCatalog(): FieldCatalog {
  return { projectId: 'project-1', fields: [] };
}

/** A field with the options a test wants it to have, ids derived from the names. */
export function catalogField(name: string, options: readonly string[]): CatalogField {
  return {
    id: `field-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    dataType: 'SINGLE_SELECT',
    options: options.map((option) => ({ id: optionId(name, option), name: option })),
  };
}

export function optionId(field: string, option: string): string {
  return `option-${field.toLowerCase().replace(/\s+/g, '-')}-${option.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

export function catalogOf(...fields: readonly CatalogField[]): FieldCatalog {
  return { projectId: 'project-1', fields: [...fields] };
}

export function seedItem(ref: IssueRef, itemId: string, values: Record<string, string> = {}): SeededItem {
  return { ref, itemId, values };
}

export function refOf(repo: string, issue: number): IssueRef {
  return IssueRef.of(repo, issue);
}
