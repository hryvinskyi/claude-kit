import { TransientFailure } from '../domain/errors.ts';
import {
  advancedCursor,
  endOf,
  endToReport,
  insideTheWindow,
  isFromItsOwnRepository,
  listingFloor,
  oldestFirst,
  parsePullRef,
  pullRefOf,
  readsPastTheFloor,
} from '../domain/forge/pull-requests.ts';
import type { ForgePull } from '../domain/forge/pull-requests.ts';
import type { ForgeConfig } from '../domain/sync-config.ts';
import { ForgeStop, sentenceOf } from './forge-calls.ts';
import type { ForgeJob, ForgePassState, FreshPull } from './forge-pass-state.ts';
import type {
  ClaimAfterReport,
  ForgeCoordination,
  KeptPull,
  ListingMark,
  PullLedger,
  PullListing,
  PullPage,
  PullReportAnswer,
  PullRequests,
} from './forge-ports.ts';
import type { Logger } from './ports.ts';
import type { ForgeRepositoryRun } from './sync-meta.ts';

/** A `Link` header that points in a circle would otherwise page for ever. */
const MAX_PAGES = 100;

/** The most paths a merge report carries, which is the most the server takes. */
const MAX_MERGE_PATHS = 3000;
/** The most pages of a pull request's files GitHub lists, a hundred at a time. */
const MAX_FILE_PAGES = 30;

const MINUTE_MS = 60 * 1000;

/** Which answers to a report end the claim; set aside and back to work both leave it live. */
const ENDS_THE_CLAIM: { readonly [C in ClaimAfterReport]: boolean } = {
  in_review: false,
  set_aside: false,
  working: false,
  completed: true,
};

/**
 * Telling the coordination server that a pull request ended: a merge with what it
 * changed and the branch it came from, or a close. Each report may be sent again,
 * and the server answers a repeat by matching nothing.
 *
 * What a merge changed is read a page per request, each one paced and guarded like
 * any other. When it cannot be read the merge is reported without it — the server
 * then takes what it kept of the merged branch — and the tally says so: a merge
 * the server is not told about holds a claim in review far longer than a merge it
 * is told about without its files. A branch of a fork is no branch of the
 * repository's, so a merge from one names no head.
 */
export class PullEnds {
  readonly #forge: PullRequests;
  readonly #coordination: ForgeCoordination;
  readonly #logger: Logger;

  constructor(forge: PullRequests, coordination: ForgeCoordination, logger: Logger) {
    this.#forge = forge;
    this.#coordination = coordination;
    this.#logger = logger;
  }

  async report(pull: ForgePull, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const ref = pullRefOf(pull.repo, pull.number);
    const mergedAt = pull.mergedAt;
    let answer: PullReportAnswer;
    if (mergedAt === null) {
      answer = await pass.calls.coordination(`the close of ${ref}`, () => this.#coordination.reportClosed(ref));
      tally.closed += 1;
    } else {
      const files = await this.#files(pull, pass, tally);
      answer = await pass.calls.coordination(`the merge of ${ref}`, () => this.#coordination.reportMerged({
        pr: ref,
        base: pull.baseRef,
        head: isFromItsOwnRepository(pull) ? pull.headRef : null,
        mergedAt,
        files,
      }));
      tally.merged += 1;
    }
    pass.reported.add(ref);
    if (answer.matched) {
      this.#logger.info('a pull request a claim waited for ended', { pr: ref, item: answer.item, claim: answer.claim });
      if (ENDS_THE_CLAIM[answer.claim]) {
        pass.endedItems.add(answer.item);
      }
    }
  }

  /** What a merge changed, every page read; nothing when a page could not be. */
  async #files(pull: ForgePull, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<string[] | null> {
    const ref = pullRefOf(pull.repo, pull.number);
    const paths: string[] = [];
    try {
      for (let page = 1, more = true; more && page <= MAX_FILE_PAGES; page += 1) {
        const read = await pass.calls.github(pull.repo, `page ${String(page)} of the files of ${ref}`, () =>
          this.#forge.pullFilesPage(pull.repo, pull.number, page));
        paths.push(...read.paths);
        more = read.more;
      }
    } catch (error) {
      if (error instanceof ForgeStop) {
        throw error;
      }
      tally.failures += 1;
      tally.mergesWithoutFiles += 1;
      this.#logger.warn('a merge is reported without its files, which could not be read', {
        pr: ref,
        reason: sentenceOf(error),
      });
      return null;
    }
    return [...new Set(paths)].slice(0, MAX_MERGE_PATHS);
  }
}

