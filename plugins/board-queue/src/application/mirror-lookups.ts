import { BoardQueueError } from '../domain/errors.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Logger } from './ports.ts';
import { mirrorLoginKey, mirrorRefKey } from './sync-meta.ts';
import type { LiveState } from '../domain/sync/claim-moves.ts';
import type { LiveClaims, MemberDirectory } from './mirror-audience.ts';
import type { ClaimFeed, WorkMember } from './sync-ports.ts';

/** The server and project whose lookups are kept, so two of them never share an answer. */
export type LookupScope = {
  readonly server: string;
  readonly project: string;
};

/** A reference that could not be read, so the move about its item was passed over. */
export type Unresolved = { readonly unresolved: string };

/**
 * The outside reference of each work item, asked of the server once and kept: a
 * reference never changes, so it is kept in the queue's notes across runs and in
 * memory within one. An item whose reference cannot be read is answered as such
 * rather than thrown, so one item the server keeps failing on never holds up the
 * rest of a page.
 */
export class ItemRefs {
  readonly #feed: ClaimFeed;
  readonly #repository: ActionRepository;
  readonly #scope: LookupScope;
  readonly #logger: Logger;
  readonly #held = new Map<number, string | null>();

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
    const key = mirrorRefKey(this.#scope.server, this.#scope.project, item);
    const kept = await this.#repository.getMeta(key);
    if (kept !== null) {
      const ref = kept === '' ? null : kept;
      this.#held.set(item, ref);
      return ref;
    }
    let ref: string | null;
    try {
      ref = await this.#feed.itemRef(item);
    } catch (error) {
      const reason = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
      this.#logger.warn('a work item\'s reference could not be read; the move about it was passed over', {
        item,
        reason,
      });
      return { unresolved: reason };
    }
    this.#held.set(item, ref);
    await this.#repository.setMeta(key, ref ?? '');
    return ref;
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
