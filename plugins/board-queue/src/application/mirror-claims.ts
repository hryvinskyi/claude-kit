import type { Action } from '../domain/action.ts';
import type { BoardDirectory } from '../domain/board-directory.ts';
import { BoardQueueError, CursorExpired, StaleAction } from '../domain/errors.ts';
import { STILL_TO_RUN_STATES } from '../domain/issue-order.ts';
import type { IssueRef } from '../domain/issue-ref.ts';
import type { KindRegistry } from '../domain/kinds/registry.ts';
import { boardStatusOf, collapseClaims, statusesTheMirrorOwns } from '../domain/sync/claim-moves.ts';
import type { IssueMove } from '../domain/sync/claim-moves.ts';
import { issueRefOfExternal } from '../domain/sync/external-ref.ts';
import type { MirrorConfig, SyncConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import { confirmStillHeld, TickLockLost } from './leased-gateways.ts';
import { draftAction } from './enqueue-action.ts';
import type { EnqueueRequest } from './enqueue-action.ts';
import { everyone } from './mirror-audience.ts';
import type { Audience, AudienceRefusal, LiveClaims, MirrorAudience } from './mirror-audience.ts';
import { ItemRefs, LiveClaimsOnce, MemberLogins } from './mirror-lookups.ts';
import type { ActionRepository, Clock, Logger, MetaWrite, TickLease } from './ports.ts';
import {
  mirrorCursorKey,
  mirrorCursorWrite,
  mirrorItemKey,
  mirrorPendingKey,
  mirrorPendingWrite,
  readCount,
  readMirrorCursor,
  readMirrorPending,
  readMirrorRun,
  writeMirrorRun,
} from './sync-meta.ts';
import type { MirrorRun, PendingMove, StoredCursor } from './sync-meta.ts';
import type { ClaimFeed, ClaimFeedPage, LiveClaim } from './sync-ports.ts';

/** The most events one page of the log holds, which is the most the server hands out. */
export const FEED_PAGE_SIZE = 500;

/**
 * The most pages one run follows. A worker that was asleep for a day catches up
 * over a few runs rather than holding the tick for the whole backlog.
 */
const MAX_PAGES_PER_RUN = 5;

/**
 * The most pages a start from the head reads before giving up. Those pages file
 * nothing and cost the server a read each; a log that has not ended by then is a
 * server answering wrongly, not a long log.
 */
const MAX_PAGES_TO_THE_HEAD = 1000;

const ORIGIN = 'the claim mirror';

/** An item whose reference a later run asks for again, so its page is kept for that run. */
const RETRY = Symbol('retry');

/** Whether an action is one the mirror filed. */
export function isMirrored(action: { readonly origin: string }): boolean {
  return action.origin === ORIGIN;
}

/** Why the waiting actions of a move the server has moved on from end without running. */
const OVERTAKEN = 'the server no longer shows the state this move left, so a later move is what the row shows';

/** The actions one filing makes, each named by its part in the filing's dedupe keys. */
const REQUEST_PARTS = ['status', 'assignees'] as const;
type RequestPart = (typeof REQUEST_PARTS)[number];

/**
 * Which refusals the log repeats at every run. A login that cannot be read is a
 * fault of this machine somebody should fix; a login the project does not know is
 * a standing state of the configuration, said once when it starts or changes.
 */
const SAID_AT_EVERY_RUN: { readonly [K in AudienceRefusal]: boolean } = {
  'login-unreadable': true,
  'no-member': false,
  ambiguous: false,
};

/** What one run of the mirror did, in the words a log line and a status report use. */
export type MirrorReport = MirrorRun;

/**
 * One run of the mirror as the pass sees it: what it did, and which of the
 * mirrored actions still queued may run in this pass — those it filed in this run
 * and those whose move it found still standing. Every other mirrored action waits
 * for a run that can say so.
 */
export type MirrorPass = {
  readonly report: MirrorReport;
  readonly cleared: ReadonlySet<string>;
};

export type MirrorClaimsDeps = {
  feed: ClaimFeed;
  repository: ActionRepository;
  kinds: KindRegistry;
  directory: BoardDirectory;
  sync: SyncConfig;
  mirror: MirrorConfig;
  clock: Clock;
  logger: Logger;
  /** Whose moves are filed; everybody's unless the deployment says otherwise. */
  audience?: MirrorAudience;
  /** How many events one page asks for; the server's own limit unless a test says otherwise. */
  pageSize?: number;
};

/** One state to file for one issue, and the event that state is as of. */
type Filing = {
  readonly item: number;
  readonly ref: IssueRef;
  /** What the server must still show when the filed actions are about to run. */
  readonly standing: PendingMove;
  /** The event the state is as of: the last one of the item's run, or the head of a fresh start. */
  readonly asOf: number;
  /** What makes each action's key: the event, or the head and the item. */
  readonly key: string;
  readonly status: string | null;
  readonly assign: readonly string[];
  readonly unassign: readonly string[];
};

type Drafted = {
  actions: Action[];
  marks: MetaWrite[];
};

/**
 * Claims on the coordination server, carried onto the boards as filed work.
 *
 * Each run follows the server's log after the cursor, page by page. A page can
 * hold nothing and still not be the end — the server leaves out what this reader
 * may not see while its cursor moves past it — so the run goes on for as long as
 * the cursor moves, and saves where every page left it. The claim events of a page
 * collapse to one move per issue, the state the last of them left behind, and a
 * move files a status write and an assignment. The status write is conditional on
 * the row still carrying a status the mirror itself writes, or none: a late event
 * never pulls a row back out of a column somebody else moved it to.
 *
 * With no cursor yet — the first run — and when the log no longer keeps what came
 * after the cursor, the mirror does not replay the log: it reads to its head
 * without filing anything and files, for every live claim, the state that claim
 * stands for now. A cursor note that is not a cursor is an error shown in every
 * status report, never read as the start of the log.
 *
 * The cursor, and the last event filed for each item, are written in the same
 * transaction as the actions, so a run that dies leaves all of it or none. A move
 * as of an event no later than one already filed for the item is not filed again,
 * however the pages fell; the key every action carries — the event its state is as
 * of — is the store's own backstop against filing one state twice.
 *
 * A run first settles whose moves it files: everybody's, or only those of the
 * person this worker runs as — and, in the owner's worker, those no person's
 * worker can file. A move is the move of whoever caused the last event of its
 * item, so a page that holds one person's claim and another's takeover of it files
 * one move, in the taker's worker; a fresh start files only the live claims that
 * person holds. A worker that files only some moves files one only while the
 * server still shows the state it left, because other workers file theirs on
 * schedules of their own. A run that cannot settle whose moves it files reads and
 * files nothing, leaves the cursor where it was, and says why.
 *
 * A move can stand when it is filed and be overtaken before its actions run — the
 * queue waited out a limit while another worker filed and ran a later move of the
 * same item. So each run, before it reads the log and before the tick drains the
 * queue, asks again of every move whose actions are still waiting whether it still
 * stands, and withdraws the actions of one that does not: they end skipped, and
 * write nothing over the later move. A pass in which that could not be asked —
 * the run declined, stopped before it, or did not run — leaves the mirrored
 * actions queued rather than run them unasked (`RunTick`).
 *
 * It writes nothing to GitHub itself: what it files is drained by the worker,
 * paced like any other work.
 */
export class MirrorClaims {
  readonly #feed: ClaimFeed;
  readonly #repository: ActionRepository;
  readonly #kinds: KindRegistry;
  readonly #directory: BoardDirectory;
  readonly #sync: SyncConfig;
  readonly #mirror: MirrorConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #pageSize: number;
  readonly #audience: MirrorAudience;
  readonly #repos: ReadonlySet<string>;
  readonly #cursorKey: string;
  readonly #pendingKey: string;
  readonly #owned: readonly string[];

  constructor(deps: MirrorClaimsDeps) {
    this.#feed = deps.feed;
    this.#repository = deps.repository;
    this.#kinds = deps.kinds;
    this.#directory = deps.directory;
    this.#sync = deps.sync;
    this.#mirror = deps.mirror;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#pageSize = deps.pageSize ?? FEED_PAGE_SIZE;
    this.#audience = deps.audience ?? everyone;
    this.#repos = new Set(deps.sync.repos.map((repo) => repo.toLowerCase()));
    this.#cursorKey = mirrorCursorKey(deps.sync.server, deps.sync.project);
    this.#pendingKey = mirrorPendingKey(deps.sync.server, deps.sync.project);
    this.#owned = statusesTheMirrorOwns(deps.mirror.status);
  }

  /**
   * One run under the tick lock the lease stands for. Each page's filings and the
   * cursor that follows them are written only while the lock is still this run's;
   * a run that finds it taken throws `TickLockLost` and keeps nothing, so the run
   * holding the lock reads on from where the cursor stood.
   */
  async execute(lease: TickLease): Promise<MirrorReport> {
    return (await this.pass(lease)).report;
  }

  /** One run, with the mirrored actions it cleared to run in this pass. */
  async pass(lease: TickLease): Promise<MirrorPass> {
    const cleared = new Set<string>();
    const before = await readMirrorRun(this.#repository);
    const stored = await readMirrorCursor(this.#repository, this.#cursorKey);
    const report: MirrorReport = {
      at: this.#clock.now().toISOString(),
      events: 0,
      filed: 0,
      duplicates: 0,
      ignored: 0,
      refused: 0,
      unresolved: 0,
      cursor: stored.kind === 'at' ? stored.cursor : 0,
      error: null,
      cursorExpired: before?.cursorExpired ?? null,
      startedFromHead: before?.startedFromHead ?? null,
      filedFor: null,
      othersMoves: 0,
      orphanMoves: 0,
      staleMoves: 0,
      declined: null,
      ownerWarning: null,
    };
    const logins = new MemberLogins(this.#feed, this.#repository, this.#sync, this.#logger);
    let refusal: AudienceRefusal | null = null;
    try {
      const answer = await this.#audience.resolve(logins);
      if (answer.ok) {
        report.filedFor = answer.audience.filedFor;
        report.ownerWarning = answer.warning;
        const lookups: Lookups = {
          refs: new ItemRefs(this.#feed, this.#repository, this.#sync, this.#logger),
          logins,
          audience: answer.audience,
          live: new LiveClaimsOnce(this.#feed),
          lease,
          pending: await readMirrorPending(this.#repository, this.#pendingKey),
          cleared,
        };
        await this.#withdrawOvertaken(report, lookups);
        await this.#read(report, stored, lookups);
      } else {
        report.declined = answer.reason;
        refusal = answer.refusal;
      }
    } catch (error) {
      if (error instanceof TickLockLost) {
        throw error;
      }
      report.error = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
      this.#logger.warn('the claim mirror stopped', { reason: report.error, cursor: report.cursor });
    }
    await writeMirrorRun(this.#repository, report);
    if (report.ownerWarning !== null) {
      this.#logger.warn('the configured owner is no member of the project', { reason: report.ownerWarning });
    }
    if (report.declined === null) {
      this.#logger.info('claims mirrored', { ...report });
    } else if (refusal !== null && (SAID_AT_EVERY_RUN[refusal] || before?.declined !== report.declined)) {
      this.#logger.warn('the claim mirror files nothing on this worker', { reason: report.declined });
    }
    return { report, cleared };
  }

  /** Reads the log from where the cursor stands: from the head when there is none yet. */
  async #read(report: MirrorReport, stored: StoredCursor, lookups: Lookups): Promise<void> {
    if (stored.kind === 'unreadable') {
      throw new Error(
        `the mirror's cursor note reads "${stored.stored}", which is not a position in the log; `
        + `nothing is read until it is corrected or removed (${this.#cursorKey})`,
      );
    }
    if (stored.kind === 'none') {
      await this.#startFromTheHead(report, lookups, 0, 'it had never run');
      return;
    }
    await this.#follow(report, lookups);
  }

  /** Follows the log from the cursor for as long as the cursor moves, a few pages at most. */
  async #follow(report: MirrorReport, lookups: Lookups): Promise<void> {
    for (let pages = 0; pages < MAX_PAGES_PER_RUN; pages += 1) {
      let page: ClaimFeedPage;
      try {
        page = await this.#feed.page(report.cursor, this.#pageSize);
      } catch (error) {
        if (!(error instanceof CursorExpired)) {
          throw error;
        }
        this.#logger.error('the claim log no longer keeps what came after the cursor; live claims are filed instead', {
          cursor: report.cursor,
          prunedThrough: error.prunedThrough,
        });
        report.cursorExpired = { at: this.#clock.now().toISOString(), prunedThrough: error.prunedThrough };
        await this.#startFromTheHead(
          report,
          lookups,
          error.prunedThrough,
          `the log no longer kept the events after ${String(report.cursor)}; it was pruned through `
          + String(error.prunedThrough),
        );
        return;
      }
      const next = page.next;
      if (next === null || next <= report.cursor) {
        return;
      }
      const { filings, retry } = await this.#filingsOf(collapseClaims(page.claims, this.#mirror.status), report, lookups);
      report.events += page.shown;
      if (retry) {
        // An item of this page could not be looked up and will be asked again: the
        // cursor stays where the page starts, so the next run reads it once more.
        // What was filed now is marked as filed, and is not filed twice.
        await this.#file(filings, null, report, lookups);
        return;
      }
      await this.#file(filings, next, report, lookups);
      report.cursor = next;
    }
  }

  /**
   * Reads the log to its head without filing anything, then files the state each
   * live claim stands for now, as of that head. Nothing about an issue no live claim
   * holds is filed: what it looked like before is not known, and a guess would move
   * a row nobody asked to move. When an item of a live claim could not be looked up
   * and will be asked again, the cursor is left where it was, so the next run starts
   * from the head once more; what was filed now is not filed again as of that head.
   */
  async #startFromTheHead(report: MirrorReport, lookups: Lookups, from: number, because: string): Promise<void> {
    let head = from;
    for (let pages = 0; ; pages += 1) {
      if (pages >= MAX_PAGES_TO_THE_HEAD) {
        throw new Error(`the claim log did not end within ${String(MAX_PAGES_TO_THE_HEAD)} pages`);
      }
      const page = await this.#feed.page(head, this.#pageSize);
      if (page.next === null || page.next <= head) {
        break;
      }
      head = page.next;
    }
    const filings: Filing[] = [];
    let retry = false;
    for (const claim of await this.#feed.liveClaims()) {
      const share = lookups.audience.shareOf(claim.holder);
      if (share === 'others') {
        report.othersMoves += 1;
        continue;
      }
      const ref = await this.#issueOf(claim.item, report, lookups);
      if (ref === RETRY) {
        retry = true;
        continue;
      }
      if (ref === null) {
        continue;
      }
      if (await this.#filedThrough(claim.item, head)) {
        report.duplicates += 1;
        continue;
      }
      filings.push(this.#filingOfClaim(claim, ref, head));
      report.orphanMoves += share === 'orphan' ? 1 : 0;
    }
    if (retry) {
      await this.#file(filings, null, report, lookups);
      return;
    }
    report.cursor = head;
    report.cursorExpired = null;
    report.startedFromHead = { at: this.#clock.now().toISOString(), event: head, because };
    await this.#file(filings, head, report, lookups);
  }

  #filingOfClaim(claim: LiveClaim, ref: IssueRef, head: number): Filing {
    const statuses = this.#mirror.status;
    const status = claim.inReview
      ? boardStatusOf('review', statuses) ?? boardStatusOf('claimed', statuses)
      : boardStatusOf('claimed', statuses);
    return {
      item: claim.item,
      ref,
      standing: { item: claim.item, lastKind: claim.inReview ? 'review_started' : 'claimed', holder: claim.holder },
      asOf: head,
      key: `head${String(head)}:${String(claim.item)}`,
      status,
      assign: [claim.holder],
      unassign: [],
    };
  }

  /**
   * The filings of a page's moves, and whether an item of the page could not be
   * looked up and will be asked again, which keeps the page for the next run.
   */
  async #filingsOf(
    moves: readonly IssueMove[],
    report: MirrorReport,
    lookups: Lookups,
  ): Promise<{ filings: Filing[]; retry: boolean }> {
    const filings: Filing[] = [];
    let retry = false;
    for (const move of moves) {
      const share = lookups.audience.shareOf(move.causedBy);
      if (share === 'others') {
        // Somebody else caused the state this item is left in; their worker files it.
        report.othersMoves += 1;
        continue;
      }
      if (!(await lookups.audience.stillStands(move, lookups.live))) {
        // The server has moved on since: a later move, filed by whichever worker
        // made it, is what the row should show.
        report.staleMoves += 1;
        continue;
      }
      const ref = await this.#issueOf(move.item, report, lookups);
      if (ref === RETRY) {
        retry = true;
        continue;
      }
      if (ref === null) {
        continue;
      }
      if (await this.#filedThrough(move.item, move.lastEventId)) {
        // The item's state as of a later event is filed already; this run of events
        // is behind it, however the pages fell this time.
        report.duplicates += 1;
        continue;
      }
      report.orphanMoves += share === 'orphan' ? 1 : 0;
      filings.push({
        item: move.item,
        ref,
        standing: { item: move.item, lastKind: move.lastKind, holder: move.holder },
        asOf: move.lastEventId,
        key: String(move.lastEventId),
        status: move.status,
        assign: move.assign,
        unassign: move.unassign,
      });
    }
    return { filings, retry };
  }

  /** Whether the item's state as of this event, or of a later one, is filed already. */
  async #filedThrough(item: number, event: number): Promise<boolean> {
    const filed = await readCount(this.#repository, mirrorItemKey(this.#sync.server, this.#sync.project, item));
    return filed !== null && event <= filed;
  }

  /**
   * Files the filings, the cursor and the last event filed for each item, in one
   * transaction; with no cursor, the cursor is left where it stands.
   */
  async #file(
    filings: readonly Filing[],
    cursor: number | null,
    report: MirrorReport,
    lookups: Lookups,
  ): Promise<void> {
    const drafted: Drafted = { actions: [], marks: [] };
    const pending = new Map(lookups.pending);
    for (const filing of filings) {
      let drafts = 0;
      for (const request of await this.#requestsFor(filing, lookups)) {
        try {
          drafted.actions.push(draftAction(this.#kinds, this.#directory, request, this.#clock.now()).action);
          drafts += 1;
        } catch (error) {
          if (!(error instanceof BoardQueueError)) {
            throw error;
          }
          report.refused += 1;
          this.#logger.warn('a mirrored move was refused', { ref: filing.ref.toString(), reason: error.describe() });
        }
      }
      if (drafts > 0) {
        pending.set(filing.key, filing.standing);
      }
      drafted.marks.push({
        key: mirrorItemKey(this.#sync.server, this.#sync.project, filing.item),
        value: String(filing.asOf),
      });
    }
    const marks = [...drafted.marks, mirrorPendingWrite(this.#pendingKey, pending)];
    await confirmStillHeld(lookups.lease);
    const written = await this.#repository.insertAll(
      drafted.actions,
      cursor === null ? marks : [...marks, mirrorCursorWrite(this.#cursorKey, cursor)],
    );
    // Written: the run's own record of the pending moves now says what the notes say.
    lookups.pending.clear();
    for (const [key, move] of pending) {
      lookups.pending.set(key, move);
    }
    for (const id of written) {
      lookups.cleared.add(id);
    }
    report.filed += written.length;
    report.duplicates += drafted.actions.length - written.length;
  }

  /**
   * Asks of every mirrored action still waiting whether its move still stands:
   * clears the queued actions of a move that does to run in this pass, withdraws
   * those of a move the server has moved on from, and forgets the moves whose
   * actions have all ended. A move this mirror holds no record of — filed before
   * the record was kept, or with the record lost — cannot be asked about; where
   * one worker files every move in the order of the log nothing can overtake it,
   * so it is cleared, and elsewhere it is left queued. Actions that wait for a
   * person (failed or blocked) are left to that person.
   */
  async #withdrawOvertaken(report: MirrorReport, lookups: Lookups): Promise<void> {
    const waiting = new Map<string, Action[]>();
    const unrecorded: Action[] = [];
    for (const action of await this.#repository.list({ states: [...STILL_TO_RUN_STATES] })) {
      if (!isMirrored(action)) {
        continue;
      }
      const key = this.#filingKeyOf(action.dedupeKey);
      if (key === null || !lookups.pending.has(key)) {
        unrecorded.push(action);
      } else {
        waiting.set(key, [...(waiting.get(key) ?? []), action]);
      }
    }
    if (lookups.audience.filedFor === null) {
      clear(lookups.cleared, unrecorded);
    }
    const before = lookups.pending.size;
    let withdrawn = 0;
    for (const [key, move] of [...lookups.pending]) {
      const actions = waiting.get(key) ?? [];
      const queued = actions.filter((action) => action.state === 'queued');
      if (actions.length === 0) {
        lookups.pending.delete(key);
        continue;
      }
      if (queued.length === 0) {
        continue;
      }
      if (await lookups.audience.stillStands(move, lookups.live)) {
        clear(lookups.cleared, queued);
        continue;
      }
      await confirmStillHeld(lookups.lease);
      for (const action of queued) {
        await this.#withdraw(action, OVERTAKEN);
      }
      if (queued.length === actions.length) {
        lookups.pending.delete(key);
      }
      withdrawn += 1;
    }
    report.staleMoves += withdrawn;
    if (withdrawn > 0 || lookups.pending.size !== before) {
      await confirmStillHeld(lookups.lease);
      await this.#repository.setMeta(this.#pendingKey, mirrorPendingWrite(this.#pendingKey, lookups.pending).value);
    }
  }

  /** Ends one waiting action of an overtaken move. */
  async #withdraw(action: Action, reason: string): Promise<void> {
    await withdrawOne(action, reason, this.#repository, this.#clock, this.#logger);
  }

  /** The key of the filing a mirrored action's dedupe key names, or null for a key this mirror did not write. */
  #filingKeyOf(dedupeKey: string | null): string | null {
    const prefix = this.#keyPrefix();
    if (dedupeKey === null || !dedupeKey.startsWith(prefix)) {
      return null;
    }
    const rest = dedupeKey.slice(prefix.length);
    const part = REQUEST_PARTS.find((one) => rest.endsWith(`:${one}`));
    return part === undefined ? null : rest.slice(0, rest.length - part.length - 1);
  }

  #keyPrefix(): string {
    return `dibs:${this.#sync.server}:${this.#sync.project}:`;
  }

  /**
   * The issue a work item stands for, when it is one the configuration keeps in
   * step; `RETRY` when its reference could not be read and a later run asks again.
   */
  async #issueOf(item: number, report: MirrorReport, lookups: Lookups): Promise<IssueRef | null | typeof RETRY> {
    const external = await lookups.refs.of(item);
    if (external !== null && typeof external !== 'string') {
      report.unresolved += 1;
      return external.retry ? RETRY : null;
    }
    const ref = external === null ? null : issueRefOfExternal(external);
    if (ref === null || !this.#repos.has(ref.repoFullName().toLowerCase())) {
      report.ignored += 1;
      return null;
    }
    return ref;
  }

  async #requestsFor(filing: Filing, lookups: Lookups): Promise<EnqueueRequest[]> {
    const key = (part: RequestPart): string => `${this.#keyPrefix()}${filing.key}:${part}`;
    const requests: EnqueueRequest[] = [];
    if (filing.status !== null) {
      requests.push({
        kind: 'board.set-fields',
        payload: {
          repo: filing.ref.repoFullName(),
          issue: filing.ref.number,
          fields: { status: filing.status },
          onlyIfStatusIn: [...this.#owned],
        },
        origin: ORIGIN,
        dedupeKey: key('status'),
      });
    }
    if (this.#mirror.assignees && (filing.assign.length > 0 || filing.unassign.length > 0)) {
      const add = await lookups.logins.loginsOf(filing.assign);
      const remove = await lookups.logins.loginsOf(filing.unassign);
      if (add.length > 0 || remove.length > 0) {
        requests.push({
          kind: 'issue.assignees',
          payload: { repo: filing.ref.repoFullName(), issue: filing.ref.number, add, remove },
          origin: ORIGIN,
          dedupeKey: key('assignees'),
        });
      }
    }
    return requests;
  }
}

type Lookups = {
  readonly refs: ItemRefs;
  readonly logins: MemberLogins;
  /** Whose moves this run files. */
  readonly audience: Audience;
  /** The live claims the moves are checked against. */
  readonly live: LiveClaims;
  /** The tick lock the run holds, confirmed before anything is filed. */
  readonly lease: TickLease;
  /** The moves filed whose actions have not all ended, by filing key; kept up to date as the run files. */
  readonly pending: Map<string, PendingMove>;
  /** The queued mirrored actions this run cleared to run in the pass. */
  readonly cleared: Set<string>;
};

function clear(cleared: Set<string>, actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.state === 'queued') {
      cleared.add(action.id);
    }
  }
}

/** Ends one waiting mirrored action without running it; one another writer changed meanwhile is left to them. */
async function withdrawOne(
  action: Action,
  reason: string,
  repository: ActionRepository,
  clock: Clock,
  logger: Logger,
): Promise<boolean> {
  action.withdraw(clock.now(), reason);
  try {
    await repository.update(action);
  } catch (error) {
    if (!(error instanceof StaleAction)) {
      throw error;
    }
    return false;
  }
  logger.info('a mirrored move was withdrawn before it ran', {
    action: action.id,
    ref: action.issueRef?.toString() ?? null,
    reason,
  });
  return true;
}

/**
 * Withdraws every mirrored action still queued, for a worker that no longer runs
 * the mirror whose moves they are: whoever runs it now files those moves, and
 * these would only hold their issues while they wait for a check this worker will
 * not make. Answers how many were withdrawn.
 */
export async function withdrawMirrored(
  deps: { repository: ActionRepository; clock: Clock; logger: Logger },
  lease: TickLease,
  reason: string,
): Promise<number> {
  let withdrawn = 0;
  for (const action of await deps.repository.list({ states: ['queued'] })) {
    if (!isMirrored(action)) {
      continue;
    }
    await confirmStillHeld(lease);
    withdrawn += (await withdrawOne(action, reason, deps.repository, deps.clock, deps.logger)) ? 1 : 0;
  }
  return withdrawn;
}