/** Pull requests read on their own, at most once a pass each, conditionally on what was kept. */
export class PullReads {
  readonly #forge: PullRequests;

  constructor(forge: PullRequests) {
    this.#forge = forge;
  }

  async read(repo: string, number: number, kept: KeptPull | null, pass: ForgePassState): Promise<FreshPull> {
    const ref = pullRefOf(repo, number);
    const already = pass.fresh.get(ref);
    if (already !== undefined) {
      return already;
    }
    const read = await pass.calls.github(repo, `the pull request ${ref}`, () =>
      this.#forge.pull(repo, number, kept?.etag ?? null));
    let fresh: FreshPull;
    if (!read.changed) {
      pass.calls.unchanged();
      if (kept === null) {
        throw new TransientFailure(`${ref} was answered "unchanged" to a request that held no tag`);
      }
      fresh = { pull: kept, mergeable: null };
    } else {
      fresh = { pull: keptOf(read.pull, kept, read.etag), mergeable: read.mergeable };
    }
    pass.fresh.set(ref, fresh);
    return fresh;
  }
}

/**
 * A pull request as read now, carrying on what was kept about it: what the server
 * was told it ended as stays only while it is still ended, so one that was
 * reopened is told about again when it ends again.
 */
function keptOf(pull: ForgePull, kept: KeptPull | null, etag: string | null): KeptPull {
  return {
    ...pull,
    etag,
    mergeableSent: kept?.mergeableSent ?? null,
    reported: endOf(pull) === null ? null : kept?.reported ?? null,
  };
}

/** The pull request with the end it ended as marked as told, once it has been. */
function told(pull: KeptPull): KeptPull {
  return { ...pull, reported: endOf(pull) };
}

export type FollowPullRequestsDeps = {
  forge: PullRequests;
  ledger: PullLedger;
  ends: PullEnds;
  settings: ForgeConfig;
  logger: Logger;
};

/**
 * Each repository's pull requests, followed by the last update.
 *
 * The pages sorted newest first are read until one reaches past the cursor less
 * the overlap, the first of them conditionally. What they hold is then handled
 * oldest first: a merge or close the server was not told about is reported, and
 * the pull request is kept with the cursor moved up to it, in one transaction, the
 * moment the server answered. A pass that stops on the way leaves the cursor at
 * the last pull request it finished, and the next pass carries on from there,
 * sending nothing twice. A report the server refuses is recorded and not sent
 * again by the listing, so one bad pull request never holds the cursor back. The
 * first page's tag is kept only once the whole window was handled.
 *
 * A first listing reads only what is open now and starts the cursor at the moment
 * GitHub says it answered: what ended before is not the server's news, and a claim
 * waiting on one of those is reconciled through the claims in review.
 */
export class FollowPullRequests implements ForgeJob {
  readonly name = 'the listing of pull requests';
  readonly #forge: PullRequests;
  readonly #ledger: PullLedger;
  readonly #ends: PullEnds;
  readonly #overlapMs: number;
  readonly #logger: Logger;

  constructor(deps: FollowPullRequestsDeps) {
    this.#forge = deps.forge;
    this.#ledger = deps.ledger;
    this.#ends = deps.ends;
    this.#overlapMs = deps.settings.overlapMinutes * MINUTE_MS;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    try {
      const mark = await this.#ledger.listing(repo);
      if (mark === null) {
        await this.#start(repo, pass, tally);
      } else {
        await this.#follow(repo, mark, pass, tally);
      }
    } catch (error) {
      if (error instanceof ForgeStop) {
        throw error;
      }
      tally.failures += 1;
      tally.listingError = sentenceOf(error);
      this.#logger.warn('the pull requests of a repository could not be listed', { repo, reason: tally.listingError });
    }
  }

