import { emptyActionCounts } from '../../src/application/action-states.ts';
import type { ActionCounts, ActionFilter, ActionRepository, MetaWrite } from '../../src/application/ports.ts';
import { Action } from '../../src/domain/action.ts';
import type { ActionProps } from '../../src/domain/action.ts';
import type { BoardKey } from '../../src/domain/board-directory.ts';
import type { CachedCatalog, FieldCatalog } from '../../src/domain/catalog.ts';
import { StaleAction } from '../../src/domain/errors.ts';
import type { IssueRef } from '../../src/domain/issue-ref.ts';
import type { QueuePause } from '../../src/domain/queue-pause.ts';

type StoredAction = {
  props: ActionProps;
  /** The order it was written in, which settles two actions filed in one millisecond. */
  seq: number;
};

/**
 * The queue without a database, for the use cases' own tests.
 *
 * It keeps rows, not aggregates: an action goes in as values and comes back out as
 * a fresh aggregate, so a test cannot accidentally hold the same object the store
 * holds and the version guard means here exactly what it means on disk.
 */
export class InMemoryActionRepository implements ActionRepository {
  readonly #rows = new Map<string, StoredAction>();
  readonly #meta = new Map<string, string>();
  #pause: QueuePause | null = null;
  readonly #catalogs = new Map<BoardKey, CachedCatalog>();
  #seq = 0;
  #lockHolders = 0;

  /**
   * Makes the next fold answer "no row changed", the way a store does when a
   * worker claimed the waiting action between the search and the write.
   */
  refuseNextCoalesce = false;

  /**
   * Runs once, just before the next fold, so a test can let another writer reach
   * the same row first — which is the whole of the race the guard exists for.
   */
  beforeNextCoalesce: (() => Promise<void>) | null = null;

  /**
   * Thrown by the next write, the way a store that is out of disk or has lost its
   * file fails: not a lost race, which the version guard reports, but a write that
   * never landed at all.
   */
  failNextUpdateWith: Error | null = null;

  /**
   * What another writer does to a row somebody else is holding: it changes, and
   * the copy in hand is no longer the row it was read from.
   */
  changeBehindTheBackOf(id: string): void {
    const stored = this.#stored(id);
    stored.props = { ...stored.props, version: stored.props.version + 1 };
  }

  /** What a transient failure does to a waiting row: it steps back into a wait. */
  delayBehindTheBackOf(id: string, notBefore: Date): void {
    const stored = this.#stored(id);
    stored.props = { ...stored.props, notBefore: new Date(notBefore.getTime()) };
  }

