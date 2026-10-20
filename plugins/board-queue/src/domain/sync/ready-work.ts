import type { IssueFacts } from '../catalog.ts';
import type { IssueRef } from '../issue-ref.ts';
import { externalRefOf } from './external-ref.ts';

/** The most items the coordination server takes in one batch. */
export const MAX_BATCH_ITEMS = 500;

/** The priority the coordination server gives an item when nothing says otherwise. */
export const DEFAULT_PRIORITY = 2;

/** One board row that holds an issue of a repository kept in step, with what the board says about it. */
export type BoardWork = {
  readonly ref: IssueRef;
  readonly issue: IssueFacts;
  /** The row's single-select values, field name → option text. */
  readonly values: Readonly<Record<string, string>>;
};

/** An issue a dependency answer named, with what that answer said about it. */
export type Blocker = {
  readonly ref: IssueRef;
  readonly title: string;
  readonly state: 'open' | 'closed';
};

/** How the board's own vocabulary is read into the coordination server's. */
export type WorkVocabulary = {
  readonly source: string;
  /** The board's Module options and the areas each stands for. */
  readonly modules: Readonly<Record<string, readonly string[]>>;
  /** Severity option prefixes and the priority each stands for. */
  readonly priorities: Readonly<Record<string, number>>;
  readonly statusField: string;
  readonly moduleField: string;
  readonly severityField: string;
};

/** An item as it is sent: a listed item of the board, or one carried only because a listed item waits for it. */
export type PlannedItem = {
  readonly ref: string;
  readonly title: string;
  readonly closed: boolean;
  readonly listing: {
    readonly priority: number;
    readonly areasHint: readonly string[];
    readonly sourceStatus: string | null;
    readonly blockedBy: readonly string[];
  } | null;
};

export type PlannedBatch = {
  readonly complete: boolean;
  readonly items: readonly PlannedItem[];
};

export type ImportPlan = {
  readonly batches: readonly PlannedBatch[];
  /** Whether the last batch says it names every open item of the source. */
  readonly complete: boolean;
  /** Why it does not, when it does not. */
  readonly incompleteBecause: string | null;
  /** Items across every batch, a blocker counted once per batch that carries it. */
  readonly items: number;
  /** How many listed items are open. */
  readonly open: number;
};

export type ImportInput = {
  readonly work: readonly BoardWork[];
  /** What blocks each listed issue, keyed by `ref.key()`. */
  readonly blockers: ReadonlyMap<string, readonly Blocker[]>;
  /** Whether every row of every board that carries a repository kept in step was read in this run. */
  readonly boardsReadWhole: boolean;
  /** Why they were not, when they were not. */
  readonly unreadBecause: string | null;
  /** How many items were open at the last import that said it was complete, or null when none did. */
  readonly lastCompleteOpen: number | null;
  readonly vocabulary: WorkVocabulary;
};

/** A listed item, the blockers it needs carried beside it, and whether it is open. */
type Unit = {
  readonly item: PlannedItem;
  readonly carried: readonly PlannedItem[];
  readonly open: boolean;
};

/**
 * The batches one import sends, in the order they are sent.
 *
 * A batch that says it is complete makes the server close every open item of the
 * source it does not name, so only one batch may say so, and only when it names
 * every open item: it goes last, holding the open items and what blocks them,
 * after the closed items have been sent in batches of their own. When the open
 * items alone do not fit one batch, or the boards were not read whole, no batch
 * says it is complete — an item that left the board then stays in the server's
 * ready list until a whole read can say so, which is the safe way to be wrong.
 *
 * Every issue a dependency answer names travels in the same batch as the item that
 * waits for it, under its own reference, so a blocker in another repository still
 * blocks. One that is not itself on the board is carried as a blocker only: it
 * belongs to no source, so a complete batch never closes it.
 */
export function planImport(input: ImportInput): ImportPlan {
  const listed = new Set(input.work.map((work) => externalRefOf(work.ref)));
  const units = input.work.map((work): Unit => {
    const blockers = input.blockers.get(work.ref.key()) ?? [];
    return {
      item: listedItem(work, blockers, input.vocabulary),
      carried: blockers
        .filter((blocker) => !listed.has(externalRefOf(blocker.ref)))
        .map(carriedItem),
      open: work.issue.state === 'open',
    };
  });
  const open = units.filter((unit) => unit.open);
  const closed = units.filter((unit) => !unit.open);
  const finalBatch = pack(open);
  const fell = suddenDrop(open.length, input.lastCompleteOpen);

  if (finalBatch.length <= 1 && input.boardsReadWhole && fell === null) {
    const batches = [...pack(closed).map(incomplete), { complete: true, items: finalBatch[0] ?? [] }];
    return { batches, complete: true, incompleteBecause: null, items: count(batches), open: open.length };
  }
  const batches = [...pack(closed), ...finalBatch].map(incomplete);
  const because = !input.boardsReadWhole
    ? input.unreadBecause ?? 'the boards were not read whole'
    : fell ?? `the open items and what blocks them are more than one batch of ${String(MAX_BATCH_ITEMS)}`;
  return { batches, complete: false, incompleteBecause: because, items: count(batches), open: open.length };
}

