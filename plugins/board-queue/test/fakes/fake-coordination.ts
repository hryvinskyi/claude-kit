import type {
  ClaimFeed,
  ClaimFeedPage,
  ImportAnswer,
  ImportBatch,
  LiveClaim,
  RefusedEdge,
  WorkImport,
  WorkMember,
} from '../../src/application/sync-ports.ts';
import type { BoardQueueError } from '../../src/domain/errors.ts';
import { CursorExpired } from '../../src/domain/errors.ts';
import type { ClaimEvent } from '../../src/domain/sync/claim-moves.ts';

/**
 * One event of the fake log: a claim event; another event the reader sees and has
 * no use for; or one it may not see, which the server leaves out of the page while
 * its cursor moves past it.
 */
export type LoggedEvent = ClaimEvent | { readonly id: number; readonly kind: 'other' | 'hidden' };

export type CoordinationCall = 'page' | 'members' | 'itemRef' | 'liveClaims' | 'putItems';

/**
 * The coordination server, in memory: a log of events, its members, its items'
 * references, and every batch it was sent. A test scripts the refusals it wants
 * and counts what was asked.
 */
export class FakeCoordination implements ClaimFeed, WorkImport {
  readonly calls: CoordinationCall[] = [];
  readonly batches: ImportBatch[] = [];
  readonly pagesAskedFrom: number[] = [];
  /** Events the log removed: a cursor at or before this is refused as expired. */
  prunedThrough = 0;
  /** Edges the server refuses in the next answers, keyed by the item that waits. */
  readonly refuseEdgesOf = new Map<string, RefusedEdge>();

  readonly #events: LoggedEvent[] = [];
  readonly #members: WorkMember[] = [];
  readonly #refs = new Map<number, string | null>();
  readonly #claims: LiveClaim[] = [];
  readonly #scripted = new Map<CoordinationCall, BoardQueueError[]>();

  log(...events: readonly LoggedEvent[]): this {
    this.#events.push(...events);
    return this;
  }

  item(id: number, ref: string | null): this {
    this.#refs.set(id, ref);
    return this;
  }

  /** A claim that is live on the server now. */
  holds(item: number, holder: string, inReview = false): this {
    this.#claims.push({ item, holder, inReview });
    return this;
  }

  /** What removing a member does to the list the server answers. */
  forget(handle: string): this {
    const at = this.#members.findIndex((member) => member.handle === handle);
    if (at >= 0) {
      this.#members.splice(at, 1);
    }
    return this;
  }

  member(handle: string, login: string | null): this {
    this.#members.push({ handle, login });
    return this;
  }

  fail(call: CoordinationCall, error: BoardQueueError): this {
    const queued = this.#scripted.get(call) ?? [];
    queued.push(error);
    this.#scripted.set(call, queued);
    return this;
  }

  page(after: number, limit: number): Promise<ClaimFeedPage> {
    this.#answer('page');
    this.pagesAskedFrom.push(after);
    if (this.prunedThrough > 0 && after < this.prunedThrough) {
      throw new CursorExpired(this.prunedThrough);
    }
    // As the server reads it: up to `limit` events after the cursor, the ones the
    // reader may not see left out, and the cursor moved to the last one read.
    const read = this.#events.filter((event) => event.id > after).slice(0, limit);
    const shown = read.filter((event) => event.kind !== 'hidden');
    const last = read[read.length - 1];
    return Promise.resolve({
      claims: shown.filter((event): event is ClaimEvent => event.kind !== 'other' && event.kind !== 'hidden'),
      shown: shown.length,
      next: last?.id ?? (this.#events.length === 0 && after === 0 ? null : after),
    });
  }

  members(): Promise<WorkMember[]> {
    this.#answer('members');
    return Promise.resolve([...this.#members]);
  }

  itemRef(id: number): Promise<string | null> {
    this.#answer('itemRef');
    return Promise.resolve(this.#refs.get(id) ?? null);
  }

  liveClaims(): Promise<LiveClaim[]> {
    this.#answer('liveClaims');
    return Promise.resolve([...this.#claims]);
  }

  putItems(batch: ImportBatch): Promise<ImportAnswer> {
    this.#answer('putItems');
    this.batches.push(batch);
    const refusedEdges = batch.items
      .map((item) => this.refuseEdgesOf.get(item.ref))
      .filter((edge): edge is RefusedEdge => edge !== undefined);
    return Promise.resolve({
      outcomes: { created: batch.items.length },
      closed: 0,
      refusedEdges,
      droppedHints: [],
    });
  }

  #answer(call: CoordinationCall): void {
    this.calls.push(call);
    const scripted = this.#scripted.get(call)?.shift();
    if (scripted !== undefined) {
      throw scripted;
    }
  }
}

/** A claim event of the fake log, with the defaults a test rarely cares about. */
export function claim(id: number, kind: ClaimEvent['kind'], item: number, member: string, previous?: string): ClaimEvent {
  return { id, kind, item, member, previous: previous ?? null, by: null };
}

/** An admin's release of a member's claim; with no admin, the server's operator's. */
export function forcedRelease(id: number, item: number, holder: string, admin: string | null): ClaimEvent {
  return { id, kind: 'force_released', item, member: holder, previous: null, by: admin };
}