  async #start(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const open: ForgePull[] = [];
    let servedAt: Date | null = null;
    for (let page = 1, more = true; more; page += 1) {
      const read = await this.#page(repo, 'open', page, null, pass);
      if (!read.changed) {
        break;
      }
      servedAt ??= read.servedAt;
      open.push(...read.pulls);
      more = read.more;
    }
    const kept: KeptPull[] = [];
    for (const pull of unique(open)) {
      const known = await this.#ledger.pull(repo, pull.number);
      const one = keptOf(pull, known, known?.etag ?? null);
      kept.push(one);
      pass.confirmed.set(pullRefOf(repo, pull.number), one);
    }
    const cursor = servedAt ?? pass.calls.startedAt;
    await this.#ledger.recordListing(repo, { cursor, etag: null }, kept);
    tally.seeded = true;
    tally.listed = kept.length;
    tally.cursor = cursor.toISOString();
  }

  async #follow(repo: string, mark: ListingMark, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const floor = listingFloor(mark.cursor, this.#overlapMs);
    const first = await this.#page(repo, 'all', 1, mark.etag, pass);
    if (!first.changed) {
      pass.calls.unchanged();
      return;
    }
    const window = first.pulls.filter((pull) => insideTheWindow(floor, pull));
    let more = first.more && !readsPastTheFloor(floor, first.pulls);
    for (let page = 2; more; page += 1) {
      const read = await this.#page(repo, 'all', page, null, pass);
      if (!read.changed) {
        break;
      }
      window.push(...read.pulls.filter((pull) => insideTheWindow(floor, pull)));
      more = read.more && !readsPastTheFloor(floor, read.pulls);
    }
    let cursor = mark.cursor;
    for (const pull of oldestFirst(unique(window))) {
      const kept = await this.#handled(pull, pass, tally);
      cursor = advancedCursor(cursor, [pull]);
      await this.#ledger.recordListing(repo, { cursor, etag: null }, [kept]);
      pass.confirmed.set(pullRefOf(repo, pull.number), kept);
      tally.listed += 1;
      tally.cursor = cursor.toISOString();
    }
    await this.#ledger.recordListing(repo, { cursor, etag: first.etag }, []);
    tally.cursor = cursor.toISOString();
  }

  /** The pull request as it is to be kept, its end reported first when the server was not told yet. */
  async #handled(pull: ForgePull, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<KeptPull> {
    const ref = pullRefOf(pull.repo, pull.number);
    const known = await this.#ledger.pull(pull.repo, pull.number);
    const carried = keptOf(pull, known, known?.etag ?? null);
    if (pass.reported.has(ref)) {
      return told(carried);
    }
    if (endToReport(pull, carried.reported) === null) {
      return carried;
    }
    try {
      await this.#ends.report(pull, pass, tally);
    } catch (error) {
      if (error instanceof ForgeStop) {
        throw error;
      }
      tally.failures += 1;
      tally.refusedReports += 1;
      this.#logger.warn('the server refused the end of a pull request; it is not sent again', {
        pr: ref,
        reason: sentenceOf(error),
      });
    }
    return told(carried);
  }

  async #page(
    repo: string,
    listing: PullListing,
    page: number,
    etag: string | null,
    pass: ForgePassState,
  ): Promise<PullPage> {
    if (page > MAX_PAGES) {
      throw new TransientFailure(`the pull requests of ${repo} ran to more pages than this reader follows`);
    }
    return pass.calls.github(repo, `page ${String(page)} of the pull requests of ${repo}`, () =>
      this.#forge.pullPage(repo, listing, page, etag));
  }
}

export type ReconcileReviewsDeps = {
  ledger: PullLedger;
  reads: PullReads;
  ends: PullEnds;
  logger: Logger;
};

/**
 * Every pull request a claim in review waits for, asked where it stands and
 * reported once it ended — however long ago. A pull request merged before its
 * holder recorded it, or while no pass ran, ended outside any listing's window,
 * and this is the only way it reaches the server. What was kept about it is never
 * taken on trust — a closed pull request may have been reopened since — unless
 * this pass's own listing read it: it is asked again, conditionally, and an answer
 * of "unchanged" costs nothing against the allowance.
 */
export class ReconcileReviews implements ForgeJob {
  readonly name = 'the claims in review';
  readonly #ledger: PullLedger;
  readonly #reads: PullReads;
  readonly #ends: PullEnds;
  readonly #logger: Logger;