  #stored(id: string): StoredAction {
    const stored = this.#rows.get(id);
    if (stored === undefined) {
      throw new Error(`the queue holds no action with the id "${id}"`);
    }
    return stored;
  }

  /**
   * Thrown by the next batch write after it has written part of its rows, the way
   * a store that fails mid-transaction does; nothing of that batch stays.
   */
  failNextBatchWith: Error | null = null;

  insert(action: Action): Promise<boolean> {
    if (this.#rows.has(action.id)) {
      throw new Error(`the queue already holds an action with the id "${action.id}"`);
    }
    if (this.#carriesTakenKey(action)) {
      return Promise.resolve(false);
    }
    this.#seq += 1;
    this.#rows.set(action.id, { props: copy(action.props()), seq: this.#seq });
    action.markPersisted();
    return Promise.resolve(true);
  }

  async insertAll(actions: readonly Action[], meta: readonly MetaWrite[]): Promise<string[]> {
    const rowsBefore = new Map(this.#rows);
    const metaBefore = new Map(this.#meta);
    const seqBefore = this.#seq;
    try {
      const written: string[] = [];
      for (const action of actions) {
        if (await this.insert(action)) {
          written.push(action.id);
        }
      }
      const breaks = this.failNextBatchWith;
      if (breaks !== null) {
        this.failNextBatchWith = null;
        throw breaks;
      }
      for (const entry of meta) {
        this.#meta.set(entry.key, entry.value);
      }
      return written;
    } catch (error) {
      this.#rows.clear();
      for (const [id, row] of rowsBefore) {
        this.#rows.set(id, row);
      }
      this.#meta.clear();
      for (const [key, value] of metaBefore) {
        this.#meta.set(key, value);
      }
      this.#seq = seqBefore;
      throw error;
    }
  }

  findByDedupeKey(key: string): Promise<Action | null> {
    const found = [...this.#rows.values()].find((stored) => stored.props.dedupeKey === key);
    return Promise.resolve(found === undefined ? null : rebuild(found));
  }

  #carriesTakenKey(action: Action): boolean {
    const key = action.dedupeKey;
    return key !== null && [...this.#rows.values()].some((stored) => stored.props.dedupeKey === key);
  }

  update(action: Action): Promise<void> {
    const breaks = this.failNextUpdateWith;
    if (breaks !== null) {
      this.failNextUpdateWith = null;
      throw breaks;
    }
    const stored = this.#rows.get(action.id);
    if (stored === undefined || stored.props.version !== action.persistedVersion) {
      throw new StaleAction(action.id, action.persistedVersion);
    }
    stored.props = copy(action.props());
    action.markPersisted();
    return Promise.resolve();
  }

  get(id: string): Promise<Action | null> {
    const stored = this.#rows.get(id);
    return Promise.resolve(stored === undefined ? null : rebuild(stored));
  }

  findCoalescible(kind: string, issueRef: IssueRef, now: Date): Promise<Action | null> {
    const waiting = this.#ordered().filter((stored) => stored.props.kind === kind
      && stored.props.state === 'queued'
      && isPast(stored.props.notBefore, now)
      && stored.props.issueRef !== null
      && stored.props.issueRef.equals(issueRef));
    const first = waiting[0];
    return Promise.resolve(first === undefined ? null : rebuild(first));
  }

  async coalesceInto(
    id: string,
    mergedPayload: unknown,
    now: Date,
    expectedVersion: number,
  ): Promise<boolean> {
    const first = this.beforeNextCoalesce;
    if (first !== null) {
      this.beforeNextCoalesce = null;
      await first();
    }
    if (this.refuseNextCoalesce) {
      this.refuseNextCoalesce = false;
      return Promise.resolve(false);
    }
    const stored = this.#rows.get(id);
    if (stored === undefined
      || stored.props.state !== 'queued'
      || stored.props.version !== expectedVersion
      || !isPast(stored.props.notBefore, now)) {
      return Promise.resolve(false);
    }
    stored.props = {
      ...stored.props,
      payload: clonePayload(mergedPayload),
      updatedAt: new Date(now.getTime()),
      version: stored.props.version + 1,
    };
    return Promise.resolve(true);
  }

  claimNextRunnable(now: Date): Promise<Action | null> {
    const ordered = this.#ordered();
    const next = ordered.find((candidate) => candidate.props.state === 'queued'
      && isPast(candidate.props.notBefore, now)
      && !ordered.some((earlier) => earlier.props.id !== candidate.props.id
        && refKey(earlier.props) === refKey(candidate.props)
        && (earlier.props.state === 'queued' || earlier.props.state === 'running')
        && isEarlier(earlier, candidate)));
    if (next === undefined) {
      return Promise.resolve(null);
    }
    const action = rebuild(next);
    action.start(now);
    next.props = copy(action.props());
    action.markPersisted();
    return Promise.resolve(action);
  }

  list(filter: ActionFilter): Promise<Action[]> {
    const repo = filter.repo?.trim().toLowerCase();
    let matching = this.#ordered().filter((stored) => {
      const props = stored.props;
      if (filter.states !== undefined && filter.states.length > 0 && !filter.states.includes(props.state)) {
        return false;
      }
      if (repo !== undefined && (props.issueRef === null
        || props.issueRef.repoFullName().toLowerCase() !== repo)) {
        return false;
      }
      if (filter.issue !== undefined && props.issueRef?.number !== filter.issue) {
        return false;
      }
      return filter.kind === undefined || props.kind === filter.kind;
    });
    if (filter.limit !== undefined) {
      matching = matching.slice(0, filter.limit);
    }
    return Promise.resolve(matching.map(rebuild));
  }

  counts(): Promise<ActionCounts> {
    const counts = emptyActionCounts();
    for (const stored of this.#rows.values()) {
      counts[stored.props.state] += 1;
    }
    return Promise.resolve(counts);
  }

  getPause(): Promise<QueuePause | null> {
    return Promise.resolve(this.#pause);
  }

  setPause(pause: QueuePause | null): Promise<void> {
    this.#pause = pause;
    return Promise.resolve();
  }

  getMeta(key: string): Promise<string | null> {
    return Promise.resolve(this.#meta.get(key) ?? null);
  }

  setMeta(key: string, value: string): Promise<void> {
    this.#meta.set(key, value);
    return Promise.resolve();
  }

  getCatalog(board: BoardKey): Promise<CachedCatalog | null> {
    return Promise.resolve(this.#catalogs.get(board) ?? null);
  }

  putCatalog(board: BoardKey, catalog: FieldCatalog, fetchedAt: Date): Promise<void> {
    this.#catalogs.set(board, { fetchedAt: new Date(fetchedAt.getTime()), catalog });
    return Promise.resolve();
  }

  /**
   * Another process holding the lock, which is the one thing a single-process test
   * cannot otherwise arrange.
   */
  pretendAnotherTickHolds = false;

  async withTickLock<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.pretendAnotherTickHolds || this.#lockHolders > 0) {
      return null;
    }
    this.#lockHolders += 1;
    try {
      return await fn();
    } finally {
      this.#lockHolders -= 1;
    }
  }

  #ordered(): StoredAction[] {
    return [...this.#rows.values()].sort(
      (one, other) => one.props.createdAt.getTime() - other.props.createdAt.getTime() || one.seq - other.seq,
    );
  }
}

function isEarlier(one: StoredAction, other: StoredAction): boolean {
  const difference = one.props.createdAt.getTime() - other.props.createdAt.getTime();
  return difference === 0 ? one.seq < other.seq : difference < 0;
}

function refKey(props: ActionProps): string {
  return props.issueRef === null ? '' : props.issueRef.key();
}

function isPast(moment: Date | null, now: Date): boolean {
  return moment === null || moment.getTime() <= now.getTime();
}

function copy(props: ActionProps): ActionProps {
  return {
    ...props,
    payload: clonePayload(props.payload),
    notBefore: props.notBefore === null ? null : new Date(props.notBefore.getTime()),
    createdAt: new Date(props.createdAt.getTime()),
    updatedAt: new Date(props.updatedAt.getTime()),
  };
}

/** The same round trip a stored payload makes, so a test sees what a reader would. */
function clonePayload(payload: unknown): unknown {
  return payload === undefined ? null : JSON.parse(JSON.stringify(payload)) as unknown;
}

function rebuild(stored: StoredAction): Action {
  return new Action(copy(stored.props));
}
