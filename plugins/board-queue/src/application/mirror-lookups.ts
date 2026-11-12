import { BoardQueueError, CredentialRejected } from '../domain/errors.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Logger } from './ports.ts';
import { mirrorLoginKey, mirrorRefAttemptsKey, mirrorRefKey, readCount } from './sync-meta.ts';
import type { LiveState } from '../domain/sync/claim-moves.ts';
import type { LiveClaims, MemberDirectory } from './mirror-audience.ts';
import type { ClaimFeed, WorkMember } from './sync-ports.ts';

/** The server and project whose lookups are kept, so two of them never share an answer. */
export type LookupScope = {
  readonly server: string;
  readonly project: string;
};

/**
 * How many runs in a row ask for one item's reference before the move about it is
 * given up on. Each run that cannot read it leaves the log where the item's page
 * starts, so the mirror files nothing newer while it waits; at five minutes a run
 * this is half an hour, long enough for a server that stumbled to recover and short
 * enough that one item it keeps failing on does not hold every later move for good.
 */
export const MAX_REF_ATTEMPTS = 6;

/**
 * A reference that could not be read. With `retry` the run leaves the page for
 * the next one, which asks again; without it the item has failed as many runs in
 * a row as are allowed, and the move about it is passed over for good.
 */
export type Unresolved = { readonly unresolved: string; readonly retry: boolean };

/**
 * The outside reference of each work item, asked of the server once and kept: a
 * reference never changes, so it is kept in the queue's notes across runs and in
 * memory within one. An item the server says has none is answered as none, for
 * good. An item whose reference cannot be read is answered as unresolved rather
 * than thrown, so the rest of a page is still filed, and the runs in a row that
 * could not read it are counted, so a later run asks again until the count is
 * spent. A refused token is no answer about the item: it is thrown, because every
 * other call of the run would be refused the same way.
 */
export class ItemRefs {
  readonly #feed: ClaimFeed;
  readonly #repository: ActionRepository;
  readonly #scope: LookupScope;
  readonly #logger: Logger;
  readonly #held = new Map<number, string | null>();
  readonly #failed = new Map<number, Unresolved>();

  constructor(feed: ClaimFeed, repository: ActionRepository, scope: LookupScope, logger: Logger) {
    this.#feed = feed;
    this.#repository = repository;
    this.#scope = scope;
    this.#logger = logger;
  }

  async of(item: number): Promise<string | null | Unresolved> {
    if (this.#held.has(item)) {
      return this.#held.get(item) ?? null;
    }
    const failed = this.#failed.get(item);
    if (failed !== undefined) {
      return failed;
    }
    const key = mirrorRefKey(this.#scope.server, this.#scope.project, item);
    const kept = await this.#repository.getMeta(key);
    if (kept !== null) {
      const ref = kept === '' ? null : kept;
      this.#held.set(item, ref);
      return ref;
    }
    const attemptsKey = mirrorRefAttemptsKey(this.#scope.server, this.#scope.project, item);
    let ref: string | null;
    try {
      ref = await this.#feed.itemRef(item);
    } catch (error) {
      if (error instanceof CredentialRejected) {
        throw error;
      }
      const unresolved = await this.#unresolved(item, attemptsKey, error);
      this.#failed.set(item, unresolved);
      return unresolved;
    }
    this.#held.set(item, ref);
    await this.#repository.setMeta(key, ref ?? '');
    await this.#repository.deleteMeta(attemptsKey);
    return ref;
  }

  /** Counts one more run that could not read the item's reference, and says whether another may ask. */
  async #unresolved(item: number, attemptsKey: string, error: unknown): Promise<Unresolved> {
    const reason = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
    const attempts = ((await readCount(this.#repository, attemptsKey)) ?? 0) + 1;
    if (attempts >= MAX_REF_ATTEMPTS) {
      await this.#repository.deleteMeta(attemptsKey);
      this.#logger.error('a work item\'s reference could not be read in as many runs as are allowed; '
        + 'the move about it was passed over', { item, attempts, reason });
      return { unresolved: reason, retry: false };
    }
    await this.#repository.setMeta(attemptsKey, String(attempts));
    this.#logger.warn('a work item\'s reference could not be read; its page is read again by the next run', {
      item,
      attempts,
      reason,
    });
    return { unresolved: reason, retry: true };
  }
}

/**
 * Each member's GitHub login, and the members a login stands for. The members are
 * read once per run, and only when a move names somebody or the run asks whose
 * moves are this worker's; what each one named is kept in the queue's notes, so the
 * login of a member who has since been removed — whose claims the removal ended —
 * is still known when the issue is unassigned. A member who never named a login
 * is left out of an assignment, and said so.
 */
export class MemberLogins implements MemberDirectory {
  readonly #feed: ClaimFeed;
  readonly #repository: ActionRepository;
  readonly #scope: LookupScope;
  readonly #logger: Logger;
  #members: readonly WorkMember[] | null = null;
  readonly #held = new Map<string, string>();

  constructor(feed: ClaimFeed, repository: ActionRepository, scope: LookupScope, logger: Logger) {
    this.#feed = feed;
    this.#repository = repository;
    this.#scope = scope;
    this.#logger = logger;
  }

  async loginsOf(handles: readonly string[]): Promise<string[]> {
    if (handles.length === 0) {
      return [];
    }
    await this.#readOnce();
    const logins: string[] = [];
    for (const handle of handles) {
      const login = this.#held.get(handle)
        ?? await this.#repository.getMeta(mirrorLoginKey(this.#scope.server, this.#scope.project, handle));
      if (login === null || login === '') {
        this.#logger.warn('a member names no GitHub login, so the issue is not assigned to them', { member: handle });
        continue;
      }
      logins.push(login);
    }
    return logins;
  }

  members(): Promise<readonly WorkMember[]> {
    return this.#readOnce();
  }

  async #readOnce(): Promise<readonly WorkMember[]> {
    if (this.#members !== null) {
      return this.#members;
    }
    const members = await this.#feed.members();
    this.#members = members;
    for (const member of members) {
      if (member.login === null) {
        continue;
      }
      this.#held.set(member.handle, member.login);
      const key = mirrorLoginKey(this.#scope.server, this.#scope.project, member.handle);
      await this.#repository.setMeta(key, member.login);
    }
    return members;
  }
}

/** The live claims of the project, read once per run, the first time a move is checked against them. */
export class LiveClaimsOnce implements LiveClaims {
  readonly #feed: ClaimFeed;
  #held: Promise<ReadonlyMap<number, LiveState>> | null = null;

  constructor(feed: ClaimFeed) {
    this.#feed = feed;
  }

  async of(item: number): Promise<LiveState> {
    this.#held ??= this.#feed.liveClaims().then((claims) => new Map(claims.map((claim) => [
      claim.item,
      { holder: claim.holder, inReview: claim.inReview },
    ])));
    return (await this.#held).get(item) ?? null;
  }
}
