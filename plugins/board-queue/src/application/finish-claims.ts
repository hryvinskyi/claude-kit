import { BoardQueueError } from '../domain/errors.ts';
import { claimMoves } from '../domain/sync/finished-claims.ts';
import type { HeldClaim, Sighting, StageStatuses } from '../domain/sync/finished-claims.ts';
import type { FinishConfig, SyncConfig } from '../domain/sync-config.ts';
import { describeUnknown } from './drain-queue.ts';
import type { ActionRepository, Clock, Logger } from './ports.ts';
import { finishSightingsKey, readSightings, writeFinishRun, writeSightings } from './sync-meta.ts';
import type { FinishRun } from './sync-meta.ts';
import type { OwnClaims } from './sync-ports.ts';

/** What one run did, in the words a log line and a status report use. */
export type FinishReport = FinishRun;

export type FinishClaimsDeps = {
  claims: OwnClaims;
  repository: ActionRepository;
  sync: SyncConfig;
  finish: FinishConfig;
  clock: Clock;
  logger: Logger;
};

/**
 * Lets this worker's own person's claims go as the board moves their work on. A
 * person who moves a ticket on to QA has finished the code, and the areas the claim
 * holds are what keeps everybody else out of those files: the claim gives them up
 * and keeps its item, so the work can be taken up again when QA sends it back. A
 * ticket that is done, or closed, ends the claim for good.
 *
 * Each run reads the claims the member the token speaks for holds, compares how
 * far each issue has gone with what the last run saw, narrows or completes the
 * claims whose issues moved on, and keeps what it saw for the next run. What counts
 * as a move is the domain's rule; this only reads, calls and remembers.
 *
 * A call that fails leaves the sighting the claim had, so the next run makes it
 * again; a claim its holder no longer held is counted and forgotten. A token that
 * speaks for an integration rather than a person lets nothing go, and says so.
 */
export class FinishClaims {
  readonly #claims: OwnClaims;
  readonly #repository: ActionRepository;
  readonly #statuses: StageStatuses;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #sightingsKey: string;

  constructor(deps: FinishClaimsDeps) {
    this.#claims = deps.claims;
    this.#repository = deps.repository;
    this.#statuses = { handedOn: new Set(deps.finish.handOn), ended: new Set(deps.finish.complete) };
    this.#clock = deps.clock;
    this.#logger = deps.logger;
    this.#sightingsKey = finishSightingsKey(deps.sync.server, deps.sync.project);
  }

  async execute(): Promise<FinishReport> {
    const report: FinishReport = {
      at: this.#clock.now().toISOString(),
      holder: null,
      held: 0,
      handedOn: [],
      completed: [],
      gone: 0,
      declined: null,
      error: null,
    };
    try {
      await this.#run(report);
    } catch (error) {
      report.error = error instanceof BoardQueueError ? error.describe() : describeUnknown(error);
      this.#logger.warn('claims were not let go', { reason: report.error });
    }
    await writeFinishRun(this.#repository, report);
    this.#logger.info('claims let go as the board moved their work on', { ...report });
    return report;
  }

  async #run(report: FinishReport): Promise<void> {
    const holder = await this.#claims.holder();
    if (holder === null) {
      report.declined = 'the coordination server\'s token speaks for an integration, not a person, '
        + 'so it holds no claims to let go';
      return;
    }
    report.holder = holder;
    const held = await this.#claims.held(holder);
    report.held = held.length;
    const moves = claimMoves(held, await readSightings(this.#repository, this.#sightingsKey), this.#statuses);
    const seen = new Map(moves.seen);
    try {
      for (const claim of moves.complete) {
        await this.#settle(claim, () => this.#claims.complete(claim.item), report.completed, report, seen, null);
      }
      for (const claim of moves.handOn) {
        await this.#settle(
          claim,
          () => this.#claims.giveUpAreas(claim.item, claim.areas),
          report.handedOn,
          report,
          seen,
          { claimedAt: claim.claimedAt, stage: 'handed-on' },
        );
      }
    } finally {
      await writeSightings(this.#repository, this.#sightingsKey, seen);
    }
  }

  /**
   * Makes one call and records what came of it: the claim named in the report and
   * its new sighting kept — none for a claim that ended — or, when its holder no
   * longer held it, counted and forgotten.
   */
  async #settle(
    claim: HeldClaim,
    call: () => Promise<boolean>,
    done: string[],
    report: FinishReport,
    seen: Map<number, Sighting>,
    after: Sighting | null,
  ): Promise<void> {
    const named = claim.ref ?? String(claim.item);
    if (!(await call())) {
      report.gone += 1;
      seen.delete(claim.item);
      return;
    }
    done.push(named);
    this.#logger.info('a claim was let go as the board moved its work on', {
      item: named,
      status: claim.boardStatus,
      ended: after === null,
    });
    if (after === null) {
      seen.delete(claim.item);
    } else {
      seen.set(claim.item, after);
    }
  }
}