/**
 * Why a batch that would close every open item it does not name should not say it
 * is complete: the open items fell to none, or to fewer than half of those the last
 * complete import named. A board read through the wrong credential, or a
 * configuration that lost a repository, reads exactly like that, and closing the
 * rest on the server would empty everybody's ready list at once. The items are
 * still sent; only the closing waits for a person to look.
 */
function suddenDrop(openNow: number, openBefore: number | null): string | null {
  if (openBefore === null || openBefore === 0) {
    return null;
  }
  if (openNow === 0 || openNow * 2 < openBefore) {
    return `the open items fell from ${String(openBefore)} to ${String(openNow)} since the last complete import, `
      + 'so this one closes nothing on the server; check the board and the configuration';
  }
  return null;
}

/**
 * The priority a Severity stands for: the longest configured prefix that fits it,
 * so `S1` never takes `S10`. A Severity nothing fits, or none, is the default.
 */
export function priorityOf(severity: string | undefined, priorities: Readonly<Record<string, number>>): number {
  const value = (severity ?? '').trim().toLowerCase();
  if (value === '') {
    return DEFAULT_PRIORITY;
  }
  let best: { length: number; priority: number } | null = null;
  for (const [prefix, priority] of Object.entries(priorities)) {
    const needle = prefix.trim().toLowerCase();
    if (needle !== '' && value.startsWith(needle) && (best === null || needle.length > best.length)) {
      best = { length: needle.length, priority };
    }
  }
  return best?.priority ?? DEFAULT_PRIORITY;
}

/** The areas a Module stands for; a Module with no entry hints at nothing. */
export function areasOf(module: string | undefined, modules: Readonly<Record<string, readonly string[]>>): string[] {
  const value = (module ?? '').trim().toLowerCase();
  if (value === '') {
    return [];
  }
  for (const [name, areas] of Object.entries(modules)) {
    if (name.trim().toLowerCase() === value) {
      return [...areas];
    }
  }
  return [];
}

function listedItem(work: BoardWork, blockers: readonly Blocker[], vocabulary: WorkVocabulary): PlannedItem {
  return {
    ref: externalRefOf(work.ref),
    title: work.issue.title,
    closed: work.issue.state === 'closed',
    listing: {
      priority: priorityOf(valueOf(work.values, vocabulary.severityField), vocabulary.priorities),
      areasHint: areasOf(valueOf(work.values, vocabulary.moduleField), vocabulary.modules),
      sourceStatus: valueOf(work.values, vocabulary.statusField) ?? null,
      blockedBy: [...new Set(blockers.map((blocker) => externalRefOf(blocker.ref)))],
    },
  };
}

function carriedItem(blocker: Blocker): PlannedItem {
  return { ref: externalRefOf(blocker.ref), title: blocker.title, closed: blocker.state === 'closed', listing: null };
}

/**
 * Units into batches of at most the server's limit, each listed item with the
 * blockers it needs carried in the same batch, and every reference once per batch.
 */
function pack(units: readonly Unit[]): PlannedItem[][] {
  const batches: PlannedItem[][] = [];
  let current: PlannedItem[] = [];
  let refs = new Set<string>();
  const wantedBy = (unit: Unit): PlannedItem[] =>
    dedupe([unit.item, ...unit.carried]).filter((item) => !refs.has(item.ref));
  for (const unit of units) {
    let wanted = wantedBy(unit);
    if (current.length > 0 && current.length + wanted.length > MAX_BATCH_ITEMS) {
      batches.push(current);
      current = [];
      refs = new Set<string>();
      wanted = wantedBy(unit);
    }
    for (const item of wanted) {
      refs.add(item.ref);
      current.push(item);
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function dedupe(items: readonly PlannedItem[]): PlannedItem[] {
  return items.filter((item, index) => items.findIndex((other) => other.ref === item.ref) === index);
}

function incomplete(items: readonly PlannedItem[]): PlannedBatch {
  return { complete: false, items };
}

function count(batches: readonly PlannedBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.items.length, 0);
}

function valueOf(values: Readonly<Record<string, string>>, field: string): string | undefined {
  const needle = field.trim().toLowerCase();
  for (const [name, value] of Object.entries(values)) {
    if (name.trim().toLowerCase() === needle) {
      return value;
    }
  }
  return undefined;
}