  constructor(deps: ReconcileReviewsDeps) {
    this.#ledger = deps.ledger;
    this.#reads = deps.reads;
    this.#ends = deps.ends;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    for (const claim of pass.snapshot.reviewClaims) {
      for (const pr of claim.prs) {
        const named = parsePullRef(pr);
        if (named === null || named.repo !== repo || pass.reported.has(pullRefOf(named.repo, named.number))) {
          continue;
        }
        try {
          await this.#reconcile(repo, named.number, pass, tally);
        } catch (error) {
          if (error instanceof ForgeStop) {
            throw error;
          }
          tally.failures += 1;
          this.#logger.warn('a pull request in review could not be reconciled', { pr, reason: sentenceOf(error) });
        }
      }
    }
  }

  async #reconcile(repo: string, number: number, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const confirmed = pass.confirmed.get(pullRefOf(repo, number));
    const current = confirmed
      ?? (await this.#reads.read(repo, number, await this.#ledger.pull(repo, number), pass)).pull;
    if (endOf(current) === null) {
      await this.#ledger.recordPull(current);
      return;
    }
    await this.#ends.report(current, pass, tally);
    await this.#ledger.recordPull(told(current));
  }
}

export type ReportMergeabilityDeps = {
  ledger: PullLedger;
  reads: PullReads;
  ends: PullEnds;
  coordination: ForgeCoordination;
  logger: Logger;
};

/**
 * Whether each open pull request of a member, and each one a claim in review
 * waits for, merges cleanly into its base, told to the server when it changed
 * since it was last told. Only a pull request read on its own says so, asked
 * conditionally: one that did not change costs nothing against the allowance, and
 * one the forge is still working out says nothing until a later pass.
 */
export class ReportMergeability implements ForgeJob {
  readonly name = 'mergeability';
  readonly #ledger: PullLedger;
  readonly #reads: PullReads;
  readonly #ends: PullEnds;
  readonly #coordination: ForgeCoordination;
  readonly #logger: Logger;

  constructor(deps: ReportMergeabilityDeps) {
    this.#ledger = deps.ledger;
    this.#reads = deps.reads;
    this.#ends = deps.ends;
    this.#coordination = deps.coordination;
    this.#logger = deps.logger;
  }

  async run(repo: string, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const waitedFor = new Set(pass.snapshot.reviewClaims.flatMap((claim) => claim.prs.map((pr) => pr.toLowerCase())));
    for (const kept of await this.#ledger.openPulls(repo)) {
      const ref = pullRefOf(kept.repo, kept.number);
      const byMember = kept.author !== null && pass.snapshot.memberLogins.has(kept.author.toLowerCase());
      if (!byMember && !waitedFor.has(ref)) {
        continue;
      }
      try {
        await this.#check(kept, pass, tally);
      } catch (error) {
        if (error instanceof ForgeStop) {
          throw error;
        }
        tally.failures += 1;
        this.#logger.warn('whether a pull request merges cleanly could not be told', { pr: ref, reason: sentenceOf(error) });
      }
    }
  }

  async #check(kept: KeptPull, pass: ForgePassState, tally: ForgeRepositoryRun): Promise<void> {
    const ref = pullRefOf(kept.repo, kept.number);
    const read = await this.#reads.read(kept.repo, kept.number, kept, pass);
    const current = read.pull;
    if (endOf(current) !== null) {
      // It ended since the listing read it; the next listing would see it too, and
      // telling the server now is what keeps a claim from waiting for that pass.
      if (!pass.reported.has(ref) && endToReport(current, current.reported) !== null) {
        await this.#ends.report(current, pass, tally);
      }
      await this.#ledger.recordPull(told(current));
      return;
    }
    const mergeable = read.mergeable;
    if (mergeable === null || mergeable === current.mergeableSent) {
      await this.#ledger.recordPull(current);
      return;
    }
    await pass.calls.coordination(`whether ${ref} merges cleanly`, () =>
      this.#coordination.reportMergeable(ref, mergeable));
    tally.mergeability += 1;
    await this.#ledger.recordPull({ ...current, mergeableSent: mergeable });
  }
}

/** The pull requests of a listing, each once: one updated while the pages were read can show up on two of them. */
function unique(pulls: readonly ForgePull[]): ForgePull[] {
  const seen = new Set<number>();
  return pulls.filter((pull) => {
    if (seen.has(pull.number)) {
      return false;
    }
    seen.add(pull.number);
    return true;
  });
}
